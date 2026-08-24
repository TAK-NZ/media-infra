#!/bin/bash
# Publish one or more normalised assets to a media-infra stream, looping forever.
#
# This imitates a DJI drone pushing a live feed: RTMP ingest, real-time pacing,
# and -c copy so the exact bitstream fetch.sh produced goes on the wire. With
# several assets the concat demuxer chains them into one continuous feed, which
# is why fetch.sh normalises everything to a shared profile.
#
# Usage:
#   ./publish.sh <uuid>                                  # default source, looped
#   ./publish.sh <uuid> drone-night-city                 # one source
#   ./publish.sh <uuid> drone-night-city drone-arid-coast # playlist, looped
#   ./publish.sh <uuid> --all-drone                      # every drone clip, looped
#   ./publish.sh <uuid> --profile dji-sd drone-night-city # non-default profile
#   ./publish.sh <uuid> --once drone-night-city          # single pass, no loop
#
# The first argument may be a full feed URL instead of a UUID, which is how you
# target another environment:
#
#   ./publish.sh rtmp://media.demo.tak.nz:1935/<uuid> --all-drone
#   ./publish.sh 'srt://media.demo.tak.nz:8890?streamid=publish:<uuid>'
#
# Env:
#   TS_HOST      endpoint host (default: media.test.tak.nz)
#   TS_STREAM    stream UUID, if not passed as the first argument
#   TS_PROFILE   encoder profile (default: dji-hd)
#   TS_PROTOCOL  ingest protocol: rtmp (default) | srt | rtsp
#   TS_AUDIO     which audio variant of the assets to publish (default: silent)

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

require_tools ffmpeg ffprobe jq

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

PROFILE="${TS_PROFILE:-dji-hd}"
PROTOCOL="${TS_PROTOCOL:-rtmp}"
LOOP=1
ALL_DRONE=0
declare -a REQUESTED=()

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)   usage ;;
        --once)      LOOP=0; shift ;;
        --all-drone) ALL_DRONE=1; shift ;;
        --profile)   PROFILE="$2"; shift 2 ;;
        --protocol)  PROTOCOL="$2"; shift 2 ;;
        --host)      TS_HOST="$2"; shift 2 ;;
        -*)          die "Unknown option: $1" ;;
        *)
            # First bare argument is the target (UUID or full URL); the rest are
            # source ids or file paths.
            if [ -z "${TS_STREAM:-}" ]; then parse_stream_arg "$1"; else REQUESTED+=("$1"); fi
            shift ;;
    esac
done

resolve_target
assert_profile_exists "$PROFILE"

if [ "$ALL_DRONE" -eq 1 ]; then
    # Every aerial clip, in catalogue order, chained into one looping feed.
    while read -r s; do REQUESTED+=("$s"); done < <(source_ids | grep '^drone-')
    [ ${#REQUESTED[@]} -gt 0 ] || die "No drone-* sources found in the catalogue"
fi

# Default to the catalogue default when no sources were named.
if [ ${#REQUESTED[@]} -eq 0 ]; then
    REQUESTED=("$(sources_query '.sources | to_entries[] | select(.value.default == true) | .key' | head -1)")
fi

# Resolve each requested id to a built asset, failing with a usable hint.
declare -a ASSETS=()
for id in "${REQUESTED[@]}"; do
    if [ -f "$id" ]; then
        ASSETS+=("$(realpath "$id")")
        continue
    fi
    assert_source_exists "$id"
    asset="$(asset_path "$id" "$PROFILE")"
    if [ ! -f "$asset" ]; then
        die "Asset not built: $asset
Run: TS_AUDIO=${TS_AUDIO:-silent} ./fetch.sh $id $PROFILE"
    fi
    ASSETS+=("$asset")
done

# A full URL wins over --protocol: it already says which protocol to use, and
# silently overriding the URL the caller typed would be surprising.
if [ -n "${TS_URL:-}" ]; then
    TARGET="$TS_URL"
    PROTOCOL="${TS_SCHEME:-$PROTOCOL}"
    case "$PROTOCOL" in
        rtmp|rtmps) OUTFMT=(-f flv) ;;
        srt)        OUTFMT=(-f mpegts) ;;
        rtsp|rtsps) OUTFMT=(-f rtsp -rtsp_transport tcp) ;;
        *)          die "Unsupported scheme in feed URL: $PROTOCOL" ;;
    esac
else
    case "$PROTOCOL" in
        rtmp) TARGET="rtmp://$TS_HOST:1935/$TS_STREAM"; OUTFMT=(-f flv) ;;
        srt)  TARGET="srt://$TS_HOST:8890?streamid=publish:$TS_STREAM"; OUTFMT=(-f mpegts) ;;
        rtsp) TARGET="rtsp://$TS_HOST:8554/$TS_STREAM"; OUTFMT=(-f rtsp -rtsp_transport tcp) ;;
        *)    die "Unsupported protocol: $PROTOCOL (expected rtmp, srt or rtsp)" ;;
    esac
fi

info "Publishing to $TARGET"
info "Profile: $PROFILE   Protocol: $PROTOCOL   Audio: ${TS_AUDIO:-silent}   Loop: $([ $LOOP -eq 1 ] && echo forever || echo once)"
total=0
for a in "${ASSETS[@]}"; do
    dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$a" 2>/dev/null || echo 0)"
    total="$(awk -v t="$total" -v d="$dur" 'BEGIN{printf "%.2f", t+d}')"
    info "  $(basename "$a") (${dur%.*}s)"
done
info "Playlist length: ${total%.*}s"

declare -a INPUT=()
CLEANUP_PLAYLIST=''

if [ ${#ASSETS[@]} -eq 1 ]; then
    INPUT=(-i "${ASSETS[0]}")
    [ $LOOP -eq 1 ] && INPUT=(-stream_loop -1 "${INPUT[@]}")
else
    # The concat demuxer needs a playlist file. -stream_loop -1 in front of a
    # concat input replays the whole list, not just the last entry.
    PLAYLIST="$(mktemp "${TMPDIR:-/tmp}/mediainfra-playlist.XXXXXX")"
    CLEANUP_PLAYLIST="$PLAYLIST"
    for a in "${ASSETS[@]}"; do
        printf "file '%s'\n" "$a" >> "$PLAYLIST"
    done
    INPUT=(-f concat -safe 0 -i "$PLAYLIST")
    [ $LOOP -eq 1 ] && INPUT=(-stream_loop -1 "${INPUT[@]}")
fi

cleanup() {
    [ -n "$CLEANUP_PLAYLIST" ] && rm -f "$CLEANUP_PLAYLIST"
}
trap cleanup EXIT

# -re paces output at wall-clock speed, which is what makes this a live feed
# rather than a fast file dump. +genpts keeps DTS monotonic across concat joins,
# which FLV requires and which the copy path cannot fix with a filter.
exec ffmpeg -hide_banner -loglevel warning -stats \
    -re -fflags +genpts \
    "${INPUT[@]}" \
    -c copy \
    "${OUTFMT[@]}" "$TARGET"
