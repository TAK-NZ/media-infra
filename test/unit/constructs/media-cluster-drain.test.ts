import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MediaInfraStack } from '../../../lib/media-infra-stack';
import { mockDevConfig } from '../../__fixtures__/mock-configs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHandlers } = require('../../../lib/constructs/assets/cluster-drain/index.js');

const props = { ClusterName: 'TAK-Dev-Media', AutoScalingGroupName: 'TAK-Dev-MediaInfra-Asg' };

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const deps = {
    setAsgToZero: async (name: string) => { calls.push(`setAsgToZero ${name}`); },
    countContainerInstances: async () => 0,
    ...overrides,
  };
  return { deps, calls };
}

describe('cluster drain handlers', () => {
  test.each(['Create', 'Update'])('%s does not scale anything down', async (RequestType) => {
    const { deps, calls } = fakeDeps();
    const { onEvent } = createHandlers(deps);
    const result = await onEvent({ RequestType, ResourceProperties: props, PhysicalResourceId: RequestType === 'Update' ? 'existing-id' : undefined });
    expect(calls).toEqual([]);
    expect(result.PhysicalResourceId).toBe(RequestType === 'Update' ? 'existing-id' : 'TAK-Dev-Media/TAK-Dev-MediaInfra-Asg');
  });

  test('Delete sets the Auto Scaling group to zero', async () => {
    const { deps, calls } = fakeDeps();
    await createHandlers(deps).onEvent({ RequestType: 'Delete', ResourceProperties: props, PhysicalResourceId: 'id' });
    expect(calls).toEqual(['setAsgToZero TAK-Dev-MediaInfra-Asg']);
  });

  test('Delete succeeds when the group no longer exists', async () => {
    const error = Object.assign(new Error('AutoScalingGroup name not found - null'), { name: 'ValidationError' });
    const { deps } = fakeDeps({ setAsgToZero: async () => { throw error; } });
    await expect(createHandlers(deps).onEvent({ RequestType: 'Delete', ResourceProperties: props, PhysicalResourceId: 'id' }))
      .resolves.toEqual({ PhysicalResourceId: 'id' });
  });

  test('Delete fails on other errors, so the stack does not report a clean delete', async () => {
    const { deps } = fakeDeps({ setAsgToZero: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); } });
    await expect(createHandlers(deps).onEvent({ RequestType: 'Delete', ResourceProperties: props, PhysicalResourceId: 'id' }))
      .rejects.toThrow('denied');
  });

  test('isComplete is true at once for Create and Update', async () => {
    const { deps } = fakeDeps({ countContainerInstances: async () => 3 });
    for (const RequestType of ['Create', 'Update']) {
      await expect(createHandlers(deps).isComplete({ RequestType, ResourceProperties: props })).resolves.toEqual({ IsComplete: true });
    }
  });

  test.each([[1, false], [2, false], [0, true]])('Delete with %i container instance(s) is complete: %s', async (count, expected) => {
    const { deps } = fakeDeps({ countContainerInstances: async () => count });
    await expect(createHandlers(deps).isComplete({ RequestType: 'Delete', ResourceProperties: props })).resolves.toEqual({ IsComplete: expected });
  });

  test('Delete is complete when the cluster no longer exists', async () => {
    const { deps } = fakeDeps({ countContainerInstances: async () => { throw Object.assign(new Error('gone'), { name: 'ClusterNotFoundException' }); } });
    await expect(createHandlers(deps).isComplete({ RequestType: 'Delete', ResourceProperties: props })).resolves.toEqual({ IsComplete: true });
  });
});

describe('cluster drain wiring', () => {
  const app = new App();
  const stack = new MediaInfraStack(app, 'TAK-Dev-MediaInfra', {
    environment: 'dev-test',
    envConfig: { ...mockDevConfig, usePreBuiltImages: true } as any,
    env: { account: '123456789012', region: 'us-west-2' },
  });
  const template = Template.fromStack(stack);

  const drainId = Object.keys(template.findResources('AWS::CloudFormation::CustomResource'))
    .find((id) => id.startsWith('MediaComputeClusterDrain'))!;
  const dependsOn = (id: string): string[] => {
    const resource = (template.toJSON().Resources as Record<string, { DependsOn?: string | string[] }>)[id];
    return ([] as string[]).concat(resource.DependsOn ?? []);
  };

  test('the drain resource exists and is given the cluster and the group', () => {
    expect(drainId).toBeDefined();
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      ClusterName: Match.anyValue(),
      AutoScalingGroupName: Match.anyValue(),
    });
  });

  test('it is deleted before the capacity provider association and the Auto Scaling group with its drain hook', () => {
    const deps = dependsOn(drainId);
    const associations = Object.keys(template.findResources('AWS::ECS::ClusterCapacityProviderAssociations'));
    expect(associations).toHaveLength(1);
    expect(deps).toContain(associations[0]);
    expect(deps.some((id) => template.toJSON().Resources[id].Type === 'AWS::AutoScaling::AutoScalingGroup')).toBe(true);
    expect(deps.some((id) => template.toJSON().Resources[id].Type === 'AWS::AutoScaling::LifecycleHook')).toBe(true);
  });

  test('the ECS service is deleted before the cluster is drained', () => {
    const services = Object.keys(template.findResources('AWS::ECS::Service'));
    expect(services).toHaveLength(1);
    expect(dependsOn(services[0])).toContain(drainId);
  });

  test('the handlers get only the permissions they need', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'autoscaling:UpdateAutoScalingGroup' })]) },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'ecs:ListContainerInstances' })]) },
    });
  });
});
