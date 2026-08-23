/**
 * Stack outputs registration following TAK.NZ pattern
 */

import * as cdk from 'aws-cdk-lib';

export interface OutputsConfig {
  stack: cdk.Stack;
  stackName: string;
  /** Elastic IP that DNS resolves to; the media server is reached directly on this address */
  mediaIp: string;
  mediaUrl: string;
  ecsServiceArn: string;
  certificateArn: string;
}

export function registerOutputs(config: OutputsConfig): void {
  const { stack, stackName, mediaIp, mediaUrl, ecsServiceArn, certificateArn } = config;

  // Static Elastic IP for the media EC2 instance
  new cdk.CfnOutput(stack, 'MediaIpOutput', {
    value: mediaIp,
    description: 'Static Elastic IP of the MediaMTX server',
    exportName: `${stackName}-MediaIp`,
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

  // Exportable certificate used by the container to terminate TLS
  new cdk.CfnOutput(stack, 'MediaCertificateArnOutput', {
    value: certificateArn,
    description: 'Exportable ACM certificate ARN used by the media service',
    exportName: `${stackName}-MediaCertificateArn`,
  });
}
