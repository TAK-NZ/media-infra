import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { ContextEnvironmentConfig } from '../stack-config';
import { MEDIAMTX_PORTS } from '../utils/constants';
import type { InfrastructureConfig, NetworkConfig, SecretsConfig, StorageConfig } from '../construct-configs';

/** Where the EFS access point is mounted inside the container */
const EFS_MOUNT_PATH = '/opt/mediamtx';

export interface MediaEcsServiceProps {
  environment: 'prod' | 'dev-test';
  envConfig: ContextEnvironmentConfig;
  infrastructure: InfrastructureConfig;
  network: NetworkConfig;
  secrets: SecretsConfig;
  storage: StorageConfig;
  stackNameComponent: string;
  /** Exportable certificate the container uses to terminate TLS itself */
  certificate: acm.ICertificate;
  /** EC2 capacity provider the service is scheduled onto */
  capacityProvider: ecs.AsgCapacityProvider;
  containerImageUri?: string;
}

/**
 * MediaMTX service running on EC2 with `host` network mode.
 *
 * Host networking is required for WebRTC ICE, which needs direct UDP
 * connectivity between the client and the server. Under Fargate awsvpc the
 * container sits behind an ENI that cannot provide that path, which is why this
 * runs on EC2 despite the extra capacity management.
 *
 * With host networking the container binds directly to the instance's network
 * interface, so container ports are the ports clients connect to and TLS is
 * terminated inside the container using the exported ACM certificate.
 */
export class MediaEcsService extends Construct {
  public readonly service: ecs.Ec2Service;
  public readonly taskDefinition: ecs.Ec2TaskDefinition;

  constructor(scope: Construct, id: string, props: MediaEcsServiceProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'MediaMtxLogGroup', {
      logGroupName: `/aws/ecs/TAK-${props.stackNameComponent}-MediaMTX`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskRole = new iam.Role(this, 'MediaMtxTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:ClientRootAccess',
        'elasticfilesystem:DescribeMountTargets',
        'elasticfilesystem:DescribeFileSystems',
      ],
      resources: [
        `arn:aws:elasticfilesystem:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:file-system/${props.storage.efs.fileSystemId}`,
        `arn:aws:elasticfilesystem:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:access-point/${props.storage.efs.accessPointId}`,
      ],
    }));

    // The entrypoint exports the certificate at startup so MediaMTX and the
    // Node API server can serve TLS. Scoped to this stack's certificate only.
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'acm:DescribeCertificate',
        'acm:ExportCertificate',
        'acm:GetCertificate',
      ],
      resources: [props.certificate.certificateArn],
    }));

    const executionRole = new iam.Role(this, 'MediaMtxExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    this.taskDefinition = new ecs.Ec2TaskDefinition(this, 'MediaMtxTaskDef', {
      // Container ports bind straight to the instance interface, giving WebRTC
      // ICE the direct UDP path it needs.
      networkMode: ecs.NetworkMode.HOST,
      taskRole,
      executionRole,
    });

    this.taskDefinition.addVolume({
      name: 'mediamtx-config',
      efsVolumeConfiguration: {
        fileSystemId: props.storage.efs.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: props.storage.efs.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    let containerImage: ecs.ContainerImage;

    if (props.containerImageUri) {
      containerImage = ecs.ContainerImage.fromRegistry(props.containerImageUri);
    } else {
      const dockerAsset = new ecrAssets.DockerImageAsset(this, 'MediaMtxDockerAsset', {
        directory: '.',
        file: 'docker/media-infra/Dockerfile',
        // Must match the Graviton instance the capacity provider launches
        platform: ecrAssets.Platform.LINUX_ARM64,
        exclude: [
          'node_modules/**',
          'cdk.out/**',
          '.cdk.staging/**',
          '**/*.log',
          '**/*.tmp',
          '.git/**',
          '.vscode/**',
          '.idea/**',
          'test/**',
          'docs/**',
          'coverage/**',
          'lib/**/*.js',
          'lib/**/*.d.ts',
          'lib/**/*.js.map',
          'bin/**/*.js',
          'bin/**/*.d.ts',
          '**/.DS_Store',
          '**/Thumbs.db',
        ],
      });
      containerImage = ecs.ContainerImage.fromDockerImageAsset(dockerAsset);
    }

    const container = this.taskDefinition.addContainer('MediaMtxContainer', {
      image: containerImage,
      // Required on EC2 task definitions: the task-level CPU/memory that
      // Fargate infers must be declared per container here.
      cpu: props.envConfig.ecs.taskCpu,
      memoryLimitMiB: props.envConfig.ecs.taskMemory,
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'mediamtx',
        logGroup,
      }),
      environment: {
        API_URL: props.secrets.cloudTakUrl,
        CLOUDTAK_Config_media_url: `https://${props.network.mediaHostname}.${props.network.hostedZoneName}`,
        ACM_CERTIFICATE_ARN: props.certificate.certificateArn,
        LOG_LEVEL: props.envConfig.logLevel ?? 'info',
        StackName: cdk.Stack.of(this).stackName,
        Environment: props.stackNameComponent,
        // Not injected automatically on EC2 the way they are on Fargate; the
        // entrypoint's AWS CLI calls need them.
        AWS_DEFAULT_REGION: cdk.Stack.of(this).region,
        AWS_REGION: cdk.Stack.of(this).region,
      },
      secrets: {
        SigningSecret: ecs.Secret.fromSecretsManager(props.secrets.signingSecret),
        MediaSecret: ecs.Secret.fromSecretsManager(props.secrets.mediaSecret),
      },
      healthCheck: {
        command: ['CMD-SHELL', `nc -z localhost ${MEDIAMTX_PORTS.API} || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addMountPoints({
      containerPath: EFS_MOUNT_PATH,
      sourceVolume: 'mediamtx-config',
      readOnly: false,
    });

    // Under host networking the host port always equals the container port.
    container.addPortMappings(
      { containerPort: MEDIAMTX_PORTS.RTMP, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.RTMPS, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.RTSP, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.RTSPS, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.SRTS, protocol: ecs.Protocol.UDP },
      { containerPort: MEDIAMTX_PORTS.PLAYBACK, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.API, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.WEBRTC, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.WEBRTC_ICE, protocol: ecs.Protocol.UDP },
      { containerPort: MEDIAMTX_PORTS.WEBRTC_ICE, protocol: ecs.Protocol.TCP },
    );

    props.secrets.signingSecret.grantRead(taskRole);
    props.secrets.mediaSecret.grantRead(taskRole);

    props.infrastructure.kmsKey.grantDecrypt(taskRole);
    props.infrastructure.kmsKey.grantDecrypt(executionRole);

    if (props.envConfig.ecs.enableEcsExec) {
      taskRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      );

      taskRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      }));
    }

    this.service = new ecs.Ec2Service(this, 'MediaMtxService', {
      cluster: props.infrastructure.ecsCluster,
      taskDefinition: this.taskDefinition,
      desiredCount: props.envConfig.ecs.desiredCount,
      capacityProviderStrategies: [{
        capacityProvider: props.capacityProvider.capacityProviderName,
        weight: 1,
      }],
      // Never drop below full capacity mid-deployment: a restarting media
      // server drops every in-flight stream.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      enableExecuteCommand: props.envConfig.ecs.enableEcsExec ?? false,
      circuitBreaker: { rollback: true },
    });
  }
}
