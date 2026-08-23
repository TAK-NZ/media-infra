import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ContextEnvironmentConfig } from '../stack-config';
import { MEDIAMTX_PORTS } from '../utils/constants';

export interface MediaEc2ComputeProps {
  vpc: ec2.IVpc;
  envConfig: ContextEnvironmentConfig;
  stackNameComponent: string;
  /** Security group applied to the container instance */
  instanceSecurityGroup: ec2.SecurityGroup;
  /** Static Elastic IP the instance attaches to itself once healthy */
  elasticIp: ec2.CfnEIP;
}

/**
 * EC2-backed ECS capacity for the MediaMTX media server.
 *
 * A dedicated cluster is created here rather than reusing the shared BaseInfra
 * cluster: EC2 capacity providers are cluster-scoped, and the shared cluster is
 * Fargate-only. The media server needs EC2 with `host` network mode so WebRTC
 * ICE gets the direct UDP path it requires.
 *
 * Instances run in public subnets with a public IP and self-associate the
 * Elastic IP that DNS points at, so no load balancer sits in the media path.
 */
export class MediaEc2Compute extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly capacityProvider: ecs.AsgCapacityProvider;
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;

  constructor(scope: Construct, id: string, props: MediaEc2ComputeProps) {
    super(scope, id);

    // Dedicated ECS cluster — EC2 capacity providers cannot attach to the
    // shared Fargate-only cluster exported by BaseInfra.
    this.cluster = new ecs.Cluster(this, 'MediaCluster', {
      clusterName: `TAK-${props.stackNameComponent}-Media`,
      vpc: props.vpc,
      containerInsightsV2: props.envConfig.general.enableContainerInsights
        ? ecs.ContainerInsights.ENHANCED
        : ecs.ContainerInsights.DISABLED,
    });

    // Instance role: ECS agent registration, SSM for ECS Exec, and the
    // ec2:AssociateAddress needed by the EIP association unit in user data.
    const instanceRole = new iam.Role(this, 'MediaInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    instanceRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:AssociateAddress',
        'ec2:DescribeAddresses',
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    }));

    const userData = ec2.UserData.custom(
      this.renderUserData({
        clusterName: this.cluster.clusterName,
        region: cdk.Stack.of(this).region,
        allocationId: props.elasticIp.attrAllocationId,
        apiPort: MEDIAMTX_PORTS.API,
      })
    );

    // An explicit launch template rather than letting the ASG default to a
    // launch configuration: those are legacy, unavailable to newer AWS accounts,
    // and do not support current instance types.
    const launchTemplate = new ec2.LaunchTemplate(this, 'MediaLaunchTemplate', {
      instanceType: new ec2.InstanceType(props.envConfig.ec2.instanceType),
      // ARM64 (Graviton) to match the container image architecture
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(ecs.AmiHardwareType.ARM),
      securityGroup: props.instanceSecurityGroup,
      role: instanceRole,
      userData,
      // Needed for the EIP association and for WebRTC ICE candidates to be
      // reachable from outside the VPC.
      associatePublicIpAddress: true,
      requireImdsv2: true,
    });

    this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'MediaAsg', {
      vpc: props.vpc,
      // Public subnets: the instance carries the public Elastic IP directly.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: props.envConfig.ec2.minCapacity,
      maxCapacity: props.envConfig.ec2.maxCapacity,
      // desiredCapacity is deliberately unset: the capacity provider's managed
      // scaling owns it, and pinning it here would reset the group on every
      // deployment and fight with ECS.
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: cdk.Duration.seconds(300),
      }),
    });

    this.capacityProvider = new ecs.AsgCapacityProvider(this, 'MediaCapacityProvider', {
      autoScalingGroup: this.autoScalingGroup,
      enableManagedScaling: true,
      targetCapacityPercent: 100,
      minimumScalingStepSize: 1,
      maximumScalingStepSize: 1,
      instanceWarmupPeriod: 300,
      // Left disabled so the ASG can replace unhealthy instances without ECS
      // holding termination back.
      enableManagedTerminationProtection: false,
    });

    this.cluster.addAsgCapacityProvider(this.capacityProvider);
  }

  /**
   * Load the user data template and substitute deployment-specific values.
   *
   * Distinctive `__NAME__` placeholders are used rather than `${NAME}` so they
   * cannot collide with the shell's own parameter expansion inside the script.
   */
  private renderUserData(values: {
    clusterName: string;
    region: string;
    allocationId: string;
    apiPort: number;
  }): string {
    const templatePath = path.join(__dirname, 'assets', 'media-instance-userdata.sh');
    const template = fs.readFileSync(templatePath, 'utf8');

    return template
      .replace(/__CLUSTER_NAME__/g, values.clusterName)
      .replace(/__AWS_REGION__/g, values.region)
      .replace(/__EIP_ALLOCATION_ID__/g, values.allocationId)
      .replace(/__API_PORT__/g, String(values.apiPort));
  }
}
