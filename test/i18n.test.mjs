// UX-01 guardrails for the interface catalogue.
//
// The point of these tests is not that a dictionary exists, but that a language cannot silently fall
// behind: a key added to one locale and forgotten in the other, a navigation entry with no
// description, or a new hardcoded string, each fails here rather than showing up as a blank label in
// the interface. The catalogue is plain data, so this needs no JSX parser and no build step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_LOCALE, LOCALES, MESSAGES, detectLocale, translate } from '../dashboard/app/src/i18n/messages.js';

const APP_SRC = new URL('../dashboard/app/src/', import.meta.url);

// Quoted literals containing at least one Chinese character. This is a text-level scan on purpose:
// it must catch a string that has not been moved into the catalogue yet, which is precisely the state
// the remaining UX-01 work is in.
const CHINESE_LITERAL = /(['"`])(?:(?!\1)[^\\\n])*[\u4e00-\u9fff](?:(?!\1)[^\\\n])*\1/g;
const USED_KEY = /(?:\bt|\btranslate)\(\s*'([^']+)'/g;
const NAV_ENTRY = /\{\s*key:\s*'([a-z-]+)',\s*icon:/g;

function walk(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // The catalogue is where interface text is supposed to be, so it is not scanned for literals.
      if (!prefix && entry.name === 'i18n') continue;
      found.push(...walk(new URL(`${entry.name}/`, dir), relative));
    } else if (/\.jsx?$/.test(entry.name)) {
      found.push({ relative, url: new URL(entry.name, dir) });
    }
  }
  return found;
}

const files = walk(APP_SRC);
const sources = new Map(files.map((file) => [file.relative, fs.readFileSync(file.url, 'utf8')]));

function chineseLiterals(text) {
  return text.match(CHINESE_LITERAL) ?? [];
}

const counts = new Map();
let hardcodedTotal = 0;
for (const [relative, text] of sources) {
  const hits = chineseLiterals(text).length;
  if (hits) counts.set(relative, hits);
  hardcodedTotal += hits;
}

// Ratchet: the number of hardcoded Chinese literals outside the catalogue. Lowering this is the
// remaining UX-01 work — 453 when the ratchet was introduced, 418 after four views, 394 after the
// confirmation modal, 352 after the reference page, 331 after the edit dialog, 320 after the search
// palette, 310 after the open-work view — and raising it means a new string was written into a
// component instead of into the catalogue, which is the regression this guards. The failure message
// names the largest remaining files.
const HARDCODED_BUDGET = 310;

test('every locale defines exactly the same keys', () => {
  const expected = Object.keys(MESSAGES[DEFAULT_LOCALE]).sort();
  assert.ok(expected.length > 0, 'the default locale must not be empty');
  for (const locale of LOCALES) {
    assert.ok(MESSAGES[locale], `locale ${locale} is missing from the catalogue`);
    assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), expected,
      `locale ${locale} must define the same keys as ${DEFAULT_LOCALE}`);
  }
});

test('no catalogued string is blank', () => {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      assert.equal(typeof value, 'string', `${locale}/${key} must be a string`);
      assert.ok(value.trim().length > 0, `${locale}/${key} must not be blank`);
    }
  }
});

test('every message key referenced by a component exists in every locale', () => {
  const used = new Set();
  for (const text of sources.values()) {
    for (const match of text.matchAll(USED_KEY)) used.add(match[1]);
  }
  assert.ok(used.size > 0, 'no t(...) call was found — the scan or the components changed shape');
  for (const locale of LOCALES) {
    for (const key of used) {
      assert.ok(MESSAGES[locale][key] !== undefined, `${locale} is missing the referenced key ${key}`);
    }
  }
});

test('every navigation entry has a label and a description in every locale', () => {
  const app = sources.get('App.jsx');
  assert.ok(app, 'App.jsx must be part of the scanned sources');
  const navKeys = [...app.matchAll(NAV_ENTRY)].map((match) => match[1]);
  assert.ok(navKeys.length >= 12, `expected the full navigation table, found ${navKeys.length} entries`);
  for (const locale of LOCALES) {
    for (const key of navKeys) {
      assert.ok(MESSAGES[locale][`nav.${key}.label`], `${locale} is missing nav.${key}.label`);
      assert.ok(MESSAGES[locale][`nav.${key}.desc`], `${locale} is missing nav.${key}.desc`);
    }
  }
});

// Files that have been fully converted to the catalogue. This list only grows, and it is what
// separates "this screen is translated" from "this screen is translated, and a test says so".
const CONVERTED = [
  'App.jsx',
  'components/DecisionModal.jsx',
  'components/EditModal.jsx',
  'components/SearchPalette.jsx',
  'views/Actions.jsx',
  'views/Conflicts.jsx',
  'views/Events.jsx',
  'views/Contexts.jsx',
  'views/Experiences.jsx',
  'views/Reference.jsx',
];

test('every converted file carries no hardcoded interface text', () => {
  for (const file of CONVERTED) {
    const text = sources.get(file);
    assert.ok(text !== undefined, `${file} is listed as converted but was not found in the app source`);
    const hits = chineseLiterals(text);
    assert.equal(hits.length, 0, `${file} still contains hardcoded Chinese: ${JSON.stringify(hits)}`);
  }
});

// The literal scan above only recognises CJK ideographs (U+4E00-U+9FFF), so it cannot see full-width
// punctuation sitting in a JSX text node — which is exactly how a full-width colon survived into the
// English interface until it was noticed by hand, and why that fix went in without a failing test.
// This scan covers that class of character directly. Comments are removed first so that a Chinese
// explanatory comment is not mistaken for interface text.
const CJK_PUNCTUATION = /[\u3000-\u303f\uff00-\uffef]/g;

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

test('every converted file is free of full-width punctuation', () => {
  for (const file of CONVERTED) {
    const text = stripComments(sources.get(file) ?? '');
    const hits = text.match(CJK_PUNCTUATION) ?? [];
    assert.equal(hits.length, 0,
      `${file} contains full-width punctuation that belongs in the catalogue: ${JSON.stringify([...new Set(hits)])}`);
  }
});

test('hardcoded Chinese outside the catalogue does not exceed its recorded budget', () => {
  const worst = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([file, n]) => `${file}:${n}`);
  assert.ok(hardcodedTotal <= HARDCODED_BUDGET,
    `hardcoded Chinese literals outside the catalogue: ${hardcodedTotal} (budget ${HARDCODED_BUDGET}). Largest: ${worst.join(', ')}`);
});

test('translate falls back to the default locale and exposes a missing key', () => {
  assert.equal(translate('en', 'shell.newMemory'), MESSAGES.en['shell.newMemory']);
  assert.equal(translate('en', 'shell.loadFailed', { error: 'boom' }), 'Failed to load: boom');
  // A missing key returns the key itself, so an untranslated string is visible rather than silent.
  assert.equal(translate('en', 'nope.not.here'), 'nope.not.here');
  assert.equal(translate('kl', 'shell.newMemory'), MESSAGES[DEFAULT_LOCALE]['shell.newMemory']);
});

test('the initial locale prefers a stored choice, then the browser, then the default', () => {
  assert.equal(detectLocale('en', 'zh-CN'), 'en');
  assert.equal(detectLocale('zh-Hans', 'en-US'), 'zh-Hans');
  assert.equal(detectLocale(null, 'en-GB'), 'en');
  assert.equal(detectLocale(null, 'zh-TW'), 'zh-Hans');
  assert.equal(detectLocale('klingon', 'fr-FR'), DEFAULT_LOCALE);
  assert.equal(detectLocale(null, ''), DEFAULT_LOCALE);
});
