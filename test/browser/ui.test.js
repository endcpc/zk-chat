// Real-browser test of the built client (headless Chromium via Playwright)
// against the Worker + Durable Object running in `wrangler dev`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import zlib from 'node:zlib';
import { chromium } from 'playwright';

const BASE = (process.env.ZK_WS_URL ?? 'ws://127.0.0.1:8787').replace(/^ws/, 'http');
const SHOTS = new URL('../../screenshots/', import.meta.url).pathname;
let browser;
const problems = [];

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
});
after(async () => browser?.close());

/** Minimal valid PNG (solid colour) so the image path is exercised with real pixels. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.set([(r + x) & 255, (g + y) & 255, b], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function user(name, { room, password, locale = 'en-US' }) {
  const ctx = await browser.newContext({ locale, viewport: { width: 1200, height: 760 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${name} console: ${m.text()}`);
  });
  await page.goto(BASE + '/#' + encodeURIComponent(room));
  assert.equal(await page.inputValue('#room'), room, 'room name prefilled from URL fragment');
  await page.fill('#pw', password);
  await page.fill('#nick', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('.chat-view', { timeout: 20000 });
  return page;
}

test('two browsers chat, DM, share an image; wrong password is isolated; zh-TW UI', async () => {
  const room = 'ui-' + Date.now();
  const alice = await user('Alice', { room, password: 'pa55word' });
  const bob = await user('Bob', { room, password: 'pa55word', locale: 'zh-CN' });
  const eve = await user('Eve', { room, password: 'not-the-password' });

  // Chinese browser locale (even zh-CN) lands on Traditional Chinese
  assert.equal(await bob.getAttribute('html', 'lang'), 'zh-Hant-TW');
  assert.equal((await bob.textContent('.composer button[type=submit]')).trim(), '傳送');

  // presence + key exchange status
  await alice.waitForSelector('.member.status-ok >> text=Bob');
  await alice.waitForSelector('.member.status-mismatch >> text=Anonymous');
  await eve.waitForSelector('.member.status-mismatch');
  await alice.waitForSelector('.notice >> text=different password');
  await alice.waitForSelector('.notice >> text=Bob joined');

  // room message (Enter to send)
  await bob.fill('.composer textarea', '大家好 from Bob');
  await bob.press('.composer textarea', 'Enter');
  await alice.waitForSelector('.msg .text >> text=大家好 from Bob');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await eve.locator('.msg .text', { hasText: 'from Bob' }).count(), 0, 'wrong-password member sees nothing');

  // private chat by clicking the avatar
  await alice.click('.member-btn >> text=Bob');
  await alice.waitForSelector('.dm-head h3 >> text=Private chat with Bob');
  const snAlice = (await alice.textContent('.safety')).trim();
  await alice.fill('.composer textarea', 'just for you, Bob');
  await alice.click('.composer button[type=submit]');
  await bob.waitForSelector('.tab .unread:not([hidden]) >> text=1');
  await bob.click('.tab >> text=Alice');
  await bob.waitForSelector('.msg .text >> text=just for you, Bob');
  const snBob = (await bob.textContent('.safety')).trim();
  assert.match(snAlice, /^(\d{5} ){11}\d{5}$/);
  assert.equal(snAlice, snBob, 'safety numbers match on both ends');
  assert.equal(await eve.locator('text=just for you').count(), 0);

  // image upload in the room
  await alice.click('.tab >> text=Room');
  await alice.setInputFiles('.composer input[type=file]', { name: 'gradient.png', mimeType: 'image/png', buffer: png(160, 100, [40, 90, 200]) });
  await bob.click('.tab >> text=聊天室');
  const img = bob.locator('figure.image img');
  await img.waitFor({ timeout: 15000 });
  await bob.waitForFunction(() => document.querySelector('figure.image img')?.naturalWidth === 160);

  // generic file
  await alice.setInputFiles('.composer input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('top secret notes') });
  await bob.waitForSelector('.file-card .file-name >> text=notes.txt');

  // themes
  await alice.selectOption('.prefs select >> nth=0', 'dark');
  assert.equal(await alice.getAttribute('html', 'data-theme'), 'dark');

  await alice.screenshot({ path: SHOTS + 'alice-room-dark.png' });
  await bob.click('.tab >> text=Alice');
  await bob.screenshot({ path: SHOTS + 'bob-dm-zh-TW.png' });
  await eve.screenshot({ path: SHOTS + 'eve-wrong-password.png' });

  // leave notification
  await bob.click('.topbar .btn.danger');
  await alice.click('.tab >> text=Room');
  await alice.waitForSelector('.notice >> text=Bob left');
  await alice.click('.tab >> text=Bob');
  await alice.waitForSelector('.notice >> text=This private chat is closed');
  assert.equal(await alice.isDisabled('.composer textarea'), true);

  // join screen screenshot (Traditional Chinese, labelled 正體中文)
  assert.equal(await bob.locator('.prefs select >> nth=1 >> option:checked').textContent(), '正體中文');
  await bob.screenshot({ path: SHOTS + 'join-zh-TW.png' });

  // every language is selectable; Arabic flips the layout right-to-left
  const codes = await alice.$$eval('.prefs select >> nth=1 >> option', (os) => os.map((o) => o.value));
  assert.ok(codes.length >= 15, 'at least 15 languages');
  for (const code of codes) {
    await alice.selectOption('.prefs select >> nth=1', code);
    assert.equal(await alice.getAttribute('html', 'dir'), code === 'ar' ? 'rtl' : 'ltr');
  }
  await alice.click('.tab >> text=الغرفة');
  // notices and download buttons already on screen re-translate too
  await alice.waitForSelector('.notice >> text=غادر Bob');
  assert.equal(await alice.locator('.notice', { hasText: 'Bob left' }).count(), 0);
  assert.equal(await alice.locator('.msg a.btn', { hasText: 'Download' }).count(), 0);
  assert.ok((await alice.locator('.msg a.btn', { hasText: 'تنزيل' }).count()) > 0);
  await alice.screenshot({ path: SHOTS + 'alice-room-ar-rtl.png' });
  await alice.selectOption('.prefs select >> nth=1', 'ko');
  await alice.waitForSelector('.composer textarea[placeholder="암호화된 메시지 입력…"]');

  const csp = problems.filter((p) => /Content Security Policy|Refused/.test(p));
  assert.deepEqual(csp, [], 'no CSP violations');
  assert.deepEqual(problems, [], 'no page errors');
});
