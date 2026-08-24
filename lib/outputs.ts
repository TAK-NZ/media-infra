/**
 * Stack outputs registration following TAK.NZ pattern
 */

import * as cdk from 'aws-cdk-lib';

export interface OutputsConfig {
  stack: cdk.Stack;
  stackName: string;
  /** Load balancer DNS name; the media hostname aliases to this */
  nlbDnsName: string;
  /** Elastic IP advertised to WebRTC clients as an ICE candidate */
  webRtcIceIp: string;
  mediaUrl: string;
  ecsServiceArn: string;
}

export function registerOutputs(config: OutputsConfig): void {
  const { stack, stackName, nlbDnsName, webRtcIceIp, mediaUrl, ecsServiceArn } = config;

  // Network Load Balancer DNS name
  new cdk.CfnOutput(stack, 'LoadBalancerDnsNameOutput', {
    value: nlbDnsName,
    description: 'Network Load Balancer DNS name',
    exportName: `${stackName}-LoadBalancerDnsName`,
  });

  // WebRTC ICE address. Not published in DNS — clients receive it inside the
  // WebRTC negotiation, since ICE cannot traverse the load balancer.
  new cdk.CfnOutput(stack, 'WebRtcIceIpOutput', {
    value: webRtcIceIp,
    description: 'Elastic IP advertised to WebRTC clients as an ICE candidate',
    exportName: `${stackName}-WebRtcIceIp`,
  });

  // Media Service URL
  new cdk.CfnOutput(stack, 'MediaUrlOutput', {
    value: mediaUrl,
    description: 'MediaMTX service URL',
    exportName: `${stackName}-MediaUrl`,
  });

  // ECS Service ARN
  new cdk.CfnOutput(stack, 'EcsServiceArnOutput', {
    value: ecsServiceArn,
    description: 'MediaMTX ECS service ARN',
    exportName: `${stackName}-EcsServiceArn`,
  });
}
