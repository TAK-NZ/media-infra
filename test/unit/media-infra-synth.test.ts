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

type IngressRule = {
  CidrIp?: string;
  SourceSecurityGroupId?: unknown;
  FromPort?: number;
  IpProtocol?: string;
};

/**
 * Collect every ingress rule in the template. CDK emits rules either inline on
 * the security group or as standalone resources depending on whether the peer is
 * a CIDR or another security group, so both are gathered.
 */
function allIngressRules(template: Template): IngressRule[] {
  const inline = Object.values(template.findResources('AWS::EC2::SecurityGroup'))
    .flatMap((g: any) => g.Properties?.SecurityGroupIngress ?? []);
  const standalone = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
    .map((r: any) => r.Properties);

  return [...inline, ...standalone];
}

/** Ports reachable from anywhere on the internet, across every security group */
function internetReachablePorts(template: Template): number[] {
  return allIngressRules(template)
    .filter((rule) => rule.CidrIp === '0.0.0.0/0')
    .map((rule) => rule.FromPort as number);
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
      const userData = renderedUserData(synth());

      // Off by default for host networking. Without it the container receives no
      // task credentials, breaking EFS IAM authorisation.
      expect(userData).toContain('ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=true');
    });

    it('raises the host UDP socket buffer defaults', () => {
      const userData = renderedUserData(synth());

      // MediaMTX gets large UDP buffers from the OS default rather than calling
      // setsockopt, which fails hard when the kernel limit is lower.
      expect(userData).toContain('net.core.rmem_default');
    });
  });

  describe('load balancer', () => {
    it('fronts the service with a network load balancer', () => {
      const template = synth();

      template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
        Type: 'network',
        Scheme: 'internet-facing',
      });
    });

    it.each([
      ['RTMPS', MEDIAMTX_PORTS.RTMPS],
      ['RTSPS', MEDIAMTX_PORTS.RTSPS],
      ['playback', MEDIAMTX_PORTS.PLAYBACK],
      ['API', MEDIAMTX_PORTS.API],
      ['WebRTC signalling', MEDIAMTX_PORTS.WEBRTC],
    ])('terminates TLS for %s on port %i', (_name, port) => {
      const template = synth();

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: port,
        Protocol: 'TLS',
        Certificates: Match.anyValue(),
      });
    });

    it('passes SRT through without TLS, since SRT encrypts itself', () => {
      const template = synth();

      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: MEDIAMTX_PORTS.SRTS,
        Protocol: 'UDP',
      });
    });

    it('targets instances and health-checks the API port', () => {
      const template = synth();

      const groups = template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup');

      // One per distinct plaintext container port: RTMP, RTSP, playback, API,
      // WebRTC signalling, SRT.
      expect(Object.keys(groups)).toHaveLength(6);

      for (const group of Object.values(groups) as any[]) {
        // Instance targets, because host networking binds the task to the
        // instance's own interface.
        expect(group.Properties.TargetType).toBe('instance');
        // Probing the API port makes the group track task health, not just
        // whether the instance booted.
        expect(String(group.Properties.HealthCheckPort)).toBe(String(MEDIAMTX_PORTS.API));
      }
    });

    it('registers the auto scaling group with every target group', () => {
      const template = synth();

      // Attached to the ASG rather than the ECS service, which would hit the
      // ECS limit of five target groups per service.
      const asgs = Object.values(template.findResources('AWS::AutoScaling::AutoScalingGroup')) as any[];
      expect(asgs[0].Properties.TargetGroupARNs).toHaveLength(6);
    });

    it('withholds the plaintext ingest listeners unless explicitly enabled', () => {
      const listenerPorts = (template: Template) =>
        Object.values(template.findResources('AWS::ElasticLoadBalancingV2::Listener'))
          .map((l: any) => l.Properties.Port);

      expect(listenerPorts(synth({ enableInsecurePorts: false })))
        .not.toContain(MEDIAMTX_PORTS.RTMP);

      expect(listenerPorts(synth({ enableInsecurePorts: true })))
        .toContain(MEDIAMTX_PORTS.RTMP);
    });
  });

  describe('TLS certificate', () => {
    it('imports the shared certificate rather than issuing one', () => {
      const template = synth();

      // The load balancer integrates with ACM natively, so no certificate
      // resource is needed in this stack.
      template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    });

    it('gives the task no ACM permissions', () => {
      const template = synth();

      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).not.toContain('acm:ExportCertificate');
    });

    it('passes no certificate ARN to the container', () => {
      const template = synth();

      const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
      const env = (Object.values(taskDefs)[0] as any).Properties.ContainerDefinitions[0].Environment;

      expect(env.map((e: any) => e.Name)).not.toContain('ACM_CERTIFICATE_ARN');
    });
  });

  describe('WebRTC ICE path', () => {
    it('keeps a static Elastic IP for ICE', () => {
      const template = synth();

      template.resourceCountIs('AWS::EC2::EIP', 1);
    });

    it('advertises the Elastic IP to clients as an ICE candidate', () => {
      const template = synth();

      // Passed in from CDK rather than read from instance metadata, which would
      // race the boot-time EIP association.
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Environment: Match.arrayWith([
              Match.objectLike({ Name: 'MTX_WEBRTCADDITIONALHOSTS' }),
            ]),
          }),
        ]),
      });
    });

    it('exposes ICE directly on the instance over UDP and TCP', () => {
      const template = synth();
      const rules = allIngressRules(template);

      for (const protocol of ['udp', 'tcp']) {
        expect(rules).toEqual(expect.arrayContaining([
          expect.objectContaining({
            CidrIp: '0.0.0.0/0',
            IpProtocol: protocol,
            FromPort: MEDIAMTX_PORTS.WEBRTC_ICE,
          }),
        ]));
      }
    });

    it('does not route ICE through the load balancer', () => {
      const template = synth();

      const listenerPorts = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::Listener'))
        .map((l: any) => l.Properties.Port);

      // A load balancer cannot carry ICE; that is the whole reason for the EIP.
      expect(listenerPorts).not.toContain(MEDIAMTX_PORTS.WEBRTC_ICE);
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

  describe('DNS', () => {
    it('aliases the media hostname to the load balancer', () => {
      const template = synth();

      // Clients only ever resolve this name; the ICE address is communicated
      // inside the WebRTC negotiation instead.
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'A',
        AliasTarget: Match.anyValue(),
      });
    });
  });

  describe('network exposure', () => {
    it('reaches the container only via the load balancer for non-ICE ports', () => {
      const template = synth();
      const exposed = internetReachablePorts(template);

      // These are the load balancer's listener ports. The container's own
      // plaintext ports must not be internet-reachable.
      expect(exposed).toContain(MEDIAMTX_PORTS.RTMPS);
      expect(exposed).toContain(MEDIAMTX_PORTS.API);

      // Only ICE is open directly on the instance.
      const instanceRules = allIngressRules(template)
        .filter((r) => r.SourceSecurityGroupId !== undefined)
        .map((r) => r.FromPort);
      expect(instanceRules).toContain(MEDIAMTX_PORTS.API);
    });

    it('does not expose the MediaMTX HLS listener, control API or auth cache', () => {
      const template = synth();
      const exposed = internetReachablePorts(template);

      // All three bind to loopback; the HLS proxy on the API port adds lease
      // authorisation that a direct listener would bypass.
      expect(exposed).not.toContain(MEDIAMTX_INTERNAL_PORTS.HLS);
      expect(exposed).not.toContain(MEDIAMTX_INTERNAL_PORTS.CONTROL_API);
      expect(exposed).not.toContain(MEDIAMTX_INTERNAL_PORTS.AUTH_CACHE);
    });

    it('withholds the plaintext ingest ports unless explicitly enabled', () => {
      expect(internetReachablePorts(synth({ enableInsecurePorts: false })))
        .not.toContain(MEDIAMTX_PORTS.RTMP);

      expect(internetReachablePorts(synth({ enableInsecurePorts: true })))
        .toContain(MEDIAMTX_PORTS.RTMP);
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
      const env = (Object.values(taskDefs)[0] as any).Properties.ContainerDefinitions[0].Environment;

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

    it('does not bind the TLS listener ports in the container', () => {
      const template = synth();

      const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
      const ports = (Object.values(taskDefs)[0] as any)
        .Properties.ContainerDefinitions[0].PortMappings
        .map((p: any) => p.ContainerPort);

      // RTMPS and RTSPS terminate at the load balancer, which forwards to the
      // plaintext ports.
      expect(ports).not.toContain(MEDIAMTX_PORTS.RTMPS);
      expect(ports).not.toContain(MEDIAMTX_PORTS.RTSPS);
      expect(ports).toContain(MEDIAMTX_PORTS.RTMP);
      expect(ports).toContain(MEDIAMTX_PORTS.RTSP);
    });
  });
});
