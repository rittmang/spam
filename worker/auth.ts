import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';
import { HttpError } from './http';

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export function isLocal(request: Request, env: Env) {
  return (
    env.DEV_MODE === 'true' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
  );
}
export async function authorize(request: Request, env: Env) {
  if (isLocal(request, env)) return 'local-owner';
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAIL)
    throw new HttpError(
      503,
      'Configure Cloudflare Access and the owner email before using the dashboard.',
    );
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'Sign in through Cloudflare Access.');
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain))
    throw new HttpError(503, 'Invalid Cloudflare Access team domain.');
  let keys = keysets.get(domain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
    keysets.set(domain, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: domain,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
    });
    if (
      typeof payload.email !== 'string' ||
      payload.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()
    )
      throw new Error('Not owner');
    return payload.email;
  } catch {
    throw new HttpError(403, 'Access is restricted to the bot owner.');
  }
}
export function verifyMutation(request: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new HttpError(403, 'Cross-origin writes are blocked.');
  if (request.headers.get('X-Watchtower-Request') !== '1')
    throw new HttpError(403, 'Missing request protection header.');
}
export async function secureEqual(a: string, b: string) {
  const encode = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode.encode(a)),
    crypto.subtle.digest('SHA-256', encode.encode(b)),
  ]);
  const l = new Uint8Array(left),
    r = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < l.length; i++) difference |= l[i] ^ r[i];
  return difference === 0;
}
