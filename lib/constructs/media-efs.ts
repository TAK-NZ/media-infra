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
 * Mount targets sit in the public subnets because that is where the EC2
 * container instance runs — it needs a public IP for the Elastic IP association
 * and for WebRTC ICE candidates to be reachable. A mount target must exist in
 * the same subnet as the client that mounts it.
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
        subnetType: ec2.SubnetType.PUBLIC,
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
