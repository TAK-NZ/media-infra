import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { MEDIAMTX_PORTS } from '../utils/constants';

export interface MediaSecurityGroupsProps {
  vpc: ec2.IVpc;
  stackNameComponent: string;
  /**
   * Expose the plaintext RTMP (1935) and RTSP (8554) ingest listeners on the load
   * balancer. The TLS variants (RTMPS 1936, RTSPS 8555) are always exposed.
   */
  enableInsecurePorts: boolean;
}

/**
 * Security groups for the media server.
 *
 * Client traffic arrives by two distinct paths, and the rules mirror that split:
 *
 *   - Everything except WebRTC ICE enters through the load balancer, so the
 *     instance only accepts those ports from the load balancer's security group.
 *   - WebRTC ICE (8189) reaches the instance's Elastic IP directly, because ICE
 *     needs a direct UDP path. That is the single port open to the internet on
 *     the instance itself.
 *
 * Ports deliberately absent: the MediaMTX HLS listener (8888), its control API
 * (4000) and the internal auth cache (9995). All three bind to loopback in
 * mediamtx.yml and are additionally not permitted here as defence in depth.
 */
export class MediaSecurityGroups extends Construct {
  /** Applied to the EC2 container instance; with host networking this fronts the container */
  public readonly instance: ec2.SecurityGroup;
  public readonly nlb: ec2.SecurityGroup;
  public readonly efs: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: MediaSecurityGroupsProps) {
    super(scope, id);

    this.instance = new ec2.SecurityGroup(this, 'MediaInstanceSecurityGroup', {
      vpc: props.vpc,
      description: 'MediaMTX EC2 container instance',
      // Needed for ECR pulls, Secrets Manager, SSM Session Manager and
      // CloudWatch Logs.
      allowAllOutbound: true,
    });

    this.nlb = new ec2.SecurityGroup(this, 'NlbSecurityGroup', {
      vpc: props.vpc,
      description: 'MediaMTX Network Load Balancer',
      allowAllOutbound: false,
    });

    this.efs = new ec2.SecurityGroup(this, 'EfsSecurityGroup', {
      vpc: props.vpc,
      description: 'EFS access for the MediaMTX container instance',
      allowAllOutbound: false,
    });

    // Ports the load balancer accepts from clients, paired with the plaintext
    // container port it forwards to.
    const forwarded: Array<{
      listenerPort: number;
      targetPort: number;
      protocol: 'tcp' | 'udp';
      description: string;
    }> = [
      { listenerPort: MEDIAMTX_PORTS.RTMPS, targetPort: MEDIAMTX_PORTS.RTMP, protocol: 'tcp', description: 'RTMPS' },
      { listenerPort: MEDIAMTX_PORTS.RTSPS, targetPort: MEDIAMTX_PORTS.RTSP, protocol: 'tcp', description: 'RTSPS' },
      { listenerPort: MEDIAMTX_PORTS.PLAYBACK, targetPort: MEDIAMTX_PORTS.PLAYBACK, protocol: 'tcp', description: 'Playback' },
      { listenerPort: MEDIAMTX_PORTS.API, targetPort: MEDIAMTX_PORTS.API, protocol: 'tcp', description: 'CloudTAK media API / HLS proxy' },
      { listenerPort: MEDIAMTX_PORTS.WEBRTC, targetPort: MEDIAMTX_PORTS.WEBRTC, protocol: 'tcp', description: 'WebRTC signalling' },
      { listenerPort: MEDIAMTX_PORTS.SRTS, targetPort: MEDIAMTX_PORTS.SRTS, protocol: 'udp', description: 'SRT' },
    ];

    if (props.enableInsecurePorts) {
      forwarded.push(
        { listenerPort: MEDIAMTX_PORTS.RTMP, targetPort: MEDIAMTX_PORTS.RTMP, protocol: 'tcp', description: 'RTMP (plaintext)' },
        { listenerPort: MEDIAMTX_PORTS.RTSP, targetPort: MEDIAMTX_PORTS.RTSP, protocol: 'tcp', description: 'RTSP (plaintext)' }
      );
    }

    const port = (protocol: 'tcp' | 'udp', value: number) =>
      protocol === 'tcp' ? ec2.Port.tcp(value) : ec2.Port.udp(value);

    for (const rule of forwarded) {
      // Internet to load balancer
      this.nlb.addIngressRule(
        ec2.Peer.anyIpv4(),
        port(rule.protocol, rule.listenerPort),
        rule.description
      );

      // Load balancer to instance
      this.instance.addIngressRule(
        ec2.Peer.securityGroupId(this.nlb.securityGroupId),
        port(rule.protocol, rule.targetPort),
        `${rule.description} from NLB`
      );

      // Load balancer egress to the target port
      this.nlb.addEgressRule(
        ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
        port(rule.protocol, rule.targetPort),
        `Forward ${rule.description} into VPC`
      );
    }

    // Health checks probe the API port on every target group.
    this.nlb.addEgressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(MEDIAMTX_PORTS.API),
      'Target group health checks'
    );

    // WebRTC ICE bypasses the load balancer entirely and arrives on the
    // instance's Elastic IP. UDP is the working path; TCP is the fallback for
    // networks that block UDP.
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(MEDIAMTX_PORTS.WEBRTC_ICE),
      'WebRTC ICE (UDP), direct to Elastic IP'
    );
    this.instance.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(MEDIAMTX_PORTS.WEBRTC_ICE),
      'WebRTC ICE (TCP fallback), direct to Elastic IP'
    );

    this.efs.addIngressRule(
      ec2.Peer.securityGroupId(this.instance.securityGroupId),
      ec2.Port.tcp(2049),
      'NFS from MediaMTX instance'
    );
  }
}
