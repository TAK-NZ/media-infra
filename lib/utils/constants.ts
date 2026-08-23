/**
 * Constants for MediaInfra infrastructure
 */

export const DEFAULT_AWS_REGION = 'ap-southeast-2';

/**
 * Ports exposed by the MediaMTX container.
 *
 * The container runs with `host` network mode on an EC2 instance with a public
 * Elastic IP, so these are the ports clients connect to directly. TLS is
 * terminated by MediaMTX (and by the Node API server on {@link API}) using the
 * exportable ACM certificate, not by a load balancer.
 */
export const MEDIAMTX_PORTS = {
  /** RTMP ingest, plaintext. Exposed only when enableInsecurePorts is set. */
  RTMP: 1935,
  /** RTMPS ingest, TLS terminated by MediaMTX */
  RTMPS: 1936,
  /** RTSP ingest, plaintext. Exposed only when enableInsecurePorts is set. */
  RTSP: 8554,
  /** RTSPS ingest, TLS terminated by MediaMTX */
  RTSPS: 8555,
  /** SRT ingest over UDP; SRT provides its own encryption */
  SRTS: 8890,
  /** MediaMTX recording playback, TLS terminated by MediaMTX */
  PLAYBACK: 9996,
  /** CloudTAK media API and HLS proxy served by the Node app over HTTPS */
  API: 9997,
  /** WebRTC signalling (WHEP/WHIP), TLS terminated by MediaMTX */
  WEBRTC: 8889,
  /** WebRTC ICE media transport, UDP with TCP fallback on the same port */
  WEBRTC_ICE: 8189,
} as const;

/**
 * Ports bound to loopback only and never exposed to the network.
 * Listed for documentation; they are deliberately absent from security groups.
 */
export const MEDIAMTX_INTERNAL_PORTS = {
  /** MediaMTX control API, consumed by the Node app over localhost */
  CONTROL_API: 4000,
  /** Internal auth cache endpoint that MediaMTX calls for authentication */
  AUTH_CACHE: 9995,
  /**
   * MediaMTX HLS listener. Reached only by the Node HLS proxy on {@link
   * MEDIAMTX_PORTS.API}, which adds lease authorisation and rewrites manifests
   * to signed URLs. Exposing it directly would bypass that.
   */
  HLS: 8888,
} as const;
