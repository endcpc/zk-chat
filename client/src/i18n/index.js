import { LOCALES } from './locales.js';

const KEY = 'zk.lang';
let current = 'en';
const listeners = new Set();

/** Any Chinese browser locale (zh, zh-CN, zh-Hans, zh-HK…) maps to Traditional Chinese. */
export function detectLanguage(langs = globalThis.navigator?.languages ?? []) {
  for (const raw of langs) {
    const l = String(raw).toLowerCase();
    if (l.startsWith('zh')) return 'zh-TW';
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('en')) return 'en';
  }
  return 'en';
}

export function initLanguage() {
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {}
  setLanguage(saved && LOCALES[saved] ? saved : detectLanguage(), false);
}

export function setLanguage(lang, persist = true) {
  if (!LOCALES[lang]) lang = 'en';
  current = lang;
  document.documentElement.lang = lang === 'zh-TW' ? 'zh-Hant-TW' : lang;
  if (persist) {
    try {
      localStorage.setItem(KEY, lang); // UI preference only; never keys or messages
    } catch {}
  }
  applyI18n(document);
  for (const fn of listeners) fn(lang);
}

export const getLanguage = () => current;
export const onLanguageChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const languages = () => Object.entries(LOCALES).map(([code, d]) => ({ code, name: d._name }));

export function t(key, vars = {}) {
  const s = LOCALES[current]?.[key] ?? LOCALES.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function applyI18n(root) {
  root.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
}
