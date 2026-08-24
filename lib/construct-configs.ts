/**
 * Configuration interfaces for MediaInfra constructs
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Infrastructure configuration
 */
export interface InfrastructureConfig {
  vpc: ec2.IVpc;
  /** Dedicated EC2-backed cluster created by this stack */
  ecsCluster: ecs.ICluster;
  kmsKey: kms.IKey;
  securityGroups: {
    /** Applied to the EC2 container instance; with host networking this fronts the container */
    instance: ec2.SecurityGroup;
    /** Applied to the Network Load Balancer */
    nlb: ec2.SecurityGroup;
    efs: ec2.SecurityGroup;
  };
}

/**
 * Network configuration
 */
export interface NetworkConfig {
  hostedZone: route53.IHostedZone;
  certificate: acm.ICertificate;
  mediaHostname: string;
  hostedZoneName: string;
}

/**
 * Secrets configuration
 */
export interface SecretsConfig {
  signingSecret: secretsmanager.ISecret;
  mediaSecret: secretsmanager.ISecret;
  cloudTakUrl: string;
}

/**
 * Storage configuration
 */
export interface StorageConfig {
  efs: {
    fileSystemId: string;
    accessPointId: string;
  };
}