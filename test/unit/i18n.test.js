import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES } from '../../client/src/i18n/locales.js';
import { detectLanguage } from '../../client/src/i18n/index.js';

const keys = Object.keys(LOCALES.en).filter((k) => !k.startsWith('_'));
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every locale has every key with the same placeholders', () => {
  assert.ok(Object.keys(LOCALES).length >= 15);
  for (const [code, dict] of Object.entries(LOCALES)) {
    for (const k of keys) {
      assert.equal(typeof dict[k], 'string', `${code} missing ${k}`);
      assert.equal(vars(dict[k]), vars(LOCALES.en[k]), `${code}.${k} placeholders`);
    }
    for (const k of Object.keys(dict)) assert.ok(k.startsWith('_') || k in LOCALES.en, `${code} has unknown key ${k}`);
  }
});

test('Chinese is 正體 only, never 繁體 or Simplified', () => {
  assert.equal(LOCALES['zh-TW']._name, '正體中文');
  assert.ok(!Object.keys(LOCALES).some((c) => /^zh-(CN|Hans|SG)$/i.test(c)));
  const all = JSON.stringify(LOCALES);
  assert.ok(!all.includes('繁體') && !all.includes('简体'));
  for (const l of ['zh', 'zh-CN', 'zh-Hans', 'zh-HK', 'zh-TW', 'zh-SG']) assert.equal(detectLanguage([l]), 'zh-TW');
});

test('browser locale detection', () => {
  assert.equal(detectLanguage(['ko-KR']), 'ko');
  assert.equal(detectLanguage(['pt-PT']), 'pt-BR');
  assert.equal(detectLanguage(['de-AT', 'en']), 'de');
  assert.equal(detectLanguage(['ar-EG']), 'ar');
  assert.equal(detectLanguage(['xx', 'fr-CA']), 'fr');
  assert.equal(detectLanguage(['xx']), 'en');
  assert.equal(LOCALES.ar._dir, 'rtl');
});
