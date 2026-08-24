import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface MediaEndpointProps {
  stackNameComponent: string;
}

/**
 * Static Elastic IP used exclusively as the WebRTC ICE address.
 *
 * ICE requires direct UDP connectivity between client and server, so it cannot
 * pass through the load balancer that fronts every other port. The instance
 * associates this address to itself at boot and MediaMTX advertises it as an ICE
 * candidate, so clients reach it directly on 8189.
 *
 * It is deliberately absent from DNS: clients discover it inside the WebRTC
 * negotiation, and everything else resolves to the load balancer. Keeping the
 * address static means advertised ICE candidates stay valid across instance
 * replacement.
 */
export class MediaEndpoint extends Construct {
  public readonly elasticIp: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props: MediaEndpointProps) {
    super(scope, id);

    this.elasticIp = new ec2.CfnEIP(this, 'MediaEip', {
      tags: [{
        key: 'Name',
        value: `TAK-${props.stackNameComponent}-MediaInfra-ice`,
      }],
    });
  }

  /** Public IPv4 address, advertised to WebRTC clients as an ICE candidate */
  public get ipAddress(): string {
    return this.elasticIp.ref;
  }
}
