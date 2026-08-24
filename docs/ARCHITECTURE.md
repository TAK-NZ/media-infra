# Architecture Documentation

## System Architecture

The TAK Media Infrastructure provides MediaMTX streaming server capabilities for TAK deployments, supporting multiple streaming protocols with CloudTAK authentication integration. This CDK-based infrastructure creates a secure, scalable media streaming foundation.

```
Client traffic arrives by two distinct paths.

  Everything except WebRTC ICE  ─────▶  Network Load Balancer  ─────▶  instance
  WebRTC ICE (needs direct UDP) ─────────────────────────────────────▶  instance


┌─────────────────┐                                    ┌─────────────────┐
│   Streaming     │                                    │   Route 53      │
│   Clients       │                                    │  media.<domain> │
│ (ATAK/iTAK/OBS/ │                                    │  alias ──▶ NLB  │
│  browsers)      │                                    └─────────────────┘
└────────┬────────┘
         │
         │  TLS terminated at the NLB using the shared ACM certificate
         │
         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       Network Load Balancer                              │
│                                                                          │
│  Listener        Protocol   ──▶  Target group (plaintext container port)  │
│  ─────────────────────────────────────────────────────────────────────   │
│  1936  RTMPS     TLS        ──▶  RTMP      1935                          │
│  8555  RTSPS     TLS        ──▶  RTSP      8554                          │
│  8889  WebRTC    TLS        ──▶  WebRTC    8889   (signalling only)       │
│  9996  Playback  TLS        ──▶  Playback  9996                          │
│  9997  API/HLS   TLS        ──▶  API       9997                          │
│  8890  SRT       UDP        ──▶  SRT       8890   (SRT self-encrypts)     │
│  1935  RTMP      TCP*       ──▶  RTMP      1935                          │
│  8554  RTSP      TCP*       ──▶  RTSP      8554                          │
│                                                                          │
│  Target groups are instance-type and attach to the Auto Scaling Group,    │
│  not the ECS service, which avoids the ECS 5-target-group service limit.  │
│  Health checks probe 9997, so task health is reflected.                   │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│              EC2 Container Instance  (ARM64 / Graviton)                  │
│              Public subnet, ECS capacity provider + ASG                  │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │        MediaMTX Container  —  host network mode                   │   │
│   │        (all listeners plaintext; no certificate in container)     │   │
│   │                                                                  │   │
│   │  Public via NLB          Loopback only                           │   │
│   │  ┌────────────────┐      ┌──────────────────────────────────┐    │   │
│   │  │ RTMP     1935  │      │ HLS listener        8888         │    │   │
│   │  │ RTSP     8554  │      │ MediaMTX ctrl API   4000         │    │   │
│   │  │ Playback 9996  │      │ Auth cache          9995         │    │   │
│   │  │ WebRTC   8889  │      └──────────────────────────────────┘    │   │
│   │  │ SRT      8890  │                                              │   │
│   │  │ API/HLS  9997  │──▶ Node app: HLS proxy, lease auth,          │   │
│   │  └────────────────┘    signed URL rewriting, CloudTAK sync       │   │
│   │                                                                  │   │
│   │  Direct from internet (bypasses the NLB)                         │   │
│   │  ┌──────────────────────────────────────────────────────────┐    │   │
│   │  │ WebRTC ICE  8189 UDP + TCP                               │◀───┼───┼── ICE
│   │  │ DTLS/SRTP, keyed via SDP — no TLS certificate involved    │    │   │
│   │  └──────────────────────────────────────────────────────────┘    │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│   Elastic IP attached at boot. Advertised as the ICE candidate via        │
│   MTX_WEBRTCADDITIONALHOSTS. Never published in DNS.                      │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │  EFS  /opt/mediamtx      │
                    │  KMS encrypted, IAM auth │
                    └──────────────────────────┘

* Insecure protocols (RTMP:1935, RTSP:8554) only enabled when enableInsecurePorts=true
```

## Component Details

### Core Infrastructure

#### 1. MediaMTX Streaming Server
- **Technology**: MediaMTX (formerly rtsp-simple-server) containerized application
- **Purpose**: Multi-protocol streaming server supporting RTMP, RTSP, SRT, HLS, WebRTC
- **Container Platform**: ECS on EC2 using `host` network mode
- **Why not Fargate**: WebRTC ICE needs direct UDP connectivity between client and server. Fargate's `awsvpc` networking cannot provide that path and no load balancer can proxy it, so the container binds directly to the instance's interface instead
- **Architecture**: ARM64 (Graviton), so the image is built for `linux/arm64`
- **Scaling**: Fixed desired count (1 task); the Auto Scaling Group provides headroom for rolling deployments
- **Configuration**: Dynamic configuration via environment variables, including `MTX_*` variables MediaMTX reads directly

#### 2. EC2 Capacity
- **Cluster**: Created by this stack. EC2 capacity providers are cluster-scoped and cannot attach to the shared Fargate-only BaseInfra cluster
- **Launch Template**: Explicit `AWS::EC2::LaunchTemplate` rather than the legacy launch configuration CDK would otherwise emit
- **Capacity Provider**: ECS managed scaling; `desiredCapacity` is deliberately unset so ECS owns it
- **Placement**: Public subnets, because the instance needs a routable address for WebRTC ICE
- **Agent config**: `ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST` is required — task IAM roles are off by default under `host` network mode

#### 3. Network Load Balancer (NLB)
- **Technology**: AWS Network Load Balancer (Layer 4)
- **Purpose**: TLS termination and load balancing for every client-facing port except WebRTC ICE
- **TLS**: Terminates RTMPS, RTSPS, playback, API and WebRTC signalling using the shared ACM certificate imported from BaseInfra. ELB integrates with ACM natively, so the certificate never leaves AWS and the container holds no certificate material
- **Pass-through**: SRT is forwarded as UDP without termination, since SRT encrypts itself
- **Health Checks**: All target groups probe the API port, so a target whose task is not running is marked unhealthy

#### 4. Target Groups
One per distinct plaintext container port. TLS listeners share the group for their
plaintext counterpart — RTMPS and RTMP both land on 1935.

- **RTMP** (1935): serves both the RTMPS listener and, when enabled, plain RTMP
- **RTSP** (8554): serves both the RTSPS listener and, when enabled, plain RTSP
- **Playback** (9996): recording playback
- **API** (9997): CloudTAK media API and HLS delivery
- **WebRTC** (8889): WHEP/WHIP signalling
- **SRT** (8890): UDP ingest

Groups are instance-type and attach to the Auto Scaling Group rather than the ECS
service, which avoids the ECS limit of five target groups per service.

#### 5. WebRTC ICE Endpoint
- **Elastic IP**: Static address associated by the instance at boot
- **Not in DNS**: MediaMTX advertises it as an ICE candidate, so clients receive it inside the WebRTC negotiation and only ever resolve the load balancer name
- **Why static**: keeps advertised ICE candidates valid across instance replacement
- **Address source**: passed in from CDK rather than read from instance metadata, which would race the boot-time association and could advertise the ephemeral public IP

### Security Architecture

#### 1. Protocol Security
- **Secure by Default**: All production deployments use encrypted protocols
- **TLS Encryption**: RTMPS, RTSPS, playback, API/HLS and WebRTC signalling, all terminated at the load balancer
- **Self-encrypting protocols**: SRT carries its own encryption; WebRTC media is DTLS/SRTP keyed via the SDP, independent of any TLS certificate
- **Optional Insecure**: RTMP and RTSP available for development only
- **Certificate Management**: Shared ACM certificate from base infrastructure, used by the load balancer and never exported

#### 2. Authentication Integration
- **CloudTAK API**: Stream authentication via CloudTAK user management
- **Signing Secret**: JWT token validation for stream access
- **Media Secret**: Additional authentication layer for media streams
- **AWS Secrets Manager**: Secure storage of authentication credentials

#### 3. Network Security
- **Security Groups**: The instance accepts non-ICE ports only from the load balancer's security group. WebRTC ICE is the single port open to the internet on the instance itself
- **Public Subnet Placement**: The container instance runs in public subnets because WebRTC ICE requires a routable address. This is a deliberate trade for WebRTC support
- **Loopback-only Listeners**: MediaMTX's HLS listener (8888), control API (4000) and the auth cache (9995) bind to `127.0.0.1` and are additionally absent from all security groups as defence in depth
- **Authorised HLS Path**: HLS is served only through the proxy on 9997, which enforces CloudTAK lease authorisation and rewrites manifests to signed URLs. Exposing 8888 directly would bypass both
- **VPC Integration**: Leverages base infrastructure VPC and security

### Streaming Protocols

#### 1. RTMP/RTMPS (Real-Time Messaging Protocol)
- **Port**: 1935 (RTMP), 1936 (RTMPS)
- **Use Case**: Live streaming from OBS, streaming software
- **Security**: TLS encryption for RTMPS
- **Authentication**: CloudTAK API integration

#### 2. RTSP/RTSPS (Real-Time Streaming Protocol)
- **Port**: 8554 (RTSP), 8555 (RTSPS)
- **Use Case**: IP camera streams, media players
- **Security**: TLS encryption for RTSPS
- **Features**: Bidirectional communication, session management

#### 3. SRT/SRTS (Secure Reliable Transport)
- **Port**: 8890
- **Use Case**: Low-latency streaming with error correction
- **Security**: Built-in encryption and authentication
- **Features**: Adaptive bitrate, packet recovery

#### 4. HLS (HTTP Live Streaming)
- **Port**: 9997 (HTTPS) — *not* 8888
- **Use Case**: Adaptive streaming for web browsers, mobile apps
- **Security**: HTTPS terminated at the load balancer, plus CloudTAK lease authorisation
- **Delivery Path**: MediaMTX's own HLS listener binds to loopback on 8888. Requests are served by the Node proxy on 9997, which authorises the lease, fetches from the loopback listener and rewrites the manifest so every segment URL is individually signed
- **Features**: Adaptive bitrate, LL-HLS tag support, wide client compatibility

#### 5. WebRTC
- **Ports**: 8889 (signalling, via the load balancer), 8189 UDP/TCP (ICE, direct to the Elastic IP)
- **Use Case**: Low-latency playback in browsers and TAK clients
- **Security**: Signalling over TLS; media is DTLS/SRTP keyed via the SDP, so no TLS certificate is involved in the media path
- **Why ICE bypasses the load balancer**: ICE requires direct UDP connectivity. MediaMTX advertises the Elastic IP as its candidate because the instance's own interfaces carry only private addresses

#### 6. Recording Playback
- **Port**: 9996 (HTTPS)
- **Use Case**: Retrieving recorded segments
- **Security**: HTTPS terminated at the load balancer

#### 7. MediaMTX Control API
- **Port**: 4000, loopback only
- **Use Case**: Path configuration and monitoring, consumed by the Node app over localhost
- **Security**: Not network-reachable. The externally available API on 9997 is the Node app's own authorising API, not this one

### Container Architecture

#### 1. MediaMTX Container
- **Base Image**: Alpine Linux for minimal attack surface
- **MediaMTX Version**: Latest stable release with security patches
- **Configuration**: Environment variable-driven configuration
- **Logging**: Structured logging to CloudWatch
- **Health Checks**: Multi-protocol health monitoring

#### 2. Authentication Integration
- **CloudTAK API Client**: HTTP client for user authentication
- **Token Validation**: JWT token verification for stream access
- **User Management**: Integration with CloudTAK user database
- **Session Management**: Stream session tracking and management

### Deployment Architecture

#### 1. Docker Image Strategy
- **Hybrid Approach**: Pre-built ECR images for CI/CD, local building for development
- **CI/CD Optimization**: Fast deployments using pre-built images (~5 minutes)
- **Development Flexibility**: Local image building for customization
- **Automatic Fallback**: Context-driven image selection

#### 2. Environment Configuration
- **dev-test**: Cost-optimized with basic scaling (1 task)
- **prod**: High-availability with auto-scaling (2+ tasks)
- **Context-Driven**: Environment-specific configuration via CDK context
- **Override Capability**: Runtime configuration overrides

### Integration Points

#### 1. Base Infrastructure Dependencies
- **VPC**: Shared networking infrastructure
- **ECS Cluster**: Shared container orchestration platform
- **KMS**: Encryption keys for secrets and storage
- **ACM Certificate**: SSL/TLS certificates for secure protocols

#### 2. CloudTAK Dependencies
- **Authentication API**: User authentication and authorization
- **Signing Secret**: JWT token signing and validation
- **Media Secret**: Additional authentication layer
- **User Database**: Stream access control

#### 3. DNS and Service Discovery
- **Route 53**: DNS records for streaming endpoints
- **Service Discovery**: ECS service registration
- **Health Monitoring**: CloudWatch metrics and alarms
- **Load Balancer Integration**: Automatic target registration

### Monitoring and Observability

#### 1. CloudWatch Integration
- **Container Metrics**: CPU, memory, network utilization
- **Application Logs**: MediaMTX server logs and access logs
- **Custom Metrics**: Stream count, connection metrics
- **Alarms**: Automated alerting for service health

#### 2. Health Checks
- **NLB Health Checks**: Protocol-specific availability monitoring
- **ECS Health Checks**: Container health and restart policies
- **Application Health**: MediaMTX API health endpoints
- **Stream Health**: Active stream monitoring and metrics