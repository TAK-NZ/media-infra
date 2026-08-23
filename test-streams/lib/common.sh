#!/bin/bash
# Shared helpers for the media-infra stream test harness.
# Sourced by fetch.sh, publish.sh and verify.sh; not meant to run standalone.

set -euo pipefail

TS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_SOURCES="$TS_ROOT/sources.json"
TS_MEDIA="${TS_MEDIA:-$TS_ROOT/media}"

# Audio and GOP settings are deliberately shared across every encoder profile.
# publish.sh concatenates assets with -c copy, which only works when all inputs
# agree on codec, timebase, sample rate and channel layout.
TS_GOP_SECONDS=2
TS_AUDIO_CODEC="aac"
TS_AUDIO_BITRATE="128k"
TS_AUDIO_RATE=48000
TS_AUDIO_CHANNELS=2

log()  { printf '%s\n' "$*" >&2; }
info() { printf '\033[0;36m%s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[0;32m%s\033[0m\n' "$*" >&2; }
warn() { printf '\033[0;33m%s\033[0m\n' "$*" >&2; }
err()  { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

require_tools() {
    local missing=()
    for tool in "$@"; do
        command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    if [ ${#missing[@]} -gt 0 ]; then
        err "Missing required tools: ${missing[*]}"
        err "On Debian/Ubuntu: sudo apt-get install -y ffmpeg jq unzip curl"
        exit 1
    fi
}

# jq query against sources.json
sources_query() {
    jq -r "$1" "$TS_SOURCES"
}

source_ids() {
    sources_query '.sources | keys_unsorted[] | select(startswith("$") | not)'
}

profile_ids() {
    sources_query '.profiles | keys_unsorted[] | select(startswith("$") | not)'
}

source_field() {
    local id="$1" field="$2"
    sources_query ".sources[\"$id\"].$field // empty"
}

profile_field() {
    local id="$1" field="$2"
    sources_query ".profiles[\"$id\"].$field // empty"
}

assert_source_exists() {
    local id="$1"
    if [ -z "$(source_field "$id" description)" ]; then
        err "Unknown source: $id"
        err "Available sources:"
        source_ids | sed 's/^/  /' >&2
        exit 1
    fi
}

assert_profile_exists() {
    local id="$1"
    if [ -z "$(profile_field "$id" description)" ]; then
        err "Unknown profile: $id"
        err "Available profiles:"
        profile_ids | sed 's/^/  /' >&2
        exit 1
    fi
}

# Normalised asset path for a given source + profile pair.
asset_path() {
    local source_id="$1" profile_id="$2"
    printf '%s/%s.%s.mp4' "$TS_MEDIA" "$source_id" "$profile_id"
}

# Warn loudly before fetching anything we are not licensed to redistribute.
check_licence() {
    local id="$1"
    local redistributable licence
    redistributable="$(source_field "$id" redistributable)"
    licence="$(source_field "$id" licence)"

    if [ "$redistributable" != "true" ]; then
        warn "Source '$id' is not redistributable."
        warn "  $licence"
        warn "  Fetch it for local testing only. Do not commit it, bake it into an"
        warn "  image, publish it, or pull it from CI."
    fi
}

# Resolve the stream UUID and endpoint host, from args or environment.
resolve_target() {
    TS_HOST="${TS_HOST:-media.test.tak.nz}"
    if [ -z "${TS_STREAM:-}" ]; then
        die "No stream UUID set. Pass one as an argument or set TS_STREAM."
    fi
}
