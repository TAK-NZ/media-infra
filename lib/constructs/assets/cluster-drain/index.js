'use strict';

// Handlers for the custom resource that empties the media ECS cluster when the stack is deleted.
//
// Why this exists: CloudFormation removes the capacity provider from the cluster
// (AWS::ECS::ClusterCapacityProviderAssociations) before it deletes the Auto Scaling group, and ECS refuses
// that while a container instance is still registered ("The specified capacity provider is in use"). The
// group has a minimum of one instance and ECS managed scaling never removes the last one, so the delete
// failed every time. This resource is deleted just before the association: it sets the group to zero
// instances and waits until the instance has deregistered from the cluster.
//
// Create and Update do nothing. The physical id never changes, so a property change is an in-place update
// and never scales the group down.
//
// The AWS SDK calls are injected (see createHandlers) so the logic can be tested without AWS.

function createHandlers(deps) {
  async function onEvent(event) {
    const { ClusterName, AutoScalingGroupName } = event.ResourceProperties;
    const physicalId = event.PhysicalResourceId || `${ClusterName}/${AutoScalingGroupName}`;

    if (event.RequestType === 'Delete') {
      try {
        await deps.setAsgToZero(AutoScalingGroupName);
      } catch (error) {
        // The group is already gone (for example an earlier, partly failed delete): nothing to scale down.
        if (!(error && error.name === 'ValidationError' && /not found|does not exist/i.test(error.message || ''))) {
          throw error;
        }
      }
    }
    return { PhysicalResourceId: physicalId };
  }

  async function isComplete(event) {
    if (event.RequestType !== 'Delete') {
      return { IsComplete: true };
    }
    const { ClusterName } = event.ResourceProperties;
    let count;
    try {
      count = await deps.countContainerInstances(ClusterName);
    } catch (error) {
      // No cluster means no container instances.
      if (error && error.name === 'ClusterNotFoundException') {
        return { IsComplete: true };
      }
      throw error;
    }
    return { IsComplete: count === 0 };
  }

  return { onEvent, isComplete };
}

// The AWS SDK v3 is part of the Lambda Node.js runtime. It is loaded on first use, not at module load.
function awsDeps() {
  return {
    async setAsgToZero(autoScalingGroupName) {
      const { AutoScalingClient, UpdateAutoScalingGroupCommand } = require('@aws-sdk/client-auto-scaling');
      await new AutoScalingClient({}).send(new UpdateAutoScalingGroupCommand({
        AutoScalingGroupName: autoScalingGroupName,
        MinSize: 0,
        DesiredCapacity: 0,
      }));
    },
    async countContainerInstances(clusterName) {
      const { ECSClient, ListContainerInstancesCommand } = require('@aws-sdk/client-ecs');
      const response = await new ECSClient({}).send(new ListContainerInstancesCommand({ cluster: clusterName }));
      return (response.containerInstanceArns || []).length;
    },
  };
}

const handlers = createHandlers({
  setAsgToZero: (name) => awsDeps().setAsgToZero(name),
  countContainerInstances: (name) => awsDeps().countContainerInstances(name),
});

exports.createHandlers = createHandlers;
exports.onEvent = handlers.onEvent;
exports.isComplete = handlers.isComplete;
