# ZK Chat: zero-knowledge, end-to-end encrypted chat

Anonymous, ephemeral group chat where the server is a **blind relay**. All key generation,
encryption, decryption and signing happen in the browser with the Web Crypto API.
The Cloudflare Worker + Durable Object only forwards ciphertext it cannot read, keeps
everything in memory, and never touches storage.

* Frontend: vanilla ES modules (no framework), built with Vite
* Backend: Cloudflare Workers + Durable Objects (one DO per room, memory only)
* Transport: WebSocket (wss://)
* UI: room chat, private chat by clicking an avatar, images and files (up to 25 MB),
  5 themes (Auto, Light, Dark, Midnight, High contrast), English / 繁體中文 / 日本語
  (any Chinese browser locale opens in Traditional Chinese; there is no Simplified build)

## Quick start

```bash
npm install
npm run dev:worker        # builds the client and runs Worker + DO locally on http://127.0.0.1:8787
# or, for hot reload: run `npx wrangler dev` in one terminal and `npm run dev` (Vite, :5173) in another

npx wrangler login
npm run deploy            # vite build && wrangler deploy
```

Share a room with `https://<your-worker>/#<room-name>`. The fragment never reaches the
server. Share the password over a different channel.

## Security design

### Three layers

| Layer | Mechanism | Protects against |
|---|---|---|
| 1. Transport | TLS 1.3 / wss | network observers, tampering in transit |
| 2. Room binding | room password mixed into every pairwise key | wrong-password members, the server (never sees the password) |
| 3. Message E2EE | ECDH P-256 + HKDF + AES-256-GCM, per-sender keys, ECDSA signatures | the server, admins, non-recipients, forged or replayed frames |

### Key derivation

```
roomHash   = SHA-256("zkchat/v1/room-id|" + roomName)          -> the only room identifier the server sees
H(pw)      = PBKDF2-SHA256(pw, salt = SHA-256("zkchat/v1/pw-salt|" + roomName), 600 000 iterations)
Z          = ECDH(myPrivate, peerPublic)                          (ephemeral per tab, non-extractable)
M          = Z XOR H(pw)                                          <- "Final Shared Key = ECDH XOR H(password)"
K_pair     = HKDF-SHA256(M, salt = roomHash, info = "zkchat/v1/pair|" + sorted public keys)
K_dm       = HKDF-SHA256(M, salt = roomHash, info = "zkchat/v1/dm|"   + sorted public keys)
```

The spec's `ECDH XOR SHA256(password)` is kept, with two hardening changes:
`SHA256` becomes **PBKDF2 (600k iterations)** so a captured ciphertext can't be used to
brute-force a weak password quickly, and the XOR result goes through **HKDF** before use
as an AES key.

### Group messages: sender keys

Each member generates a random AES-256 *sender key*, wraps it for every other member with
`K_pair`, and encrypts its room messages once with it. Every join or leave triggers a
fresh sender key for everyone:

* a newcomer never receives an old key, so earlier messages are unreadable (no history);
* a departed member never receives the new key, so later messages are unreadable.

Members with a different password derive a different `K_pair`. Key unwrapping fails the
AES-GCM tag check, so they are marked **Different password** and can't read anything in
either direction.

### Private chat

Clicking an avatar opens a DM encrypted with `K_dm`. The relay forwards a DM frame **only
to its recipient**. Other members never receive it, not even as ciphertext. Each DM shows
a 60-digit **safety number**. If both people see the same number, the server didn't swap
keys (no man in the middle).

### Every frame

* Plaintext padded to 256-byte buckets (4 KiB above 4 KiB) to hide message length
* AES-GCM AAD binds the ciphertext to `[version, type, roomHash, from, to, keyId]`
* ECDSA P-256 signature over AAD + IV + ciphertext, so the server can't forge, redirect,
  or reattribute frames
* Per-sender message IDs drop replays
* Files: 192 KiB chunks, each encrypted like a message, then SHA-256 checked on reassembly

### What the relay does and does not see

Sees: client IPs and timing, the room hash, ephemeral public keys, random member IDs it
assigns, padded ciphertext sizes, member count.
Never sees: room names, passwords, nicknames (sent inside encrypted key frames), message
text, file names, or file contents. The DO code never calls storage and logs nothing.
`observability` is disabled in `wrangler.jsonc`.

### Hardening

* Strict CSP (`script-src 'self'`, no inline scripts, `connect-src` limited to the app's own wss origin),
  `frame-ancestors 'none'`, `no-referrer`, `nosniff`, HSTS, COOP
* Cross-origin WebSocket connections are rejected (Origin check)
* All user content is rendered with `textContent`. Only raster images (PNG/JPEG/GIF/WebP/AVIF)
  are shown inline; everything else, including SVG and HTML, is a download only
* Relay limits: 50 members per room, 1 MB per frame, 40 frames/s per socket (burst 160),
  10 s hello timeout, 90 s idle timeout
* Keys and the password factor are wiped from memory when you leave or the tab closes.
  `localStorage` holds only the theme and language

### Honest limits

* **Served code is trusted.** As with any web E2EE app, whoever controls the deployment
  could ship malicious JavaScript. Self-host it, and pin and verify the built assets.
* **Metadata** (IP addresses, timing, sizes, member count) is visible to the relay and Cloudflare.
* **Safety numbers are the MITM defense.** If nobody compares them, a malicious server
  could substitute keys.
* "Forward secrecy" here comes from ephemeral per-session keys, rotation on membership
  change, and no stored history. There is no per-message ratchet (Double Ratchet).

## Project layout

```
client/
  index.html
  public/favicon.svg
  src/
    main.js                entry: theme, language, mount
    styles.css             themes via CSS variables
    crypto/encoding.js     base64/hex/bytes helpers
    crypto/primitives.js   ECDH, PBKDF2, HKDF, AES-GCM, ECDSA, padding, safety numbers
    core/emitter.js
    core/session.js        the whole protocol (DOM-free; also runs in Node for tests)
    i18n/locales.js        en, zh-TW (Traditional), ja
    i18n/index.js
    ui/app.js              join screen, members, tabs, DMs, files, drag-drop, paste
    ui/dom.js  ui/identicon.js  ui/theme.js
worker/src/
  index.js                 routing, security headers, Origin check
  room.js                  RoomDO blind relay (memory only)
test/
  unit/crypto.test.js      11 crypto tests
  e2e/relay.test.js        12 tests: real clients through wrangler dev (workerd)
  browser/ui.test.js       headless Chromium: 3 users, chat, DM, image, file, zh-TW, themes
  run-e2e.sh
wrangler.jsonc  vite.config.js  package.json
```

## Tests

```bash
npm test             # unit tests (Node 20+)
npm run test:e2e     # builds, starts wrangler dev, runs relay + browser tests
                     # browser test needs: npx playwright install --with-deps chromium
```

What the end-to-end suite verifies against the real Worker/DO runtime:
security headers and no inline scripts; bad paths and foreign origins rejected; real-time
join and leave; relay frames never contain plaintext or nicknames; newcomers see no
history; DMs reach only the recipient; wrong-password isolation in both directions;
separate rooms stay separate; sender keys rotate on leave; 1 MB room and DM file
transfers pass integrity checks; tampered frames are rejected and replays dropped; relay
code never uses storage or logs. In the browser test there are no CSP violations or page
errors.
