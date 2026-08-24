# CHANGELOG

## Emoji Cheatsheet
- :pencil2: doc updates
- :bug: when fixing a bug
- :rocket: when making general improvements
- :white_check_mark: when adding tests
- :arrow_up: when upgrading dependencies
- :tada: when adding new features

## Version History

### Pending Release

#### Pin the container instance count to one

The Auto Scaling Group allowed two instances while only one MediaMTX task ever
runs. Because the NLB target groups are attached to the ASG rather than to task
placement, the second instance was registered as a target for all six listeners
without running the task, and the load balancer balanced onto it. Roughly half of
all client connections failed — observed in practice during a deployment as
connection refused on RTMP, I/O errors on SRT and empty replies on HLS and WebRTC,
while RTSP happened to hit the good target.

- :bug: Set `maxCapacity` to 1 for both environments; a stream exists only on the MediaMTX process it was published to, so a second instance cannot serve it
- :bug: Reject `maxCapacity > 1` in `validateEnvConfig` so the constraint cannot regress through a context override
- :white_check_mark: Add validation coverage for the capacity rule

> [!NOTE]
> This makes deployments a hard cutover rather than a rolling replacement, so a
> publisher must reconnect afterwards. That is a deliberate tradeoff: the
> alternative silently black-holes about half of all client connections for the
> length of a health-check window.

#### Let the ECS service replace its task

The service asked for `minHealthyPercent: 100` / `maxHealthyPercent: 200`, which
requires two tasks to run concurrently during a deployment. That is impossible
here and deadlocks the update:

- The task uses `host` network mode, so it exclusively owns host ports 1935, 8554,
  8889, 8890, 9996, 9997 and 8189. A second task cannot be placed beside it.
- With the instance count pinned to one there is nowhere else to place it. A
  `t4g.large` registers 7813 MiB and the running task holds 4096 MiB, leaving
  3717 MiB, so ECS fails placement with `TaskFailedToStart: RESOURCE:MEMORY`
  before it even reaches the port conflict.

ECS therefore retried placement indefinitely while refusing to stop the task
holding the resources, leaving CloudFormation in `UPDATE_IN_PROGRESS`.

Holding the old task open never protected streams in any case: a stream lives
inside the single MediaMTX process it was published to and there is no session
migration, so publishers are dropped by the cutover regardless.

- :bug: Set `minHealthyPercent: 0` and `maxHealthyPercent: 100` so the old task is stopped before the replacement starts
- :bug: Disable Availability Zone Rebalancing. ECS rejects `maximumPercent <= 100` while it is on, and it defaults to on for new services. There is nothing for it to do here: a single task on a single instance has no uneven AZ distribution to correct, and letting ECS move the task between AZs is the instance churn this stack is trying to avoid
- :white_check_mark: Update the deployment-safety test to assert stop-then-start

#### Build pre-built images for ARM64

The CI image build was still targeting `linux/amd64` while the EC2 migration moved
the service onto Graviton (`t4g`) instances. A deploy with
`usePreBuiltImages=true` therefore pulled an amd64 image onto an ARM64 host and
every task died immediately:

```
exec /start: exec format error
Container "MediaMtxContainer" exited with code 255
```

Three tasks failed in a row, the deployment circuit breaker tripped, and the
stack rolled back. The CDK-built path was never affected because it already sets
`platform: ecrAssets.Platform.LINUX_ARM64`; only the workflow was left behind.

- :bug: Build with `--platform linux/arm64` in both the demo and production image workflows
- :bug: Switch from `docker build` to `docker buildx build`. This is required rather than cosmetic: the Dockerfile pins its builder stages with `--platform=$BUILDPLATFORM`, which only BuildKit populates — under the classic builder it expands to nothing
- :bug: Add `docker/setup-qemu-action`, needed for the stages that must execute target-architecture binaries. The Go and npm builds run natively on the amd64 runner and cross-compile, so emulation is limited to the final stage
- :bug: Pass `MEDIAMTX_BASE_IMAGE` and `MEDIAMTX_BRANCH` build args, which the workflow omitted, so a pre-built image and a CDK-built image are now the same artefact rather than silently diverging from the configured version
- :bug: Bump `mediamtx.buildRevision` to 2 in both environments. The workflow skips the build when the tag already exists, so the existing amd64 `mediamtx-1.19.0-r1` images would otherwise be reused and the failure would repeat
- :rocket: Push via `buildx --push` instead of a separate `docker push`, which writes the manifest correctly for a single-platform build

#### Scope the Docker build context

The container asset is defined with `directory: '.'` and there was no
`.dockerignore`, so the entire repository was both shipped to the Docker daemon
and folded into the asset fingerprint. Two consequences: builds transferred
hundreds of megabytes they never read, and any unrelated edit changed the image
hash, producing a new task definition and an unnecessary container restart on the
next deploy. Running `test-streams/fetch.sh` was enough to do it, because the
fetched video lands inside the build context.

- :rocket: Add `.dockerignore`, reducing the staged build context from 458 MiB to 244 KiB. Only `docker/media-infra/Dockerfile` and `docker-container/` are sent, which is all the Dockerfile reads
- :rocket: Editing `test-streams/` or fetching test media no longer changes the container image hash, while changes under `docker-container/` still do

> [!NOTE]
> This changes the image hash once, so the next deploy rebuilds and replaces the
> task. Verified by building the staged context for `linux/arm64`: every layer
> cached against the previous full-context build, confirming the copied content is
> byte-identical.

#### Tighten health check timings

The AWS defaults (30s interval, threshold 3) give 90 seconds in each direction.
That matters whenever more than one instance is registered: a replacement is not
servable for 90s after its task is ready, and an instance that has lost its task
keeps receiving traffic for 90s. The second case was observed black-holing
roughly half of all client connections during a deployment.

- :rocket: Target group health checks move to a 10s interval, 5s timeout and both thresholds at 2, shrinking each window to about 20s. Thresholds are kept equal, which NLB has historically required
- :rocket: Container health check interval drops from 30s to 10s. The container serves about a second after start, but a 30s interval delayed the first probe to t+30 and left ECS over a minute from steady state. This does not change client-visible downtime, since the target groups attach to the ASG rather than the service, but it decides how quickly the deployment circuit breaker reacts to a broken image
- :pencil2: `startPeriod` stays at 60s deliberately: a success inside the start period marks the container healthy immediately, so a generous value costs nothing when startup is fast while still covering a cold image pull

#### Fix HLS playlist caching

Live HLS playlists were served with no `Cache-Control` while Express stamped a
weak `ETag` onto every body. Nothing told the client the playlist was volatile,
and the validator actively invited revalidation. Tolerant players (hls.js, and so
CloudTAK's own player) ride through this by polling again when the media sequence
has not advanced, but native players stall at the live edge after 10-15 seconds
and then need several reloads to recover.

- :bug: Send `Cache-Control: no-store, no-cache, must-revalidate` on HLS manifests, and suppress the `ETag` by using `res.end` rather than `res.send`
- :bug: Stop forwarding `if-none-match` / `if-modified-since` / `if-range` upstream when fetching a playlist we rewrite — upstream's validators do not describe our rewritten body, and a 304 from upstream surfaced to the client as a 500
- :bug: Reduce the signed segment URL TTL from 10 minutes to 120 seconds. A typical live window retains only ~90s of segments, so a paused client resumed with a still-valid token pointing at segments the origin had already deleted, and got an opaque upstream 404 instead of a clean expiry
- :bug: Tie the resource cache TTL to the signed URL TTL (plus a 60s margin) so the token is always what expires first, producing a 403 rather than a misleading 404

#### Add stream test harness

- :tada: Add `test-streams/` — generates a DJI-like drone feed, publishes it on a loop, and verifies that all five protocols actually deliver media
- :white_check_mark: `verify.sh` decodes frames on RTSP, RTMP, SRT and HLS, walks the full HLS master → media → segment chain, asserts playlists are uncacheable, and checks WebRTC ICE advertises the Elastic IP. Exits non-zero on failure
- :rocket: `fetch.sh` normalises sources to a shared profile (H.264 Main, fixed 2s GOP, no B-frames, `-nal-hrd cbr`, AAC-LC 48 kHz) approximating DJI's HD / SD / Smooth uplink tiers
- :rocket: `publish.sh` chains several clips through the concat demuxer with `-c copy` for a continuous looping feed
- :rocket: Assets are video-only by default. ATAK plays any audio track it receives, so an embedded reference tone is audible to the operator; `TS_AUDIO=tone` opts back in when the audio path is what is being tested
- :rocket: Drop the Big Buck Bunny source now that real aerial footage is catalogued; as synthetic animation its motion said little about how the pipeline handles a drone feed. Note that no remaining source is redistributable, so none should be pulled from CI
- :rocket: `publish.sh` and `verify.sh` accept a full feed URL in place of a bare UUID, so another environment needs no extra flags
- :pencil2: Document why an `.m3u8` source cannot exercise RTSP/RTMP/SRT/WebRTC: `syncPaths()` skips MediaMTX path creation for HTTP sources, so those streams are served by the Node proxy and no MediaMTX path exists

> [!NOTE]
> No test media is committed. The drone clips are royalty-free stock from
> dronestock.com and are fetched on demand into the gitignored
> `test-streams/media/`.

### v10.0.0 - 2026-08-23

> [!WARNING]
> This release moves the media service from Fargate to EC2 with `host` network
> mode. The change is not backwards compatible:
>
> - **A dedicated ECS cluster is created by this stack.** The shared BaseInfra
>   cluster is Fargate-only and cannot host EC2 capacity providers.
> - **MediaMTX's HLS listener (8888) is no longer publicly reachable.** It binds to
>   loopback and is served through the authenticated proxy on 9997. Clients using
>   `:8888` directly must move to `:9997`.
> - **Container instances run in public subnets** and require ARM64 (Graviton)
>   instance types to match the image architecture.
> - **A new `WebRtcIceIp` output exposes an Elastic IP** used solely as the WebRTC
>   ICE address. It is not published in DNS.

#### Move from Fargate to EC2 with host networking

WebRTC ICE needs direct UDP connectivity between client and server. Fargate's
`awsvpc` networking cannot provide that path, which is why the previous release
had to ship with WebRTC disabled. `host` network mode on EC2 removes that
constraint.

- :tada: Enable WebRTC end to end — signalling on 8889 plus ICE on 8189 over UDP with TCP fallback
- :rocket: Replace `FargateTaskDefinition`/`FargateService` with `Ec2TaskDefinition`/`Ec2Service` using `NetworkMode.HOST`
- :rocket: Add EC2 capacity: dedicated ECS cluster, explicit `AWS::EC2::LaunchTemplate`, Auto Scaling Group and ECS capacity provider with managed scaling
- :rocket: Build the container image for ARM64 (Graviton) and validate that the configured instance type is a Graviton family

#### Split the client path in two

Everything except ICE stays behind the load balancer. ICE alone needs a direct
route, so it gets a static Elastic IP on the instance.

- :rocket: The load balancer terminates TLS for RTMPS (1936), RTSPS (8555), playback (9996), WebRTC signalling (8889) and the API/HLS proxy (9997), and passes SRT (8890) through unmodified since SRT encrypts itself
- :rocket: Add an Elastic IP used solely as the WebRTC ICE address. The instance associates it at boot and MediaMTX advertises it as an ICE candidate, so it never appears in DNS — clients receive it inside the WebRTC negotiation
- :rocket: Pass the ICE address in from CDK rather than reading instance metadata, which would otherwise race the boot-time association and could advertise the instance's ephemeral public address
- :rocket: Attach target groups to the Auto Scaling Group rather than the ECS service, which sidesteps the ECS limit of five target groups per service. Health checks probe the API port, so a target whose task is not running is still marked unhealthy

#### Keep TLS out of the container

The load balancer integrates with ACM natively, so the shared BaseInfra
certificate is used as-is and the container holds no certificate material.

- :rocket: Every MediaMTX listener and the Node API server are plaintext; TLS terminates at the load balancer and forwards decrypted traffic inside the VPC
- :rocket: The container carries no certificate handling code, no ACM permissions on the task role, and no certificate tooling in the image

#### Reduce network exposure

- :rocket: Bind MediaMTX's HLS listener and control API to loopback; the only path to HLS is the proxy on 9997, which enforces lease authorisation and rewrites manifests to signed URLs
- :rocket: The instance accepts non-ICE ports only from the load balancer's security group. ICE is the single port open to the internet on the instance itself
- :rocket: `enableInsecurePorts` now governs whether the plaintext RTMP/RTSP ingest listeners exist at all

#### Reliability and correctness

- :bug: Enable `ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST` on the container instance. Task IAM roles are off by default under `host` network mode, so without this the container receives no task credentials and EFS IAM authorisation fails
- :bug: Fix the MediaMTX build's architecture smoke test, which read `go env GOARCH` after that variable had been overridden for cross-compilation. The check always believed the binary was natively runnable and tried to execute an ARM64 binary on the build host
- :bug: Fix EFS being destroyed on stack deletion in production — the removal policy was hardcoded and now follows `general.removalPolicy`
- :bug: Fix `npx cdk` resolving to the CDK app instead of the CDK CLI; `package.json` declared a `bin` entry named `cdk` that shadowed the real CLI once `bin/cdk.js` had been compiled
- :bug: Fix npm deploy/synth/diff scripts passing `--context environment=` when the app reads `envType=`
- :rocket: Hold full capacity through deployments (`MinimumHealthyPercent: 100`) and enable the deployment circuit breaker with rollback; a restarting media server drops every in-flight stream
- :rocket: Tune UDP socket buffers on the host so MediaMTX gets large buffers from the OS default, avoiding the `setsockopt` failure that previously killed the container
- :rocket: Move the EFS mount to `/opt/mediamtx`. Mount targets stay in the private subnets — they are per Availability Zone rather than per subnet, so one serves every instance in that AZ regardless of which subnet the instance sits in
- :rocket: Build the final image stage with no `RUN` steps at all. Commands there execute as the target architecture, which cannot run when cross-building for ARM64 from an x86-64 host without QEMU binfmt handlers
- :rocket: Propagate service tags to tasks and enable enhanced Container Insights in both environments
- :rocket: Make MediaMTX log level configurable per environment and overridable from the CLI

#### Tests

- :white_check_mark: Add `media-infra-synth.test.ts` — 36 assertions against the synthesised template covering host networking, TLS termination per port, target group wiring, the ICE path bypassing the load balancer, network exposure, deployment configuration and EFS retention
- :white_check_mark: Remove tests that asserted on local literals rather than real behaviour

#### Dependencies

- :arrow_up: `aws-cdk-lib` 2.266.0, `aws-cdk` 2.1138.0, `constructs` 10.8.1, `jest` 30.4.2, `ts-jest` 29.4.12, `@types/node` 26.2.0
- :arrow_up: Container: `typescript` 7.0.2, `undici` 8.10.0, `uuid` 14.0.2, `eslint` 10.9.0, `@openaddresses/batch-schema` 10.27.0, `@sinclair/typebox` 0.34.52, `node-cron` 4.6.0, `tsx` 4.23.12
- :arrow_up: Root TypeScript held at 6.0.3; `ts-jest` requires `typescript <7`
- :arrow_up: `npm audit` reports no vulnerabilities in either package

### v9.5.0 - 2026-07-02

- :arrow_up: Update MediaMTX to v1.19.0 (multi-stage Docker build from source)
- :tada: Add internal MediaMTX auth endpoint (`127.0.0.1:9995`) with 5-minute in-memory cache to reduce CloudTAK API load
- :tada: Enable WebRTC support — NLB listeners, security group rules, and ECS port mappings for ports 8889 (TCP) and 8189 (UDP/TCP)
- :tada: Add ACM certificate export support — container fetches TLS cert at startup via `ACM_CERTIFICATE_ARN` and enables WebRTC encryption
- :rocket: Add `ACM_CERTIFICATE_ARN` environment variable to ECS task definition; grant task role ACM export permissions
- :rocket: Rewrite `start` script from bash to POSIX sh; replace `yq` dependency with `sed`; use `exec /mediamtx` for proper PID 1
- :rocket: Switch to multi-stage Dockerfile — TypeScript compiled at build time, no `tsx` runtime needed, Node 24
- :rocket: HLS proxy now supports HEAD requests, `Range`/conditional request headers, streaming pipeline (no full-segment buffering), and abort-on-disconnect
- :rocket: Manifest rewriting uses SHA-256 hashes instead of random UUIDs for deterministic signed URLs; adds LL-HLS tag support (`#EXT-X-PART`, `#EXT-X-PRELOAD-HINT`)
- :bug: Fix do-while pagination off-by-one in `listMediaMTXPathsMap` and `listCloudTAKPaths`
- :bug: Remove `any` casts in proxy and response streaming; narrow `verifySignedUrl` return type
- :arrow_up: Update `undici` to v8, `uuid` to v14, `eslint` to v10, `typescript` to v6
- :arrow_up: Remove unused `axios` dependency from docker-container
- :white_check_mark: Update ECS mocked test to include WebRTC target groups

### v8.4.0 - 2025-12-29

- :arrow_up: Update MediaMTX to v1.15.6

### v8.3.1 - 2025-12-16

- :arrow_up: Update MediaMTX to v1.15.5
- :tada: Add complete Node.js API server with Express
- :tada: Add HLS manifest proxying and rewriting
- :tada: Add JWT-based signed URL generation
- :rocket: Migrate from CLOUDTAK_URL to API_URL environment variable
- :rocket: Enhanced persistence logic with better error handling
- :rocket: Add MediaMTX API proxying routes
- :rocket: Add authentication middleware
- :rocket: Improved sync frequency (every 10 seconds)

### v8.3.0 - 2025-12-15

- :rocket: Migrate Signing to use JsonWebTokens
- :white_check_mark: Add automated CI tests for manifest generation

### v8.2.0 - 2025-12-12

- :bug: Proxy all HLS requests to ensure Authentication data isn't lost on redirects

### v8.1.0 - 2025-12-10

- :bug: Resilient Startup
- :arrow_up: MediaMTX@1.15.5

### v8.0.1 - 2025-11-25

- :rocket: Add additional logging on API Failures

### v8.0.0 - 2025-11-25

> ![!WARNING]
> This version introduces breaking changes to the API_URL environment variable.
> Previously the Media Server expected the full URL including the `/api` prefix.
> From this version onwards, only the base URL should be provided.

- :rocket: Don't expect `/api` prefix in the API_URL

### v7.2.0 - 2025-11-20

- :arrow_up: Update to MediaMTX@1.15.4

### v7.1.0 - 2025-11-18

- :tada: Support additional HLS Streams in proxy

### v7.0.2 - 2025-11-13

- :bug: Fix circular API dependency

### v7.0.0 - 2025-11-13

> [!WARNING]
> This version introduces breaking changes to the Proxy API and HLS Proxying support.
> CloudTAK@12 and above is required to use this version.

- :rocket: Complete NodeJS Proxy API as well as HLS Proxying support

### v6.1.0 - 2025-11-06

- :rocket: Introduce NodeJS Proxy API to intercept and trigage config updates in a future version

### v6.0.0 - 2025-09-22

> [!WARNING]
> The `CLOUDTAK_URL` Env Var is now called `API_URL` for consistency across all CloudTAK services.

### v5.2.0 - 2025-09-22

- :arrow_up: Update MediaMTX@1.15.0

### v5.1.0 - 2025-08-10

- :rocket: Support removing expired leases from the config

### v5.0.0 - 2025-08-10

- :tada: Remove all on disk config in favour of API based sync with the upstream CloudTAK service

### v4.5.0 - 2025-08-09

- :rocket: Change to RunOnInit

### v4.4.0 - 2025-08-09

- :rocket: Allow overriding Health Check Ports/Protocols

### v4.3.0 - 2025-08-08

- :rocket: Use `runOnDemand` with `ffmpeg` for more reliable external stream ingestion

### v4.2.0 - 2025-08-04

- :arrow_up: Update `mediamtx@1.13.1`
  
### v4.1.0 - 2025-07-07

- :arrow_up: Update `mediamtx@1.13.0`

### v4.0.3 - 2025-06-24

- :rocket: Fix diff generation for config

### v4.0.2 - 2025-06-24

- :rocket: Use unified limit value

### v4.0.1 - 2025-06-24

- :rocket: Fix paging bug in config

### v4.0.0 - 2025-06-12

- :rocket: Migrate to VPC-2.0

### v3.4.0 - 2025-06-09

- :arrow_up: Update to MediaMTX@1.12.3

### v3.3.4 - 2025-04-29

- :bug: Remove process.env.Environment requirement from persist

### v3.3.3 - 2025-04-17

- :tada: Second GHR test

### v3.3.2 - 2025-04-17

- :tada: Second GHR test

### v3.3.1 - 2025-04-17

- :tada: Initial GHR test

### v3.3.0 - 2025-04-14

- :tada: Update MediaMTX@1.12

### v3.2.0

- :tada: Enable Playback API by default

### v3.1.0

- :bug: Small bugs in path generation & diff comparison

### v3.0.0

- :tada: Reverse the management of state, instead checking CloudTAK for a list of Video Leases

### v2.21.0

- :rocket: Add Playback List

### v2.20.1

- :arrow_up: Update Core Deps

### v2.20.0

- :rocket: Ensure `management` User is retained

### v2.19.0

- :arrow_up: Update `mediamtx@1.11.2`

### v2.18.0

- :white_check_mark: Add basic tests of persist script
- :tada: Explicitly add path names to `any` user if there is not another user controlling their access

### v2.17.0

- :arrow_up: Update MediaMTX to `v1.11.1`
- :bug: Fix Lints

### v2.16.0

- :bug: Change DependsOn Strategy

### v2.15.0

- :rocket: Lock to SubnetA for time being to ensure a single EIP can be used for access

### v2.14.0

- :arrow_up: Update `MediaMTX@1.10.0`

### v2.13.1

- :bug: UDP Ports health check on alternate service

### v2.13.0

- :tada: Perform JSON Diff before writing config file if a diff has been detected.
- :rocket: Setup TS Build step and enable in GH Actions
- :rocket: Health Check each individual port/protocol
- :tada: Enable SRT by default

### v2.12.0

- :rocket: Finish persistance script

### v2.11.0

- :rocket: Add persistance script

### v2.10.0

- :rocket: Add KMS Key Alias

### v2.9.1

- :bug: Flip Resource name

### v2.9.0

- :rocket: Remove unused AWS Secret

### v2.8.0

- :rocket: Add RTMP

### v2.7.1

- :bug: Fix bug in password setting

### v2.7.0

- :rocket: Use password from Secret Store

### v2.6.0

- :rocket: Support for proxying HLS Streams

### v2.5.0

- :rocket: Consistent API responses

### v2.4.0

- :rocket: Expose all ports dynamically via PORTS array

### v2.3.0

- :tada: Load Initial Config if one doesn't exist otherwise load from volume

### v2.2.0

- :tada: Add Secret for future API Access

### v2.1.0

- :tada: Add TLS Certificate for API

### v2.0.0

- :rocket: Build out ECS Service
- :tada: **Breaking** Seperate TaskDefinition between `-task` & `-service`

### v1.4.0

- :rocket: Expose API Port
- :tada: Setup EFS for persisant config

### v1.3.0

- :rocket: Deploy behind ELB as ECS Service

### v1.2.0

- :rocket: Cut down config table

### v1.1.0

- :rocket: Add Custom Config File

### v1.0.1

- :rocket: Add releaser

### v1.0.0

- :rocket: Initial Release

