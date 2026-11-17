// Cloudflare Worker entry: serves the static client and routes
// /ws/<64-hex room hash> to that room's Durable Object.

export { RoomDO } from './room.js';

const ROOM_PATH = /^\/ws\/([0-9a-f]{64})$/;

function securityHeaders(res, url) {
  const out = new Response(res.body, res);
  const h = out.headers;
  const wsOrigin = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`;
  h.set(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' blob: data:",
      "media-src 'self' blob:",
      "font-src 'self'",
      `connect-src 'self' ${wsOrigin}`,
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
  );
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  if (url.protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  if (url.pathname === '/' || url.pathname.endsWith('.html')) h.set('Cache-Control', 'no-cache');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(ROOM_PATH);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      // Block cross-site WebSocket hijacking from other web origins.
      const origin = request.headers.get('Origin');
      if (origin && new URL(origin).host !== url.host) {
        return new Response('Forbidden origin', { status: 403 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith('/ws/')) return new Response('Not found', { status: 404 });
    const res = await env.ASSETS.fetch(request);
    return securityHeaders(res, url);
  },
};
