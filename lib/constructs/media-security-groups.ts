import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { MEDIAMTX_PORTS } from '../utils/constants';

export interface MediaSecurityGroupsProps {
  vpc: ec2.IVpc;
  stackNameComponent: string;
  /**
   * Expose the plaintext RTMP (1935) and RTSP (8554) ingest ports to the
   * internet. The TLS variants (RTMPS 1936, RTSPS 8555) are always exposed.
   */
  enableInsecurePorts: boolean;
}

/**
 * Security groups for the MediaMTX media server.
 *
 * The container runs with `host` network mode on an EC2 instance that carries a
 * public Elastic IP, so there is no load balancer in the media path. Client
 * traffic reaches the instance directly and the instance security group is the
 * only network control in front of MediaMTX.
 *
 * Ports deliberately NOT exposed: the MediaMTX control API (4000), the internal
 * auth cache (9995), metrics (9998) and pprof (9999). Those bind to loopback in
 * mediamtx.yml, and are additionally not permitted here as defence in depth.
 */
export class MediaSecurityGroups extends Construct {
  /** Applied to the EC2 container instance — with host networking this is effectively the container's SG */
  public readonly instance: ec2.SecurityGroup;
  public readonly efs: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: MediaSecurityGroupsProps) {
    super(scope, id);

    this.instance = new ec2.SecurityGroup(this, 'MediaInstanceSecurityGroup', {
      vpc: props.vpc,
      description: 'MediaMTX EC2 container instance - direct internet access to media ports',
      // Needed for ECR pulls, Secrets Manager, ACM export, SSM Session Manager
      // and CloudWatch Logs.
      allowAllOutbound: true,
    });

    this.efs = new ec2.SecurityGroup(this, 'EfsSecurityGroup', {
      vpc: props.vpc,
      description: 'EFS access for the MediaMTX container instance',
      allowAllOutbound: false,
    });

    // Plaintext ingest ports — opt-in only.
    if (props.enableInsecurePorts) {
      this.instance.addIngressRule(
        ec2.Peer.anyIpv4(), ec2.Port.tcp(MEDIAMTX_PORTS.RTMP), 'RTMP (plaintext)');
      this.instance.addIngressRule(
        ec2.Peer.anyIpv4(), ec2.Port.tcp(MEDIAMTX_PORTS.RTSP), 'RTSP (plaintext)');
    }

    // TLS ingest — MediaMTX terminates these itself using the exported ACM cert.
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(MEDIAMTX_PORTS.RTMPS), 'RTMPS');
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(MEDIAMTX_PORTS.RTSPS), 'RTSPS');

    // SRT carries its own encryption.
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.udp(MEDIAMTX_PORTS.SRTS), 'SRT');

    // Playback / delivery, all TLS.
    //
    // MediaMTX's own HLS listener (8888) is deliberately absent: it binds to
    // loopback and is reached only by the Node proxy on API, which adds lease
    // authorisation and signed-URL rewriting on top of it.
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(MEDIAMTX_PORTS.PLAYBACK), 'Playback (HTTPS)');
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(MEDIAMTX_PORTS.API), 'CloudTAK media API / HLS proxy (HTTPS)');

    // WebRTC: signalling plus ICE. ICE needs the direct UDP path that host
    // networking provides — this is the reason the service runs on EC2.
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(MEDIAMTX_PORTS.WEBRTC), 'WebRTC signalling (HTTPS)');
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.udp(MEDIAMTX_PORTS.WEBRTC_ICE), 'WebRTC ICE (UDP)');
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(), ec2.Port.tcp(MEDIAMTX_PORTS.WEBRTC_ICE), 'WebRTC ICE (TCP fallback)');

    // EFS
    this.efs.addIngressRule(
      ec2.Peer.securityGroupId(this.instance.securityGroupId),
      ec2.Port.tcp(2049),
      'NFS from MediaMTX instance'
    );
  }
}
