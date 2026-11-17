const KEY = 'zk.theme';
export const THEMES = ['auto', 'light', 'dark', 'midnight', 'contrast'];

export function initTheme() {
  let saved = 'auto';
  try {
    saved = localStorage.getItem(KEY) || 'auto';
  } catch {}
  setTheme(saved, false);
}

export function setTheme(name, persist = true) {
  if (!THEMES.includes(name)) name = 'auto';
  if (name === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = name;
  if (persist) {
    try {
      localStorage.setItem(KEY, name); // UI preference only
    } catch {}
  }
}

export function getTheme() {
  return document.documentElement.dataset.theme || 'auto';
}
