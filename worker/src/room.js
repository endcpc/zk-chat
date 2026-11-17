// RoomDO: one Durable Object per room hash, acting as a blind relay.
//
// Zero-knowledge guarantees enforced here:
//   * Never calls this.state.storage. Every byte lives in this object's
//     memory and disappears when the last socket closes and the DO is evicted.
//   * Never decrypts, inspects or logs ciphertext. Only routing fields
//     (t, to) are read; everything else is copied through opaquely.
//   * Assigns member ids itself, so peers cannot impersonate a routing id.
//   * Does not log frames, ids or keys.

const MAX_MEMBERS = 50;
const MAX_FRAME = 1_000_000; // Cloudflare caps WebSocket messages at 1 MiB
const HELLO_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 90_000; // clients ping every 20 s
const RATE_PER_SEC = 40;
const RATE_BURST = 160;

const B64_POINT = /^[A-Za-z0-9+/]{87}=$/; // 65-byte uncompressed P-256 point
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KID = /^[0-9a-f]{16}$/;

function randomId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class RoomDO {
  constructor(state, env) {
    this.state = state; // intentionally unused: no storage
    this.env = env;
    /** @type {Map<string, Peer>} */
    this.peers = new Map();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const peer = {
      id: randomId(),
      ws: server,
      joined: false,
      dh: null,
      sig: null,
      tokens: RATE_BURST,
      refillAt: Date.now(),
      lastSeen: Date.now(),
      strikes: 0,
    };

    peer.helloTimer = setTimeout(() => {
      if (!peer.joined) this.kill(peer, 4001, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    server.addEventListener('message', (ev) => this.onMessage(peer, ev.data));
    server.addEventListener('close', () => this.drop(peer));
    server.addEventListener('error', () => this.drop(peer));

    return new Response(null, { status: 101, webSocket: client });
  }

  send(peer, obj) {
    try {
      peer.ws.send(JSON.stringify(obj));
    } catch {
      this.drop(peer);
    }
  }

  broadcast(obj, exceptId) {
    const data = JSON.stringify(obj);
    for (const p of this.peers.values()) {
      if (p.id === exceptId) continue;
      try {
        p.ws.send(data);
      } catch {
        this.drop(p);
      }
    }
  }

  kill(peer, code, reason) {
    try {
      peer.ws.close(code, reason);
    } catch {}
    this.drop(peer);
  }

  drop(peer) {
    clearTimeout(peer.helloTimer);
    clearTimeout(peer.idleTimer);
    if (!peer.joined) return;
    peer.joined = false;
    if (this.peers.get(peer.id) === peer) {
      this.peers.delete(peer.id);
      this.broadcast({ t: 'leave', id: peer.id });
    }
  }

  touch(peer) {
    peer.lastSeen = Date.now();
    clearTimeout(peer.idleTimer);
    peer.idleTimer = setTimeout(() => this.kill(peer, 4002, 'idle'), IDLE_TIMEOUT_MS);
  }

  allow(peer) {
    const now = Date.now();
    peer.tokens = Math.min(RATE_BURST, peer.tokens + ((now - peer.refillAt) / 1000) * RATE_PER_SEC);
    peer.refillAt = now;
    if (peer.tokens < 1) return false;
    peer.tokens -= 1;
    return true;
  }

  onMessage(peer, data) {
    if (typeof data !== 'string' || data.length > MAX_FRAME) {
      return this.kill(peer, 1009, 'frame too large');
    }
    if (!this.allow(peer)) {
      if (++peer.strikes > 50) return this.kill(peer, 4008, 'rate limit');
      return this.send(peer, { t: 'error', code: 'rate-limited' });
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.send(peer, { t: 'error', code: 'bad-json' });
    }
    if (!msg || typeof msg !== 'object') return;
    this.touch(peer);

    if (!peer.joined) {
      if (msg.t !== 'hello') return this.send(peer, { t: 'error', code: 'hello-required' });
      return this.onHello(peer, msg);
    }

    switch (msg.t) {
      case 'ping':
        return this.send(peer, { t: 'pong' });
      case 'msg': {
        const out = this.sealed(peer, msg, false);
        if (out) this.broadcast(out, peer.id);
        return;
      }
      case 'key':
      case 'dm': {
        const out = this.sealed(peer, msg, true);
        if (!out) return;
        const target = this.peers.get(out.to);
        if (!target) return this.send(peer, { t: 'error', code: 'no-such-member' });
        return this.send(target, out); // only the recipient ever receives it
      }
      default:
        return this.send(peer, { t: 'error', code: 'unknown-type' });
    }
  }

  onHello(peer, msg) {
    if (!B64_POINT.test(msg.dh ?? '') || !B64_POINT.test(msg.sig ?? '')) {
      return this.kill(peer, 4003, 'bad hello');
    }
    if (this.peers.size >= MAX_MEMBERS) {
      this.send(peer, { t: 'error', code: 'room-full' });
      return this.kill(peer, 4004, 'room full');
    }
    for (const p of this.peers.values()) {
      if (p.dh === msg.dh) return this.kill(peer, 4005, 'duplicate key');
    }
    clearTimeout(peer.helloTimer);
    peer.dh = msg.dh;
    peer.sig = msg.sig;
    peer.joined = true;

    const members = [...this.peers.values()].map((p) => ({ id: p.id, dh: p.dh, sig: p.sig }));
    this.peers.set(peer.id, peer);
    this.send(peer, { t: 'welcome', id: peer.id, members });
    this.broadcast({ t: 'join', id: peer.id, dh: peer.dh, sig: peer.sig }, peer.id);
  }

  /** Copy only whitelisted, shape-checked fields; stamp the server-known sender id. */
  sealed(peer, msg, direct) {
    const { t, v, iv, ct, s, kid, to } = msg;
    if (v !== 1) return null;
    if (typeof iv !== 'string' || iv.length !== 16 || !B64.test(iv)) return null;
    if (typeof ct !== 'string' || !ct.length || !B64.test(ct)) return null;
    if (typeof s !== 'string' || s.length > 200 || !B64.test(s)) return null;
    const out = { t, v, from: peer.id, iv, ct, s };
    if (t !== 'dm') {
      if (typeof kid !== 'string' || !KID.test(kid)) return null;
      out.kid = kid;
    }
    if (direct) {
      if (typeof to !== 'string' || to === peer.id || !this.peers.has(to)) {
        if (typeof to === 'string' && !this.peers.has(to)) {
          this.send(peer, { t: 'error', code: 'no-such-member' });
        }
        return null;
      }
      out.to = to;
    }
    return out;
  }
}
