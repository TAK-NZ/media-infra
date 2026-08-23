import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MediaInfraStack } from '../../lib/media-infra-stack';
import { mockDevConfig, mockProdConfig } from '../__fixtures__/mock-configs';
import { MEDIAMTX_PORTS, MEDIAMTX_INTERNAL_PORTS } from '../../lib/utils/constants';

/**
 * Synthesises the real stack and asserts against the produced CloudFormation.
 *
 * `usePreBuiltImages` is forced on so the container image resolves to an ECR URI
 * rather than a DockerImageAsset, which would require a working Docker daemon.
 */
function synth(overrides: Record<string, unknown> = {}, environment: 'prod' | 'dev-test' = 'dev-test') {
  const app = new App();
  const stack = new MediaInfraStack(app, 'TAK-Dev-MediaInfra', {
    environment,
    envConfig: {
      ...mockDevConfig,
      usePreBuiltImages: true,
      ...overrides,
    } as any,
    env: { account: '123456789012', region: 'us-west-2' },
  });
  return Template.fromStack(stack);
}

/**
 * Flatten the launch template's user data into a string. CloudFormation
 * intrinsics inside it are replaced with a placeholder so the surrounding shell
 * script can be asserted on.
 */
function renderedUserData(template: Template): string {
  const launchTemplates = template.findResources('AWS::EC2::LaunchTemplate');
  const userData = Object.values(launchTemplates)[0].Properties.LaunchTemplateData.UserData;
  const parts = userData['Fn::Base64']['Fn::Join'][1] as unknown[];

  return parts.map((part) => (typeof part === 'string' ? part : '<intrinsic>')).join('');
}

describe('MediaInfraStack synthesis', () => {
  describe('compute architecture', () => {
    it('runs the task on EC2 with host network mode', () => {
      const template = synth();

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        NetworkMode: 'host',
        RequiresCompatibilities: ['EC2'],
      });
    });

    it('creates an EC2 capacity provider backed by an auto scaling group', () => {
      const template = synth();

      template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
      template.resourceCountIs('AWS::ECS::CapacityProvider', 1);
      template.hasResourceProperties('AWS::ECS::CapacityProvider', {
        AutoScalingGroupProvider: Match.objectLike({
          ManagedScaling: Match.objectLike({ Status: 'ENABLED', TargetCapacity: 100 }),
        }),
      });
    });

    it('creates its own ECS cluster rather than importing one', () => {
      const template = synth();

      // EC2 capacity providers are cluster-scoped and cannot attach to the
      // Fargate-only cluster exported by BaseInfra.
      template.resourceCountIs('AWS::ECS::Cluster', 1);
    });

    it('launches ARM64 instances of the configured type', () => {
      const template = synth({ ec2: { instanceType: 'm7g.large', minCapacity: 1, maxCapacity: 3 } });

      template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
        LaunchTemplateData: Match.objectLike({ InstanceType: 'm7g.large' }),
      });
      template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
        MinSize: '1',
        MaxSize: '3',
      });
    });

    it('requires IMDSv2 on the container instance', () => {
      const template = synth();

      template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
        LaunchTemplateData: Match.objectLike({
          MetadataOptions: Match.objectLike({ HttpTokens: 'required' }),
        }),
      });
    });

    it('opts the ECS agent into task IAM roles for host network mode', () => {
      const template = synth();
      const userData = renderedUserData(template);

      // Off by default for host networking. Without it the container receives no
      // task credentials, breaking the ACM certificate export and EFS IAM auth.
      expect(userData).toContain('ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true');
    });

    it('raises the host UDP socket buffer defaults', () => {
      const template = synth();
      const userData = renderedUserData(template);

      // MediaMTX gets large UDP buffers from the OS default rather than calling
      // setsockopt, which fails hard when the kernel limit is lower.
      expect(userData).toContain('net.core.rmem_default');
    });

    it('defers the Elastic IP association until the media API is serving', () => {
      const template = synth();
      const userData = renderedUserData(template);

      expect(userData).toContain('media-eip-association.service');
      expect(userData).toContain('ec2 associate-address');
    });
  });

  describe('public endpoint', () => {
    it('uses an Elastic IP and no load balancer', () => {
      const template = synth();

      template.resourceCountIs('AWS::EC2::EIP', 1);
      // A load balancer cannot carry WebRTC ICE, so there must not be one.
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 0);
      template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 0);
    });

    it('points DNS directly at the Elastic IP with a short TTL', () => {
      const template = synth();

      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'A',
        TTL: '60',
      });
    });

    it('grants the instance permission to associate the Elastic IP', () => {
      const template = synth();

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ec2:AssociateAddress']),
            }),
          ]),
        }),
      });
    });
  });

  describe('TLS certificate', () => {
    it('issues an exportable certificate', () => {
      const template = synth();

      // Export must be enabled at issuance; it cannot be added to the shared
      // BaseInfra certificate after the fact.
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        CertificateExport: 'ENABLED',
        ValidationMethod: 'DNS',
      });
    });

    it('lets the task export only that certificate', () => {
      const template = synth();

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['acm:ExportCertificate']),
              Resource: { Ref: Match.stringLikeRegexp('MediaCertificate') },
            }),
          ]),
        }),
      });
    });

    it('passes the certificate ARN to the container', () => {
      const template = synth();

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'ACM_CERTIFICATE_ARN' }),
            ]),
          }),
        ]),
      });
    });
  });

  describe('network exposure', () => {
    const publicPorts = [
      MEDIAMTX_PORTS.RTMPS,
      MEDIAMTX_PORTS.RTSPS,
      MEDIAMTX_PORTS.PLAYBACK,
      MEDIAMTX_PORTS.API,
      MEDIAMTX_PORTS.WEBRTC,
      MEDIAMTX_PORTS.WEBRTC_ICE,
    ];

    it.each(publicPorts)('exposes port %i to the internet', (port) => {
      const template = synth();

      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: port, ToPort: port }),
        ]),
      });
    });

    it('exposes WebRTC ICE over both UDP and TCP', () => {
      const template = synth();

      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            IpProtocol: 'udp',
            FromPort: MEDIAMTX_PORTS.WEBRTC_ICE,
          }),
          Match.objectLike({
            IpProtocol: 'tcp',
            FromPort: MEDIAMTX_PORTS.WEBRTC_ICE,
          }),
        ]),
      });
    });

    it('does not expose the MediaMTX HLS listener, control API or auth cache', () => {
      const template = synth();
      const groups = template.findResources('AWS::EC2::SecurityGroup');

      const exposedPorts = Object.values(groups)
        .flatMap((g: any) => g.Properties?.SecurityGroupIngress ?? [])
        .filter((rule: any) => rule.CidrIp === '0.0.0.0/0')
        .map((rule: any) => rule.FromPort);

      // These are reached over loopback only; the HLS proxy on API adds lease
      // authorisation that a direct listener would bypass.
      expect(exposedPorts).not.toContain(MEDIAMTX_INTERNAL_PORTS.HLS);
      expect(exposedPorts).not.toContain(MEDIAMTX_INTERNAL_PORTS.CONTROL_API);
      expect(exposedPorts).not.toContain(MEDIAMTX_INTERNAL_PORTS.AUTH_CACHE);
    });

    it('withholds the plaintext ingest ports unless explicitly enabled', () => {
      const secured = synth({ enableInsecurePorts: false });
      const secureRules = Object.values(secured.findResources('AWS::EC2::SecurityGroup'))
        .flatMap((g: any) => g.Properties?.SecurityGroupIngress ?? [])
        .map((rule: any) => rule.FromPort);

      expect(secureRules).not.toContain(MEDIAMTX_PORTS.RTMP);
      expect(secureRules).not.toContain(MEDIAMTX_PORTS.RTSP);

      const open = synth({ enableInsecurePorts: true });
      const openRules = Object.values(open.findResources('AWS::EC2::SecurityGroup'))
        .flatMap((g: any) => g.Properties?.SecurityGroupIngress ?? [])
        .map((rule: any) => rule.FromPort);

      expect(openRules).toContain(MEDIAMTX_PORTS.RTMP);
      expect(openRules).toContain(MEDIAMTX_PORTS.RTSP);
    });
  });

  describe('deployment safety', () => {
    it('holds full capacity through a deployment', () => {
      const template = synth();

      // A restarting media server drops every in-flight stream, so the old task
      // must stay up until the replacement is healthy.
      template.hasResourceProperties('AWS::ECS::Service', {
        DeploymentConfiguration: Match.objectLike({
          MinimumHealthyPercent: 100,
          MaximumPercent: 200,
          DeploymentCircuitBreaker: Match.objectLike({ Enable: true, Rollback: true }),
        }),
        PropagateTags: 'SERVICE',
      });
    });

    it('retains EFS in prod and destroys it in dev-test', () => {
      const prod = synth({ ...mockProdConfig, usePreBuiltImages: true } as any, 'prod');
      prod.hasResource('AWS::EFS::FileSystem', { DeletionPolicy: 'Retain' });

      const dev = synth();
      dev.hasResource('AWS::EFS::FileSystem', { DeletionPolicy: 'Delete' });
    });

    it('encrypts EFS and mounts it through an access point', () => {
      const template = synth();

      template.hasResourceProperties('AWS::EFS::FileSystem', { Encrypted: true });
      template.resourceCountIs('AWS::EFS::AccessPoint', 1);
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Volumes: Match.arrayWith([
          Match.objectLike({
            EFSVolumeConfiguration: Match.objectLike({
              TransitEncryption: 'ENABLED',
              AuthorizationConfig: Match.objectLike({ IAM: 'ENABLED' }),
            }),
          }),
        ]),
      });
    });
  });

  describe('container configuration', () => {
    it('passes the media server public URL, not the CloudTAK API URL', () => {
      const template = synth();

      const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
      const env = Object.values(taskDefs)[0].Properties.ContainerDefinitions[0].Environment;

      const apiUrl = env.find((e: any) => e.Name === 'API_URL');
      const mediaUrl = env.find((e: any) => e.Name === 'CLOUDTAK_Config_media_url');

      expect(apiUrl).toBeDefined();
      expect(mediaUrl).toBeDefined();
      // Signed HLS URLs are resolved against this, so it must be the media
      // server's own hostname rather than the CloudTAK API.
      expect(JSON.stringify(mediaUrl.Value)).not.toEqual(JSON.stringify(apiUrl.Value));
    });

    it('propagates the configured log level', () => {
      const template = synth({ logLevel: 'debug' });

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'LOG_LEVEL', Value: 'debug' }),
            ]),
          }),
        ]),
      });
    });

    it('injects the signing and media secrets rather than plain env vars', () => {
      const template = synth();

      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Secrets: Match.arrayWith([
              Match.objectLike({ Name: 'SigningSecret' }),
              Match.objectLike({ Name: 'MediaSecret' }),
            ]),
          }),
        ]),
      });
    });
  });
});
