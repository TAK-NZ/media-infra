import { App } from 'aws-cdk-lib';
import { MediaInfraStack } from '../../lib/media-infra-stack';
import { mockDevConfig, mockProdConfig } from '../__fixtures__/mock-configs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import { MediaSecurityGroups } from '../../lib/constructs/media-security-groups';
import { MediaNlb } from '../../lib/constructs/media-nlb';
import { MediaEndpoint } from '../../lib/constructs/media-endpoint';
import { MediaEc2Compute } from '../../lib/constructs/media-ec2-compute';
import { MediaEcsService } from '../../lib/constructs/media-ecs-service';
import { MediaEfs } from '../../lib/constructs/media-efs';

// Mock all CDK services
jest.mock('aws-cdk-lib/aws-ec2');
jest.mock('aws-cdk-lib/aws-certificatemanager');
jest.mock('aws-cdk-lib/aws-route53');
jest.mock('aws-cdk-lib/aws-secretsmanager');
jest.mock('aws-cdk-lib/aws-kms');
jest.mock('../../lib/constructs/media-security-groups');
jest.mock('../../lib/constructs/media-nlb');
jest.mock('../../lib/constructs/media-endpoint');
jest.mock('../../lib/constructs/media-ec2-compute');
jest.mock('../../lib/constructs/media-ecs-service');
jest.mock('../../lib/constructs/media-efs');
jest.mock('../../lib/outputs');

const mockVpc = {
  vpcId: 'vpc-12345',
  availabilityZones: ['us-west-2a', 'us-west-2b'],
  publicSubnets: [{ subnetId: 'subnet-pub1' }, { subnetId: 'subnet-pub2' }],
  privateSubnets: [{ subnetId: 'subnet-priv1' }, { subnetId: 'subnet-priv2' }]
};

const mockCertificate = {
  certificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/test-cert'
};

const mockHostedZone = {
  hostedZoneId: 'Z123456789',
  zoneName: 'tak.nz'
};

const mockKmsKey = {
  keyArn: 'arn:aws:kms:us-west-2:123456789012:key/test-key'
};

const mockSecret = {
  secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:test-secret'
};

const mockSecurityGroups = {
  instance: { securityGroupId: 'sg-instance' },
  nlb: { securityGroupId: 'sg-nlb' },
  efs: { securityGroupId: 'sg-efs' }
};

const mockTargetGroups = [{}, {}, {}, {}, {}, {}];

const mockNlb = {
  loadBalancer: { loadBalancerDnsName: 'tak-dev-media.elb.amazonaws.com' },
  targetGroups: {},
  allTargetGroups: jest.fn().mockReturnValue(mockTargetGroups)
};

const mockEndpoint = {
  elasticIp: { ref: '203.0.113.10', attrAllocationId: 'eipalloc-12345' },
  ipAddress: '203.0.113.10'
};

const mockCompute = {
  cluster: { clusterName: 'TAK-Dev-Media' },
  capacityProvider: { capacityProviderName: 'test-capacity-provider' },
  autoScalingGroup: {}
};

const mockMediaService = {
  service: {
    serviceArn: 'arn:aws:ecs:service/test-service',
    node: { addDependency: jest.fn() }
  }
};

const mockEfs = {
  fileSystem: { fileSystemId: 'fs-12345', mountTargetsAvailable: {} },
  accessPoint: { accessPointId: 'fsap-12345' }
};

function primeMocks() {
  (ec2.Vpc.fromVpcAttributes as jest.Mock).mockReturnValue(mockVpc);
  (acm.Certificate.fromCertificateArn as jest.Mock).mockReturnValue(mockCertificate);
  (route53.HostedZone.fromHostedZoneAttributes as jest.Mock).mockReturnValue(mockHostedZone);
  (kms.Key.fromKeyArn as jest.Mock).mockReturnValue(mockKmsKey);
  (secretsmanager.Secret.fromSecretCompleteArn as jest.Mock).mockReturnValue(mockSecret);

  (MediaSecurityGroups as jest.MockedClass<typeof MediaSecurityGroups>).mockImplementation(() => mockSecurityGroups as any);
  (MediaNlb as jest.MockedClass<typeof MediaNlb>).mockImplementation(() => mockNlb as any);
  (MediaEndpoint as jest.MockedClass<typeof MediaEndpoint>).mockImplementation(() => mockEndpoint as any);
  (MediaEc2Compute as jest.MockedClass<typeof MediaEc2Compute>).mockImplementation(() => mockCompute as any);
  (MediaEcsService as jest.MockedClass<typeof MediaEcsService>).mockImplementation(() => mockMediaService as any);
  (MediaEfs as jest.MockedClass<typeof MediaEfs>).mockImplementation(() => mockEfs as any);
}

describe('MediaInfraStack', () => {
  let app: App;

  beforeEach(() => {
    app = new App();
    jest.clearAllMocks();
    primeMocks();
  });

  describe('Class Definition', () => {
    it('exports MediaInfraStack class', () => {
      expect(MediaInfraStack).toBeDefined();
      expect(typeof MediaInfraStack).toBe('function');
    });

    it('has constructor that accepts props', () => {
      expect(MediaInfraStack.length).toBe(3); // scope, id, props
    });
  });

  describe('Configuration Validation', () => {
    it('validates dev config structure', () => {
      expect(mockDevConfig.stackName).toBe('Dev');
      expect(mockDevConfig.ecs.taskCpu).toBe(512);
      expect(mockDevConfig.ecs.taskMemory).toBe(1024);
    });

    it('validates prod config structure', () => {
      expect(mockProdConfig.stackName).toBe('Prod');
      expect(mockProdConfig.ecs.taskCpu).toBe(1024);
      expect(mockProdConfig.ecs.taskMemory).toBe(2048);
    });
  });

  describe('Stack Construction', () => {
    it('creates stack with dev environment', () => {
      const stack = new MediaInfraStack(app, 'TestStack', {
        environment: 'dev-test',
        envConfig: mockDevConfig
      });

      expect(stack).toBeInstanceOf(MediaInfraStack);
      expect(stack.stackName).toBe('TestStack');
    });

    it('creates stack with prod environment', () => {
      const stack = new MediaInfraStack(app, 'TestStack', {
        environment: 'prod',
        envConfig: mockProdConfig
      });

      expect(stack).toBeInstanceOf(MediaInfraStack);
      expect(stack.stackName).toBe('TestStack');
    });

    it('imports AWS resources including the shared certificate', () => {
      new MediaInfraStack(app, 'TestStack', {
        environment: 'dev-test',
        envConfig: mockDevConfig
      });

      expect(ec2.Vpc.fromVpcAttributes).toHaveBeenCalled();
      expect(route53.HostedZone.fromHostedZoneAttributes).toHaveBeenCalled();
      expect(kms.Key.fromKeyArn).toHaveBeenCalled();
      expect(secretsmanager.Secret.fromSecretCompleteArn).toHaveBeenCalledTimes(2);
      // The load balancer uses the shared certificate, so it is imported rather
      // than issued in this stack.
      expect(acm.Certificate.fromCertificateArn).toHaveBeenCalled();
    });

    it('creates all required constructs', () => {
      new MediaInfraStack(app, 'TestStack', {
        environment: 'dev-test',
        envConfig: mockDevConfig
      });

      expect(MediaSecurityGroups).toHaveBeenCalledWith(
        expect.anything(),
        'SecurityGroups',
        expect.objectContaining({
          stackNameComponent: 'Dev',
          enableInsecurePorts: false
        })
      );

      expect(MediaEfs).toHaveBeenCalledWith(
        expect.anything(),
        'MediaEfs',
        expect.objectContaining({ stackNameComponent: 'Dev' })
      );

      expect(MediaEndpoint).toHaveBeenCalledWith(
        expect.anything(),
        'MediaEndpoint',
        expect.objectContaining({ stackNameComponent: 'Dev' })
      );

      expect(MediaNlb).toHaveBeenCalledWith(
        expect.anything(),
        'MediaNlb',
        expect.objectContaining({
          stackNameComponent: 'Dev',
          certificate: mockCertificate
        })
      );

      expect(MediaEc2Compute).toHaveBeenCalledWith(
        expect.anything(),
        'MediaCompute',
        expect.objectContaining({ stackNameComponent: 'Dev' })
      );

      expect(MediaEcsService).toHaveBeenCalledWith(
        expect.anything(),
        'MediaEcsService',
        expect.objectContaining({
          environment: 'dev-test',
          envConfig: mockDevConfig,
          stackNameComponent: 'Dev'
        })
      );
    });

    it('passes the Elastic IP allocation to the compute layer', () => {
      new MediaInfraStack(app, 'TestStack', {
        environment: 'dev-test',
        envConfig: mockDevConfig
      });

      // The instance associates the EIP to itself at boot, so it needs the
      // allocation created by MediaEndpoint.
      expect(MediaEc2Compute).toHaveBeenCalledWith(
        expect.anything(),
        'MediaCompute',
        expect.objectContaining({ elasticIp: mockEndpoint.elasticIp })
      );
    });

    it('registers the load balancer target groups with the compute layer', () => {
      new MediaInfraStack(app, 'TestStack', {
        environment: 'dev-test',
        envConfig: mockDevConfig
      });

      // Attached to the ASG rather than the ECS service, to stay clear of the
      // ECS five-target-groups-per-service limit.
      expect(MediaEc2Compute).toHaveBeenCalledWith(
        expect.anything(),
        'MediaCompute',
        expect.objectContaining({ targetGroups: mockTargetGroups })
      );
    });

    it('passes the ICE address to the ECS service rather than a certificate', () => {
      new MediaInfraStack(app, 'TestStack', {
        environment: 'dev-test',
        envConfig: mockDevConfig
      });

      const call = (MediaEcsService as jest.MockedClass<typeof MediaEcsService>).mock.calls[0];
      const props = call[2] as unknown as Record<string, unknown>;

      expect(props.iceAddress).toBe(mockEndpoint.ipAddress);
      // TLS terminates at the load balancer, so the container gets no cert.
      expect(props).not.toHaveProperty('certificate');
    });

    it('handles insecure ports configuration', () => {
      const configWithInsecurePorts = {
        ...mockDevConfig,
        enableInsecurePorts: true
      };

      new MediaInfraStack(app, 'TestStack', {
        environment: 'dev-test',
        envConfig: configWithInsecurePorts
      });

      expect(MediaSecurityGroups).toHaveBeenCalledWith(
        expect.anything(),
        'SecurityGroups',
        expect.objectContaining({ enableInsecurePorts: true })
      );

      expect(MediaNlb).toHaveBeenCalledWith(
        expect.anything(),
        'MediaNlb',
        expect.objectContaining({ enableInsecurePorts: true })
      );
    });

    it('retains EFS in prod and destroys it in dev-test', () => {
      new MediaInfraStack(app, 'TestProdStack', {
        environment: 'prod',
        envConfig: mockProdConfig
      });

      expect(MediaEfs).toHaveBeenCalledWith(
        expect.anything(),
        'MediaEfs',
        expect.objectContaining({ retainOnDelete: true })
      );

      jest.clearAllMocks();
      primeMocks();

      new MediaInfraStack(new App(), 'TestDevStack', {
        environment: 'dev-test',
        envConfig: mockDevConfig
      });

      expect(MediaEfs).toHaveBeenCalledWith(
        expect.anything(),
        'MediaEfs',
        expect.objectContaining({ retainOnDelete: false })
      );
    });

    it('passes correct environment to ECS service', () => {
      new MediaInfraStack(app, 'TestProdStack', {
        environment: 'prod',
        envConfig: mockProdConfig
      });

      expect(MediaEcsService).toHaveBeenCalledWith(
        expect.anything(),
        'MediaEcsService',
        expect.objectContaining({
          environment: 'prod',
          envConfig: mockProdConfig
        })
      );
    });
  });
});
