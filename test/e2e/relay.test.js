// End-to-end tests: real ChatSession clients talking through the real
// Worker + Durable Object running locally in `wrangler dev` (workerd).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { ChatSession } from '../../client/src/core/session.js';
import { randomBytes, randomId, hex } from '../../client/src/crypto/encoding.js';
import { sha256, roomHash } from '../../client/src/crypto/primitives.js';

const BASE = process.env.ZK_WS_URL ?? 'ws://127.0.0.1:8787';
const HTTP = BASE.replace(/^ws/, 'http');
const ITER = 2000; // speed; production default is 600k
const open = new Set();

after(() => {
  for (const s of open) s.close();
});

/** WebSocket subclass that records every raw frame the server delivers to this client. */
function tappedWs(log) {
  return class extends WebSocket {
    constructor(url) {
      super(url);
      this.addEventListener('message', (ev) => log.push(ev.data));
    }
  };
}

async function join(roomName, password, nickname) {
  const raw = [];
  const s = new ChatSession({ url: BASE, roomName, password, nickname, iterations: ITER, WebSocketImpl: tappedWs(raw) });
  s.raw = raw;
  s.events = [];
  for (const ev of ['message', 'file', 'join', 'leave', 'member-update', 'warning', 'rotated', 'server-error']) {
    s.on(ev, (d) => s.events.push({ ev, d }));
  }
  await s.connect();
  open.add(s);
  return s;
}

function waitFor(s, ev, pred = () => true, ms = 8000) {
  const hit = s.events.find((e) => e.ev === ev && pred(e.d));
  if (hit) return Promise.resolve(hit.d);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for ${ev}`));
    }, ms);
    const off = s.on(ev, (d) => {
      if (pred(d)) {
        clearTimeout(t);
        off();
        resolve(d);
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = (s, id) => s.members.get(id)?.status;
async function waitStatus(s, id, status, ms = 8000) {
  const end = Date.now() + ms;
  while (statusOf(s, id) !== status) {
    if (Date.now() > end) throw new Error(`member ${id} never became ${status} (is ${statusOf(s, id)})`);
    await sleep(20);
  }
}
const room = () => 'room-' + randomId(6);
const texts = (s) => s.events.filter((e) => e.ev === 'message' && !e.d.self).map((e) => e.d.text);

test('server serves the client with strict security headers', async () => {
  const res = await fetch(HTTP + '/');
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const html = await res.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline scripts');
});

test('websocket endpoint rejects bad paths and foreign origins', async () => {
  assert.equal((await fetch(HTTP + '/ws/not-a-hash')).status, 404);
  const h = await roomHash('x');
  const status = (origin) =>
    new Promise((resolve, reject) => {
      const req = http.get(HTTP + '/ws/' + h, {
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': Buffer.from(randomId(8), 'hex').toString('base64'), Origin: origin,
        },
      });
      req.on('response', (res) => (res.resume(), resolve(res.statusCode)));
      req.on('upgrade', (res, socket) => (socket.destroy(), resolve(res.statusCode)));
      req.on('error', reject);
    });
  assert.equal(await status('https://evil.example'), 403);
  assert.equal(await status(HTTP), 101);
});

test('presence: joins and leaves are announced to everyone in real time', async () => {
  const r = room();
  const a = await join(r, 'pw', 'Alice');
  const b = await join(r, 'pw', 'Bob');
  const joined = await waitFor(a, 'join', (d) => d.id === b.id);
  assert.equal(joined.id, b.id);
  assert.ok(b.members.has(a.id), 'newcomer gets current member list');
  await waitStatus(a, b.id, 'ok');
  await waitStatus(b, a.id, 'ok');
  assert.equal(a.members.get(b.id).nick, 'Bob', 'nickname travels only inside encrypted key frames');
  b.close();
  open.delete(b);
  const left = await waitFor(a, 'leave', (d) => d.id === b.id);
  assert.equal(left.id, b.id);
  assert.equal(a.members.size, 0);
});

test('room messages are end-to-end encrypted; relay frames never contain plaintext', async () => {
  const r = room();
  const a = await join(r, 'pw', 'A');
  const b = await join(r, 'pw', 'B');
  const c = await join(r, 'pw', 'C');
  await waitStatus(b, a.id, 'ok');
  await waitStatus(c, a.id, 'ok');
  await waitStatus(a, c.id, 'ok');
  const secret = 'the eagle lands at midnight ' + randomId(4);
  await a.sendText(secret);
  await waitFor(b, 'message', (d) => d.text === secret);
  await waitFor(c, 'message', (d) => d.text === secret);
  for (const s of [b, c]) {
    const all = s.raw.join('\n');
    assert.ok(!all.includes('eagle'), 'plaintext never on the wire');
    assert.ok(!all.includes('"A"') && !all.includes('nick'), 'nickname never on the wire');
    for (const f of s.raw.map((x) => JSON.parse(x))) {
      const allowed = new Set(['t', 'v', 'from', 'to', 'kid', 'iv', 'ct', 's', 'id', 'dh', 'sig', 'members', 'code']);
      for (const k of Object.keys(f)) assert.ok(allowed.has(k), `unexpected field ${k}`);
    }
  }
  assert.ok(!a.raw.some((x) => x.includes(secret)), 'sender gets no echo from server');
});

test('no history: a newcomer cannot see anything said before they joined', async () => {
  const r = room();
  const a = await join(r, 'pw', 'A');
  const b = await join(r, 'pw', 'B');
  await waitStatus(b, a.id, 'ok');
  await a.sendText('before you came');
  await waitFor(b, 'message', (d) => d.text === 'before you came');
  const d = await join(r, 'pw', 'D');
  await waitStatus(d, a.id, 'ok');
  await a.sendText('after you came');
  await waitFor(d, 'message', (x) => x.text === 'after you came');
  assert.deepEqual(texts(d), ['after you came']);
});

test('private chat: only the addressed member receives the frame', async () => {
  const r = room();
  const a = await join(r, 'pw', 'A');
  const b = await join(r, 'pw', 'B');
  const c = await join(r, 'pw', 'C');
  await waitStatus(a, b.id, 'ok');
  await waitStatus(b, a.id, 'ok');
  await waitStatus(c, a.id, 'ok');
  const rawBefore = c.raw.length;
  await a.sendText('just between us', { to: b.id });
  const got = await waitFor(b, 'message', (d) => d.text === 'just between us');
  assert.equal(got.scope, 'dm');
  assert.equal(got.peerId, a.id);
  await a.sendText('room ping');
  await waitFor(c, 'message', (d) => d.text === 'room ping');
  const cFrames = c.raw.slice(rawBefore).map((x) => JSON.parse(x));
  assert.ok(!cFrames.some((f) => f.t === 'dm'), 'third member never receives the DM frame');
  assert.ok(!texts(c).includes('just between us'));
  // both sides compute the same safety number
  assert.equal(await a.safetyNumberWith(b.id), await b.safetyNumberWith(a.id));
});

test('room password isolation: different passwords cannot read each other', async () => {
  const r = room();
  const a = await join(r, 'correct horse', 'A');
  const b = await join(r, 'correct horse', 'B');
  const e = await join(r, 'wrong password', 'E');
  await waitStatus(a, e.id, 'mismatch');
  await waitStatus(e, a.id, 'mismatch');
  await waitStatus(a, b.id, 'ok');
  await waitStatus(b, a.id, 'ok');
  await a.sendText('for password holders');
  await e.sendText('from the outsider');
  await waitFor(b, 'message', (d) => d.text === 'for password holders');
  await sleep(400);
  assert.ok(!texts(e).includes('for password holders'));
  assert.ok(!texts(a).includes('from the outsider'));
  assert.ok(!texts(b).includes('from the outsider'));
  await assert.rejects(a.sendText('dm attempt', { to: e.id }), /password mismatch/);
});

test('different rooms are fully separated', async () => {
  const a = await join(room(), 'pw', 'A');
  const b = await join(room(), 'pw', 'B');
  await a.sendText('hello?');
  await sleep(300);
  assert.equal(a.members.size, 0);
  assert.equal(b.members.size, 0);
  assert.deepEqual(texts(b), []);
});

test('sender keys rotate on every leave', async () => {
  const r = room();
  const a = await join(r, 'pw', 'A');
  const b = await join(r, 'pw', 'B');
  const c = await join(r, 'pw', 'C');
  await waitStatus(c, a.id, 'ok');
  // wait until A's join-triggered rotations have settled and B holds A's current key
  let kidBefore;
  for (let stable = 0, end = Date.now() + 8000; stable < 5 && Date.now() < end; await sleep(40)) {
    const k = a.mySend?.kid;
    stable = k && k === kidBefore && b.members.get(a.id)?.senderKeys.has(k) ? stable + 1 : 0;
    kidBefore = k;
  }
  const bHadKeys = [...b.members.get(a.id).senderKeys.keys()];
  assert.ok(bHadKeys.includes(kidBefore));
  b.close();
  open.delete(b);
  await waitFor(a, 'leave', (d) => d.id === b.id);
  await waitFor(a, 'rotated', (d) => d.kid !== kidBefore);
  assert.notEqual(a.mySend.kid, kidBefore);
  assert.ok(!bHadKeys.includes(a.mySend.kid), 'departed member never had the new key');
  await a.sendText('post-leave');
  await waitFor(c, 'message', (d) => d.text === 'post-leave');
});

test('files and images: encrypted chunked transfer with integrity check (room and DM)', async () => {
  const r = room();
  const a = await join(r, 'pw', 'A');
  const b = await join(r, 'pw', 'B');
  const c = await join(r, 'pw', 'C');
  await waitStatus(b, a.id, 'ok');
  await waitStatus(c, a.id, 'ok');
  await waitStatus(a, b.id, 'ok');
  const bytes = randomBytes(1_000_003);
  const sha = hex(await sha256(bytes));
  await a.sendFile({ name: 'photo.png', mime: 'image/png', bytes });
  const got = await waitFor(b, 'file', (d) => d.name === 'photo.png', 20000);
  assert.equal(got.size, bytes.length);
  assert.equal(hex(await sha256(got.bytes)), sha);
  await waitFor(c, 'file', (d) => d.name === 'photo.png', 20000);

  const dmBytes = randomBytes(300_000);
  const cBefore = c.raw.length;
  await a.sendFile({ name: 'secret.pdf', mime: 'application/pdf', bytes: dmBytes }, { to: b.id });
  const dmGot = await waitFor(b, 'file', (d) => d.name === 'secret.pdf', 20000);
  assert.equal(dmGot.scope, 'dm');
  assert.equal(hex(await sha256(dmGot.bytes)), hex(await sha256(dmBytes)));
  await sleep(200);
  assert.ok(!c.raw.slice(cBefore).some((x) => JSON.parse(x).t === 'dm'));
});

test('forged frames: tampered ciphertext or wrong signature are dropped', async () => {
  const r = room();
  const a = await join(r, 'pw', 'A');
  const b = await join(r, 'pw', 'B');
  await waitStatus(b, a.id, 'ok');
  // Capture a legit frame A sends, flip one ciphertext byte, and replay it from A's socket.
  const sent = [];
  const origSend = a.ws.send.bind(a.ws);
  a.ws.send = (data) => {
    sent.push(data);
    origSend(data);
  };
  await a.sendText('legit');
  await waitFor(b, 'message', (d) => d.text === 'legit');
  const frame = JSON.parse(sent.find((x) => JSON.parse(x).t === 'msg'));
  const ct = Buffer.from(frame.ct, 'base64');
  ct[10] ^= 0x01;
  origSend(JSON.stringify({ ...frame, ct: ct.toString('base64') }));
  await waitFor(b, 'warning', (d) => d.code === 'bad-signature');
  // Exact replay of the untouched frame is ignored too (duplicate message id).
  origSend(sent.find((x) => JSON.parse(x).t === 'msg'));
  await sleep(300);
  assert.equal(texts(b).filter((t) => t === 'legit').length, 1);
});

test('relay code never touches Durable Object storage', () => {
  const src = readFileSync(new URL('../../worker/src/room.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /storage\s*\.|\.storage\b|ctx\.storage|KV|D1|R2/);
  assert.doesNotMatch(code, /console\.(log|info|warn|error|debug)/, 'relay logs nothing');
});
