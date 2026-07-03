/**
 * Constants for MediaInfra infrastructure
 */

export const DEFAULT_AWS_REGION = 'ap-southeast-2';

export const MEDIAMTX_PORTS = {
  RTMP: 1935,
  RTSP: 8554,
  RTMPS: 1936,
  RTSPS: 8555,
  SRTS: 8890,
  HLS_HTTPS: 8888,
  API_HTTPS: 9997,
  // WebRTC (8889) and ICE (8189) are defined in mediamtx.yml but not routed
  // through the NLB or registered as ECS target groups. WebRTC requires direct
  // UDP connectivity (ICE) which is not supported on Fargate awsvpc networking.
  // Retain these constants for reference when migrating to EC2+host networking.
  WEBRTC: 8889,
  WEBRTC_ICE: 8189,
} as const;

