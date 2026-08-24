import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { MEDIAMTX_PORTS } from '../utils/constants';

export interface MediaNlbProps {
  vpc: ec2.IVpc;
  /** Shared ACM certificate imported from BaseInfra; never exported */
  certificate: acm.ICertificate;
  hostedZone: route53.IHostedZone;
  /** Subdomain label for the media server, e.g. "video" */
  mediaHostname: string;
  stackNameComponent: string;
  enableInsecurePorts: boolean;
  nlbSecurityGroup: ec2.SecurityGroup;
}

/**
 * Network Load Balancer fronting the media server.
 *
 * The NLB terminates TLS for every client-facing port using the shared ACM
 * certificate, which is why the container needs no certificate material of its
 * own. ACM integrates natively with Elastic Load Balancing, so the certificate
 * never has to be exportable.
 *
 * WebRTC ICE (8189) is deliberately absent. ICE requires direct UDP connectivity
 * to the media server and reaches the instance's Elastic IP instead — see
 * MediaEndpoint. That address is advertised to clients inside the WebRTC
 * negotiation, so it never appears in DNS.
 *
 * Target groups are attached to the Auto Scaling Group rather than registered
 * against the ECS service, which avoids the ECS limit of five load balancer
 * target groups per service. Task health is still reflected: the health check
 * probes the API port, which only answers when the task is running.
 */
export class MediaNlb extends Construct {
  public readonly loadBalancer: elbv2.NetworkLoadBalancer;
  public readonly securityGroup: ec2.SecurityGroup;

  /**
   * Keyed by the plaintext container port each group forwards to. TLS listeners
   * share the group for their plaintext counterpart — RTMPS 1936 and RTMP 1935
   * both land on the RTMP listener inside the container.
   */
  public readonly targetGroups: {
    rtmp: elbv2.NetworkTargetGroup;
    rtsp: elbv2.NetworkTargetGroup;
    playback: elbv2.NetworkTargetGroup;
    api: elbv2.NetworkTargetGroup;
    webrtc: elbv2.NetworkTargetGroup;
    srts: elbv2.NetworkTargetGroup;
  };

  constructor(scope: Construct, id: string, props: MediaNlbProps) {
    super(scope, id);

    this.securityGroup = props.nlbSecurityGroup;

    this.loadBalancer = new elbv2.NetworkLoadBalancer(this, 'MediaNlb', {
      loadBalancerName: `tak-${props.stackNameComponent.toLowerCase()}-media`,
      vpc: props.vpc,
      internetFacing: true,
      ipAddressType: elbv2.IpAddressType.IPV4,
      securityGroups: [this.securityGroup],
      crossZoneEnabled: true,
    });

    // Instance targets rather than IP targets: with host network mode the task
    // binds directly to the instance's interface, so the instance *is* the
    // target. The ASG registers and deregisters members automatically.
    const targetGroup = (
      name: string,
      port: number,
      protocol: elbv2.Protocol
    ): elbv2.NetworkTargetGroup => new elbv2.NetworkTargetGroup(this, name, {
      port,
      protocol,
      vpc: props.vpc,
      targetType: elbv2.TargetType.INSTANCE,
      // Probing the API port means the group tracks task health, not merely
      // whether the instance booted.
      //
      // Timings are deliberately tighter than the AWS defaults (30s interval,
      // threshold 3, which give 90 seconds in each direction). Those 90 seconds
      // matter in the two situations where more than one instance is registered:
      // a replacement instance is not servable for 90s after its task is ready,
      // and an instance that has lost its task keeps receiving traffic for 90s.
      // The second case was observed black-holing roughly half of all client
      // connections during a deployment. At 10s and threshold 2 both windows
      // shrink to about 20 seconds.
      //
      // Both thresholds are kept equal, which NLB has historically required.
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: MEDIAMTX_PORTS.API.toString(),
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    this.targetGroups = {
      rtmp: targetGroup('RtmpTargetGroup', MEDIAMTX_PORTS.RTMP, elbv2.Protocol.TCP),
      rtsp: targetGroup('RtspTargetGroup', MEDIAMTX_PORTS.RTSP, elbv2.Protocol.TCP),
      playback: targetGroup('PlaybackTargetGroup', MEDIAMTX_PORTS.PLAYBACK, elbv2.Protocol.TCP),
      api: targetGroup('ApiTargetGroup', MEDIAMTX_PORTS.API, elbv2.Protocol.TCP),
      webrtc: targetGroup('WebRtcTargetGroup', MEDIAMTX_PORTS.WEBRTC, elbv2.Protocol.TCP),
      srts: targetGroup('SrtsTargetGroup', MEDIAMTX_PORTS.SRTS, elbv2.Protocol.UDP),
    };

    // TLS-terminating listeners. Each decrypts and forwards to the plaintext
    // container port behind it.
    this.loadBalancer.addListener('RtmpsListener', {
      port: MEDIAMTX_PORTS.RTMPS,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.rtmp],
    });

    this.loadBalancer.addListener('RtspsListener', {
      port: MEDIAMTX_PORTS.RTSPS,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.rtsp],
    });

    this.loadBalancer.addListener('PlaybackListener', {
      port: MEDIAMTX_PORTS.PLAYBACK,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.playback],
    });

    this.loadBalancer.addListener('ApiListener', {
      port: MEDIAMTX_PORTS.API,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.api],
    });

    // WebRTC signalling (WHEP/WHIP). Only the handshake passes through here; the
    // media itself is DTLS-encrypted over ICE and bypasses the load balancer.
    this.loadBalancer.addListener('WebRtcListener', {
      port: MEDIAMTX_PORTS.WEBRTC,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.webrtc],
    });

    // SRT provides its own encryption, so it passes through unmodified.
    //
    // Construct ID must stay 'SrtsListener'. A load balancer permits only one
    // listener per port, so renaming it would make CloudFormation attempt to
    // create the replacement on 8890 before deleting the original, which fails.
    this.loadBalancer.addListener('SrtsListener', {
      port: MEDIAMTX_PORTS.SRTS,
      protocol: elbv2.Protocol.UDP,
      defaultTargetGroups: [this.targetGroups.srts],
    });

    // Plaintext ingest listeners, opt-in only.
    if (props.enableInsecurePorts) {
      this.loadBalancer.addListener('RtmpListener', {
        port: MEDIAMTX_PORTS.RTMP,
        protocol: elbv2.Protocol.TCP,
        defaultTargetGroups: [this.targetGroups.rtmp],
      });

      this.loadBalancer.addListener('RtspListener', {
        port: MEDIAMTX_PORTS.RTSP,
        protocol: elbv2.Protocol.TCP,
        defaultTargetGroups: [this.targetGroups.rtsp],
      });
    }

    // Clients only ever resolve this name. The Elastic IP used for ICE is
    // communicated inside the WebRTC negotiation instead.
    new route53.ARecord(this, 'MediaARecord', {
      zone: props.hostedZone,
      recordName: props.mediaHostname,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(this.loadBalancer)
      ),
    });
  }

  /** All target groups, for attaching to the Auto Scaling Group */
  public allTargetGroups(): elbv2.NetworkTargetGroup[] {
    return Object.values(this.targetGroups);
  }
}
