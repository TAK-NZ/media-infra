/**
 * Export the media server's TLS certificate from ACM to disk.
 *
 * Runs once from the entrypoint, before MediaMTX and the API server start. Both
 * of those serve TLS directly — there is no load balancer terminating it — so
 * they cannot start until these files exist.
 *
 * This is deliberately implemented with the AWS SDK and node:crypto rather than
 * `aws acm export-certificate | jq | openssl`. Installing those packages would
 * require a `RUN` step in the final image stage, which cannot execute when
 * cross-building for ARM64 from an x86-64 host without QEMU. Node is already
 * present in the image and covers all three jobs.
 */

import fs from 'node:fs';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { ACMClient, ExportCertificateCommand } from '@aws-sdk/client-acm';

const SERVER_KEY_PATH = '/server.key';
const SERVER_CERT_PATH = '/server.crt';

async function main(): Promise<void> {
    const certificateArn = process.env.ACM_CERTIFICATE_ARN;

    if (!certificateArn) {
        throw new Error('ACM_CERTIFICATE_ARN is not set; cannot obtain TLS material');
    }

    // ACM requires the exported private key to be passphrase-protected. The
    // passphrase only has to survive until it is used to decrypt the key below,
    // so a per-start random value is used and never persisted.
    const passphrase = randomBytes(48).toString('base64');

    const client = new ACMClient({});

    const response = await client.send(new ExportCertificateCommand({
        CertificateArn: certificateArn,
        Passphrase: Buffer.from(passphrase, 'utf8')
    }));

    if (!response.Certificate || !response.PrivateKey) {
        throw new Error('ACM did not return certificate and private key material');
    }

    // MediaMTX expects the leaf followed by any intermediates in one file.
    const chain = [response.Certificate, response.CertificateChain]
        .filter((part): part is string => Boolean(part))
        .map((part) => part.trim())
        .join('\n');

    const privateKey = createPrivateKey({
        key: response.PrivateKey,
        passphrase
    }).export({ type: 'pkcs8', format: 'pem' });

    fs.writeFileSync(SERVER_CERT_PATH, `${chain}\n`, { mode: 0o644 });
    fs.writeFileSync(SERVER_KEY_PATH, privateKey, { mode: 0o600 });

    console.log(`ok - TLS certificate exported from ${certificateArn}`);
}

try {
    await main();
} catch (err) {
    // Fatal by design. Every internet-facing listener is configured for TLS, so
    // continuing without a certificate would either fail to bind or, worse,
    // serve plaintext on a public port.
    console.error('FATAL: could not export TLS certificate from ACM');
    console.error(err instanceof Error ? err.message : err);
    console.error('The certificate must have been issued with export enabled.');
    process.exit(1);
}
