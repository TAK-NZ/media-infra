import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface MediaEfsProps {
  vpc: ec2.IVpc;
  kmsKey: kms.IKey;
  stackNameComponent: string;
  efsSecurityGroup: ec2.SecurityGroup;
  /** Whether to retain the file system when the stack is deleted */
  retainOnDelete: boolean;
}

/**
 * Persistent storage for MediaMTX runtime state and recordings.
 *
 * Mount targets stay in the private subnets even though the container instance
 * runs in a public one. EFS mount targets are per Availability Zone, not per
 * subnet: one mount target per AZ serves every instance in that AZ regardless of
 * which subnet it sits in.
 * https://docs.aws.amazon.com/efs/latest/ug/accessing-fs.html
 *
 * Keeping them private also avoids putting the file system's network interfaces
 * on a public subnet for no benefit.
 */
export class MediaEfs extends Construct {
  public readonly fileSystem: efs.FileSystem;
  public readonly accessPoint: efs.AccessPoint;

  constructor(scope: Construct, id: string, props: MediaEfsProps) {
    super(scope, id);

    this.fileSystem = new efs.FileSystem(this, 'MediaEfsFileSystem', {
      vpc: props.vpc,
      encrypted: true,
      kmsKey: props.kmsKey,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      removalPolicy: props.retainOnDelete
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroup: props.efsSecurityGroup,
    });

    this.accessPoint = new efs.AccessPoint(this, 'MediaMtxAccessPoint', {
      fileSystem: this.fileSystem,
      path: '/mediamtx',
      createAcl: {
        ownerUid: '1000',
        ownerGid: '1000',
        permissions: '755',
      },
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
    });
  }
}
