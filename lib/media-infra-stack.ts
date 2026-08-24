import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps, Fn } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';

// Construct imports
import { MediaSecurityGroups } from './constructs/media-security-groups';
import { MediaNlb } from './constructs/media-nlb';
import { MediaEndpoint } from './constructs/media-endpoint';
import { MediaEc2Compute } from './constructs/media-ec2-compute';
import { MediaEcsService } from './constructs/media-ecs-service';
import { MediaEfs } from './constructs/media-efs';
import { MEDIAMTX_PORTS } from './utils/constants';

// Utility imports
import { ContextEnvironmentConfig } from './stack-config';
import { validateEnvType, validateStackName, validateMediaMtxConfig } from './utils/validation';
import {
  createBaseImportValue,
  createCloudTakImportValue,
  BASE_EXPORT_NAMES,
  CLOUDTAK_EXPORT_NAMES
} from './cloudformation-imports';
import type { InfrastructureConfig, NetworkConfig, SecretsConfig, StorageConfig } from './construct-configs';

export interface MediaInfraStackProps extends StackProps {
  environment: 'prod' | 'dev-test';
  envConfig: ContextEnvironmentConfig;
}

/**
 * Main CDK stack for the TAK Media Infrastructure.
 *
 * MediaMTX runs on an EC2-backed ECS capacity provider using `host` network
 * mode. Two distinct client paths reach it:
 *
 *   - A Network Load Balancer terminates TLS for every client-facing port and
 *     forwards plaintext into the VPC. This is the only name in DNS.
 *   - WebRTC ICE reaches a static Elastic IP on the instance directly, because
 *     ICE requires direct UDP connectivity that no load balancer can proxy.
 *     Clients learn that address inside the WebRTC negotiation.
 *
 * `host` network mode on EC2 is what makes the second path possible, and is why
 * this does not run on Fargate.
 *
 * Foundational resources (VPC, KMS key, certificate, hosted zone, ECR repo) are
 * imported from BaseInfra; secrets and the CloudTAK service URL come from the
 * CloudTAK stack. The ECS cluster is owned by this stack because EC2 capacity
 * providers are cluster-scoped.
 */
export class MediaInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MediaInfraStackProps) {
    super(scope, id, {
      ...props,
      description: 'TAK Media Layer - MediaMTX Streaming Server on EC2 with WebRTC',
    });

    // Validate configuration early
    validateEnvType(props.environment);
    validateStackName(props.envConfig.stackName);
    validateMediaMtxConfig(props.envConfig);

    const { envConfig } = props;

    const stackNameComponent = envConfig.stackName;
    const resolvedStackName = id;
    const region = cdk.Stack.of(this).region;
    const enableInsecurePorts = envConfig.enableInsecurePorts;
    const usePreBuiltImages = envConfig.usePreBuiltImages;
    const retainOnDelete = envConfig.general.removalPolicy.toUpperCase() === 'RETAIN';

    // =================
    // IMPORT BASE INFRASTRUCTURE RESOURCES
    // =================

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'VPC', {
      vpcId: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.VPC_ID)),
      availabilityZones: [region + 'a', region + 'b'],
      publicSubnetIds: [
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PUBLIC_A)),
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PUBLIC_B))
      ],
      privateSubnetIds: [
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PRIVATE_A)),
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PRIVATE_B))
      ],
      vpcCidrBlock: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.VPC_CIDR_IPV4))
    });

    // Shared ACM certificate. Used by the load balancer, which integrates with
    // ACM natively — the certificate never needs to leave AWS.
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate',
      Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.CERTIFICATE_ARN))
    );

    // Route53 Hosted Zone
    const hostedZoneId = Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.HOSTED_ZONE_ID));
    const hostedZoneName = Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.HOSTED_ZONE_NAME));
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: hostedZoneId,
      zoneName: hostedZoneName,
    });

    // KMS Key for EFS and secrets encryption
    const kmsKey = kms.Key.fromKeyArn(this, 'KmsKey',
      Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.KMS_KEY))
    );

    // =================
    // IMPORT SECRETS FROM CLOUDTAK
    // =================

    const signingSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'SigningSecret',
      Fn.importValue(createCloudTakImportValue(stackNameComponent, CLOUDTAK_EXPORT_NAMES.SIGNING_SECRET))
    );

    const mediaSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'MediaSecret',
      Fn.importValue(createCloudTakImportValue(stackNameComponent, CLOUDTAK_EXPORT_NAMES.MEDIA_SECRET))
    );

    const cloudTakUrl = Fn.importValue(createCloudTakImportValue(stackNameComponent, CLOUDTAK_EXPORT_NAMES.SERVICE_URL));

    // =================
    // CONTAINER IMAGE STRATEGY
    // =================

    let containerImageUri: string | undefined;
    if (usePreBuiltImages) {
      const mediamtxImageTag = this.node.tryGetContext('mediamtxImageTag') ?? envConfig.docker?.mediamtxImageTag ?? 'latest';
      const ecrRepoArn = Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.ECR_REPO));
      const ecrRepoName = Fn.select(1, Fn.split('/', ecrRepoArn));
      containerImageUri = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${cdk.Token.asString(ecrRepoName)}:${mediamtxImageTag}`;
    }

    // =================
    // EXTRACT MEDIA HOSTNAME FROM CLOUDTAK EXPORT
    // =================

    const mediaUrlExport = Fn.importValue(createCloudTakImportValue(stackNameComponent, 'MediaUrl'));
    const mediaHostname = Fn.select(0, Fn.split('.', Fn.select(2, Fn.split('/', mediaUrlExport))));
    const mediaFqdn = `${mediaHostname}.${hostedZoneName}`;

    // =================
    // CREATE SECURITY GROUPS
    // =================

    const securityGroups = new MediaSecurityGroups(this, 'SecurityGroups', {
      vpc,
      stackNameComponent,
      enableInsecurePorts,
    });

    // =================
    // CREATE EFS
    // =================

    const mediaEfs = new MediaEfs(this, 'MediaEfs', {
      vpc,
      kmsKey,
      stackNameComponent,
      efsSecurityGroup: securityGroups.efs,
      retainOnDelete,
    });

    // =================
    // CREATE WEBRTC ICE ENDPOINT (ELASTIC IP)
    // =================

    // Created before the compute layer: the instance user data needs the EIP
    // allocation ID so it can associate the address to itself at boot.
    const endpoint = new MediaEndpoint(this, 'MediaEndpoint', {
      stackNameComponent,
    });

    // =================
    // CREATE NETWORK LOAD BALANCER
    // =================

    const nlb = new MediaNlb(this, 'MediaNlb', {
      vpc,
      certificate,
      hostedZone,
      mediaHostname,
      stackNameComponent,
      enableInsecurePorts,
      nlbSecurityGroup: securityGroups.nlb,
    });

    // =================
    // CREATE EC2 CAPACITY (CLUSTER + ASG + CAPACITY PROVIDER)
    // =================

    const compute = new MediaEc2Compute(this, 'MediaCompute', {
      vpc,
      envConfig,
      stackNameComponent,
      instanceSecurityGroup: securityGroups.instance,
      elasticIp: endpoint.elasticIp,
      targetGroups: nlb.allTargetGroups(),
    });

    // =================
    // STRUCTURED CONFIGURATION OBJECTS
    // =================

    const infrastructure: InfrastructureConfig = {
      vpc,
      ecsCluster: compute.cluster,
      kmsKey,
      securityGroups: {
        instance: securityGroups.instance,
        nlb: securityGroups.nlb,
        efs: securityGroups.efs
      }
    };

    const network: NetworkConfig = {
      hostedZone,
      certificate,
      mediaHostname,
      hostedZoneName
    };

    const secrets: SecretsConfig = {
      signingSecret,
      mediaSecret,
      cloudTakUrl
    };

    const storage: StorageConfig = {
      efs: {
        fileSystemId: mediaEfs.fileSystem.fileSystemId,
        accessPointId: mediaEfs.accessPoint.accessPointId
      }
    };

    // =================
    // CREATE MEDIAMTX ECS SERVICE
    // =================

    const mediaService = new MediaEcsService(this, 'MediaEcsService', {
      environment: props.environment,
      envConfig,
      infrastructure,
      network,
      secrets,
      storage,
      stackNameComponent,
      capacityProvider: compute.capacityProvider,
      iceAddress: endpoint.ipAddress,
      containerImageUri
    });

    // The EFS mount targets must exist before a task tries to mount them.
    mediaService.service.node.addDependency(mediaEfs.fileSystem.mountTargetsAvailable);

    // =================
    // STACK OUTPUTS
    // =================

    new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
      value: nlb.loadBalancer.loadBalancerDnsName,
      description: 'Network Load Balancer DNS name',
      exportName: `${resolvedStackName}-LoadBalancerDnsName`
    });

    new cdk.CfnOutput(this, 'WebRtcIceIp', {
      value: endpoint.ipAddress,
      description: 'Elastic IP advertised to WebRTC clients as an ICE candidate',
      exportName: `${resolvedStackName}-WebRtcIceIp`
    });

    new cdk.CfnOutput(this, 'MediaUrl', {
      value: `https://${mediaFqdn}:${MEDIAMTX_PORTS.API}`,
      description: 'MediaMTX API HTTPS URL',
      exportName: `${resolvedStackName}-MediaUrl`
    });

    new cdk.CfnOutput(this, 'EcsServiceArn', {
      value: mediaService.service.serviceArn,
      description: 'MediaMTX ECS Service ARN',
      exportName: `${resolvedStackName}-EcsServiceArn`
    });

    new cdk.CfnOutput(this, 'EfsFileSystemId', {
      value: mediaEfs.fileSystem.fileSystemId,
      description: 'EFS File System ID for MediaMTX state',
      exportName: `${resolvedStackName}-EfsFileSystemId`
    });

    new cdk.CfnOutput(this, 'MediaHostname', {
      value: mediaFqdn,
      description: 'MediaMTX fully qualified hostname',
      exportName: `${resolvedStackName}-MediaHostname`
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: compute.cluster.clusterName,
      description: 'Dedicated ECS cluster for the media service',
      exportName: `${resolvedStackName}-EcsClusterName`
    });
  }
}
