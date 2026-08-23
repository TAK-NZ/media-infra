#!/bin/bash
# Verify every published protocol on a media-infra stream actually delivers media.
#
# Checks headers and handshakes, but mostly it decodes frames: a protocol that
# negotiates cleanly and then serves nothing is the exact failure this harness
# exists to catch. Exits non-zero if any required check fails.
#
# Usage:
#   ./verify.sh <stream-uuid>
#   ./verify.sh <stream-uuid> --host media.test.tak.nz
#   ./verify.sh <stream-uuid> --expect-eip 184.33.122.159
#   ./verify.sh <stream-uuid> --skip webrtc,srt
#
# Env:
#   TS_HOST        endpoint host (default: media.test.tak.nz)
#   TS_STREAM      stream UUID, if not passed as the first argument
#   TS_EXPECT_EIP  assert WebRTC ICE advertises this address
#   TS_PROBE_SECS  seconds of media to decode per protocol (default: 5)

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

require_tools ffmpeg ffprobe curl jq

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

PROBE_SECS="${TS_PROBE_SECS:-5}"
EXPECT_EIP="${TS_EXPECT_EIP:-}"
SKIP=""

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)      usage ;;
        --host)         TS_HOST="$2"; shift 2 ;;
        --expect-eip)   EXPECT_EIP="$2"; shift 2 ;;
        --skip)         SKIP="$2"; shift 2 ;;
        --probe-secs)   PROBE_SECS="$2"; shift 2 ;;
        -*)             die "Unknown option: $1" ;;
        *)              TS_STREAM="$1"; shift ;;
    esac
done

resolve_target

PASS=0; FAIL=0; SKIPPED=0
declare -a FAILURES=()

skipped() { case ",$SKIP," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

pass()   { ok   "  ✅ $1"; PASS=$((PASS+1)); }
fail()   { err  "  ❌ $1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }
skip()   { warn "  ⊘  $1 (skipped)"; SKIPPED=$((SKIPPED+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mediainfra-verify.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

header() { info ""; info "── $1"; }

# ---------------------------------------------------------------------------
# Decode-based check shared by RTSP / RTMP / SRT
# ---------------------------------------------------------------------------
check_decode() {
    local label="$1" url="$2"

    local probe
    probe="$(timeout $((PROBE_SECS + 40)) ffprobe -hide_banner -v error -rw_timeout 20000000 \
        -show_entries stream=codec_type,codec_name,width,height \
        -of csv=p=0 "$url" 2>&1 || true)"

    if ! printf '%s' "$probe" | grep -q 'video'; then
        fail "$label: no video stream (${probe:-no response})"
        return
    fi

    local res
    res="$(printf '%s' "$probe" | awk -F, '/video/{print $3"x"$4; exit}')"

    # Decoding is the real test. A negotiated session that yields no frames is
    # the failure mode we care about.
    local decode
    decode="$(timeout $((PROBE_SECS + 40)) ffmpeg -hide_banner -v error -rw_timeout 20000000 \
        -i "$url" -t "$PROBE_SECS" -f null - 2>&1 || true)"

    if [ -n "$decode" ]; then
        fail "$label: decoded ${PROBE_SECS}s with errors: $(printf '%s' "$decode" | head -1)"
        return
    fi

    local audio=''
    printf '%s' "$probe" | grep -q 'audio' && audio=' +audio'
    pass "$label: $res${audio}, ${PROBE_SECS}s decoded clean"
}

# ---------------------------------------------------------------------------
# RTSP / RTMP / SRT
# ---------------------------------------------------------------------------
header "RTSP (8554)"
if skipped rtsp; then skip "RTSP"; else
    check_decode "RTSP" "rtsp://$TS_HOST:8554/$TS_STREAM"
fi

header "RTMP (1935)"
if skipped rtmp; then skip "RTMP"; else
    check_decode "RTMP" "rtmp://$TS_HOST:1935/$TS_STREAM"
fi

header "SRT (8890/udp)"
if skipped srt; then skip "SRT"; else
    check_decode "SRT" "srt://$TS_HOST:8890?streamid=read:$TS_STREAM"
fi

# ---------------------------------------------------------------------------
# HLS: walk master -> media playlist -> init + newest segment, then decode
# ---------------------------------------------------------------------------
header "HLS (9997)"
if skipped hls; then skip "HLS"; else
    BASE="https://$TS_HOST:9997"
    MASTER="$BASE/stream/$TS_STREAM/index.m3u8"

    code="$(curl -sS -o "$WORK/master.m3u8" -D "$WORK/master.h" -w '%{http_code}' --max-time 25 "$MASTER" || echo 000)"
    if [ "$code" != "200" ]; then
        fail "HLS master playlist: http=$code"
    else
        pass "HLS master playlist: http=200"

        # A live media playlist must not be cacheable. Without an explicit
        # no-store, a client that revalidates can be handed a stale window and
        # stall at the live edge; tolerant players retry, native ones do not.
        if grep -qi '^cache-control:.*no-store' "$WORK/master.h"; then
            pass "HLS master: Cache-Control no-store present"
        else
            fail "HLS master: Cache-Control missing or cacheable ($(grep -i '^cache-control' "$WORK/master.h" | tr -d '\r' || echo 'header absent'))"
        fi
        if grep -qi '^etag:' "$WORK/master.h"; then
            fail "HLS master: ETag present on a live playlist (invites revalidation)"
        else
            pass "HLS master: no ETag"
        fi

        # Bare URI lines are variant playlists; quoted URI="..." are rendition
        # groups. Strip quotes carefully or the token is corrupted.
        VID="$(grep -v '^#' "$WORK/master.m3u8" | grep -m1 'm3u8' || true)"
        if [ -z "$VID" ]; then
            # Not a master playlist: treat it as a media playlist directly.
            cp "$WORK/master.m3u8" "$WORK/media.m3u8"
            info "     (single-variant playlist)"
        else
            mcode="$(curl -sS -o "$WORK/media.m3u8" -D "$WORK/media.h" -w '%{http_code}' --max-time 25 "$BASE$VID" || echo 000)"
            if [ "$mcode" != "200" ]; then
                fail "HLS media playlist: http=$mcode"
            else
                pass "HLS media playlist: http=200"
                if grep -qi '^cache-control:.*no-store' "$WORK/media.h"; then
                    pass "HLS media playlist: Cache-Control no-store present"
                else
                    fail "HLS media playlist: Cache-Control missing or cacheable"
                fi
            fi
        fi

        nseg="$(grep -cE 'segment|\.m4s|\.ts' "$WORK/media.m3u8" 2>/dev/null || echo 0)"
        if [ "$nseg" -gt 0 ]; then
            pass "HLS media playlist lists $nseg segment refs"

            INIT="$(sed -n 's/.*EXT-X-MAP:URI="\([^"]*\)".*/\1/p' "$WORK/media.m3u8" | head -1)"
            # Take the newest segment: the oldest may already have rotated out
            # of the live window, which would be a false failure.
            NEW="$(grep -v '^#' "$WORK/media.m3u8" | grep -E 'segment|\.m4s|\.ts' | tail -1 || true)"

            if [ -n "$INIT" ]; then
                icode="$(curl -sS -o "$WORK/init.mp4" -w '%{http_code}' --max-time 25 "$BASE$INIT" || echo 000)"
                [ "$icode" = "200" ] && pass "HLS init segment: http=200 ($(stat -c%s "$WORK/init.mp4") bytes)" \
                                     || fail "HLS init segment: http=$icode"
            fi
            if [ -n "$NEW" ]; then
                scode="$(curl -sS -o "$WORK/seg.bin" -w '%{http_code}' --max-time 30 "$BASE$NEW" || echo 000)"
                if [ "$scode" = "200" ]; then
                    pass "HLS newest segment: http=200 ($(stat -c%s "$WORK/seg.bin") bytes)"
                else
                    fail "HLS newest segment: http=$scode"
                fi
            fi
        else
            fail "HLS media playlist lists no segments"
        fi

        # Whole-chain decode through ffmpeg is the authoritative check.
        hdec="$(timeout $((PROBE_SECS + 60)) ffmpeg -hide_banner -v error \
            -i "$MASTER" -t "$PROBE_SECS" -f null - 2>&1 || true)"
        if [ -z "$hdec" ]; then
            pass "HLS end-to-end: ${PROBE_SECS}s decoded clean"
        else
            fail "HLS end-to-end decode: $(printf '%s' "$hdec" | head -1)"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# WebRTC: WHEP offer/answer plus ICE candidate inspection
# ---------------------------------------------------------------------------
header "WebRTC (8889)"
if skipped webrtc; then skip "WebRTC"; else
    cat > "$WORK/offer.sdp" <<'SDP'
v=0
o=- 0 0 IN IP4 0.0.0.0
s=-
t=0 0
a=group:BUNDLE 0
m=video 9 UDP/TLS/RTP/SAVPF 102
c=IN IP4 0.0.0.0
a=rtcp-mux
a=ice-ufrag:verify01
a=ice-pwd:verify0123456789abcdefghij
a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF
a=setup:actpass
a=mid:0
a=recvonly
a=rtpmap:102 H264/90000
a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
SDP
    # CRLF line endings: some SDP parsers are strict about this.
    sed -i 's/$/\r/' "$WORK/offer.sdp"

    wcode="$(curl -sS -o "$WORK/answer.sdp" -w '%{http_code}' --max-time 25 \
        -X POST -H 'Content-Type: application/sdp' \
        --data-binary @"$WORK/offer.sdp" \
        "https://$TS_HOST:8889/$TS_STREAM/whep" || echo 000)"

    if [ "$wcode" = "201" ]; then
        pass "WebRTC WHEP: http=201 Created"
        ncand="$(grep -c '^a=candidate' "$WORK/answer.sdp" || true)"
        if [ "${ncand:-0}" -gt 0 ]; then
            pass "WebRTC ICE: $ncand candidate(s) offered"
            grep -oE 'candidate:[^ ]+ [0-9]+ (udp|tcp) [0-9]+ [0-9.]+ [0-9]+ typ [a-z]+' "$WORK/answer.sdp" \
                | sed 's/^/       /' >&2 || true
            if [ -n "$EXPECT_EIP" ]; then
                if grep -q "$EXPECT_EIP" "$WORK/answer.sdp"; then
                    pass "WebRTC ICE advertises expected address $EXPECT_EIP"
                else
                    fail "WebRTC ICE does not advertise $EXPECT_EIP (clients behind NAT will fail)"
                fi
            fi
        else
            fail "WebRTC ICE: no candidates in answer"
        fi
        # NOTE: this stops at SDP + ICE. Completing DTLS/SRTP needs a real
        # WebRTC stack, so actual media delivery over WebRTC is NOT proven here.
        warn "     WebRTC media delivery unverified: DTLS/SRTP needs a real client"
    else
        body="$(head -c 200 "$WORK/answer.sdp" 2>/dev/null || true)"
        fail "WebRTC WHEP: http=$wcode $body"
    fi
fi

# ---------------------------------------------------------------------------
header ""
info "════════════════════════════════════════"
info "  passed: $PASS   failed: $FAIL   skipped: $SKIPPED"
if [ $FAIL -gt 0 ]; then
    err ""
    err "Failures:"
    for f in "${FAILURES[@]}"; do err "  - $f"; done
    exit 1
fi
ok ""
ok "All checks passed for $TS_STREAM on $TS_HOST"
