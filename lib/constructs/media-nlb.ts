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
  certificate: acm.ICertificate;
  hostedZone: route53.IHostedZone;
  mediaHostname: string;
  stackNameComponent: string;
  enableInsecurePorts: boolean;
  nlbSecurityGroup: ec2.SecurityGroup;
}

export class MediaNlb extends Construct {
  public readonly loadBalancer: elbv2.NetworkLoadBalancer;
  public readonly securityGroup: ec2.SecurityGroup;

  // Exactly 5 target groups — the ECS Fargate awsvpc limit.
  //
  // WebRTC signalling (8889) shares the api target group since both are TCP
  // and land on container ports handled by the same process.
  //
  // WebRTC ICE (8189 UDP/TCP) is intentionally NOT exposed through the NLB.
  // ICE requires direct UDP connectivity between client and server; NLB UDP
  // forwarding to Fargate awsvpc containers does not work reliably. WebRTC
  // clients will use STUN to discover the ECS task's public IP and connect
  // directly on port 8189, bypassing the NLB for media transport.
  public readonly targetGroups: {
    rtmp: elbv2.NetworkTargetGroup;
    rtsp: elbv2.NetworkTargetGroup;
    srts: elbv2.NetworkTargetGroup;
    hls: elbv2.NetworkTargetGroup;
    api: elbv2.NetworkTargetGroup;
  };

  constructor(scope: Construct, id: string, props: MediaNlbProps) {
    super(scope, id);

    this.securityGroup = props.nlbSecurityGroup;

    // Create Network Load Balancer
    this.loadBalancer = new elbv2.NetworkLoadBalancer(this, 'MediaNlb', {
      loadBalancerName: `tak-${props.stackNameComponent.toLowerCase()}-media`,
      vpc: props.vpc,
      internetFacing: true,
      ipAddressType: elbv2.IpAddressType.IPV4,
      securityGroups: [this.securityGroup]
    });

    // 5 target groups — at the ECS Fargate awsvpc limit
    this.targetGroups = {
      rtmp: new elbv2.NetworkTargetGroup(this, 'RtmpTargetGroup', {
        port: MEDIAMTX_PORTS.RTMP,
        protocol: elbv2.Protocol.TCP,
        vpc: props.vpc,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          protocol: elbv2.Protocol.TCP,
          port: MEDIAMTX_PORTS.API_HTTPS.toString(),
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(10),
          healthyThresholdCount: 5,
        },
      }),
      rtsp: new elbv2.NetworkTargetGroup(this, 'RtspTargetGroup', {
        port: MEDIAMTX_PORTS.RTSP,
        protocol: elbv2.Protocol.TCP,
        vpc: props.vpc,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          protocol: elbv2.Protocol.TCP,
          port: MEDIAMTX_PORTS.API_HTTPS.toString(),
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(10),
          healthyThresholdCount: 5,
        },
      }),
      srts: new elbv2.NetworkTargetGroup(this, 'SrtsTargetGroup', {
        port: MEDIAMTX_PORTS.SRTS,
        protocol: elbv2.Protocol.UDP,
        vpc: props.vpc,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          protocol: elbv2.Protocol.TCP,
          port: MEDIAMTX_PORTS.API_HTTPS.toString(),
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(10),
          healthyThresholdCount: 5,
        },
      }),
      hls: new elbv2.NetworkTargetGroup(this, 'HlsTargetGroup', {
        port: MEDIAMTX_PORTS.HLS_HTTPS,
        protocol: elbv2.Protocol.TCP,
        vpc: props.vpc,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          protocol: elbv2.Protocol.TCP,
          port: MEDIAMTX_PORTS.API_HTTPS.toString(),
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(10),
          healthyThresholdCount: 5,
        },
      }),
      // API target group also handles WebRTC signalling (8889 → same container)
      // and Playback (9996 → same container), keeping us at exactly 5 groups.
      api: new elbv2.NetworkTargetGroup(this, 'ApiTargetGroup', {
        port: MEDIAMTX_PORTS.API_HTTPS,
        protocol: elbv2.Protocol.TCP,
        vpc: props.vpc,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          protocol: elbv2.Protocol.TCP,
          port: MEDIAMTX_PORTS.API_HTTPS.toString(),
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(10),
          healthyThresholdCount: 5,
        },
      }),
    };

    const enableInsecurePorts = props.enableInsecurePorts;

    // Create listeners
    if (enableInsecurePorts) {
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

    // Secure RTMPS listener (TLS terminated at NLB)
    this.loadBalancer.addListener('RtmpsListener', {
      port: MEDIAMTX_PORTS.RTMPS,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.rtmp],
    });

    // Secure RTSPS listener (TLS terminated at NLB)
    this.loadBalancer.addListener('RtspsListener', {
      port: MEDIAMTX_PORTS.RTSPS,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.rtsp],
    });

    // SRTS listener (SRT has built-in encryption)
    this.loadBalancer.addListener('SrtsListener', {
      port: MEDIAMTX_PORTS.SRTS,
      protocol: elbv2.Protocol.UDP,
      defaultTargetGroups: [this.targetGroups.srts],
    });

    // HLS HTTPS listener
    this.loadBalancer.addListener('HlsListener', {
      port: MEDIAMTX_PORTS.HLS_HTTPS,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.hls],
    });

    // API HTTPS listener
    this.loadBalancer.addListener('ApiListener', {
      port: MEDIAMTX_PORTS.API_HTTPS,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.api],
    });

    // Playback listener — shares api target group (same container, port 9997)
    this.loadBalancer.addListener('PlaybackListener', {
      port: 9996,
      protocol: elbv2.Protocol.TLS,
      certificates: [props.certificate],
      defaultTargetGroups: [this.targetGroups.api],
    });

    // WebRTC signalling listener — shares api target group (same container)
    // WebRTC ICE (8189) is NOT routed through the NLB; clients connect directly
    // to the ECS task public IP discovered via STUN.
    this.loadBalancer.addListener('WebRtcListener', {
      port: MEDIAMTX_PORTS.WEBRTC,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [this.targetGroups.api],
    });

    // Create Route53 A record
    new route53.ARecord(this, 'MediaARecord', {
      zone: props.hostedZone,
      recordName: props.mediaHostname,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(this.loadBalancer)
      ),
    });
  }
}
