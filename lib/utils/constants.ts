/**
 * Constants for MediaInfra infrastructure
 */

export const DEFAULT_AWS_REGION = 'ap-southeast-2';

/**
 * MediaMTX ports.
 *
 * Client traffic arrives by two paths. Everything except WebRTC ICE goes through
 * the Network Load Balancer, which terminates TLS and forwards plaintext to the
 * container. ICE reaches the instance's Elastic IP directly, because it needs a
 * direct UDP path that no load balancer can proxy.
 *
 * Ports marked "load balancer only" are listener ports the container never binds
 * — the balancer decrypts them and forwards to the plaintext port behind.
 */
export const MEDIAMTX_PORTS = {
  /** RTMP ingest, plaintext. Reachable only when enableInsecurePorts is set. */
  RTMP: 1935,
  /** RTMPS ingest. Load balancer only; forwards to {@link RTMP}. */
  RTMPS: 1936,
  /** RTSP ingest, plaintext. Reachable only when enableInsecurePorts is set. */
  RTSP: 8554,
  /** RTSPS ingest. Load balancer only; forwards to {@link RTSP}. */
  RTSPS: 8555,
  /** SRT ingest over UDP; passes through the balancer unmodified as SRT encrypts itself */
  SRTS: 8890,
  /** MediaMTX recording playback */
  PLAYBACK: 9996,
  /** CloudTAK media API and HLS proxy served by the Node app */
  API: 9997,
  /** WebRTC signalling (WHEP/WHIP) */
  WEBRTC: 8889,
  /**
   * WebRTC ICE media transport, UDP with TCP fallback on the same port.
   *
   * Bypasses the load balancer entirely and is reached on the instance's Elastic
   * IP. WebRTC media is DTLS-encrypted using keys exchanged in the SDP, so it
   * needs no TLS certificate.
   */
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
