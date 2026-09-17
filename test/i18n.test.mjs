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

// Ratchet: the number of hardcoded Chinese literals outside the catalogue, of which the four wire
// markers in lib/chat.js are exempt data rather than translatable text, so the effective floor is 4
// and not 0. Lowering this is the remaining UX-01 work — 453 when the ratchet was introduced, then
// 418, 394, 352, 331, 320, 310, 302, 295, 294, 293, and 292 after the chat bubbles. It kept falling as
// later pages were converted; the last three blocks took it to 55, then 37, then 28 — and raising it
// means a new string was written into a component instead of into the catalogue, which is the
// regression this guards. The failure message names the largest remaining files.
//
// KNOWN UNDERCOUNT: this counts *quoted* literals, so Chinese sitting in a JSX text node is invisible
// to it. Converting components/ChatBubbles.jsx moved the count by 1 while it actually removed three
// pieces of Chinese — two of them were <span>我</span>, bare JSX text. The number below is therefore a
// floor, not the full remainder, and the same class of text still has to be found by reading.
//
// KNOWN OVERCOUNT: the delimiter class allows any character except the delimiter itself, so on a line
// that carries two attribute values there is nothing stopping a match from starting at the closing
// quote of the first and ending at the opening quote of the second. Chinese JSX text sitting between
// two attribute quotes is therefore counted as a literal. Removing the first-run step whose line held
// two className attributes lowered this count by one more than the number of real strings deleted.
// Do not paste such a line into a comment either: it would be counted here as well.
const HARDCODED_BUDGET = 28;

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
  'components/ChatBubbles.jsx',
  'components/ComposeModal.jsx',
  'components/DataTable.jsx',
  'components/DecisionModal.jsx',
  'components/DetailDrawer.jsx',
  'components/EditModal.jsx',
  'components/Links.jsx',
  'components/ScrollToTop.jsx',
  'components/SearchPalette.jsx',
  'lib/events.js',
  'views/Actions.jsx',
  'views/Conflicts.jsx',
  'views/Events.jsx',
  'views/Contexts.jsx',
  'views/Experiences.jsx',
  'views/Sessions.jsx',
  'views/System.jsx',
  'views/Facts.jsx',
  'views/Habits.jsx',
  'views/Overview.jsx',
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

// KNOWN UNDERCOUNT, now closed: the literal scan above matches *quoted* literals, so Chinese sitting
// in a JSX text node was invisible to it. Converting components/ChatBubbles.jsx moved that count by 1
// while it actually removed three pieces of Chinese, two of which were <span>我</span>, bare JSX text.
//
// This second scan covers exactly the complement: comments are stripped, then quoted and template
// literals are blanked out, and whatever Chinese is left is text the interface renders directly. The
// two scans therefore partition the file rather than overlapping, and together they measure the real
// remainder instead of a floor.
const QUOTED_LITERAL = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;

function jsxTextChinese(text) {
  return stripComments(text).replace(QUOTED_LITERAL, ' ').match(/[\u4e00-\u9fff]/g) ?? [];
}

const jsxCounts = new Map();
let jsxTotal = 0;
for (const [relative, text] of sources) {
  const hits = jsxTextChinese(text).length;
  if (hits) jsxCounts.set(relative, hits);
  jsxTotal += hits;
}

test('every converted file is free of Chinese in JSX text', () => {
  for (const file of CONVERTED) {
    const hits = jsxTextChinese(sources.get(file) ?? '').length;
    assert.equal(hits, 0,
      `${file} renders ${hits} Chinese character(s) directly as JSX text: ${JSON.stringify(jsxTextChinese(sources.get(file) ?? ''))}`);
  }
});

// The budget for the complement scan. Measured when the scan was introduced: 1138 characters, and
// never raised. That number is the honest scale of what is left, and it is far larger than the
// literal count above suggested — views/Settings.jsx alone renders 814 characters of Chinese prose
// directly as JSX text while holding only 70 quoted literals, so the remaining work is dominated by
// paragraphs written inline, not by short labels. Every converted file already measures zero here.
const JSX_TEXT_BUDGET = 158;

test('Chinese rendered as JSX text outside the catalogue does not exceed its recorded budget', () => {
  const worst = [...jsxCounts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([file, n]) => `${file}:${n}`);
  assert.ok(jsxTotal <= JSX_TEXT_BUDGET,
    `Chinese characters rendered as JSX text outside the catalogue: ${jsxTotal} (budget ${JSX_TEXT_BUDGET}). Largest: ${worst.join(', ')}`);
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

// Files whose Chinese is data rather than interface text, and must therefore NOT be translated.
// lib/chat.js parses the checkpoint markers that lib/hooks.mjs writes into an event body, so those
// strings are a wire format: translating them would stop the writer and the parser agreeing and the
// conversation bubbles would silently collapse into one paragraph. They are pinned at an exact count
// so the exemption cannot quietly grow into a hiding place for real interface text.
const EXEMPT_CHINESE = new Map([
  ['lib/chat.js', 4],
]);

test('exempt files hold exactly the data markers they are exempted for', () => {
  for (const [file, expected] of EXEMPT_CHINESE) {
    const actual = chineseLiterals(sources.get(file) ?? '').length;
    assert.equal(actual, expected,
      `${file} is exempt for ${expected} data marker(s) but now holds ${actual}; the exemption covers wire-format markers only`);
  }
});

test('the checkpoint markers the console parses still match the ones the hook writes', () => {
  // The contract, not a copy of it: the parser in the app and the writer in the backend must agree
  // byte for byte. Localising either side fails here instead of failing silently in the interface.
  //
  // Comments are stripped first, and that is not tidiness: the first version of this test read the
  // whole file, and lib/chat.js documents the markers in a comment, so the assertion was satisfied by
  // the comment while the actual constant had been changed. It passed with the code deliberately
  // broken. A contract test that a comment can satisfy is not a contract test.
  const backend = stripComments(fs.readFileSync(new URL('../lib/hooks.mjs', import.meta.url), 'utf8'));
  const frontend = stripComments(sources.get('lib/chat.js') ?? '');
  assert.ok(frontend, 'lib/chat.js must be part of the scanned sources');
  for (const marker of ['任务要求（用户报告）：', '最近回复（未复核，不是当前事实）：']) {
    assert.ok(backend.includes(marker), `lib/hooks.mjs no longer writes the marker ${marker}`);
    assert.ok(frontend.includes(marker), `lib/chat.js no longer recognises the marker ${marker}`);
  }
  // The reply marker is also parsed by the digest, so a third place has to keep agreeing with them.
  const digest = stripComments(fs.readFileSync(new URL('../lib/digest.mjs', import.meta.url), 'utf8'));
  assert.ok(digest.includes('最近回复（未复核，不是当前事实）：'),
    'lib/digest.mjs no longer writes or parses the same reply marker');
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
