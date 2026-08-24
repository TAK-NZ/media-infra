import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ContextEnvironmentConfig } from '../stack-config';
import { MEDIAMTX_PORTS } from '../utils/constants';
import type { InfrastructureConfig, NetworkConfig, SecretsConfig, StorageConfig } from '../construct-configs';

/** Where the EFS access point is mounted inside the container */
const EFS_MOUNT_PATH = '/opt/mediamtx';

/** Fallback when no MediaMTX version is configured; matches the Dockerfile default */
const DEFAULT_MEDIAMTX_VERSION = '1.19.0';

export interface MediaEcsServiceProps {
  environment: 'prod' | 'dev-test';
  envConfig: ContextEnvironmentConfig;
  infrastructure: InfrastructureConfig;
  network: NetworkConfig;
  secrets: SecretsConfig;
  storage: StorageConfig;
  stackNameComponent: string;
  /** EC2 capacity provider the service is scheduled onto */
  capacityProvider: ecs.AsgCapacityProvider;
  /**
   * Elastic IP advertised to WebRTC clients as an ICE candidate.
   *
   * Passed in rather than read from instance metadata: the container would
   * otherwise race the boot-time EIP association and could advertise the
   * instance's ephemeral public address instead.
   */
  iceAddress: string;
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
      const mediaMtxVersion = props.envConfig.mediamtx?.version ?? DEFAULT_MEDIAMTX_VERSION;

      const dockerAsset = new ecrAssets.DockerImageAsset(this, 'MediaMtxDockerAsset', {
        directory: '.',
        file: 'docker/media-infra/Dockerfile',
        // Must match the Graviton instance the capacity provider launches
        platform: ecrAssets.Platform.LINUX_ARM64,
        buildArgs: {
          // Drives both the runtime base image and the source build, so a single
          // configured version keeps the two in step.
          MEDIAMTX_BASE_IMAGE: `bluenviron/mediamtx:${mediaMtxVersion}-ffmpeg`,
          MEDIAMTX_BRANCH: `v${mediaMtxVersion}`,
        },
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
        // MediaMTX reads MTX_* variables directly. ICE candidates must reference
        // a routable address, and the instance's own interfaces only carry
        // private IPs.
        MTX_WEBRTCADDITIONALHOSTS: props.iceAddress,
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
      // A 10s interval rather than 30s. In practice the container is serving
      // about a second after it starts (MediaMTX binds every listener
      // immediately, and the Node API follows roughly a second later), yet a 30s
      // interval means the first probe does not run until t+30 and ECS does not
      // reach steady state for over a minute. This does not affect client-visible
      // downtime, because the target groups are attached to the ASG rather than
      // the service and so are not gated on this check; it affects how quickly a
      // deployment settles and, more importantly, how quickly the circuit breaker
      // notices a broken image.
      //
      // startPeriod stays generous on purpose. Failures inside the start period
      // do not count toward retries but a success still marks the container
      // healthy immediately, so a long start period costs nothing when startup is
      // fast while still protecting a cold image pull.
      healthCheck: {
        command: ['CMD-SHELL', `nc -z localhost ${MEDIAMTX_PORTS.API} || exit 1`],
        interval: cdk.Duration.seconds(10),
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
    //
    // The TLS listener ports (RTMPS 1936, RTSPS 8555) are absent: those terminate
    // at the load balancer, which forwards to the plaintext ports below.
    container.addPortMappings(
      { containerPort: MEDIAMTX_PORTS.RTMP, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.RTSP, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.SRTS, protocol: ecs.Protocol.UDP },
      { containerPort: MEDIAMTX_PORTS.PLAYBACK, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.API, protocol: ecs.Protocol.TCP },
      { containerPort: MEDIAMTX_PORTS.WEBRTC, protocol: ecs.Protocol.TCP },
      // ICE bypasses the load balancer and is reached directly on the Elastic IP.
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
      // Stop the old task before starting the new one. This looks like the
      // wrong choice for availability, but 100/200 deadlocks here and buys
      // nothing:
      //
      // The task uses host network mode, so it owns host ports 1935, 8554,
      // 8889, 8890, 9996, 9997 and 8189 exclusively; a second task cannot be
      // placed on the same instance. The ASG is capped at one instance (see
      // media-ec2-compute), so there is nowhere else to put it either. Demanding
      // 100% healthy therefore asks ECS to start a replacement it can never
      // place while refusing to stop the task holding the ports, and the
      // deployment spins until the circuit breaker rolls it back.
      //
      // Keeping the old task alive would not preserve streams anyway. A stream
      // lives inside the single MediaMTX process it was published to, and there
      // is no session migration, so publishers are dropped by the cutover
      // regardless. A short, clean interruption is the honest outcome.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // ECS rejects maxHealthyPercent <= 100 while Availability Zone Rebalancing
      // is on, and it defaults to on for new services. Rebalancing has nothing
      // to do here anyway: there is a single task on a single instance, so there
      // is no uneven AZ distribution to correct, and letting ECS move the task
      // between AZs is precisely the instance churn this stack avoids.
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.DISABLED,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      enableExecuteCommand: props.envConfig.ecs.enableEcsExec ?? false,
      circuitBreaker: { rollback: true },
    });
  }
}
