import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface MediaCertificateProps {
  /** Route53 hosted zone used for DNS validation */
  hostedZone: route53.IHostedZone;
  /** Fully qualified domain name for the media server, e.g. video.example.com */
  domainName: string;
  stackNameComponent: string;
}

/**
 * Exportable ACM certificate for the MediaMTX media server.
 *
 * The media service runs on EC2 with `host` network mode and is directly
 * internet-facing — there is no load balancer terminating TLS on its behalf.
 * MediaMTX therefore needs the certificate's private key material inside the
 * container to serve WebRTC over DTLS/TLS.
 *
 * `allowExport` must be set at issuance time; it cannot be enabled on an
 * existing certificate. This is why a dedicated certificate is created here
 * rather than reusing the shared BaseInfra certificate — enabling export on
 * the shared certificate would expose its private key to every consumer,
 * whereas this one is scoped to the media subdomain only.
 *
 * Note: exportable public certificates incur a charge at issuance and again
 * at each renewal, unlike standard ACM public certificates.
 */
export class MediaCertificate extends Construct {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: MediaCertificateProps) {
    super(scope, id);

    this.certificate = new acm.Certificate(this, 'MediaCertificate', {
      domainName: props.domainName,
      certificateName: `TAK-${props.stackNameComponent}-MediaInfra`,
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
      // Required so the container can call acm:ExportCertificate at startup
      allowExport: true,
    });
  }
}
