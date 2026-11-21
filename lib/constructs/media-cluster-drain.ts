import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface MediaClusterDrainProps {
  readonly cluster: ecs.ICluster;
  readonly autoScalingGroup: autoscaling.IAutoScalingGroup;
}

/**
 * Empties the media ECS cluster when the stack is deleted, so the capacity provider can be removed.
 *
 * CloudFormation removes the capacity provider from the cluster before it deletes the Auto Scaling group,
 * and ECS refuses while a container instance is registered. The group keeps a minimum of one instance and
 * managed scaling never removes the last one, so deleting the stack failed with "The specified capacity
 * provider is in use" and needed a manual scale-down.
 *
 * This custom resource does nothing on create and update. On delete it sets the group to zero instances and
 * waits (up to 15 minutes) until no container instance is registered. It depends on the cluster and on the
 * Auto Scaling group with its drain hook, so it is deleted before them, while the drain hook still works.
 * Make the ECS service depend on this construct, so the service is deleted before the instance is removed.
 */
export class MediaClusterDrain extends Construct {
  constructor(scope: Construct, id: string, props: MediaClusterDrainProps) {
    super(scope, id);

    const code = lambda.Code.fromAsset(path.join(__dirname, 'assets', 'cluster-drain'));
    const runtime = lambda.Runtime.NODEJS_22_X;

    const onEventHandler = new lambda.Function(this, 'OnEvent', {
      runtime,
      handler: 'index.onEvent',
      code,
      timeout: cdk.Duration.minutes(1),
      description: 'Sets the media Auto Scaling group to zero instances when the stack is deleted',
    });
    onEventHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['autoscaling:UpdateAutoScalingGroup'],
      resources: [props.autoScalingGroup.autoScalingGroupArn],
    }));

    const isCompleteHandler = new lambda.Function(this, 'IsComplete', {
      runtime,
      handler: 'index.isComplete',
      code,
      timeout: cdk.Duration.minutes(1),
      description: 'Waits until no container instance is registered in the media cluster',
    });
    isCompleteHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:ListContainerInstances'],
      resources: [props.cluster.clusterArn],
    }));

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler,
      isCompleteHandler,
      queryInterval: cdk.Duration.seconds(15),
      totalTimeout: cdk.Duration.minutes(15),
    });

    const resource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        ClusterName: props.cluster.clusterName,
        AutoScalingGroupName: props.autoScalingGroup.autoScalingGroupName,
      },
    });

    // Deleted before the cluster (and its capacity provider association) and before the group with its drain
    // hook, so the hook can still drain the instance when this resource scales the group down.
    resource.node.addDependency(props.cluster);
    resource.node.addDependency(props.autoScalingGroup);
  }
}
