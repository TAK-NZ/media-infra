import { MediaEcsService } from '../../../lib/constructs/media-ecs-service';

/**
 * Smoke checks only. Behaviour of the synthesised service — host network mode,
 * capacity provider strategy, deployment configuration, port exposure — is
 * asserted against the real template in test/unit/media-infra-synth.test.ts.
 */
describe('MediaEcsService Construct', () => {
  it('exports MediaEcsService class', () => {
    expect(MediaEcsService).toBeDefined();
    expect(typeof MediaEcsService).toBe('function');
  });

  it('has constructor that accepts props', () => {
    expect(MediaEcsService.length).toBe(3); // scope, id, props
  });
});
