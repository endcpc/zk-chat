import { h, clear, formatBytes } from './dom.js';
import { identicon } from './identicon.js';
import { t, applyI18n, languages, getLanguage, setLanguage, onLanguageChange } from '../i18n/index.js';
import { THEMES, getTheme, setTheme } from './theme.js';
import { ChatSession, MAX_FILE_BYTES, MAX_TEXT } from '../core/session.js';
import { randomId } from '../crypto/encoding.js';

// Only raster formats are rendered inline; everything else (SVG, HTML…) is a download.
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const THEME_LABEL = { auto: 'themeAuto', light: 'themeLight', dark: 'themeDark', midnight: 'themeMidnight', contrast: 'themeContrast' };

const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

function roomFromHash() {
  try {
    return decodeURIComponent(location.hash.replace(/^#/, ''));
  } catch {
    return '';
  }
}

const groupHex = (hexStr, n = 32) => (hexStr.slice(0, n).toUpperCase().match(/.{1,4}/g) ?? []).join(' ');

export function mountApp(root) {
  const app = new App(root);
  app.showJoin();
  window.addEventListener('pagehide', () => app.teardown());
  return app;
}

/** Keep only the fields that are set. */
const pick = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v));

class App {
  constructor(root) {
    this.root = root;
    this.blobUrls = new Set();
    this.offs = [];
    this.names = new Map();
    this.toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(this.toastEl);
    onLanguageChange(() => this.onLanguage());
  }

  // ------------------------------------------------------------ shared bits

  prefsControls() {
    const theme = h(
      'select',
      { class: 'select', 'data-i18n-title': 'theme', onchange: (e) => setTheme(e.target.value) },
      THEMES.map((name) => h('option', { value: name, 'data-i18n': THEME_LABEL[name], selected: getTheme() === name })),
    );
    const lang = h(
      'select',
      { class: 'select', 'data-i18n-title': 'language', onchange: (e) => setLanguage(e.target.value) },
      languages().map((l) => h('option', { value: l.code, text: l.name, selected: getLanguage() === l.code })),
    );
    return h('div', { class: 'prefs' }, theme, lang);
  }

  toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 4200);
  }

  teardown() {
    for (const off of this.offs) off();
    this.offs = [];
    this.session?.close();
    this.session = null;
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.clear();
    this.names.clear();
    document.title = t('appName');
  }

  onLanguage() {
    document.title = t('appName');
    if (!this.session) return;
    this.renderMembers();
    for (const c of this.convs.values()) c.refresh();
    document.querySelectorAll('.notice').forEach((el) => el._render && (el.textContent = el._render()));
    document.querySelectorAll('.msg .meta .name[data-from]').forEach((el) => (el.textContent = this.nameOf(el.dataset.from)));
    this.updateComposer();
  }

  // ------------------------------------------------------------- join view

  showJoin(prefill = {}) {
    this.teardown();
    const room = h('input', {
      id: 'room', name: 'room', autocomplete: 'off', spellcheck: false, maxlength: 128,
      'data-i18n-placeholder': 'roomPlaceholder', value: prefill.room ?? roomFromHash(),
    });
    const pw = h('input', {
      id: 'pw', name: 'pw', type: 'password', autocomplete: 'off', maxlength: 256,
      'data-i18n-placeholder': 'passwordPlaceholder',
    });
    const nick = h('input', {
      id: 'nick', name: 'nick', autocomplete: 'off', maxlength: 32,
      'data-i18n-placeholder': 'nicknamePlaceholder', value: prefill.nick ?? '',
    });
    const status = h('p', { class: 'form-status', role: 'status' });
    const btn = h('button', { type: 'submit', class: 'btn primary wide', 'data-i18n': 'join' });

    const form = h(
      'form',
      {
        class: 'join-card',
        autocomplete: 'off',
        onsubmit: async (e) => {
          e.preventDefault();
          const roomName = room.value.trim();
          if (!roomName) {
            status.textContent = t('errRoomRequired');
            room.focus();
            return;
          }
          btn.disabled = true;
          status.textContent = t('deriving');
          const session = new ChatSession({ url: wsBase(), roomName, password: pw.value, nickname: nick.value });
          pw.value = '';
          try {
            const p = session.connect();
            setTimeout(() => {
              if (btn.disabled) status.textContent = t('connecting');
            }, 400);
            await p;
          } catch (err) {
            btn.disabled = false;
            const msg = String(err?.message ?? err);
            status.textContent = /room-full|4004/.test(msg) ? t('errRoomFull') : t('errConnect', { reason: msg });
            return;
          }
          this.showChat(session, roomName, nick.value);
        },
      },
      h('div', { class: 'brand-lg' }, h('span', { class: 'lock', 'aria-hidden': 'true' }), h('h1', { 'data-i18n': 'appName' })),
      h('p', { class: 'tagline', 'data-i18n': 'tagline' }),
      h('label', { for: 'room', 'data-i18n': 'roomName' }),
      h(
        'div',
        { class: 'input-row' },
        room,
        h('button', {
          type: 'button', class: 'btn ghost', 'data-i18n': 'randomRoom',
          onclick: () => (room.value = `room-${randomId(5)}`),
        }),
      ),
      h('label', { for: 'pw', 'data-i18n': 'password' }),
      pw,
      h('small', { class: 'hint', 'data-i18n': 'passwordHint' }),
      h('label', { for: 'nick', 'data-i18n': 'nickname' }),
      nick,
      h('small', { class: 'hint', 'data-i18n': 'nicknameHint' }),
      btn,
      status,
      h(
        'ul',
        { class: 'layers' },
        h('li', { 'data-i18n': 'layer1' }),
        h('li', { 'data-i18n': 'layer2' }),
        h('li', { 'data-i18n': 'layer3' }),
      ),
    );

    clear(this.root).append(h('div', { class: 'join-view' }, h('div', { class: 'join-prefs' }, this.prefsControls()), form));
    applyI18n(this.root);
    (room.value ? pw : room).focus();
  }

  // ------------------------------------------------------------- chat view

  showChat(session, roomName, nickname) {
    this.session = session;
    this.roomName = roomName;
    this.nickname = nickname;
    this.convs = new Map();
    this.active = 'room';
    this.mismatchNotified = new Set();
    this.pendingFiles = new Map();

    this.memberList = h('ul', { class: 'member-list' });
    this.memberCount = h('span', { class: 'count' });
    this.panes = h('div', { class: 'panes' });
    this.tabs = h('nav', { class: 'tabs', role: 'tablist' });
    this.input = h('textarea', { rows: 1, maxlength: MAX_TEXT, class: 'input', 'aria-label': 'message' });
    this.fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => this.handleFiles(e.target.files) });
    this.sendBtn = h('button', { type: 'submit', class: 'btn primary', 'data-i18n': 'send' });
    this.banner = h('div', { class: 'banner', hidden: true });
    const dropOverlay = h('div', { class: 'drop-overlay', 'data-i18n': 'dropHere' });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this.composer.requestSubmit();
      }
    });
    this.input.addEventListener('input', () => this.autosize());
    this.input.addEventListener('paste', (e) => {
      const files = e.clipboardData?.files;
      if (files?.length) {
        e.preventDefault();
        this.handleFiles(files);
      }
    });

    this.composer = h(
      'form',
      { class: 'composer', onsubmit: (e) => (e.preventDefault(), this.sendCurrent()) },
      h('button', { type: 'button', class: 'btn icon attach', 'data-i18n-title': 'attach', onclick: () => this.fileInput.click() }, '+'),
      this.fileInput,
      this.input,
      this.sendBtn,
    );

    const main = h('main', { class: 'chat' }, this.tabs, this.banner, this.panes, this.composer, dropOverlay);
    let dragDepth = 0;
    main.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      main.classList.add('dragging');
    });
    main.addEventListener('dragover', (e) => e.preventDefault());
    main.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        main.classList.remove('dragging');
      }
    });
    main.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      main.classList.remove('dragging');
      if (e.dataTransfer?.files?.length) this.handleFiles(e.dataTransfer.files);
    });

    const header = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'lock', 'aria-hidden': 'true' }), h('strong', { 'data-i18n': 'appName' })),
      h('span', { class: 'room-chip', title: roomName, text: '# ' + roomName }),
      h('span', { class: 'badge e2ee', 'data-i18n': 'e2ee' }),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn ghost', 'data-i18n': 'copyInvite', onclick: () => this.copyInvite() }),
      this.prefsControls(),
      h('button', { type: 'button', class: 'btn danger', 'data-i18n': 'leave', onclick: () => this.showJoin({ room: roomName, nick: nickname }) }),
    );

    const sidebar = h(
      'aside',
      { class: 'sidebar' },
      h('h2', {}, h('span', { 'data-i18n': 'members' }), ' ', this.memberCount),
      this.memberList,
      h('p', { class: 'hint', 'data-i18n': 'avatarHint' }),
      h(
        'div',
        { class: 'my-fp' },
        h('small', { 'data-i18n': 'yourFingerprint' }),
        h('code', { text: groupHex(session.myFingerprint) }),
      ),
    );

    clear(this.root).append(h('div', { class: 'chat-view' }, header, h('div', { class: 'layout' }, sidebar, main)));
    applyI18n(this.root);

    const room = this.ensureConv('room');
    this.notice(room, () => t('noHistory'));
    if (session.members.size === 0) this.notice(room, () => t('onlyYou'));
    this.select('room');
    this.renderMembers();
    this.updateComposer();
    this.bindSession(session);
    this.input.focus();
  }

  bindSession(s) {
    const on = (ev, fn) => this.offs.push(s.on(ev, fn));
    on('message', (d) => {
      const conv = d.scope === 'dm' ? this.ensureConv(d.peerId) : this.convs.get('room');
      this.addMessage(conv, { from: d.self ? s.id : d.from, ts: d.ts, body: h('div', { class: 'text', text: d.text }) });
    });
    on('file-start', (d) => {
      const conv = d.scope === 'dm' ? this.ensureConv(d.peerId) : this.convs.get('room');
      const bar = h('progress', { max: 1, value: 0 });
      const label = h('small', { text: t('receiving', { pct: 0 }) });
      const body = h('div', { class: 'file-card pending' }, h('span', { class: 'file-name', text: d.name }), h('small', { text: formatBytes(d.size) }), bar, label);
      const el = this.addMessage(conv, { from: d.from, ts: d.ts, body });
      this.pendingFiles.set(`${d.from}:${d.fileId}`, { el, bar, label, body });
    });
    on('file-progress', (d) => {
      const p = this.pendingFiles.get(`${d.from}:${d.fileId}`);
      if (!p) return;
      p.bar.value = d.fraction;
      p.label.textContent = t('receiving', { pct: Math.round(d.fraction * 100) });
    });
    on('file', (d) => {
      if (d.self) return; // our own uploads are rendered from sendFile's result
      const key = `${d.from}:${d.fileId}`;
      const p = this.pendingFiles.get(key);
      this.pendingFiles.delete(key);
      const body = this.fileBody(d);
      if (p) p.body.replaceWith(body);
      else {
        const conv = d.scope === 'dm' ? this.ensureConv(d.peerId) : this.convs.get('room');
        this.addMessage(conv, { from: d.from, ts: d.ts, body });
      }
    });
    // The nickname arrives inside the first encrypted key frame, so the
    // "joined" notice waits for it (or 2 s) instead of showing "Anonymous".
    this.pendingJoins = new Map();
    const announceJoin = (id) => {
      const timer = this.pendingJoins.get(id);
      if (timer === undefined) return;
      clearTimeout(timer);
      this.pendingJoins.delete(id);
      if (s.members.has(id)) this.notice(this.convs.get('room'), () => t('joined', { name: this.nameOf(id) }));
    };
    this.offs.push(() => this.pendingJoins.forEach((timer) => clearTimeout(timer)));
    on('join', (m) => {
      this.names.set(m.id, this.snapshot(m));
      this.pendingJoins.set(m.id, setTimeout(() => announceJoin(m.id), 2000));
      this.renderMembers();
    });
    on('member-update', (m) => {
      this.names.set(m.id, this.snapshot(m));
      if (m.status !== 'pending') announceJoin(m.id);
      this.renderMembers();
      for (const c of this.convs.values()) c.refresh();
      if (m.status === 'mismatch' && !this.mismatchNotified.has(m.id)) {
        this.mismatchNotified.add(m.id);
        this.notice(this.convs.get('room'), () => t('mismatchNotice', { name: this.nameOf(m.id) }), 'warn');
      }
    });
    on('leave', (m) => {
      announceJoin(m.id);
      this.names.set(m.id, { ...this.snapshot(m), ...pick(this.names.get(m.id)) });
      const name = () => this.nameOf(m.id);
      this.notice(this.convs.get('room'), () => t('left', { name: name() }));
      const dm = this.convs.get(m.id);
      if (dm) {
        dm.closed = true;
        this.notice(dm, () => t('peerGone', { name: name() }), 'warn');
        dm.refresh();
        this.updateComposer();
      }
      for (const [k, p] of this.pendingFiles) if (k.startsWith(m.id + ':')) p.body.remove(), this.pendingFiles.delete(k);
      this.renderMembers();
    });
    on('warning', (w) => {
      if (w.code === 'file-corrupt') this.toast(t('fileCorrupt'));
    });
    on('server-error', (e) => {
      if (e.code === 'rate-limited') this.toast(t('notSent', { reason: e.code }));
    });
    on('disconnected', () => {
      clear(this.banner).append(
        h('span', { text: t('disconnected') }),
        h('button', { type: 'button', class: 'btn primary', text: t('rejoin'), onclick: () => this.showJoin({ room: this.roomName, nick: this.nickname }) }),
      );
      this.banner.hidden = false;
      this.input.disabled = true;
      this.sendBtn.disabled = true;
    });
  }

  /** Who a member was, kept after they leave so their name can still be rendered (and re-translated). */
  snapshot(m) {
    const fp = m?.fp ? Array.from(m.fp.slice(0, 2), (b) => b.toString(16).padStart(2, '0')).join('') : '';
    return { nick: m?.nick, fingerprint: fp };
  }

  nameOf(id) {
    return this.displayName(id, this.names.get(id));
  }

  displayName(id, fallback) {
    const s = this.session;
    if (id === s?.id) return this.nickname?.trim() || t('you');
    const m = s?.members.get(id);
    const nick = m?.nick || fallback?.nick;
    if (nick) return nick;
    const fp = m?.fp ? Array.from(m.fp.slice(0, 2), (b) => b.toString(16).padStart(2, '0')).join('') : fallback?.fingerprint?.slice(0, 4) ?? '';
    return `${t('anonymous')} ${fp.toUpperCase()}`.trim();
  }

  fpOf(id) {
    if (id === this.session.id) return this.session.myFingerprint;
    const m = this.session.members.get(id);
    return m?.fp ? Array.from(m.fp, (b) => b.toString(16).padStart(2, '0')).join('') : '0'.repeat(64);
  }

  // ---------------------------------------------------------------- members

  renderMembers() {
    const s = this.session;
    if (!s) return;
    clear(this.memberList);
    this.memberCount.textContent = `(${s.members.size + 1})`;
    this.memberList.append(
      h(
        'li',
        { class: 'member me' },
        h('span', { class: 'avatar' }, identicon(s.myFingerprint, 34)),
        h('span', { class: 'who' }, h('span', { class: 'name', text: this.displayName(s.id) }), h('small', { text: t('you') })),
      ),
    );
    const others = [...s.members.values()].sort((a, b) => this.displayName(a.id).localeCompare(this.displayName(b.id)));
    for (const m of others) {
      const statusKey = m.status === 'ok' ? 'statusOk' : m.status === 'mismatch' ? 'statusMismatch' : 'statusPending';
      this.memberList.append(
        h(
          'li',
          { class: `member status-${m.status}` },
          h(
            'button',
            {
              type: 'button',
              class: 'member-btn',
              title: t('privateWith', { name: this.displayName(m.id) }),
              onclick: () => this.openDM(m.id),
            },
            h('span', { class: 'avatar' }, identicon(this.fpOf(m.id), 34)),
            h('span', { class: 'who' }, h('span', { class: 'name', text: this.displayName(m.id) }), h('small', { class: 'pill', text: t(statusKey) })),
          ),
        ),
      );
    }
  }

  openDM(id) {
    const m = this.session.members.get(id);
    if (!m) return;
    if (m.status === 'mismatch') return this.toast(t('passwordMismatchDm'));
    this.ensureConv(id);
    this.select(id);
    this.input.focus();
  }

  // ---------------------------------------------------------- conversations

  ensureConv(key) {
    if (this.convs.has(key)) return this.convs.get(key);
    const isDm = key !== 'room';
    const list = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
    const pane = h('section', { class: 'pane', role: 'tabpanel', hidden: true });
    const tabLabel = h('span', { class: 'tab-label' });
    const badge = h('span', { class: 'unread', hidden: true });
    const tab = h('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => this.select(key) }, tabLabel, badge);
    const conv = { key, isDm, list, pane, tab, tabLabel, badge, unread: 0, closed: false };

    if (isDm) {
      const title = h('h3');
      const note = h('p', { class: 'hint' });
      const sn = h('code', { class: 'safety' });
      const help = h('small', { class: 'hint' });
      const summary = h('summary', {});
      pane.append(h('div', { class: 'dm-head' }, h('span', { class: 'avatar' }, identicon(this.fpOf(key), 40)), h('div', {}, title, note), h('details', { class: 'safety-box' }, summary, sn, help)));
      this.session.safetyNumberWith(key).then((n) => (sn.textContent = n)).catch(() => {});
      tab.prepend(h('span', { class: 'avatar sm' }, identicon(this.fpOf(key), 18)));
      tab.append(
        h('span', {
          class: 'tab-close', role: 'button', tabindex: 0, 'data-i18n-title': 'close', title: t('close'),
          onclick: (e) => {
            e.stopPropagation();
            this.closeConv(key);
          },
        }, '×'),
      );
      conv.refresh = () => {
        const name = this.nameOf(key);
        title.textContent = t('privateWith', { name });
        note.textContent = t('privateNote', { name });
        summary.textContent = t('safetyNumber');
        help.textContent = t('safetyHelp', { name });
        tabLabel.textContent = name;
        tab.classList.toggle('closed', conv.closed);
      };
    } else {
      conv.refresh = () => (tabLabel.textContent = '# ' + t('room'));
    }
    pane.append(list);
    conv.refresh();
    this.convs.set(key, conv);
    this.panes.append(pane);
    this.tabs.append(tab);
    return conv;
  }

  closeConv(key) {
    const conv = this.convs.get(key);
    if (!conv || key === 'room') return;
    conv.pane.querySelectorAll('[data-blob]').forEach((el) => {
      URL.revokeObjectURL(el.dataset.blob);
      this.blobUrls.delete(el.dataset.blob);
    });
    conv.pane.remove();
    conv.tab.remove();
    this.convs.delete(key);
    if (this.active === key) this.select('room');
  }

  select(key) {
    this.active = key;
    for (const c of this.convs.values()) {
      const on = c.key === key;
      c.pane.hidden = !on;
      c.tab.classList.toggle('active', on);
      c.tab.setAttribute('aria-selected', String(on));
      if (on) {
        c.unread = 0;
        c.badge.hidden = true;
        c.list.scrollTop = c.list.scrollHeight;
      }
    }
    this.updateComposer();
    this.updateTitle();
  }

  updateComposer() {
    if (!this.convs) return;
    const conv = this.convs.get(this.active);
    const closed = !!conv?.closed;
    this.input.placeholder = t(this.active === 'room' ? 'typeMessage' : 'typePrivate');
    this.input.disabled = closed;
    this.sendBtn.disabled = closed;
    this.composer.querySelector('.attach').disabled = closed;
  }

  updateTitle() {
    const total = [...this.convs.values()].reduce((n, c) => n + c.unread, 0);
    document.title = (total ? `(${total}) ` : '') + t('appName');
  }

  addMessage(conv, { from, ts, body }) {
    const self = from === this.session.id;
    const nearBottom = conv.list.scrollHeight - conv.list.scrollTop - conv.list.clientHeight < 80;
    const time = new Intl.DateTimeFormat(getLanguage(), { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
    const el = h(
      'div',
      { class: 'msg' + (self ? ' self' : '') },
      h('span', { class: 'avatar' }, identicon(this.fpOf(from), 30)),
      h('div', { class: 'bubble' }, h('div', { class: 'meta' }, h('span', { class: 'name', 'data-from': from, text: this.nameOf(from) }), h('time', { text: time })), body),
    );
    conv.list.append(el);
    if (self || nearBottom) conv.list.scrollTop = conv.list.scrollHeight;
    if (!self && (this.active !== conv.key || document.hidden)) {
      conv.unread++;
      conv.badge.textContent = String(conv.unread);
      conv.badge.title = t('unread', { n: conv.unread });
      conv.badge.hidden = false;
      this.updateTitle();
    }
    return el;
  }

  /** `render` is a string or a function returning the text; functions re-run when the language changes. */
  notice(conv, render, kind = '') {
    if (!conv) return;
    const fn = typeof render === 'function' ? render : () => render;
    const el = h('div', { class: `notice ${kind}`, text: fn() });
    el._render = fn;
    conv.list.append(el);
    conv.list.scrollTop = conv.list.scrollHeight;
  }

  // --------------------------------------------------------------- sending

  async sendCurrent() {
    const text = this.input.value;
    if (!text.trim()) return;
    const key = this.active;
    const conv = this.convs.get(key);
    if (conv?.closed) return;
    this.input.value = '';
    this.autosize();
    try {
      await this.session.sendText(text, { to: key === 'room' ? undefined : key });
    } catch (err) {
      this.notice(conv, () => t('notSent', { reason: err?.message ?? err }), 'warn');
      if (!this.input.value) this.input.value = text;
    }
  }

  async handleFiles(fileList) {
    const files = [...(fileList ?? [])];
    this.fileInput.value = '';
    const key = this.active;
    const conv = this.convs.get(key);
    if (!conv || conv.closed || !this.session) return;
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        this.toast(t('fileTooLarge', { name: file.name }));
        continue;
      }
      if (!file.size) continue;
      const bar = h('progress', { max: 1, value: 0 });
      const label = h('small', { text: t('sending', { pct: 0 }) });
      const body = h('div', { class: 'file-card pending' }, h('span', { class: 'file-name', text: file.name }), h('small', { text: formatBytes(file.size) }), bar, label);
      this.addMessage(conv, { from: this.session.id, ts: Date.now(), body });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const ev = await this.session.sendFile(
          { name: file.name, mime: file.type, bytes },
          {
            to: key === 'room' ? undefined : key,
            onProgress: (f) => {
              bar.value = f;
              label.textContent = t('sending', { pct: Math.round(f * 100) });
            },
          },
        );
        body.replaceWith(this.fileBody(ev));
      } catch (err) {
        label.textContent = t('notSent', { reason: err?.message ?? err });
        body.classList.add('failed');
      }
    }
  }

  fileBody(d) {
    const inline = INLINE_IMAGES.has(d.mime);
    const blob = new Blob([d.bytes], { type: inline ? d.mime : 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    this.blobUrls.add(url);
    if (inline) {
      return h(
        'figure',
        { class: 'image', dataset: { blob: url } },
        h('a', { href: url, download: d.name, 'data-i18n-title': 'download', title: t('download') }, h('img', { src: url, alt: d.name, loading: 'lazy' })),
        h('figcaption', {}, h('span', { text: d.name }), ' · ', formatBytes(d.size)),
      );
    }
    return h(
      'div',
      { class: 'file-card', dataset: { blob: url } },
      h('span', { class: 'file-icon', 'aria-hidden': 'true' }),
      h('span', { class: 'file-name', text: d.name }),
      h('small', { text: formatBytes(d.size) }),
      h('a', { class: 'btn ghost', href: url, download: d.name, 'data-i18n': 'download', text: t('download') }),
    );
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(this.input.scrollHeight, 180) + 'px';
  }

  async copyInvite() {
    const link = `${location.origin}/#${encodeURIComponent(this.roomName)}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const tmp = h('textarea', { value: link });
      document.body.append(tmp);
      tmp.select();
      document.execCommand('copy');
      tmp.remove();
    }
    this.toast(t('inviteCopied'));
  }
}
