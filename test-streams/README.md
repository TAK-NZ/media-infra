# Stream test harness

Generates a synthetic drone video feed, publishes it to a deployed media-infra
stack, and verifies that every advertised protocol actually delivers media.

Three scripts:

| Script | Purpose |
|---|---|
| `fetch.sh` | Download a catalogued source and normalise it into a DJI-like H.264 asset |
| `publish.sh` | Push one or more assets to a stream over RTMP, looping continuously |
| `verify.sh` | Probe RTSP, RTMP, SRT, HLS and WebRTC and fail if any is not serving |

## Quick start

```bash
cd test-streams

# Build the default aerial clip (~17 MiB download, a few seconds to encode)
./fetch.sh

# Publish it on a loop to a stream UUID from CloudTAK
./publish.sh <stream-uuid>

# In another shell, verify every protocol
./verify.sh <stream-uuid> --expect-eip <webrtc-elastic-ip>
```

To loop through all four aerial clips as one continuous feed:

```bash
./fetch.sh --all
./publish.sh <stream-uuid> --all-drone
```

Requires `ffmpeg`, `ffprobe`, `jq`, `curl` and `unzip`. On Ubuntu:
`sudo apt-get install -y ffmpeg jq unzip curl`.

## Why the source has to be a push protocol

The stream must exist in MediaMTX before any of this works, and that depends on
how the stream is configured in CloudTAK.

`syncPaths()` in `docker-container/lib/persist.ts` skips MediaMTX path creation
whenever the configured source is an HTTP(S) URL:

```ts
if (isHLSPath(path.proxy)) {
    // We use the HLS proxy for existing HLS streams
    continue;
}
```

So a stream whose source is an `.m3u8` URL is served by the Node HLS proxy,
which fetches the origin directly and never involves MediaMTX. HLS works; RTSP,
RTMP, SRT and WebRTC all return `path is not configured` because no path exists.

Create the stream **without** an HTTP source so this harness can publish into it.
The two error messages tell you which situation you are in:

| WHEP response | Meaning |
|---|---|
| `path '<uuid>' is not configured` | No MediaMTX path. Source is an HTTP/HLS URL, or the stream does not exist. |
| `no stream is available on path '<uuid>'` | Path exists, nothing publishing yet. Run `publish.sh`. |

This is also the reason the harness matters: an `.m3u8` source exercises one code
path, and a real drone exercises a completely different one.

## Sources

`sources.json` is the catalogue. `./fetch.sh --list` prints it.

| id | Content | Duration | Fetch |
|---|---|---|---|
| `drone-night-city` | Night flight over a city (default) | 30.5s | ~17 MiB |
| `drone-winter-town` | Snowy mill town, 59.94fps source | 25.8s | ~14 MiB |
| `drone-city-rooftops` | Sunny European city, 1.9:1 crop, 23.976fps | 20.5s | ~11 MiB |
| `drone-arid-coast` | Remote coastline with surf | 31.1s | ~16 MiB |

All four are royalty-free stock from
[dronestock.com](https://dronestock.com/), delivered over Mux. They are chosen to
stress different parts of the encoder:

- **night-city** is the low-light case: many small point lights over large dark
  areas, which is where a rate-limited encoder struggles most.
- **winter-town** is the fine-detail case: snow, bare branches and parked cars,
  at double the frame rate of the others.
- **city-rooftops** is high-contrast daylight, and the only non-16:9 source, so
  it exercises letterboxing.
- **arid-coast** is the opposite extreme: mostly flat sand, sky and water, where
  a CBR encoder has bits to spare and should look clean. Longest clip, so it is
  the best single source for a soak test.

### Licensing

**No media is committed to this repository.** `media/` is gitignored and every
asset is fetched on demand.

Royalty-free covers *use*, not redistribution of the raw asset, so the `drone-*`
clips are marked `redistributable: false` and `fetch.sh` warns when it pulls one.
Fetch them locally; do not commit them, bake them into a container image, publish
them, or pull them from CI.

Every source in the catalogue now falls into that category, so **nothing here is
safe to pull from CI**. Big Buck Bunny previously filled that role under CC-BY,
but as synthetic animation it said little about how the pipeline handles a drone
feed. If a CI-safe source is needed later, add one with `redistributable: true`
rather than reaching for these.

## Encoder profiles

Sources are normalised rather than streamed as-is, for two reasons: `publish.sh`
can then push with `-c copy` (the bitstream on the wire is exactly what was
encoded, and looping costs almost no CPU), and clips built at the same profile
are concat-compatible so they can be chained into a playlist.

| Profile | Resolution | Bitrate | Approximates |
|---|---|---|---|
| `dji-hd` (default) | 1920x1080 @30 | 6000k CBR | Pilot 2 / Dock default livestream |
| `dji-sd` | 1280x720 @30 | 3000k CBR | Constrained 4G uplink |
| `dji-smooth` | 854x480 @30 | 1000k CBR | Worst-case uplink |

All profiles use a fixed 2s GOP, no B-frames, `-nal-hrd cbr` and AAC-LC 48 kHz
stereo. The fixed GOP and absent B-frames are what make the output resemble a
hardware drone encoder rather than a file transcode; scene-cut detection is
disabled so keyframe spacing is genuinely constant.

### Audio

Assets are **video-only by default**. ATAK plays whatever audio track it is
given, so anything embedded here is audible to the operator as a hum or beep. A
test feed should be silent unless audio is what you are testing.

| `TS_AUDIO` | Result |
|---|---|
| `silent` (default) | No audio stream at all (`-an`) |
| `tone` | 440 Hz reference tone, useful to prove the audio path end to end |
| `source` | Keep the source's own audio, falling back to video-only if it has none |

The mode is part of the asset filename (`<source>.<profile>.<mode>.mp4`) so
switching modes cannot silently reuse an asset built the other way.

```bash
./fetch.sh drone-arid-coast dji-sd     # specific source and profile
TS_AUDIO=tone ./fetch.sh               # embed the reference tone
TS_DURATION=10 ./fetch.sh              # cap the asset length
TS_FORCE=1 ./fetch.sh                  # re-encode even if cached
```

## Verification

`verify.sh` exits non-zero if any check fails, so it is usable as a gate.

It decodes frames rather than only checking that a connection succeeds, because
the failure this harness exists to catch is a protocol that negotiates cleanly
and then serves nothing. It also asserts that HLS playlists are sent
uncacheable, and that WebRTC ICE advertises the Elastic IP rather than a private
address.

```bash
./verify.sh <uuid>                                  # all protocols
./verify.sh <uuid> --expect-eip 203.0.113.10        # assert the ICE address
./verify.sh <uuid> --skip webrtc,srt                # subset
./verify.sh <uuid> --probe-secs 15                  # decode longer
```

### What it does not prove

WebRTC is checked only as far as the WHEP offer/answer and the ICE candidate
list. Completing DTLS/SRTP needs a real WebRTC stack, so **actual media delivery
over WebRTC is not verified** — the script prints a warning saying so. Confirm it
in a browser against `https://<host>:8889/<uuid>`.

RTSP negotiation logs `461 Unsupported Transport` before succeeding. That is
expected: `mediamtx.yml` sets `rtspTransports: [tcp]`, so ffmpeg's initial UDP
`SETUP` is refused and it falls back to TCP. It costs one round trip per connect
and is harmless.

## Publishing options

```bash
./publish.sh <uuid> --once drone-night-city      # single pass instead of looping
./publish.sh <uuid> --profile dji-sd             # lower tier
./publish.sh <uuid> --protocol srt               # ingest over SRT instead of RTMP
./publish.sh <uuid> /path/to/your.mp4            # a file, bypassing the catalogue
```

### Targeting another environment

Both `publish.sh` and `verify.sh` accept a full feed URL in place of a bare UUID,
and take the host from it. A URL also determines the protocol, overriding
`--protocol`, since silently ignoring the scheme the caller typed would be
surprising.

```bash
./publish.sh rtmp://media.demo.tak.nz:1935/<uuid> --all-drone
./publish.sh 'srt://media.demo.tak.nz:8890?streamid=publish:<uuid>'
./verify.sh  https://media.demo.tak.nz:8889/<uuid>
```

`--host` still works for the bare-UUID form. Quote SRT URLs: the `?` and `&` are
shell metacharacters.

Ingest defaults to RTMP on port 1935 because that is what DJI aircraft actually
use. Per DJI's SDK documentation, MSDK v5 supports RTMP (not RTMPS), GB28181,
RTSP and Agora, while v4 is RTMP-only. Port 1935 on the NLB is a plain TCP
listener, so unencrypted RTMP ingest works; the TLS variants sit on 1936 (RTMPS)
and 8555 (RTSPS).

Passing a file directly is the escape hatch for footage that cannot be
catalogued. It must already match the profile's codec parameters for `-c copy`
to work; if in doubt, normalise it with `fetch.sh` semantics first.

## Notes on the implementation

Two things in `fetch.sh` are deliberate and worth not "simplifying":

The encode is bounded by an explicit `-t` derived from the probed source
duration. `-shortest` alone is not dependable here: with a filter graph and two
inputs it does not reliably propagate EOF from the video input, and because the
synthesised tone is an infinite `lavfi` source the encode then runs forever,
growing the output until the disk fills. This was observed — some clips
terminated correctly and one did not.

Cached assets are validated by probing for a decodable duration, not by checking
that the file exists. An interrupted encode leaves a file with no `moov` atom,
and silently reusing it produces a confusing failure in `publish.sh` far from the
actual cause.

## Deployments and this harness

The service is single-instance: a published stream lives in one MediaMTX process
with no clustering, and the NLB target groups are attached to the Auto Scaling
Group rather than to task placement. Every ASG instance is therefore a registered
target whether or not it runs the task.

That matters when reading a failed run. During a deployment ECS may briefly place
the new task on a second instance while the old one is still registered, and for
the length of one health-check window the load balancer will balance onto an
instance with nothing listening. `verify.sh` reports that as connection refused or
empty replies on some protocols but not others, which looks alarming and is
transient. Re-run it once the ASG has settled back to a single instance.

`maxCapacity` is pinned to 1 to keep that window from opening at all. The tradeoff
is that deployments become a hard cutover rather than a rolling replacement, so
the publisher has to reconnect. That is preferable to silently failing half of
all client connections, but it is a tradeoff rather than a free win.
