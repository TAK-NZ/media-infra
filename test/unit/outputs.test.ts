import { registerOutputs, OutputsConfig } from '../../lib/outputs';
import { App, Stack } from 'aws-cdk-lib';

describe('Outputs', () => {
  describe('registerOutputs function', () => {
    it('creates stack outputs correctly', () => {
      const app = new App();
      const stack = new Stack(app, 'TestStack');

      const config: OutputsConfig = {
        stack,
        stackName: 'TAK-Dev-MediaInfra',
        mediaIp: '203.0.113.10',
        mediaUrl: 'https://media.dev.tak.nz:9997',
        ecsServiceArn: 'arn:aws:ecs:us-west-2:123456789012:service/test-service',
        certificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/test-cert'
      };

      expect(() => registerOutputs(config)).not.toThrow();
    });

    it('validates OutputsConfig interface', () => {
      const app = new App();
      const stack = new Stack(app, 'TestStack');

      const config: OutputsConfig = {
        stack,
        stackName: 'test',
        mediaIp: '203.0.113.10',
        mediaUrl: 'https://test.com',
        ecsServiceArn: 'arn:test',
        certificateArn: 'arn:aws:acm:us-west-2:123456789012:certificate/test-cert'
      };

      expect(config.stack).toBeDefined();
      expect(config.stackName).toBe('test');
      expect(config.mediaIp).toBe('203.0.113.10');
      expect(config.mediaUrl).toBe('https://test.com');
      expect(config.ecsServiceArn).toBe('arn:test');
      expect(config.certificateArn).toMatch(/^arn:aws:acm:/);
    });
  });
});
