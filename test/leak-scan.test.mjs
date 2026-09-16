// Coverage for the leak gate.
//
// The gate is the last thing standing between a working tree and a public release, so it
// is tested as a gate rather than as a formatter: a synthetic sample of every rule must
// fail the run, the matched value must never reach the diagnostics, a broken private term
// file must fail loudly instead of scanning without it, and the coverage statement must
// admit which files were not inspected.
//
// The scanner scans the repository, this file included, so every synthetic sample below is
// assembled from fragments at run time. Writing a sample as one literal would make this
// test file itself a leak. The final test in this file is the repository self-scan, which
// fails if that discipline is ever broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('../scripts/leak-scan.mjs', import.meta.url));

/** Join fragments; see the file header for why samples are never single literals. */
const S = (...parts) => parts.join('');

const SAMPLE = {
  windows: S('C:', '/Us', 'ers/', 'zqx1', '/private/work'),
  macos: S('/', 'Us', 'ers/', 'zqx1', '/private/work'),
  linux: S('/', 'ho', 'me/', 'zqx1', '/private/work'),
  qqEmail: S('12345678', '@', 'qq.com'),
  githubToken: S('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  gitlabToken: S('gl', 'pat-', 'A1b2C3d4E5f6G7h8I9j0'),
  slackToken: S('xo', 'xb-', '123456789012-abcdefghijklmnop'),
  googleKey: S('AI', 'za', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r'),
  openaiKey: S('sk', '-', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
  awsKey: S('AK', 'IA', 'A1B2C3D4E5F6G7H8'),
  privateKey: S('-----BE', 'GIN ', 'OPENSSH PRIVATE KEY-----'),
  npmrc: S('registry', '=', 'https://nexus.example.com', '/repository/npm/'),
  npmrcToken: S('//nexus.example.com/:_auth', 'Token=npm_abcdefghijklmnop'),
  nexusUrl: S('https://nexus.example.com/', 'repository/npm/package.tgz'),
  hostSuffix: S('https://git.example.', 'internal/repo'),
  lockfile: S('"resolved"', ':', ' "', 'https://nexus.example.com/npm/x.tgz', '"'),
  privateTerm: S('my-', 'private', '-project'),
};

function run(args, options = {}) {
  const env = { ...process.env };
  // Never inherit a real private term list: a test must not depend on the machine.
  delete env.MEMKEEL_LEAK_TERMS_FILE;
  if (options.terms) env.MEMKEEL_LEAK_TERMS_FILE = options.terms;
  return spawnSync(process.execPath, [scanner, ...args], { encoding: 'utf8', windowsHide: true, env });
}

function tempDir(t, prefix = 'memkeel-leak-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t) {
  const dir = tempDir(t);
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { dir, write };
}

const output = (result) => `${result.stdout}${result.stderr}`;
const NO_STACK = /\n\s+at /;

test('a tree with none of the rules passes', (t) => {
  const { dir, write } = fixture(t);
  write('notes.md', '# Release notes\n\nNothing private here.\n');
  const result = run(['--root', dir]);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /leak-scan: clean \(1 files scanned\)/);
});

test('the placeholders the documentation uses are not reported as leaks', (t) => {
  const { dir, write } = fixture(t);
  write('config.json', JSON.stringify({
    memoryRoot: 'C:/Users/<you>/agent-memory',
    policyRoot: 'C:/Users/<you>/.memkeel',
    macos: '/Users/<name>/agent-memory',
    linux: '/home/<name>/agent-memory',
    fixture: 'C:/Users/demo/Code/sample',
    runner: '/home/runner/work/repo/repo',
  }, null, 2));
  const result = run(['--root', dir]);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /leak-scan: clean/);
});

// Every rule must be able to fail the run, and must do so without publishing the value.
const CASES = [
  ['windows-user-path', SAMPLE.windows],
  ['macos-user-path', SAMPLE.macos],
  ['linux-user-path', SAMPLE.linux],
  ['qq-email', SAMPLE.qqEmail],
  ['access-token', SAMPLE.githubToken],
  ['gitlab-token', SAMPLE.gitlabToken],
  ['slack-token', SAMPLE.slackToken],
  ['google-api-key', SAMPLE.googleKey],
  ['api-key', SAMPLE.openaiKey],
  ['aws-access-key-id', SAMPLE.awsKey],
  ['private-key', SAMPLE.privateKey],
  ['npmrc-registry', SAMPLE.npmrc],
  ['npmrc-auth-token', SAMPLE.npmrcToken],
  ['private-registry-url', SAMPLE.nexusUrl],
  ['private-host-suffix', SAMPLE.hostSuffix],
  ['lockfile-nonpublic-registry', SAMPLE.lockfile],
];

for (const [id, sample] of CASES) {
  test(`${id} fails the gate and the matched value is never echoed`, (t) => {
    const { dir, write } = fixture(t);
    // The sample opens its own line: an .npmrc setting is line-anchored by design, so a
    // sample buried mid-sentence would not be the shape that rule is written for.
    write('notes.txt', `# notes\n\n${sample}\n`);
    const result = run(['--root', dir]);
    assert.equal(result.status, 1, output(result));
    assert.match(result.stderr, new RegExp(`notes\\.txt:3: \\[${id}\\]`));
    assert.match(result.stderr, /a public release must be clean/);
    assert.equal(
      output(result).includes(sample),
      false,
      `diagnostics echoed the matched value:\n${output(result)}`,
    );
  });
}

test('a private term from the external list fails the gate and is never echoed', (t) => {
  const { dir, write } = fixture(t);
  write('notes.md', `line one\nline two\nuses ${SAMPLE.privateTerm} here\nand ${SAMPLE.privateTerm} again\n`);
  const termsDir = tempDir(t, 'memkeel-leak-terms-');
  const termsFile = path.join(termsDir, 'terms.json');
  fs.writeFileSync(termsFile, JSON.stringify([SAMPLE.privateTerm]));

  const result = run(['--root', dir], { terms: termsFile });
  assert.equal(result.status, 1, output(result));
  assert.match(result.stderr, /\[private-term\]/);
  // Both occurrences are reported on their real lines.
  assert.match(result.stderr, /notes\.md:3: \[private-term\]/);
  assert.match(result.stderr, /notes\.md:4: \[private-term\]/);
  assert.equal(output(result).includes(SAMPLE.privateTerm), false, 'the private term was echoed');
});

test('a missing private terms file fails instead of scanning without it', (t) => {
  const dir = tempDir(t);
  const result = run(['--root', dir], { terms: path.join(dir, 'absent.json') });
  // Silently continuing would turn the gate into a no-op wherever the list is misconfigured.
  assert.equal(result.status, 2, output(result));
  assert.match(result.stderr, /Cannot read the private terms file/);
  assert.doesNotMatch(result.stderr, NO_STACK);
  assert.equal(result.stdout.trim(), '');
});

const BAD_TERMS = [
  ['not JSON', 'definitely not json'],
  ['a JSON object instead of an array', '{"term":"x"}'],
  ['an array holding a non-string', '[1,2]'],
  ['an array holding an empty string', '["ok",""]'],
  ['an array holding a whitespace-only string', '["ok","  "]'],
];

for (const [label, body] of BAD_TERMS) {
  test(`a private terms file that is ${label} fails with one clean line`, (t) => {
    const termsDir = tempDir(t, 'memkeel-leak-terms-');
    const termsFile = path.join(termsDir, 'terms.json');
    fs.writeFileSync(termsFile, body);
    const dir = tempDir(t);
    const result = run(['--root', dir], { terms: termsFile });
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /^leak-scan: /);
    assert.doesNotMatch(result.stderr, NO_STACK);
    assert.equal(result.stdout.trim(), '');
  });
}

test('symlinks are not followed, so a link cannot pull in a file from outside the tree', (t) => {
  const outside = tempDir(t, 'memkeel-leak-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), `leaked ${SAMPLE.windows}\n`);
  const dir = tempDir(t);
  try {
    fs.symlinkSync(outside, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`this machine cannot create a symlink (${error.code}), so the not-followed policy is unverified here`);
    return;
  }
  const result = run(['--root', dir]);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /1 symlink\(s\) not followed/);
});

test('dependency and VCS directories are outside the scan boundary', (t) => {
  const { dir, write } = fixture(t);
  write('node_modules/pkg/index.js', SAMPLE.githubToken);
  write('.git/config', SAMPLE.windows);
  const result = run(['--root', dir]);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /leak-scan: clean \(0 files scanned\)/);
});

test('non-text extensions are reported as not inspected instead of silently ignored', (t) => {
  const { dir, write } = fixture(t);
  write('logo.png', SAMPLE.windows);
  write('font.woff2', SAMPLE.githubToken);
  const result = run(['--root', dir]);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /2 non-text file\(s\) not inspected/);
  assert.match(result.stdout, /\.png x1/);
  assert.match(result.stdout, /\.woff2 x1/);
  assert.match(result.stdout, /not covered by this result/);
});

test('a binary file with a text extension is reported, not scanned as mojibake', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'blob.txt'), Buffer.concat([
    Buffer.from([0x00, 0x01, 0x02]),
    Buffer.from(SAMPLE.windows, 'utf8'),
    Buffer.from([0x00]),
  ]));
  const result = run(['--root', dir]);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /1 binary file\(s\) not inspected/);
});

test('the scanner file itself is scanned, not skipped by name', (t) => {
  const dir = tempDir(t);
  const copy = path.join(dir, 'scripts', 'leak-scan.mjs');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, `${fs.readFileSync(scanner, 'utf8')}\n// ${SAMPLE.windows}\n`);
  const result = run(['--root', dir]);
  assert.equal(result.status, 1, output(result));
  assert.match(result.stderr, /\[windows-user-path\]/);
});

test('--json reports rule id, file and line without values', (t) => {
  const { dir, write } = fixture(t);
  write('a.txt', `${SAMPLE.windows}\n`);
  const result = run(['--root', dir, '--json']);
  assert.equal(result.status, 1, output(result));
  const report = JSON.parse(result.stdout);
  // A Windows profile path also contains the macOS /Users/<name>/ shape, so more than one
  // rule may report the same line. Overlapping true positives are fine; false ones are not.
  assert.ok(report.hits.some((hit) => hit.id === 'windows-user-path'), JSON.stringify(report));
  assert.ok(report.hits.every((hit) => hit.file === 'a.txt' && hit.line === 1), JSON.stringify(report));
  assert.equal(JSON.stringify(report).includes(SAMPLE.windows), false);
});

test('a bad invocation fails with a clean message, not a stack trace', (t) => {
  const dir = tempDir(t);
  for (const args of [['--root'], ['--unknown-flag'], ['--root', path.join(dir, 'does-not-exist')]]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')} => ${output(result)}`);
    assert.match(result.stderr, /^leak-scan: /);
    assert.doesNotMatch(result.stderr, NO_STACK);
  }
});

test('the repository itself is clean, including this test file', () => {
  const result = run([]);
  assert.equal(result.status, 0, `the repository has a leak:\n${output(result)}`);
  assert.match(result.stdout, /leak-scan: clean \(\d+ files scanned\)/);
});
