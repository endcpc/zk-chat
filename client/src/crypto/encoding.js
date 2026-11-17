// Byte / string helpers shared by the browser client and the Node test harness.
// Pure ES modules, no dependencies.

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s) => te.encode(s);
export const fromUtf8 = (b) => td.decode(b);

export function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('expected bytes');
}

export function b64(bytes) {
  const u = toBytes(bytes);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function unb64(str) {
  if (typeof str !== 'string') throw new TypeError('expected base64 string');
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const hex = (b) =>
  Array.from(toBytes(b), (x) => x.toString(16).padStart(2, '0')).join('');

export function unhex(str) {
  if (typeof str !== 'string' || str.length % 2 || /[^0-9a-f]/i.test(str)) {
    throw new TypeError('expected hex string');
  }
  const out = new Uint8Array(str.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
  return out;
}

export function concat(...parts) {
  const arrs = parts.map(toBytes);
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  }
  return out;
}

export const randomId = (n = 12) => hex(randomBytes(n));

export function wipe(...arrs) {
  for (const a of arrs) if (a instanceof Uint8Array) a.fill(0);
}
