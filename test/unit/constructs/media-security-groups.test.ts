import { MediaSecurityGroups } from '../../../lib/constructs/media-security-groups';

/**
 * Smoke checks only. The actual ingress rules — which ports are reachable from
 * the internet, and which are withheld — are asserted against the synthesised
 * template in test/unit/media-infra-synth.test.ts.
 */
describe('MediaSecurityGroups Construct', () => {
  it('exports MediaSecurityGroups class', () => {
    expect(MediaSecurityGroups).toBeDefined();
    expect(typeof MediaSecurityGroups).toBe('function');
  });

  it('has constructor that accepts props', () => {
    expect(MediaSecurityGroups.length).toBe(3); // scope, id, props
  });
});
