import Schema from '@openaddresses/batch-schema';
// Aliased: the bare name `Response` in this file refers to the global fetch
// Response (see shouldSendProxyBody), and importing Express's type unaliased
// would shadow it.
import type { Response as ExpressResponse } from 'express';
import { Type } from '@sinclair/typebox';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import type { Config } from '../lib/config.js';
import { verifySignedUrl, SIGNED_URL_TTL_SECONDS } from '../lib/signing.js';
import NodeCache from 'node-cache';
import { getCloudTAKPath } from '../lib/persist.js';
import { Manifest } from '../lib/manifest.js';
import Err from '@openaddresses/batch-error';
import { isHLSPath } from '../lib/payload.js';

const REQUEST_HEADER_ALLOWLIST = ['authorization', 'user-agent', 'accept', 'accept-language', 'accept-encoding', 'range', 'if-range', 'if-none-match', 'if-modified-since'];

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'set-cookie'
]);

/**
 * Maps a resource hash back to its real upstream URL.
 *
 * Deliberately outlives the signed-URL TTL so the token is always what expires
 * first. If a cache entry disappeared while its token was still valid, the client
 * would get a misleading 404 "resource not found" rather than a 403 that
 * correctly reports an expired URL.
 */
const RESOURCE_CACHE_TTL_SECONDS = SIGNED_URL_TTL_SECONDS + 60;

const cache = new NodeCache({ stdTTL: RESOURCE_CACHE_TTL_SECONDS });

/**
 * Send an HLS playlist with caching disabled.
 *
 * A live media playlist must never be cached: its whole purpose is to change on
 * every request. Previously these responses carried no Cache-Control at all
 * while Express stamped a weak ETag onto the body, which is the worst pairing.
 * Nothing told the client the playlist was volatile, and the validator actively
 * invited revalidation. Tolerant players (hls.js) survive that by polling again
 * when the media sequence has not advanced, but native players stall at the live
 * edge after a few seconds and then need a hard reload.
 *
 * res.end is used rather than res.send because res.send is what attaches the
 * ETag; there is no per-response way to suppress it.
 */
function sendManifest(res: ExpressResponse, body: string): void {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.removeHeader('ETag');
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
    res.end(body);
}

/**
 * Header-only variant of sendManifest for HEAD requests.
 */
function sendManifestHead(res: ExpressResponse): void {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.removeHeader('ETag');
    res.end();
}

export function getUpstreamRequestMethod(method: string): 'GET' | 'HEAD' {
    return method === 'HEAD' ? 'HEAD' : 'GET';
}

export function getPlaylistUpstreamUrl(stream: string, proxy: string | null | undefined): URL {
    if (proxy && isHLSPath(proxy)) {
        return new URL(proxy);
    }

    return new URL(`http://localhost:8888/${stream}/index.m3u8`);
}

type AbortAwareEmitter = {
    aborted?: boolean;
    destroyed?: boolean;
    once(event: 'aborted' | 'close', listener: () => void): void;
    off(event: 'aborted' | 'close', listener: () => void): void;
};

/**
 * Conditional-request headers, which must not be forwarded when fetching a
 * playlist we are about to rewrite.
 *
 * The body we return is not the body upstream validated: we rewrite every URI
 * into a signed URL, so upstream's ETag and Last-Modified do not describe our
 * response. Forwarding a client validator can also make upstream answer 304,
 * which is not `ok`, so it would surface to the client as a 500 on what is
 * really a successful cache revalidation.
 *
 * Segment requests are different and keep these headers, since byte-range and
 * revalidation semantics do apply to bytes we pass through untouched.
 */
const CONDITIONAL_REQUEST_HEADERS = ['if-none-match', 'if-modified-since', 'if-range'];

export function getManifestRequestHeaders(
    headers: Record<string, string | string[] | undefined>
): Record<string, string> {
    const forwarded = getProxyRequestHeaders(headers);
    for (const header of CONDITIONAL_REQUEST_HEADERS) {
        delete forwarded[header];
    }
    return forwarded;
}

export function getProxyRequestHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const forwardedHeaders: Record<string, string> = {};

    for (const header of REQUEST_HEADER_ALLOWLIST) {
        const value = headers[header];
        if (typeof value === 'string') {
            forwardedHeaders[header] = value;
        } else if (Array.isArray(value) && value.length) {
            forwardedHeaders[header] = value.join(', ');
        }
    }

    return forwardedHeaders;
}

export function getProxyResponseHeaders(headers: Headers): Array<[string, string]> {
    const forwardedHeaders: Array<[string, string]> = [];

    for (const [header, value] of headers.entries()) {
        if (HOP_BY_HOP_RESPONSE_HEADERS.has(header.toLowerCase())) continue;
        forwardedHeaders.push([header, value]);
    }

    return forwardedHeaders;
}

export function bindClientDisconnectAbort(req: AbortAwareEmitter, res: AbortAwareEmitter): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();

    const abortUpstream = () => {
        if (!controller.signal.aborted) controller.abort();
    };

    const cleanup = () => {
        req.off('aborted', abortUpstream);
        req.off('close', abortUpstream);
        res.off('close', abortUpstream);
    };

    req.once('aborted', abortUpstream);
    req.once('close', abortUpstream);
    res.once('close', abortUpstream);
    controller.signal.addEventListener('abort', cleanup, { once: true });

    if (req.aborted || req.destroyed || res.destroyed) {
        abortUpstream();
    }

    return {
        signal: controller.signal,
        cleanup
    };
}

function shouldSendUpstreamBody(status: number, body: Response['body'] | null): body is Response['body'] {
    return body !== null && ![204, 205, 304].includes(status);
}

export function shouldSendProxyBody(
    method: string,
    status: number,
    body: Response['body'] | null
): body is Response['body'] {
    return method !== 'HEAD' && shouldSendUpstreamBody(status, body);
}

export default async function router(schema: Schema, config: Config) {
    await schema.get('/stream/:stream/:type.m3u8', {
        name: 'HLS Manifest',
        group: 'Stream',
        description: 'Returns Proxied HLS Manifest',
        query: Type.Object({
            token: Type.Optional(Type.String())
        }),
        params: Type.Object({
            type: Type.Union([Type.Literal('index'), Type.Literal('segment')]),
            stream: Type.String()
        }),
    }, async (req, res) => {
        try {
            if (req.query.token) {
                const decoded = verifySignedUrl(config.SigningSecret, req.params.stream, req.query.token);

                if (!decoded || typeof decoded === 'boolean') {
                    throw new Err(403, null, 'Invalid or expired signed URL');
                }

                const realUrl = cache.get<string>(`${req.params.stream}-${decoded.hash}`);
                if (!realUrl) {
                    return res.status(404).json({ error: 'Resource not found or expired' });
                }

                const headers = getManifestRequestHeaders(req.headers);
                const method = getUpstreamRequestMethod(req.method);

                const resPlaylist = await fetch(realUrl, {
                    method,
                    headers
                });

                if (!resPlaylist.ok) {
                    if (resPlaylist.status === 404) {
                        throw new Err(404, null, `Stream not found: ${resPlaylist.status}: ${resPlaylist.statusText}`);
                    } else {
                        throw new Err(500, null, `Failed to fetch playlist: ${resPlaylist.status}: ${resPlaylist.statusText}`);
                    }
                }

                res.status(resPlaylist.status);

                if (req.method === 'HEAD') {
                    sendManifestHead(res);
                    return;
                }

                const m3u8Content = await resPlaylist.text();
                const newM3U8 = Manifest.rewrite(m3u8Content, realUrl, req.params.stream, config, cache);

                sendManifest(res, newM3U8);
            } else {
                const cloudtakPath = await getCloudTAKPath(config, req.params.stream);
                const url = getPlaylistUpstreamUrl(req.params.stream, cloudtakPath.proxy);

                const headers = getManifestRequestHeaders(req.headers);
                const method = getUpstreamRequestMethod(req.method);

                const resPlaylist = await fetch(url, {
                    method,
                    headers
                });

                if (!resPlaylist.ok) {
                    if (resPlaylist.status === 404) {
                        throw new Err(404, null, `Stream not found: ${resPlaylist.status}: ${resPlaylist.statusText}`);
                    } else {
                        throw new Err(500, null, `Failed to fetch playlist: ${resPlaylist.status}: ${resPlaylist.statusText}`);
                    }
                }

                res.status(resPlaylist.status);

                if (req.method === 'HEAD') {
                    sendManifestHead(res);
                    return;
                }

                const m3u8Content = await resPlaylist.text();
                const newM3U8 = Manifest.rewrite(m3u8Content, url.href, req.params.stream, config, cache);

                sendManifest(res, newM3U8);
            }
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/stream/:stream/segment.:format', {
        name: 'HLS Segment',
        group: 'Stream',
        description: 'Returns Proxied HLS Media',
        query: Type.Object({
            token: Type.String()
        }),
        params: Type.Object({
            stream: Type.String(),
            format: Type.String()
        }),
    }, async (req, res) => {
        const { signal, cleanup } = bindClientDisconnectAbort(req, res);

        try {
            const decoded = verifySignedUrl(config.SigningSecret, req.params.stream, req.query.token);

            if (!decoded || typeof decoded === 'boolean') {
                throw new Err(403, null, 'Invalid or expired signed URL');
            }

            const realUrl = cache.get<string>(`${req.params.stream}-${decoded.hash}`);
            if (!realUrl) {
                return res.status(404).json({ error: 'Resource not found or expired' });
            }

            const headers = getProxyRequestHeaders(req.headers);
            const method = getUpstreamRequestMethod(req.method);

            const segmentResp = await fetch(realUrl, { method, headers, signal });

            res.status(segmentResp.status);

            for (const [header, value] of getProxyResponseHeaders(segmentResp.headers)) {
                res.setHeader(header, value);
            }

            if (!segmentResp.headers.has('content-type')) {
                res.setHeader('Content-Type', 'application/octet-stream');
            }

            if (!shouldSendProxyBody(req.method, segmentResp.status, segmentResp.body)) {
                res.end();
                return;
            }

            await pipeline(
                Readable.fromWeb(segmentResp.body as ReadableStream),
                res
            );
        } catch (err) {
            if (signal.aborted) return;

            if (res.headersSent) {
                res.destroy(err instanceof Error ? err : new Error('Failed to stream media segment'));
            } else {
                Err.respond(err, res);
            }
        } finally {
            cleanup();
        }
    });
}
