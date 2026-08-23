ARG BUILDPLATFORM
ARG MEDIAMTX_BASE_IMAGE=bluenviron/mediamtx:1.19.0-ffmpeg
ARG MEDIAMTX_REPO=https://github.com/bluenviron/mediamtx.git
ARG MEDIAMTX_BRANCH=v1.19.0

FROM --platform=$BUILDPLATFORM node:24-alpine AS app-builder

WORKDIR /app

COPY docker-container/package.json docker-container/package-lock.json docker-container/tsconfig.json ./
RUN npm ci

COPY docker-container/index.ts ./
COPY docker-container/lib/ ./lib/
COPY docker-container/routes/ ./routes/

RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS node-runtime

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS mediamtx-builder

ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
ARG MEDIAMTX_REPO
ARG MEDIAMTX_BRANCH

RUN apk add --no-cache file git

WORKDIR /build
RUN git clone --depth 1 --branch "${MEDIAMTX_BRANCH}" "${MEDIAMTX_REPO}" .
RUN set -eux; \
	echo "v0.0.0-custom" > internal/core/VERSION; \
	go generate ./...; \
	# Capture the builder's own platform before GOOS/GOARCH are overridden for
	# cross-compilation, so the smoke test below can tell whether the resulting
	# binary is actually executable here.
	hostos="$(go env GOOS)"; \
	hostarch="$(go env GOARCH)"; \
	targetos="${TARGETOS:-$hostos}"; \
	targetarch="${TARGETARCH:-$hostarch}"; \
	targetvariant="${TARGETVARIANT:-}"; \
	export CGO_ENABLED=0 GOOS="${targetos}" GOARCH="${targetarch}"; \
	goarm="${targetvariant#v}"; \
	if [ "${targetarch}" = "arm" ]; then export GOARM="${goarm:-7}"; fi; \
	go build -tags enable_upgrade -trimpath -ldflags="-s -w" -o /mediamtx .; \
	file /mediamtx; \
	case "${targetos}/${targetarch}" in \
		linux/amd64) file /mediamtx | grep -q 'ELF 64-bit.*x86-64' ;; \
		linux/arm64) file /mediamtx | grep -Eq 'ELF 64-bit.*(aarch64|ARM)' ;; \
		linux/arm) file /mediamtx | grep -q 'ELF 32-bit.*ARM' ;; \
	esac; \
	if [ "${targetos}" = "${hostos}" ] && [ "${targetarch}" = "${hostarch}" ]; then \
		/mediamtx --version; \
	else \
		echo "cross-compiled ${targetos}/${targetarch} on ${hostos}/${hostarch}; skipping version check"; \
	fi

# Final Stage
FROM ${MEDIAMTX_BASE_IMAGE}

# This stage deliberately contains no RUN steps. Its commands would execute as
# TARGETARCH, which cannot run when cross-building for ARM64 from an x86-64 host
# unless QEMU binfmt handlers are registered. Nothing needs installing: TLS is
# terminated at the load balancer, so no certificate tooling is required.

# Replace the pre-built MediaMTX binary with our source-built one
COPY --from=mediamtx-builder /mediamtx /mediamtx

# Copy a target-platform Node runtime without executing package-manager steps
COPY --from=node-runtime /usr/local/ /usr/local/

# Ports below are the plaintext listeners the load balancer forwards to. The
# TLS-fronted ports (RTMPS 1936, RTSPS 8555) terminate at the load balancer and
# are never bound by the container.

# RTMP
EXPOSE 1935

# RTSP
EXPOSE 8554

# SRT
EXPOSE 8890/udp

# Playback
EXPOSE 9996

# CloudTAK media API and HLS proxy
EXPOSE 9997

# WebRTC signalling and ICE (UDP with TCP fallback)
EXPOSE 8889
EXPOSE 8189
EXPOSE 8189/udp

COPY docker-container/mediamtx.yml /mediamtx.yml
COPY docker-container/start /start

COPY --from=app-builder /app/node_modules /node_modules
COPY --from=app-builder /app/dist /dist
COPY docker-container/package.json /dist/package.json

ENTRYPOINT [ "/start" ]
