# TAK Media Infrastructure

<p align=center>Modern AWS CDK v2 media streaming infrastructure for Team Awareness Kit (TAK) deployments

## Overview

The [Team Awareness Kit (TAK)](https://tak.gov/solutions/emergency) provides Fire, Emergency Management, and First Responders an operationally agnostic tool for improved situational awareness and a common operational picture. 

This repository deploys the media streaming infrastructure layer for a complete TAK deployment, providing robust MediaMTX streaming server with advanced capabilities such as RTMP, RTSP, RTMPS, RTSPS, SRT, HLS, and WebRTC protocols with CloudTAK API authentication integration - all while using [free and open source software](https://en.wikipedia.org/wiki/Free_and_open-source_software).

It is specifically targeted at the deployment of [TAK.NZ](https://tak.nz) via a CI/CD pipeline. Nevertheless others interested in deploying a similar infrastructure can do so by adapting the configuration items.

### Architecture Layers

This media infrastructure requires the base infrastructure, authentication infrastructure, TAK
infrastructure, and CloudTAK layers, each deployed as a separate stack from its own repository.

For the full layer diagram and deployment order across all TAK.NZ repositories, see the
[TAK.NZ organization overview](https://github.com/TAK-NZ). That diagram is maintained in one place
so it stays current as layers are added.

## Quick Start

### Prerequisites
- [AWS Account](https://signin.aws.amazon.com/signup) with configured credentials
- Base infrastructure stack (`TAK-<n>-BaseInfra`) must be deployed first
- Authentication infrastructure stack (`TAK-<n>-AuthInfra`) must be deployed first
- TAK infrastructure stack (`TAK-<n>-TakInfra`) must be deployed first
- CloudTAK stack (`TAK-<n>-CloudTAK`) must be deployed first
- Public Route 53 hosted zone (e.g., `tak.nz`)
- [Node.js](https://nodejs.org/) and npm installed
- **For CI/CD deployment:** See [AWS & GitHub Setup Guide](docs/AWS_GITHUB_SETUP.md) for MediaInfra-specific GitHub Actions configuration

### Installation & Deployment

```bash
# 1. Install dependencies
npm install

# 2. Bootstrap CDK (first time only)
npx cdk bootstrap --profile your-aws-profile

# 3. Deploy development environment
npm run deploy:dev

# 4. Deploy production environment  
npm run deploy:prod
```

## Infrastructure Resources

### Compute & Services
- **ECS Cluster** - Dedicated cluster created by this stack; EC2 capacity providers are cluster-scoped and cannot attach to the shared BaseInfra cluster
- **EC2 Capacity Provider** - Launch template, Auto Scaling Group and capacity provider running ARM64 (Graviton) instances
- **ECS Service** - MediaMTX container using `host` network mode, which is what makes WebRTC ICE possible
- **Network Load Balancer** - Terminates TLS for every client-facing port and forwards plaintext into the VPC
- **Target Groups** - One per plaintext container port: RTMP, RTSP, playback, API, WebRTC signalling, SRT
- **EFS** - Persistent MediaMTX state, mounted at `/opt/mediamtx`

### Networking
- **Elastic IP** - Static address used solely as the WebRTC ICE endpoint. Not published in DNS; clients receive it inside the WebRTC negotiation
- **Route 53 Records** - Media hostname aliased to the load balancer
- **Security Groups** - The instance accepts non-ICE ports only from the load balancer; ICE is the single port open to the internet on the instance itself

### Security
- **CloudTAK Integration** - Stream authentication via the CloudTAK API, with a short-lived in-container cache
- **ACM Certificate** - Shared certificate imported from BaseInfra and used by the load balancer

### CDK Utilities
- **Context Overrides** - Command-line parameter override system (`lib/utils/context-overrides.ts`)
- **Constants** - Centralized MediaMTX port and infrastructure constants (`lib/utils/constants.ts`)
- **Tag Helpers** - Standardized resource tagging utilities (`lib/utils/tag-helpers.ts`)

## Why EC2 rather than Fargate

WebRTC ICE requires direct UDP connectivity between client and server. Fargate's
`awsvpc` networking cannot provide that path, and no load balancer can proxy it.
Running the container with `host` network mode on EC2 gives ICE a direct route via
a static Elastic IP, while everything else stays behind the load balancer.

This also means the container image must be built for ARM64 to match the Graviton
instance type, and that the ECS cluster is owned by this stack.

## Docker Image Strategy

This stack uses a **hybrid Docker image strategy** that supports both pre-built images from ECR and local Docker building for maximum flexibility.

- **Strategy**: See [Docker Image Strategy Guide](docs/DOCKER_IMAGE_STRATEGY.md) for details
- **CI/CD Mode**: Uses pre-built images for fast deployments
- **Development Mode**: Builds images locally for flexible development
- **Automatic Fallback**: Seamlessly switches between modes based on context parameters

### Docker Images Used

1. **MediaMTX Server**: Built from `docker/media-infra/Dockerfile` with MediaMTX and authentication integration

### Usage Modes

**CI/CD Deployments (Fast)**:
```bash
npm run deploy:dev -- --context usePreBuiltImages=true
npm run deploy:prod -- --context usePreBuiltImages=true
```

**Local Development (Flexible)**:
```bash
npm run deploy:local:dev    # Builds images locally
npm run deploy:local:prod   # Builds images locally
```

## Streaming Protocols & Ports

Client traffic arrives by two paths. Everything except WebRTC ICE goes through the
load balancer, which terminates TLS. ICE reaches the instance's Elastic IP
directly, because it needs a direct UDP path no load balancer can carry.

### Via the load balancer

| Port | Protocol | Description | TLS | Security |
|------|----------|-------------|-----|----------|
| 1936 | RTMPS | RTMP over TLS | Terminated at NLB | Always enabled |
| 8555 | RTSPS | RTSP over TLS | Terminated at NLB | Always enabled |
| 8889 | WebRTC | WHEP/WHIP signalling | Terminated at NLB | Always enabled |
| 9996 | HTTPS | Recording playback | Terminated at NLB | Always enabled |
| 9997 | HTTPS | CloudTAK media API and HLS delivery | Terminated at NLB | Always enabled |
| 8890 | SRT | SRT ingest over UDP | SRT's own encryption | Always enabled |
| 1935 | RTMP | RTMP streaming, plaintext | None | Conditional (insecure) |
| 8554 | RTSP | RTSP streaming, plaintext | None | Conditional (insecure) |

### Direct to the instance

| Port | Protocol | Description | Encryption |
|------|----------|-------------|------------|
| 8189 | WebRTC ICE | Media transport, UDP with TCP fallback | DTLS/SRTP, keyed via SDP |

### Not exposed

These bind to loopback inside the container and are deliberately unreachable:

| Port | Purpose | Reached by |
|------|---------|------------|
| 8888 | MediaMTX HLS listener | The authenticated proxy on 9997 |
| 4000 | MediaMTX control API | The Node app over localhost |
| 9995 | Authentication cache | MediaMTX over localhost |

**HLS note**: MediaMTX's HLS listener is not served directly. HLS is delivered
through port 9997, which enforces CloudTAK lease authorisation and rewrites
manifests to signed URLs — exposing 8888 would bypass both.

**Security note**: Plaintext ports (1935, 8554) only exist when
`enableInsecurePorts` is `true`.

## Available Environments

| Environment | Stack Name | Description | Domain | Instance | Monthly Cost* |
|-------------|------------|-------------|--------|----------|---------------|
| `dev-test` | `TAK-Dev-MediaInfra` | Cost-optimized development | `media.dev.tak.nz` | `t4g.large` | ~$90 USD |
| `prod` | `TAK-Prod-MediaInfra` | Production | `media.tak.nz` | `t4g.xlarge` | ~$160 USD |

*Rough estimates in USD for ap-southeast-2, excluding data transfer and streaming
usage. Dominated by the EC2 instance plus the load balancer. These are higher than
the earlier Fargate-based figures because the service now runs on a continuously
running instance — the trade for WebRTC support.

## Development Workflow

### New NPM Scripts (Enhanced Developer Experience)
```bash
# Development and Testing
npm run dev                    # Build and test
npm run test:watch            # Run tests in watch mode
npm run test:coverage         # Generate coverage report

# Environment-Specific Deployment
npm run deploy:dev            # Deploy to dev-test
npm run deploy:prod           # Deploy to production
npm run synth:dev             # Preview dev infrastructure
npm run synth:prod            # Preview prod infrastructure

# Infrastructure Management
npm run cdk:diff:dev          # Show what would change in dev
npm run cdk:diff:prod         # Show what would change in prod
npm run cdk:bootstrap         # Bootstrap CDK in account
```

### Configuration System

The project uses **AWS CDK context-based configuration** for consistent deployments:

- **All settings** stored in [`cdk.json`](cdk.json) under `context` section
- **Version controlled** - consistent deployments across team members
- **Runtime overrides** - use `--context` flag for one-off changes
- **Environment-specific** - separate configs for dev-test and production

#### Configuration Override Examples
```bash
# Enable insecure ports for development
npm run deploy:dev -- --context enableInsecurePorts=true

# Use pre-built images for faster deployment
npm run deploy:prod -- --context usePreBuiltImages=true

# Override ECS task sizing
npm run deploy:dev -- --context taskCpu=1024 --context taskMemory=2048 --context desiredCount=2

# Override the EC2 capacity provider. Must be an ARM64 (Graviton) family to match
# the container image architecture.
npm run deploy:dev -- --context instanceType=m7g.large --context maxCapacity=3

# Raise MediaMTX log verbosity for one deployment
npm run deploy:dev -- --context logLevel=debug

# Override ECR settings
npm run deploy:prod -- --context imageRetentionCount=10 --context scanOnPush=true

# Override MediaMTX version (drives both the base image and the source build)
npm run deploy:dev -- --context mediamtxVersion=1.19.0
```

## 📚 Documentation

- **[🚀 Deployment Guide](docs/DEPLOYMENT_GUIDE.md)** - Comprehensive deployment instructions and configuration options
- **[🏗️ Architecture Guide](docs/ARCHITECTURE.md)** - Technical architecture and design decisions  
- **[⚡ Quick Reference](docs/QUICK_REFERENCE.md)** - Fast deployment commands and environment comparison
- **[⚙️ Configuration Guide](docs/PARAMETERS.md)** - Complete configuration management reference
- **[🎥 Streaming Guide](docs/STREAMING_GUIDE.md)** - MediaMTX configuration and streaming protocols
- **[🐳 Docker Image Strategy](docs/DOCKER_IMAGE_STRATEGY.md)** - Hybrid image strategy for fast CI/CD and flexible development

## Security Features

### Enterprise-Grade Security
- **🔑 KMS Encryption** - EFS encrypted at rest with customer-managed keys; in-transit encryption and IAM authorisation on the mount
- **🛡️ Network Security** - The container instance runs in public subnets, as WebRTC ICE needs a routable address. Only the ICE port is open to the internet on the instance; every other port is reachable solely through the load balancer
- **🔒 IAM Policies** - Least-privilege access patterns throughout
- **📋 Protocol Security** - TLS terminated at the load balancer for all client-facing protocols; SRT and WebRTC media carry their own encryption
- **🔐 Authentication** - CloudTAK API integration for stream authentication, with HLS delivered only through the authorising proxy

## Getting Help

### Common Issues
- **Base Infrastructure** - Ensure base infrastructure stack is deployed first
- **Authentication Infrastructure** - Ensure authentication infrastructure stack is deployed first
- **TAK Infrastructure** - Ensure TAK infrastructure stack is deployed first
- **CloudTAK** - Ensure CloudTAK stack is deployed first
- **Route53 Hosted Zone** - Ensure your domain's hosted zone exists before deployment
- **AWS Permissions** - CDK requires broad permissions for CloudFormation operations
- **Docker Images** - CDK automatically handles Docker image building and ECR management
- **Stack Name Matching** - Ensure stackName parameter matches your infrastructure deployments

### Support Resources
- **AWS CDK Documentation** - https://docs.aws.amazon.com/cdk/
- **MediaMTX Documentation** - https://github.com/bluenviron/mediamtx
- **TAK-NZ Project** - https://github.com/TAK-NZ/
- **Issue Tracking** - Use GitHub Issues for bug reports and feature requests

## License

TAK.NZ is distributed under [AGPL-3.0-only](LICENSE)
Copyright (C) 2026 - Christian Elsen, Team Awareness Kit New Zealand (TAK.NZ)
Copyright (c) 2023 Public Safety TAK
