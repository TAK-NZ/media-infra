import jwt from 'jsonwebtoken';

/**
 * Lifetime of a signed segment URL.
 *
 * A token only has to outlive the round trip from "client fetched this manifest"
 * to "client requested the segments listed in it", plus some retry slack. That
 * is a few seconds for a live playlist.
 *
 * This was previously 10 minutes, which is far longer than the live window any
 * source actually retains (a typical sliding window holds ~90s of segments). The
 * mismatch meant a paused client resumed holding a still-valid token that
 * pointed at segments the origin had already deleted, so instead of a clean
 * "your URL expired" it got an opaque upstream 404, sometimes as an HTML error
 * page proxied straight through.
 */
export const SIGNED_URL_TTL_SECONDS = 120;

export function generateSignedUrl(
    secret: string,
    path: string,
    hash: string,
    type: string
): string {
    const token = jwt.sign({
        path,
        hash,
        type
    }, secret, { expiresIn: SIGNED_URL_TTL_SECONDS });

    return `/stream/${path}/segment.${type}?token=${token}`;
}

export function verifySignedUrl(
    secret: string,
    path: string,
    token: string
): { path: string; hash: string; type: string } | false {
    try {
        const decoded = jwt.verify(token, secret) as { path: string; hash: string; type: string };
        if (decoded.path !== path) return false;
        return decoded;
    } catch (err) {
        console.error(err);
        return false;
    }
}
