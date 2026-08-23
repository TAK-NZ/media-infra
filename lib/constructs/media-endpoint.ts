import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface MediaEndpointProps {
  hostedZone: route53.IHostedZone;
  /** Subdomain label for the media server, e.g. "video" */
  mediaHostname: string;
  stackNameComponent: string;
}

/**
 * Public network endpoint for the media server.
 *
 * There is no load balancer: the EC2 container instance attaches this Elastic IP
 * to itself once the media API is serving (see the EIP association unit in the
 * instance user data), and DNS resolves straight to it.
 *
 * A load balancer cannot sit in this path because WebRTC ICE requires direct UDP
 * connectivity to the media server. A stable Elastic IP also keeps the ICE
 * candidates that MediaMTX advertises valid across instance replacement.
 */
export class MediaEndpoint extends Construct {
  public readonly elasticIp: ec2.CfnEIP;
  public readonly aRecord: route53.ARecord;

  constructor(scope: Construct, id: string, props: MediaEndpointProps) {
    super(scope, id);

    this.elasticIp = new ec2.CfnEIP(this, 'MediaEip', {
      tags: [{
        key: 'Name',
        value: `TAK-${props.stackNameComponent}-MediaInfra`,
      }],
    });

    // A plain A record rather than an alias — an alias target requires an AWS
    // resource such as a load balancer, and there isn't one here.
    // Short TTL so clients follow the address quickly if the EIP is remapped.
    this.aRecord = new route53.ARecord(this, 'MediaARecord', {
      zone: props.hostedZone,
      recordName: props.mediaHostname,
      target: route53.RecordTarget.fromIpAddresses(this.elasticIp.ref),
      ttl: cdk.Duration.seconds(60),
    });
  }
}
