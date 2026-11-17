// ChatSession: the whole end-to-end protocol, independent of the DOM.
// The same module runs in the browser and in the Node test harness.
//
// Layers
//   1. Transport: TLS (wss://) to the Cloudflare Worker.
//   2. Room binding: every pairwise key mixes in H(room password), so members
//      with a different password can never decrypt each other.
//   3. Message E2EE: ephemeral ECDH P-256 pairwise keys, per-sender AES-256-GCM
//      sender keys rotated on every join/leave, ECDSA signatures on every frame.
//
// The server only ever sees: an opaque room hash, ephemeral public keys,
// random member ids, and ciphertext padded to fixed buckets.

import { Emitter } from './emitter.js';
import {
  PROTOCOL_VERSION,
  PBKDF2_ITERATIONS,
  generateIdentity,
  importPeerKeys,
  roomHash,
  passwordFactor,
  deriveChannelKeys,
  newSenderKey,
  importSenderKey,
  seal,
  open,
  pad,
  unpad,
  sign,
  verify,
  fingerprint,
  safetyNumber,
  sha256,
} from '../crypto/primitives.js';
import { utf8, fromUtf8, b64, unb64, hex, concat, randomId, wipe } from '../crypto/encoding.js';

export const MAX_TEXT = 4000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const CHUNK_BYTES = 192 * 1024;
const MAX_TRANSFERS_PER_PEER = 4;
const KEEP_OLD_SENDER_KEYS = 3;
const SEEN_CAP = 5000;
const PING_MS = 20_000;
const ROTATE_DEBOUNCE_MS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sanitizeNick(nick) {
  return String(nick ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, 32);
}

const isB64 = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
const isId = (s) => typeof s === 'string' && /^[0-9a-f]{16,64}$/.test(s);

export class ChatSession extends Emitter {
  /**
   * @param {object} opts
   * @param {string} opts.url        ws(s)://host  (no trailing path)
   * @param {string} opts.roomName   never leaves the client
   * @param {string} opts.password   never leaves the client
   * @param {string} [opts.nickname] sent only inside encrypted key frames
   * @param {Function} [opts.WebSocketImpl]
   * @param {number} [opts.iterations] PBKDF2 iterations (tests may lower it)
   */
  constructor(opts) {
    super();
    this.opts = { iterations: PBKDF2_ITERATIONS, WebSocketImpl: globalThis.WebSocket, nickname: '', ...opts };
    this.nickname = sanitizeNick(this.opts.nickname);
    this.members = new Map();
    this.transfers = new Map();
    this.id = null;
    this.mySend = null;
    this.closed = false;
    this._in = Promise.resolve();
    this._out = Promise.resolve();
    this._timers = new Set();
  }

  // ------------------------------------------------------------ lifecycle

  async connect() {
    const { url, roomName, password, iterations, WebSocketImpl } = this.opts;
    if (!String(roomName ?? '').trim()) throw new Error('room name required');
    [this.room, this.pw, this.me] = await Promise.all([
      roomHash(roomName),
      passwordFactor(password ?? '', roomName, iterations),
      generateIdentity(),
    ]);
    this.myFp = await fingerprint(this.me.dhPub, this.me.sigPub);

    const ws = new WebSocketImpl(`${String(url).replace(/\/+$/, '')}/ws/${this.room}`);
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      this._settle = (err) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve(this);
      };
      ws.onopen = () =>
        this._send({ t: 'hello', v: PROTOCOL_VERSION, dh: this.me.dhPubB64, sig: this.me.sigPubB64 });
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        this._in = this._in
          .then(() => this._handle(msg))
          .catch((e) => this.emit('warning', { code: 'handler', detail: String(e?.message ?? e) }));
      };
      ws.onclose = (ev) => {
        this._clearTimers();
        this._settle(new Error(`connection closed (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`));
        if (!this.closed) {
          this.closed = true;
          this.emit('disconnected', { code: ev.code, reason: ev.reason });
        }
        this._wipe();
      };
      ws.onerror = () => {};
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._clearTimers();
    try {
      this.ws?.close(1000, 'bye');
    } catch {}
    this._wipe();
  }

  _wipe() {
    this.members.clear();
    this.transfers.clear();
    this.mySend = null;
    if (this.pw) wipe(this.pw);
  }

  _clearTimers() {
    for (const t of this._timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this._timers.clear();
  }

  // ------------------------------------------------------------- queries

  memberList() {
    return [...this.members.values()].map((m) => ({
      id: m.id,
      nick: m.nick,
      status: m.status,
      fingerprint: m.fp ? hex(m.fp) : '',
    }));
  }

  get myFingerprint() {
    return this.myFp ? hex(this.myFp) : '';
  }

  async safetyNumberWith(id) {
    const m = this.members.get(id);
    if (!m) throw new Error('unknown member');
    await m.ready;
    return safetyNumber(this.myFp, m.fp);
  }

  // ------------------------------------------------------------- inbound

  async _handle(msg) {
    switch (msg.t) {
      case 'welcome': {
        if (this.id || !isId(msg.id) || !Array.isArray(msg.members)) return;
        this.id = msg.id;
        await Promise.all(msg.members.map((m) => this._addMember(m)));
        this._timers.add(setInterval(() => this._send({ t: 'ping' }), PING_MS));
        this._settle();
        this.emit('ready', { id: this.id });
        this._scheduleRotate();
        return;
      }
      case 'join': {
        const m = await this._addMember(msg);
        if (m) {
          this.emit('join', this._publicMember(m));
          this._scheduleRotate();
        }
        return;
      }
      case 'leave': {
        const m = this.members.get(msg.id);
        if (!m) return;
        this.members.delete(msg.id);
        for (const k of this.transfers.keys()) if (k.startsWith(m.id + ':')) this.transfers.delete(k);
        this.emit('leave', this._publicMember(m));
        this._scheduleRotate(); // leaver's copy of our sender key becomes useless
        return;
      }
      case 'key':
      case 'msg':
      case 'dm':
        return this._handleSealed(msg);
      case 'error':
        this.emit('server-error', { code: String(msg.code ?? 'unknown') });
        if (!this.id) this._settle(new Error(`server: ${msg.code}`));
        return;
      default:
        return; // pong and unknown frames
    }
  }

  async _addMember(info) {
    if (!info || !isId(info.id) || info.id === this.id || this.members.has(info.id)) return null;
    const m = {
      id: info.id,
      nick: '',
      status: 'pending', // pending -> ok | mismatch
      senderKeys: new Map(),
      seen: new Set(),
      fp: null,
      keys: null,
      verifyKey: null,
    };
    m.ready = (async () => {
      const pk = await importPeerKeys(info.dh, info.sig);
      m.verifyKey = pk.verifyKey;
      m.fp = await fingerprint(pk.dhPub, pk.sigPub);
      m.keys = await deriveChannelKeys({
        myDhPrivate: this.me.dhPrivate,
        peerDhKey: pk.dhKey,
        pwFactor: this.pw,
        roomHashHex: this.room,
        myDhPubB64: this.me.dhPubB64,
        peerDhPubB64: info.dh,
      });
    })();
    this.members.set(m.id, m);
    try {
      await m.ready;
    } catch {
      this.members.delete(m.id);
      this.emit('warning', { code: 'bad-member-key', id: m.id });
      return null;
    }
    return m;
  }

  _publicMember(m) {
    return { id: m.id, nick: m.nick, status: m.status, fingerprint: m.fp ? hex(m.fp) : '' };
  }

  _setStatus(m, status, nick) {
    const changed = m.status !== status || (nick !== undefined && nick !== m.nick);
    m.status = status;
    if (nick !== undefined) m.nick = nick;
    if (changed) this.emit('member-update', this._publicMember(m));
  }

  _header(t, from, to, kid) {
    return utf8(JSON.stringify([PROTOCOL_VERSION, t, this.room, from, to || '', kid || '']));
  }

  _signedBytes(aad, iv, ct) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, aad.length);
    return concat(len, aad, iv, ct);
  }

  async _handleSealed(msg) {
    const from = this.members.get(msg.from);
    if (!from) return;
    try {
      await from.ready;
    } catch {
      return;
    }
    if (!isB64(msg.iv, 24) || !isB64(msg.ct, 1_400_000) || !isB64(msg.s, 200)) return;
    const direct = msg.t === 'key' || msg.t === 'dm';
    if (direct && msg.to !== this.id) return;
    if (msg.t !== 'dm' && !(typeof msg.kid === 'string' && /^[0-9a-f]{16}$/.test(msg.kid))) return;

    const iv = unb64(msg.iv);
    const ct = unb64(msg.ct);
    if (iv.length !== 12) return;
    const aad = this._header(msg.t, msg.from, direct ? msg.to : '', msg.t === 'dm' ? '' : msg.kid);
    if (!(await verify(from.verifyKey, unb64(msg.s), this._signedBytes(aad, iv, ct)))) {
      this.emit('warning', { code: 'bad-signature', id: from.id });
      return;
    }

    let key;
    if (msg.t === 'key') key = from.keys.pair;
    else if (msg.t === 'dm') key = from.keys.dm;
    else key = from.senderKeys.get(msg.kid);
    if (!key) return; // message encrypted before we joined: by design unreadable

    let payload;
    try {
      const pt = await open(key, iv, ct, aad);
      payload = JSON.parse(fromUtf8(unpad(pt)));
      wipe(pt);
    } catch {
      // A valid signature but failed decryption on a pairwise channel means the
      // peer derived a different key: they used a different room password.
      if (direct) this._setStatus(from, 'mismatch');
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    if (msg.t === 'key') {
      if (payload.kid !== msg.kid || !isB64(payload.k, 64)) return;
      const raw = unb64(payload.k);
      if (raw.length !== 32) return;
      from.senderKeys.set(payload.kid, await importSenderKey(raw));
      wipe(raw);
      while (from.senderKeys.size > KEEP_OLD_SENDER_KEYS) {
        from.senderKeys.delete(from.senderKeys.keys().next().value);
      }
      this._setStatus(from, 'ok', sanitizeNick(payload.nick));
      return;
    }

    if (typeof payload.id !== 'string' || payload.id.length > 64) return;
    if (from.seen.has(payload.id)) return; // replay
    from.seen.add(payload.id);
    if (from.seen.size > SEEN_CAP) from.seen.delete(from.seen.values().next().value);

    await this._deliver(from, msg.t === 'dm' ? 'dm' : 'room', payload);
  }

  async _deliver(from, scope, p) {
    const base = { scope, from: from.id, peerId: scope === 'dm' ? from.id : null, self: false, id: p.id };
    const ts = Number.isFinite(p.ts) ? p.ts : Date.now();
    switch (p.type) {
      case 'text':
        if (typeof p.body !== 'string' || p.body.length > MAX_TEXT) return;
        this.emit('message', { ...base, ts, text: p.body });
        return;
      case 'file': {
        const ok =
          typeof p.fileId === 'string' && /^[0-9a-f]{24}$/.test(p.fileId) &&
          typeof p.name === 'string' && p.name.length <= 255 &&
          typeof p.mime === 'string' && p.mime.length <= 100 &&
          Number.isInteger(p.size) && p.size > 0 && p.size <= MAX_FILE_BYTES &&
          p.chunks === Math.ceil(p.size / CHUNK_BYTES) &&
          typeof p.sha === 'string' && /^[0-9a-f]{64}$/.test(p.sha);
        if (!ok) return;
        let active = 0;
        for (const k of this.transfers.keys()) if (k.startsWith(from.id + ':')) active++;
        if (active >= MAX_TRANSFERS_PER_PEER) return;
        const key = `${from.id}:${p.fileId}`;
        this.transfers.set(key, { scope, ts, meta: p, parts: new Array(p.chunks), got: 0 });
        this.emit('file-start', { ...base, ts, fileId: p.fileId, name: p.name, mime: p.mime, size: p.size });
        return;
      }
      case 'chunk': {
        const key = `${from.id}:${p.fileId}`;
        const tr = this.transfers.get(key);
        if (!tr || tr.scope !== scope) return;
        if (!Number.isInteger(p.idx) || p.idx < 0 || p.idx >= tr.meta.chunks || tr.parts[p.idx]) return;
        if (!isB64(p.data, Math.ceil(CHUNK_BYTES / 3) * 4 + 4)) return;
        const data = unb64(p.data);
        tr.parts[p.idx] = data;
        tr.got++;
        this.emit('file-progress', { ...base, fileId: p.fileId, fraction: tr.got / tr.meta.chunks });
        if (tr.got < tr.meta.chunks) return;
        this.transfers.delete(key);
        const bytes = concat(...tr.parts);
        const good = bytes.length === tr.meta.size && hex(await sha256(bytes)) === tr.meta.sha;
        if (!good) {
          this.emit('warning', { code: 'file-corrupt', id: from.id, fileId: p.fileId });
          return;
        }
        this.emit('file', {
          ...base,
          id: tr.meta.id,
          ts: tr.ts,
          fileId: p.fileId,
          name: tr.meta.name,
          mime: tr.meta.mime,
          size: tr.meta.size,
          bytes,
        });
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------ outbound

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  _enqueueOut(job) {
    const p = this._out.then(job);
    this._out = p.catch(() => {});
    return p;
  }

  _scheduleRotate() {
    clearTimeout(this._rotateTimer);
    this._timers.delete(this._rotateTimer);
    this._rotateTimer = setTimeout(() => {
      this._timers.delete(this._rotateTimer);
      this._enqueueOut(() => this._rotate()).catch((e) =>
        this.emit('warning', { code: 'rotate', detail: String(e?.message ?? e) }),
      );
    }, ROTATE_DEBOUNCE_MS);
    this._timers.add(this._rotateTimer);
  }

  async _rotate() {
    if (!this.id || this.closed) return;
    const sk = await newSenderKey();
    this.mySend = { kid: sk.kid, key: sk.key };
    const k = b64(sk.raw);
    wipe(sk.raw);
    for (const m of [...this.members.values()]) {
      if (!m.keys) continue;
      await this._sealAndSend('key', m.keys.pair, { kid: sk.kid, k, nick: this.nickname }, { to: m.id, kid: sk.kid });
    }
    this.emit('rotated', { kid: sk.kid });
  }

  async _sealAndSend(t, key, payload, { to, kid } = {}) {
    const pt = pad(utf8(JSON.stringify(payload)));
    const aad = this._header(t, this.id, to, kid);
    const { iv, ct } = await seal(key, pt, aad);
    wipe(pt);
    const s = await sign(this.me.sigPrivate, this._signedBytes(aad, iv, ct));
    const frame = { t, v: PROTOCOL_VERSION, iv: b64(iv), ct: b64(ct), s: b64(s) };
    if (to) frame.to = to;
    if (kid) frame.kid = kid;
    if (!this._send(frame)) throw new Error('not connected');
  }

  async _sendPayload(payload, to) {
    if (to) {
      const m = this.members.get(to);
      if (!m) throw new Error('member left');
      await m.ready;
      if (m.status === 'mismatch') throw new Error('password mismatch with this member');
      return this._sealAndSend('dm', m.keys.dm, payload, { to });
    }
    if (!this.mySend) await this._rotate();
    return this._sealAndSend('msg', this.mySend.key, payload, { kid: this.mySend.kid });
  }

  async _drain() {
    while (this.ws && (this.ws.bufferedAmount ?? 0) > 1024 * 1024) await sleep(15);
  }

  /** Send a text message to the room, or privately when `to` is a member id. */
  async sendText(text, { to } = {}) {
    const body = String(text);
    if (!body.trim()) return null;
    if (body.length > MAX_TEXT) throw new Error('message too long');
    const payload = { type: 'text', id: randomId(), ts: Date.now(), body };
    await this._enqueueOut(() => this._sendPayload(payload, to));
    const ev = { scope: to ? 'dm' : 'room', from: this.id, peerId: to ?? null, self: true, id: payload.id, ts: payload.ts, text: body };
    this.emit('message', ev);
    return ev;
  }

  /** Encrypt and send a file in 192 KiB chunks. */
  async sendFile({ name, mime, bytes }, { to, onProgress } = {}) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!data.length) throw new Error('empty file');
    if (data.length > MAX_FILE_BYTES) throw new Error('file too large');
    const fileId = randomId(12);
    const meta = {
      type: 'file',
      id: randomId(),
      ts: Date.now(),
      fileId,
      name: String(name || 'file').slice(0, 255),
      mime: String(mime || 'application/octet-stream').slice(0, 100),
      size: data.length,
      chunks: Math.ceil(data.length / CHUNK_BYTES),
      sha: hex(await sha256(data)),
    };
    await this._enqueueOut(() => this._sendPayload(meta, to));
    for (let i = 0; i < meta.chunks; i++) {
      const slice = data.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      await this._enqueueOut(async () => {
        await this._drain();
        await this._sendPayload({ type: 'chunk', id: randomId(), fileId, idx: i, data: b64(slice) }, to);
        await sleep(30); // stay well under the relay's per-socket frame rate limit
      });
      onProgress?.((i + 1) / meta.chunks);
    }
    const ev = {
      scope: to ? 'dm' : 'room',
      from: this.id,
      peerId: to ?? null,
      self: true,
      id: meta.id,
      ts: meta.ts,
      fileId,
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      bytes: data,
    };
    this.emit('file', ev);
    return ev;
  }
}
