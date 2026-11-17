// All cryptography runs locally through the Web Crypto API.
// Curve choice: P-256 for both ECDH and ECDSA, because it is supported by
// every browser's Web Crypto implementation and by Node, so all clients
// interoperate without negotiation.

import { utf8, unhex, b64, unb64, hex, concat, randomBytes, toBytes, wipe } from './encoding.js';

const subtle = globalThis.crypto.subtle;

export const PROTOCOL_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' };

export const sha256 = async (data) => new Uint8Array(await subtle.digest('SHA-256', toBytes(data)));
export const sha512 = async (data) => new Uint8Array(await subtle.digest('SHA-512', toBytes(data)));

const normalizeRoom = (name) => String(name).trim().normalize('NFC');

// ---------------------------------------------------------------- identity

/** Ephemeral per-session identity. Private keys are non-extractable. */
export async function generateIdentity() {
  const dh = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const sig = await subtle.generateKey(ECDSA, false, ['sign', 'verify']);
  const dhPub = new Uint8Array(await subtle.exportKey('raw', dh.publicKey));
  const sigPub = new Uint8Array(await subtle.exportKey('raw', sig.publicKey));
  return {
    dhPrivate: dh.privateKey,
    sigPrivate: sig.privateKey,
    dhPub,
    sigPub,
    dhPubB64: b64(dhPub),
    sigPubB64: b64(sigPub),
  };
}

function checkPoint(bytes) {
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error('bad public key');
  return bytes;
}

export async function importPeerKeys(dhPubB64, sigPubB64) {
  const dhPub = checkPoint(unb64(dhPubB64));
  const sigPub = checkPoint(unb64(sigPubB64));
  const dhKey = await subtle.importKey('raw', dhPub, ECDH, false, []);
  const verifyKey = await subtle.importKey('raw', sigPub, ECDSA, false, ['verify']);
  return { dhPub, sigPub, dhKey, verifyKey };
}

// -------------------------------------------------------------- room / password

/** What the server sees instead of the room name. */
export async function roomHash(roomName) {
  return hex(await sha256(utf8('zkchat/v1/room-id|' + normalizeRoom(roomName))));
}

/**
 * H(password): the password factor of the spec's
 *   Final Shared Key = ECDH_Shared_Key XOR H(Room Password)
 * H is PBKDF2-SHA256 (600k iterations, salted by the room name) instead of a
 * single SHA-256, so a captured ciphertext cannot be used to brute-force a
 * weak password at billions of guesses per second.
 */
export async function passwordFactor(password, roomName, iterations = PBKDF2_ITERATIONS) {
  const salt = await sha256(utf8('zkchat/v1/pw-salt|' + normalizeRoom(roomName)));
  const base = await subtle.importKey('raw', utf8(String(password).normalize('NFC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return new Uint8Array(bits);
}

export function xorBytes(a, b) {
  if (a.length !== b.length) throw new Error('xor length mismatch');
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/**
 * Pairwise channel keys between me and one peer.
 *   Z = ECDH(myPriv, peerPub)
 *   M = Z XOR H(password)                 <- the spec's Final Shared Key
 *   pair = HKDF(M, salt=roomHash, info="pair"|sorted pubs)  (wraps sender keys)
 *   dm   = HKDF(M, salt=roomHash, info="dm"|sorted pubs)    (private chat)
 */
export async function deriveChannelKeys({ myDhPrivate, peerDhKey, pwFactor, roomHashHex, myDhPubB64, peerDhPubB64 }) {
  const z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peerDhKey }, myDhPrivate, 256));
  const m = xorBytes(z, pwFactor);
  const ikm = await subtle.importKey('raw', m, 'HKDF', false, ['deriveKey']);
  wipe(z, m);
  const [a, b] = [myDhPubB64, peerDhPubB64].sort();
  const salt = unhex(roomHashHex);
  const derive = (label) =>
    subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(`zkchat/v1/${label}|${a}|${b}`) },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  const [pair, dm] = await Promise.all([derive('pair'), derive('dm')]);
  return { pair, dm };
}

// ------------------------------------------------------------- sender keys

export async function newSenderKey() {
  const raw = randomBytes(32);
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { kid: hex(randomBytes(8)), raw, key };
}

export const importSenderKey = (raw) =>
  subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

// --------------------------------------------------------------------- AEAD

export async function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
  return { iv, ct: new Uint8Array(ct) };
}

export async function open(key, iv, ct, aad) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct);
  return new Uint8Array(pt);
}

// ---------------------------------------------------------------- padding

/** Length-hiding padding: 256-byte buckets up to 4 KiB, then 4 KiB buckets. */
export function pad(bytes) {
  const total = 4 + bytes.length;
  const block = total <= 4096 ? 256 : 4096;
  const out = new Uint8Array(Math.ceil(total / block) * block);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

export function unpad(buf) {
  if (buf.length < 4) throw new Error('bad padding');
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0);
  if (len > buf.length - 4) throw new Error('bad padding');
  return buf.subarray(4, 4 + len);
}

// -------------------------------------------------------------- signatures

export async function sign(sigPrivate, data) {
  return new Uint8Array(await subtle.sign(ECDSA_SIGN, sigPrivate, data));
}

export async function verify(verifyKey, signature, data) {
  try {
    return await subtle.verify(ECDSA_SIGN, verifyKey, signature, data);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------- fingerprints

export const fingerprint = (dhPub, sigPub) => sha256(concat(dhPub, sigPub));

/**
 * 60-digit safety number for a pair, identical on both sides.
 * If the server ever substituted keys (MITM), the two users would see
 * different numbers when they compare them out of band.
 */
export async function safetyNumber(fpA, fpB) {
  const [x, y] = [fpA, fpB].sort((p, q) => (hex(p) < hex(q) ? -1 : 1));
  const h = await sha512(concat(utf8('zkchat/v1/safety|'), x, y));
  const dv = new DataView(h.buffer);
  const groups = [];
  for (let i = 0; i < 12; i++) groups.push(String(dv.getUint32(i * 4) % 100000).padStart(5, '0'));
  return groups.join(' ');
}
