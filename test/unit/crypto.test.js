import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIdentity,
  importPeerKeys,
  roomHash,
  passwordFactor,
  deriveChannelKeys,
  xorBytes,
  seal,
  open,
  pad,
  unpad,
  sign,
  verify,
  fingerprint,
  safetyNumber,
  newSenderKey,
} from '../../client/src/crypto/primitives.js';
import { utf8, fromUtf8, b64, unb64, hex, unhex, randomBytes } from '../../client/src/crypto/encoding.js';

const ITER = 1000; // fast for tests; production uses 600k

async function pairKeys(a, b, pwA, pwB, room) {
  const rh = await roomHash(room);
  const pa = await importPeerKeys(a.dhPubB64, a.sigPubB64);
  const pb = await importPeerKeys(b.dhPubB64, b.sigPubB64);
  const kA = await deriveChannelKeys({ myDhPrivate: a.dhPrivate, peerDhKey: pb.dhKey, pwFactor: await passwordFactor(pwA, room, ITER), roomHashHex: rh, myDhPubB64: a.dhPubB64, peerDhPubB64: b.dhPubB64 });
  const kB = await deriveChannelKeys({ myDhPrivate: b.dhPrivate, peerDhKey: pa.dhKey, pwFactor: await passwordFactor(pwB, room, ITER), roomHashHex: rh, myDhPubB64: b.dhPubB64, peerDhPubB64: a.dhPubB64 });
  return { kA, kB };
}

test('encoding round trips', () => {
  const bytes = randomBytes(200_000);
  assert.deepEqual(unb64(b64(bytes)), bytes);
  assert.deepEqual(unhex(hex(bytes.subarray(0, 64))), bytes.subarray(0, 64));
  assert.equal(fromUtf8(utf8('密碼 ✓')), '密碼 ✓');
});

test('room hash is deterministic, 64 hex, and hides the name', async () => {
  const h = await roomHash('secret-room');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await roomHash('  secret-room '));
  assert.notEqual(h, await roomHash('secret-room2'));
  assert.ok(!h.includes(Buffer.from('secret').toString('hex')));
});

test('password factor depends on password and room', async () => {
  const a = await passwordFactor('pw', 'r', ITER);
  assert.equal(a.length, 32);
  assert.deepEqual(a, await passwordFactor('pw', 'r', ITER));
  assert.notDeepEqual(a, await passwordFactor('pw2', 'r', ITER));
  assert.notDeepEqual(a, await passwordFactor('pw', 'r2', ITER));
});

test('xor is self-inverse and length checked', () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([255, 0, 7]);
  assert.deepEqual(xorBytes(xorBytes(a, b), b), a);
  assert.throws(() => xorBytes(a, new Uint8Array(2)));
});

test('same password -> both sides derive the same pair and dm keys', async () => {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const { kA, kB } = await pairKeys(a, b, 'hunter2', 'hunter2', 'room');
  const aad = utf8('ctx');
  const s1 = await seal(kA.pair, utf8('hello'), aad);
  assert.equal(fromUtf8(await open(kB.pair, s1.iv, s1.ct, aad)), 'hello');
  const s2 = await seal(kB.dm, utf8('private'), aad);
  assert.equal(fromUtf8(await open(kA.dm, s2.iv, s2.ct, aad)), 'private');
  // pair and dm keys are domain separated
  await assert.rejects(open(kB.dm, s1.iv, s1.ct, aad));
});

test('different password -> decryption fails (password error isolation)', async () => {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const { kA, kB } = await pairKeys(a, b, 'right', 'wrong', 'room');
  const aad = utf8('ctx');
  const s = await seal(kA.pair, utf8('hello'), aad);
  await assert.rejects(open(kB.pair, s.iv, s.ct, aad));
});

test('AAD binds ciphertext to its context', async () => {
  const sk = await newSenderKey();
  const s = await seal(sk.key, utf8('x'), utf8('room-A'));
  await assert.rejects(open(sk.key, s.iv, s.ct, utf8('room-B')));
});

test('padding hides length into buckets', () => {
  assert.equal(pad(utf8('a')).length, 256);
  assert.equal(pad(new Uint8Array(252)).length, 256);
  assert.equal(pad(new Uint8Array(253)).length, 512);
  assert.equal(pad(new Uint8Array(5000)).length, 8192);
  const msg = utf8('padding test ✓');
  assert.equal(fromUtf8(unpad(pad(msg))), 'padding test ✓');
  assert.throws(() => unpad(new Uint8Array([0, 0, 1, 0])));
});

test('signatures verify and detect tampering', async () => {
  const a = await generateIdentity();
  const p = await importPeerKeys(a.dhPubB64, a.sigPubB64);
  const data = utf8('frame');
  const s = await sign(a.sigPrivate, data);
  assert.equal(await verify(p.verifyKey, s, data), true);
  assert.equal(await verify(p.verifyKey, s, utf8('frame!')), false);
});

test('safety number is symmetric and changes if a key is swapped', async () => {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const m = await generateIdentity();
  const fa = await fingerprint(a.dhPub, a.sigPub);
  const fb = await fingerprint(b.dhPub, b.sigPub);
  const fm = await fingerprint(m.dhPub, m.sigPub);
  const n1 = await safetyNumber(fa, fb);
  assert.match(n1, /^(\d{5} ){11}\d{5}$/);
  assert.equal(n1, await safetyNumber(fb, fa));
  assert.notEqual(n1, await safetyNumber(fa, fm));
});

test('rejects malformed public keys', async () => {
  await assert.rejects(importPeerKeys(b64(new Uint8Array(65)), b64(new Uint8Array(65))));
  await assert.rejects(importPeerKeys(b64(new Uint8Array(33)), b64(new Uint8Array(65))));
});
