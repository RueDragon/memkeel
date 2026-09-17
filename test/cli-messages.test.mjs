// Guardrails for the CLI message catalogue in lib/messages.mjs.
//
// The dashboard catalogue has its own test file, and this is the CLI's counterpart rather than a
// share of it: the published package ships lib/ and the built dashboard/static/, but not
// dashboard/app/, so an installed CLI cannot read the dashboard catalogue at all. The two
// catalogues are therefore kept honest the same way - by asserting the properties here - instead of
// by living in one file.
//
// The last test is the one that would have caught the bug this work started from: three error lines
// in memory.mjs were Chinese while every other line the CLI printed was English, and nothing
// noticed because both are perfectly valid strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DEFAULT_LOCALE, LOCALES, MESSAGES, detectLocale, translate } from '../lib/messages.mjs';

const ROOT = new URL('../', import.meta.url);
const CLI = fileURLToPath(new URL('memory.mjs', ROOT));

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

test('every message key referenced by the CLI exists in every locale', () => {
  const used = new Set();
  const sources = [fileURLToPath(new URL('memory.mjs', ROOT))];
  for (const entry of fs.readdirSync(fileURLToPath(new URL('lib/', ROOT)), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) sources.push(fileURLToPath(new URL(`lib/${entry.name}`, ROOT)));
  }
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:\bt|\btranslate)\(\s*'(cli\.[^']+)'/g)) used.add(match[1]);
  }
  assert.ok(used.size > 0, 'the CLI must reference at least one catalogue key');
  for (const key of used) {
    for (const locale of LOCALES) {
      assert.ok(MESSAGES[locale][key], `${key} is referenced by the CLI but missing from ${locale}`);
    }
  }
});

// The precedence is explicit: MEMKEEL_LOCALE wins, then the conventional locale variables, then
// English. An environment that names a language the catalogue does not have must not silently pick
// a translation.
test('the locale is detected from the environment with English as the fallback', () => {
  assert.equal(detectLocale({}), 'en');
  assert.equal(detectLocale({ LANG: 'C.UTF-8' }), 'en');
  assert.equal(detectLocale({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(detectLocale({ LANG: 'zh_CN.UTF-8' }), 'zh-Hans');
  assert.equal(detectLocale({ LC_ALL: 'zh_TW.UTF-8' }), 'zh-Hans');
  assert.equal(detectLocale({ LC_MESSAGES: 'zh-Hans' }), 'zh-Hans');
  assert.equal(detectLocale({ MEMKEEL_LOCALE: 'zh-Hans' }), 'zh-Hans');
  assert.equal(detectLocale({ MEMKEEL_LOCALE: 'zh-CN', LANG: 'en_US.UTF-8' }), 'zh-Hans');
  assert.equal(detectLocale({ MEMKEEL_LOCALE: 'en', LANG: 'zh_CN.UTF-8' }), 'en');
  assert.equal(detectLocale({ MEMKEEL_LOCALE: 'fr', LANG: 'zh_CN.UTF-8' }), 'zh-Hans');
});

test('translate substitutes parameters and never returns a blank', () => {
  assert.equal(translate('en', 'cli.error.unexpectedArgument', { argument: '--oops' }), 'Unexpected argument: --oops');
  assert.match(translate('zh-Hans', 'cli.error.unknownCommand', { command: 'nope' }), /^未知命令：nope$/);
  assert.equal(translate('en', 'cli.no.such.key'), 'cli.no.such.key');
  assert.equal(translate('en', 'cli.error.homeNeedsDirectory'), '--home requires a directory');
  // An unknown locale falls back to the default one rather than throwing.
  assert.equal(translate('fr', 'cli.error.homeNeedsDirectory'), '--home requires a directory');
});

// Comments are the one place Chinese is allowed to stay: they explain the code to the maintainer and
// are never printed. Everything else in the entry point has to come from the catalogue.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

test('the CLI entry point prints no Chinese of its own', () => {
  const text = stripComments(fs.readFileSync(CLI, 'utf8'));
  const hits = [...new Set(text.match(/[\u4e00-\u9fff]/g) ?? [])];
  assert.deepEqual(hits, [],
    `memory.mjs must not hold printed Chinese outside the catalogue: ${JSON.stringify(hits)}`);
});

// The end-to-end check: the same broken invocation has to come back in the chosen language, which is
// what proves the catalogue is actually wired up rather than merely present.
function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MEMKEEL_LOCALE: '', LANG: '', LC_ALL: '', LC_MESSAGES: '', ...env },
  });
}

test('the CLI answers in the language the environment asks for', () => {
  const english = run(['config', 'nonsense'], { MEMKEEL_LOCALE: 'en' });
  assert.equal(english.status, 2);
  assert.match(english.stderr, /^Usage: memkeel config validate\|show\|migrate/);

  const chinese = run(['config', 'nonsense'], { MEMKEEL_LOCALE: 'zh-Hans' });
  assert.equal(chinese.status, 2);
  assert.match(chinese.stderr, /^用法：memkeel config validate\|show\|migrate/);

  const fromLang = run(['config', 'nonsense'], { LANG: 'zh_CN.UTF-8' });
  assert.match(fromLang.stderr, /^用法：/);
});
