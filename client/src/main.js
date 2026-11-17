import './styles.css';
import { initLanguage, t } from './i18n/index.js';
import { initTheme } from './ui/theme.js';
import { mountApp } from './ui/app.js';

initTheme();
initLanguage();
document.title = t('appName');

if (!globalThis.crypto?.subtle || !globalThis.isSecureContext) {
  document.getElementById('app').textContent =
    'This browser context has no Web Crypto (HTTPS or localhost is required). Nothing was sent.';
} else {
  mountApp(document.getElementById('app'));
}
