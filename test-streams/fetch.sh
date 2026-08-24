#!/bin/bash
# Fetch a catalogued test source and normalise it into a DJI-like H.264 asset.
#
# Normalising up front matters for two reasons: it lets publish.sh push with
# -c copy (so the bitstream on the wire is exactly what we encoded, and the CPU
# cost of a loop is near zero), and it makes clips from different sources
# concat-compatible so they can be chained into a playlist.
#
# Usage:
#   ./fetch.sh                          # default source, dji-hd profile
#   ./fetch.sh dji-nature041            # specific source
#   ./fetch.sh dji-nature041 dji-sd     # specific source and profile
#   ./fetch.sh --list                   # show the catalogue
#   ./fetch.sh --all                    # every catalogued source
#
# Env:
#   TS_MEDIA      override the media cache directory
#   TS_DURATION   cap the normalised asset length in seconds (default: full clip)
#   TS_FORCE=1    re-encode even if the asset is already cached
#   TS_AUDIO      silent (default, no audio track) | tone (440 Hz) | source
#                 Video-only is the default because ATAK plays any audio track
#                 it receives, so a tone is audible to the operator.

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

require_tools ffmpeg ffprobe jq curl

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

list_catalogue() {
    printf '\nProfiles:\n'
    while read -r p; do
        printf '  %-12s %s\n' "$p" "$(profile_field "$p" description)"
        printf '  %-12s %sx%s @ %sfps, %s\n' '' \
            "$(profile_field "$p" width)" "$(profile_field "$p" height)" \
            "$(profile_field "$p" fps)" "$(profile_field "$p" video_bitrate)"
    done < <(profile_ids)

    printf '\nSources:\n'
    while read -r s; do
        # HLS sources report the top rendition size; file sources report the whole file.
        local_size="$(source_field "$s" verified.size_bytes)"
        [ -z "$local_size" ] && local_size="$(source_field "$s" verified.top_rendition_bytes)"
        human="$(awk -v b="${local_size:-0}" 'BEGIN{if(b>1073741824) printf "%.1f GiB", b/1073741824; else if (b>0) printf "%.0f MiB", b/1048576; else print "?"}')"
        dur="$(source_field "$s" verified.duration_s)"
        flag=''
        [ "$(source_field "$s" redistributable)" != "true" ] && flag=' [not redistributable]'
        [ "$(source_field "$s" default)" = "true" ] && flag="$flag [default]"
        printf '  %-20s %-9s %-7s %s%s\n' "$s" "$human" "${dur}s" "$(source_field "$s" description)" "$flag"
    done < <(source_ids)
    printf '\n'
    exit 0
}

default_source() {
    local id
    id="$(sources_query '.sources | to_entries[] | select(.value.default == true) | .key' | head -1)"
    [ -n "$id" ] || die "No default source marked in sources.json"
    printf '%s' "$id"
}

# Download to the cache, resuming a partial transfer if one exists.
download_raw() {
    local id="$1" url="$2" dest="$3"
    if [ -f "$dest" ]; then
        local expected actual
        expected="$(source_field "$id" verified.size_bytes)"
        actual="$(stat -c%s "$dest")"
        if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
            info "  raw already cached ($(numfmt --to=iec "$actual"))"
            return 0
        fi
        warn "  cached raw file is $(numfmt --to=iec "$actual"), expected $(numfmt --to=iec "${expected:-0}"); resuming"
    fi
    info "  downloading $url"
    curl -fL --retry 3 --retry-delay 2 -C - --progress-bar -o "$dest" "$url" \
        || die "Download failed for $id"
}

# The DJI ZIP sources need unpacking before we can find a video inside.
unpack_archive() {
    local zip="$1" outdir="$2"
    require_tools unzip
    info "  unpacking archive"
    mkdir -p "$outdir"
    unzip -o -q "$zip" -d "$outdir" || die "Failed to unpack $zip"
    local found
    found="$(find "$outdir" -type f \( -iname '*.mov' -o -iname '*.mp4' -o -iname '*.mxf' -o -iname '*.braw' \) | head -1)"
    [ -n "$found" ] || die "No video file found inside $zip"
    printf '%s' "$found"
}

# True only if the file is a complete, decodable asset with a real duration.
asset_is_valid() {
    local f="$1" dur
    [ -s "$f" ] || return 1
    dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null | head -1 || true)"
    [ -n "$dur" ] && [ "$dur" != "N/A" ] || return 1
    awk -v d="$dur" 'BEGIN{ exit !(d+0 > 0.5) }'
}

# Highest-resolution video stream, as an absolute ffmpeg stream index.
#
# Multivariant HLS exposes one video stream per rendition, and ffprobe can list
# them more than once, so positional selectors like 0:v:1 are not dependable.
# The absolute index from the 'index' field is unambiguous.
best_video_index() {
    local input="$1"
    ffprobe -v error -select_streams v -show_entries stream=index,width \
        -of csv=p=0 "$input" 2>/dev/null \
        | sort -u \
        | awk -F, 'NF>=2 { if ($2+0 > max) { max=$2+0; idx=$1 } } END { if (max>0) print idx }'
}

normalise() {
    local input="$1" output="$2" profile="$3"

    local w h fps vb bufsize h264p h264l gop
    w="$(profile_field "$profile" width)"
    h="$(profile_field "$profile" height)"
    fps="$(profile_field "$profile" fps)"
    vb="$(profile_field "$profile" video_bitrate)"
    bufsize="$(profile_field "$profile" bufsize)"
    h264p="$(profile_field "$profile" h264_profile)"
    h264l="$(profile_field "$profile" h264_level)"
    gop=$(( fps * TS_GOP_SECONDS ))

    # This probe must not abort the script under `set -e`: an absent audio stream
    # is an expected outcome, and grep exits 1 when it matches nothing.
    local has_audio vidx
    has_audio="$(ffprobe -v error -select_streams a -show_entries stream=index \
        -of csv=p=0 "$input" 2>/dev/null | grep -E '^[0-9]+$' | head -1 || true)"
    vidx="$(best_video_index "$input" || true)"
    [ -n "$vidx" ] || die "No video stream found in $input"
    info "  selected video stream index $vidx"

    # Bound the encode explicitly rather than trusting -shortest.
    #
    # The synthesised tone is an infinite lavfi source. -shortest is supposed to
    # stop at the shortest input, but with a filter graph and multiple inputs it
    # does not reliably propagate EOF: some sources terminate and others encode
    # forever, growing the output until the disk fills. An explicit -t derived
    # from the source duration is deterministic.
    local src_duration limit
    src_duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$input" 2>/dev/null | head -1 || true)"
    limit="${TS_DURATION:-}"
    if [ -z "$limit" ]; then
        if [ -n "$src_duration" ] && [ "$src_duration" != "N/A" ]; then
            limit="$src_duration"
        else
            warn "  cannot determine source duration; capping at 60s"
            limit=60
        fi
    fi

    # Audio mode. Video-only is the default deliberately: ATAK plays whatever
    # audio track it is given, so a synthesised reference tone is audible to the
    # operator as a hum or beep. A test feed should be silent unless the audio
    # path is what you are actually testing.
    local -a audio_in=() maps=() audio_codec=()
    case "${TS_AUDIO:-silent}" in
        silent)
            maps=(-map "0:$vidx")
            audio_codec=(-an)
            [ -n "$has_audio" ] && info "  dropping the source audio track (TS_AUDIO=tone to keep a tone)"
            ;;
        tone)
            # Finite duration, so neither input is unbounded.
            warn "  embedding a 440 Hz tone; this is audible in ATAK"
            audio_in=(-f lavfi -i "sine=frequency=440:sample_rate=$TS_AUDIO_RATE:duration=$limit")
            maps=(-map "0:$vidx" -map 1:a:0)
            audio_codec=(-c:a "$TS_AUDIO_CODEC" -profile:a aac_low -b:a "$TS_AUDIO_BITRATE"
                         -ar "$TS_AUDIO_RATE" -ac "$TS_AUDIO_CHANNELS")
            ;;
        source)
            if [ -n "$has_audio" ]; then
                maps=(-map "0:$vidx" -map 0:a:0)
                audio_codec=(-c:a "$TS_AUDIO_CODEC" -profile:a aac_low -b:a "$TS_AUDIO_BITRATE"
                             -ar "$TS_AUDIO_RATE" -ac "$TS_AUDIO_CHANNELS")
            else
                warn "  TS_AUDIO=source but the source is silent; producing video only"
                maps=(-map "0:$vidx")
                audio_codec=(-an)
            fi
            ;;
        *)
            die "Unknown TS_AUDIO mode: ${TS_AUDIO} (expected silent, tone or source)"
            ;;
    esac

    local -a duration=(-t "$limit" -shortest)

    info "  encoding -> ${w}x${h} @ ${fps}fps, $vb CBR, ${TS_GOP_SECONDS}s GOP, H.264 $h264p"

    # -nal-hrd cbr plus a fixed GOP and no B-frames is what makes this look like
    # a hardware drone encoder rather than a file transcode.
    ffmpeg -y -hide_banner -loglevel error -stats \
        -i "$input" "${audio_in[@]}" \
        "${maps[@]}" "${duration[@]}" \
        -c:v libx264 -profile:v "$h264p" -level "$h264l" \
        -preset veryfast -tune zerolatency \
        -pix_fmt yuv420p \
        -vf "scale=$w:$h:force_original_aspect_ratio=decrease,pad=$w:$h:(ow-iw)/2:(oh-ih)/2,setsar=1" \
        -r "$fps" -g "$gop" -keyint_min "$gop" -sc_threshold 0 -bf 0 \
        -b:v "$vb" -minrate "$vb" -maxrate "$vb" -bufsize "$bufsize" -nal-hrd cbr \
        "${audio_codec[@]}" \
        -movflags +faststart \
        "$output" || die "Encode failed"
}

fetch_one() {
    local source_id="$1" profile_id="$2"

    assert_source_exists "$source_id"
    assert_profile_exists "$profile_id"

    local asset
    asset="$(asset_path "$source_id" "$profile_id")"

    # Only treat a cached asset as usable if it actually decodes. An interrupted
    # encode leaves a file with no moov atom, and silently reusing it means
    # publish.sh fails later with a confusing error a long way from the cause.
    if [ -f "$asset" ] && [ "${TS_FORCE:-0}" != "1" ]; then
        if asset_is_valid "$asset"; then
            ok "✅ $source_id [$profile_id] already built: $asset"
            return 0
        fi
        warn "  cached asset is unreadable or truncated; rebuilding"
        rm -f "$asset"
    fi

    info "▶ $source_id [$profile_id]"
    check_licence "$source_id"
    mkdir -p "$TS_MEDIA"

    local url input
    url="$(source_field "$source_id" url)"

    if [ "$(source_field "$source_id" hls)" = "true" ]; then
        # ffmpeg pulls only the rendition we select, so there is nothing to cache
        # separately: skip straight to the encode and read from the CDN.
        info "  HLS source; reading directly from the CDN (no raw cache needed)"
        input="$url"
    else
        local raw
        raw="$TS_MEDIA/raw-$source_id.$(printf '%s' "${url##*.}" | tr '[:upper:]' '[:lower:]')"
        download_raw "$source_id" "$url" "$raw"
        input="$raw"
        if [ "$(source_field "$source_id" archive)" = "zip" ]; then
            input="$(unpack_archive "$raw" "$TS_MEDIA/unpacked-$source_id")"
            info "  using $input"
        fi
    fi

    normalise "$input" "$asset" "$profile_id"

    # Report what we actually produced rather than what we asked for.
    local summary
    summary="$(ffprobe -v error -select_streams v:0 \
        -show_entries stream=codec_name,profile,width,height,r_frame_rate \
        -show_entries format=duration,bit_rate -of csv=p=0 "$asset" | tr '\n' ' ')"
    ok "✅ built $asset"
    log "   $summary"
}

main() {
    local -a args=()
    while [ $# -gt 0 ]; do
        case "$1" in
            -h|--help)  usage ;;
            -l|--list)  list_catalogue ;;
            --all)
                local profile="${2:-dji-hd}"
                while read -r s; do
                    fetch_one "$s" "$profile"
                done < <(source_ids)
                exit 0 ;;
            *) args+=("$1"); shift ;;
        esac
    done

    local source_id="${args[0]:-$(default_source)}"
    local profile_id="${args[1]:-dji-hd}"
    fetch_one "$source_id" "$profile_id"
}

main "$@"
