jest.mock('aws-cdk-lib/aws-ecs', () => ({
  ...jest.requireActual('aws-cdk-lib/aws-ecs'),
  Ec2TaskDefinition: jest.fn().mockImplementation(() => ({
    addContainer: jest.fn().mockReturnValue({
      addPortMappings: jest.fn(),
      addMountPoints: jest.fn()
    }),
    addVolume: jest.fn(),
    taskRole: {
      addToPrincipalOrResource: jest.fn()
    },
    executionRole: {
      addToPrincipalOrResource: jest.fn(),
      addToPolicy: jest.fn()
    }
  })),
  Ec2Service: jest.fn().mockImplementation(() => ({
    serviceArn: 'arn:aws:ecs:us-west-2:123456789012:service/test'
  })),
  LogDriver: {
    awsLogs: jest.fn()
  },
  Protocol: { TCP: 'tcp', UDP: 'udp' }
}));

jest.mock('aws-cdk-lib/aws-logs', () => ({
  LogGroup: jest.fn().mockImplementation(() => ({})),
  RetentionDays: { ONE_WEEK: 7 }
}));

jest.mock('aws-cdk-lib/aws-iam', () => ({
  Role: jest.fn().mockImplementation(() => ({
    addToPolicy: jest.fn(),
    addManagedPolicy: jest.fn()
  })),
  ServicePrincipal: jest.fn(),
  PolicyStatement: jest.fn().mockImplementation(() => ({
    addActions: jest.fn(),
    addResources: jest.fn()
  })),
  ManagedPolicy: {
    fromAwsManagedPolicyName: jest.fn().mockReturnValue({})
  },
  Effect: { ALLOW: 'Allow' }
}));

import { MediaEcsService } from '../../../lib/constructs/media-ecs-service';
import { App, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import { mockDevConfig } from '../../__fixtures__/mock-configs';

describe('MediaEcsService Construct (Mocked)', () => {
  let app: App;
  let stack: Stack;
  let vpc: ec2.IVpc;
  let ecsCluster: ecs.ICluster;
  let securityGroup: ec2.SecurityGroup;
  let signingSecret: secretsmanager.ISecret;
  let mediaSecret: secretsmanager.ISecret;
  let kmsKey: kms.IKey;
  let certificate: any;
  let capacityProvider: any;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'TestStack');

    vpc = ec2.Vpc.fromVpcAttributes(stack, 'TestVpc', {
      vpcId: 'vpc-12345',
      availabilityZones: ['us-west-2a', 'us-west-2b'],
      privateSubnetIds: ['subnet-1', 'subnet-2'],
      publicSubnetIds: ['subnet-3', 'subnet-4']
    });

    ecsCluster = ecs.Cluster.fromClusterAttributes(stack, 'TestCluster', {
      clusterName: 'test-cluster',
      vpc,
      securityGroups: []
    });

    securityGroup = new ec2.SecurityGroup(stack, 'TestSG', {
      vpc,
      description: 'Test security group'
    });

    signingSecret = {
      grantRead: jest.fn()
    } as any;
    mediaSecret = {
      grantRead: jest.fn()
    } as any;
    kmsKey = {
      grantDecrypt: jest.fn()
    } as any;
    certificate = {
      certificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/test-cert'
    };
    capacityProvider = {
      capacityProviderName: 'test-capacity-provider'
    };
  });

  it('creates MediaEcsService construct successfully', () => {
    expect(() => {
      new MediaEcsService(stack, 'TestMediaEcsService', {
        environment: 'dev-test',
        envConfig: mockDevConfig,
        infrastructure: {
          vpc,
          ecsCluster,
          kmsKey,
          securityGroups: {
            instance: securityGroup,
            nlb: securityGroup,
            efs: securityGroup
          }
        },
        network: {
          hostedZone: {} as any,
          certificate,
          mediaHostname: 'media',
          hostedZoneName: 'test.com'
        },
        secrets: {
          signingSecret,
          mediaSecret,
          cloudTakUrl: 'https://cloudtak.test.com'
        },
        storage: {
          efs: {
            fileSystemId: 'fs-12345678',
            accessPointId: 'fsap-12345678'
          }
        },
        stackNameComponent: 'Dev',
        capacityProvider,
        iceAddress: '203.0.113.10'
      });
    }).not.toThrow();
  });
});
