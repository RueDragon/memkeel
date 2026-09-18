import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultTransport, inside, atomicJson, existingMode, isInsidePath, publishStoreFile, writeFilePreservingMode } from '../lib/transport.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-memory-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { vaultRoot: path.join(root, 'vault'), policyRoot: path.join(root, 'policy') };
  fs.mkdirSync(config.vaultRoot); fs.mkdirSync(config.policyRoot);
  const transport = new VaultTransport(config);
  // The real CLI decodes the two-character sequences backslash-n to a line feed and
  // backslash-t to a tab on every argument, and cannot escape a literal backslash before
  // those letters (measured 2026-09-10). The double mirrors that decoding so the suite
  // fails if document content is ever routed through the argument protocol again.
  const decodeArguments = (text) => text.replaceAll('\\n', '\n').replaceAll('\\t', '\t');
  transport.cli = (command, args) => {
    const file = inside(config.vaultRoot, args.path);
    if (command === 'read') return fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n').trim();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (command === 'create') fs.writeFileSync(file, decodeArguments(args.content));
    if (command === 'append') fs.appendFileSync(file, `\n${decodeArguments(args.content)}`);
    return '';
  };
  return { config, transport };
}
test('generated patch preserves Chinese, CRLF and manual sections', (t) => {
  const { config, transport } = fixture(t);
  const before = '# 手动内容\r\nKeep\r\n<!-- AUTO-MANAGED:START -->\r\n旧状态\r\n<!-- AUTO-MANAGED:END -->\r\n人工尾部\r\n';
  fs.writeFileSync(path.join(config.vaultRoot, 'existing.md'), before);
  transport.managed('existing.md', '', '## 当前\n新状态');
  const result = fs.readFileSync(path.join(config.vaultRoot, 'existing.md'), 'utf8');
  assert.ok(result.startsWith('# 手动内容\r\nKeep\r\n'));
  assert.ok(result.endsWith('\r\n人工尾部\r\n')); assert.match(result, /新状态/);
});
test('an exact replacement keeps its provenance inside the memory home and leaks nothing to the temp directory', (t) => {
  const { config, transport } = fixture(t);
  const stagedBefore = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('lu-memory-patch-')));
  const before = 'alpha\n'; const next = 'beta\n';
  fs.writeFileSync(path.join(config.vaultRoot, 'note.md'), before);
  transport.replace('note.md', before, next);
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, 'note.md'), 'utf8'), next);
  // Staging the generated patch in the OS temp directory used to leave one directory behind on
  // every replacement, which accumulated into thousands of them on a working machine.
  const leaked = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('lu-memory-patch-') && !stagedBefore.has(name));
  assert.deepEqual(leaked, [], 'no staging directory may be left in the OS temp directory');
  const backups = path.join(config.policyRoot, 'backups', 'replacements');
  const entries = fs.readdirSync(backups);
  assert.ok(entries.some((name) => name.endsWith('.json')), 'the replacement record is kept');
  assert.ok(entries.some((name) => fs.statSync(path.join(backups, name)).isDirectory()), 'the generated patch is kept as durable provenance');
});
test('concurrent target mutation is rejected without replacement', (t) => {
  const { config, transport } = fixture(t); fs.writeFileSync(path.join(config.vaultRoot, 'existing.md'), 'user changed');
  assert.throws(() => transport.replace('existing.md', 'old', 'new'), /Concurrent/);
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, 'existing.md'), 'utf8'), 'user changed');
});
test('full CRLF-to-LF replacement ignores global core.autocrlf=true', (t) => {
  const { config, transport } = fixture(t);
  const before = '# 旧入口\r\n旧行\r\n'; const next = '# 新入口\n新行\n';
  fs.writeFileSync(path.join(config.vaultRoot, 'root.md'), before);
  transport.replace('root.md', before, next);
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, 'root.md'), 'utf8'), next);
});
test('create chunks keep Markdown paragraphs and JSON parseable', (t) => {
  const { transport } = fixture(t);
  const body = '# Header\n\n' + Array.from({ length: 8 }, (_, i) => `${i} ${'中'.repeat(450)}`).join('\n\n');
  transport.create('new.md', body); assert.equal(transport.verify('new.md'), body);
});
test('ambiguous managed blocks fail closed', (t) => {
  const { config, transport } = fixture(t); fs.writeFileSync(path.join(config.vaultRoot, 'bad.md'), 'manual-only');
  assert.throws(() => transport.managed('bad.md', '', 'replace'), /exactly one/);
});

test('content that quotes the managed markers cannot forge a second block', (t) => {
  const { config, transport } = fixture(t);
  const file = path.join(config.vaultRoot, 'forged.md');
  fs.writeFileSync(file, 'manual\n<!-- AUTO-MANAGED:START -->\nold\n<!-- AUTO-MANAGED:END -->\n');
  // Event bodies, fact text and evidence lists are arbitrary text, so one of them can quote the
  // markers themselves - which is how a live store was deadlocked on 2026-09-17.
  transport.managed('forged.md', '', 'a note must hold <!-- AUTO-MANAGED:START --> / <!-- AUTO-MANAGED:END --> exactly once');
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after.split('<!-- AUTO-MANAGED:START -->').length - 1, 1, 'the content forged a second start marker');
  assert.equal(after.split('<!-- AUTO-MANAGED:END -->').length - 1, 1, 'the content forged a second end marker');
  assert.match(after, /&lt;!-- AUTO-MANAGED:START --&gt;/, 'the quoted marker is kept, escaped rather than dropped');
  // The damage is not the stray marker, it is that every later write refuses for good.
  transport.managed('forged.md', '', 'second write');
  assert.match(fs.readFileSync(file, 'utf8'), /second write/);
});

test('CLI diagnostics preserve non-empty stdout when stderr is empty', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-memory-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  fs.writeFileSync(path.join(vaultRoot, 'note.md'), 'content');
  const transport = new VaultTransport({
    vaultRoot,
    policyRoot: path.join(root, 'policy'),
    obsidianCli: 'obsidian.com',
    vaultName: 'demo-vault',
    spawnSync: () => ({ status: 0, signal: null, error: null, stderr: '', stdout: 'Error: hidden read failure' }),
  });
  assert.throws(() => transport.read('note.md'), /stdout=Error: hidden read failure/);
});

test('successful note content containing an Error line is not treated as a CLI failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-memory-cli-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  fs.writeFileSync(path.join(vaultRoot, 'note.md'), '# Note\n\nError: this is note content');
  const transport = new VaultTransport({
    vaultRoot,
    policyRoot: path.join(root, 'policy'),
    obsidianCli: 'obsidian.com',
    vaultName: 'demo-vault',
    spawnSync: () => ({ status: 0, signal: null, error: null, stderr: '', stdout: '# Note\n\nError: this is note content' }),
  });
  assert.equal(transport.verify('note.md'), '# Note\n\nError: this is note content');
});

test('read retries transient CLI failures but does not retry terminal failures', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-memory-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  fs.writeFileSync(path.join(vaultRoot, 'note.md'), 'content');
  let transientAttempts = 0;
  const transient = new VaultTransport({
    vaultRoot,
    policyRoot: path.join(root, 'policy'),
    obsidianCli: 'obsidian.com',
    vaultName: 'demo-vault',
    spawnSync: () => {
      transientAttempts += 1;
      return transientAttempts === 1
        ? { status: 1, signal: null, error: null, stderr: 'vault is busy', stdout: '' }
        : { status: 0, signal: null, error: null, stderr: '', stdout: 'content' };
    },
  });
  assert.equal(transient.read('note.md'), 'content');
  assert.equal(transientAttempts, 2);

  let terminalAttempts = 0;
  const terminal = new VaultTransport({
    vaultRoot,
    policyRoot: path.join(root, 'policy'),
    obsidianCli: 'obsidian.com',
    vaultName: 'demo-vault',
    spawnSync: () => {
      terminalAttempts += 1;
      return { status: 1, signal: null, error: null, stderr: 'access denied', stdout: '' };
    },
  });
  assert.throws(() => terminal.read('note.md'), /stderr=<empty>|access denied/);
  assert.equal(terminalAttempts, 1);
});

test('the CLI argument protocol is lossy for backslash sequences, so content never uses it', (t) => {
  const { config, transport } = fixture(t);
  const TAB = String.fromCharCode(9);
  const LF = String.fromCharCode(10);
  transport.cli('create', { path: 'probe.md', content: `a\\tb` });
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, 'probe.md'), 'utf8'), `a${TAB}b`);
  transport.cli('append', { path: 'probe.md', content: `c\\nd` });
  assert.ok(fs.readFileSync(path.join(config.vaultRoot, 'probe.md'), 'utf8').endsWith(`c${LF}d`));
});

test('event content with backslash-t and backslash-n paths round-trips byte-exact', (t) => {
  const { config, transport } = fixture(t);
  const seen = [];
  const cli = transport.cli;
  transport.cli = (command, args) => { seen.push(command); return cli(command, args); };
  // A Windows path whose separators precede 't' and 'n' is what corrupted the live journal.
  const tunnel = 'C:\\Users\\demo\\.dsh\\remote-web-ui-tunnel\\tunnel.ps1';
  const body = `# Note\n\ntunnel console: ${tunnel}\nlogs: C:\\temp\\node_modules`;
  transport.create('windows.md', body);
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, 'windows.md'), 'utf8'), body);
  assert.ok(seen.length > 0 && seen.every((command) => command === 'read'), 'content must never travel through the CLI argument protocol');

  transport.append('windows.md', `appended: ${tunnel}`);
  const after = fs.readFileSync(path.join(config.vaultRoot, 'windows.md'), 'utf8');
  assert.ok(after.endsWith(`appended: ${tunnel}`));
  assert.equal(after.includes(String.fromCharCode(9)), false, 'no tab may appear where a backslash-t was written');
});

test('a persistent readback mismatch reports the mismatch instead of destroying the appended bytes', (t) => {
  const { config, transport } = fixture(t);
  const file = path.join(config.vaultRoot, 'note.md');
  fs.writeFileSync(file, 'original');
  // Only the post-write readback goes stale, so the write really happens: the file on disk holds the
  // complete append, and a mismatch is a report about the vault view rather than about those bytes.
  transport.read = (relative) => (fs.readFileSync(path.join(config.vaultRoot, relative), 'utf8').includes('new line') ? 'stale vault view' : 'original');
  assert.throws(() => transport.append('note.md', 'new line'), /readback mismatch/i);
  // The append was published all at once, so there is no partial state to roll back from. Writing the
  // previous bytes back would delete an append that succeeded, and would overwrite anything a second
  // writer had put there - which is what the readback check exists to protect.
  assert.equal(fs.readFileSync(file, 'utf8'), 'original\n\nnew line', 'the published bytes must survive a stale vault view');
});

test('a persistent readback mismatch reports the mismatch instead of removing the created note', (t) => {
  const { config, transport } = fixture(t);
  transport.read = () => 'stale vault view';
  assert.throws(() => transport.create('partial.md', '# New'), /readback mismatch/i);
  // The note is complete on disk. Deleting it because a *view* of it lagged would destroy the bytes
  // the check exists to protect, and would do so on the strength of a cache, not of the file.
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, 'partial.md'), 'utf8'), '# New', 'the created note must survive a stale vault view');
});

test('an append whose block is already the note tail is not appended a second time', (t) => {
  const { config, transport } = fixture(t);
  const file = path.join(config.vaultRoot, 'note.md');
  fs.writeFileSync(file, 'original');
  transport.append('note.md', 'new line');
  const once = fs.readFileSync(file, 'utf8');
  // The retry of an append that was published but never acknowledged - the process died between the
  // rename and the readback - must recognise its own trailing block instead of writing it twice.
  transport.append('note.md', 'new line');
  assert.equal(fs.readFileSync(file, 'utf8'), once, 'the same block must not be appended twice');
  // Only the exact trailing block is recognised, so ordinary appends are unaffected.
  transport.append('note.md', 'other line');
  assert.equal(fs.readFileSync(file, 'utf8'), `${once}\n\nother line`, 'a different block must still be appended');
});

// --------------------------------------------------------------- permissions (DEP-02)

test('a rewrite keeps the permissions of the file it replaces', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, 'model = "demo"\n');
  const before = existingMode(file);
  assert.equal(typeof before, 'number');
  writeFilePreservingMode(file, 'model = "demo"\nbound\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = "demo"\nbound\n');
  // The replacement is a fresh file; without preservation it would take the process default.
  assert.equal(existingMode(file), before);
});

test('a file that does not exist yet is created with the platform default', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(existingMode(path.join(root, 'absent')), null);
  const file = path.join(root, 'nested', 'new.toml');
  writeFilePreservingMode(file, 'fresh\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'fresh\n');
  assert.equal(typeof existingMode(file), 'number');
});

test('atomicJson keeps the mode of the file it atomically replaces', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'receipt.json');
  atomicJson(file, { format: 1 });
  const before = existingMode(file);
  atomicJson(file, { format: 1, files: {} });
  // rename keeps the source file's mode, so the temp file has to be created with the target's.
  assert.equal(existingMode(file), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { format: 1, files: {} });
});

test('a restrictive mode survives a rewrite', { skip: process.platform === 'win32' ? 'Windows reports a synthesised mode and chmod only toggles the read-only bit, so a 0600 assertion cannot hold there; the same path runs on Linux and macOS in CI' : false }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'credentials.toml');
  fs.writeFileSync(file, 'token = "secret"\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  assert.equal(existingMode(file), 0o600);
  writeFilePreservingMode(file, 'token = "secret"\nbound\n');
  // Host configuration can carry credentials, so widening 0600 to the umask default would leak it.
  assert.equal(existingMode(file), 0o600);
  atomicJson(file, { token: 'secret' });
  assert.equal(existingMode(file), 0o600);
});

test('a replacement that fails part-way leaves the original file untouched, not truncated', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, 'model = "demo"\n');

  // A torn write: the bytes go in and the write fails before they are complete, which is the state a
  // process killed mid-write leaves behind - a direct write truncates the target first, so half of the
  // new content is what stays on disk. The write is matched by content rather than by path so this
  // holds whichever file the implementation writes first.
  const real = fs.writeFileSync;
  fs.writeFileSync = function (target, content, ...rest) {
    if (String(content).includes('bound')) {
      real.call(fs, target, String(content).slice(0, 4));
      const error = new Error('ENOSPC: no space left on device, write');
      error.code = 'ENOSPC';
      throw error;
    }
    return real.call(fs, target, ...rest);
  };
  t.after(() => { fs.writeFileSync = real; });

  assert.throws(() => writeFilePreservingMode(file, 'model = "demo"\nbound\n'), /ENOSPC/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model = "demo"\n', 'a failed replacement must leave the original bytes');
  assert.deepEqual(fs.readdirSync(root), ['config.toml'], 'and it must not leave a partial file beside it');
});

test('a symlinked configuration keeps the link and publishes atomically at its target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'dotfiles', 'codex.toml');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'model = "demo"\n');
  const link = path.join(root, 'config.toml');
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) { t.skip(`this platform cannot create a symlink without elevation (${error.code})`); return; }

  writeFilePreservingMode(link, 'model = "demo"\nbound\n');
  // Replacing the link with a regular file would break a dotfile layout the user set up on purpose, and
  // writing through the link in place is the truncating write this module exists to remove. The link is
  // resolved instead and the replacement published at its target, so both properties hold at once.
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the configuration must still be a symlink');
  assert.equal(fs.readFileSync(target, 'utf8'), 'model = "demo"\nbound\n', 'and its target must hold the new bytes');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['codex.toml'], 'the publish must leave no temporary behind');
});

// --------------------------------------------------------------- symlinks inside a store

test('a file symlink that leaves the store is refused, and neither the link nor its target is touched', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'store');
  const outside = path.join(root, 'shared');
  fs.mkdirSync(store); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'note.md'), 'original\n');
  try { fs.symlinkSync(path.join(outside, 'note.md'), path.join(store, 'note.md'), 'file'); }
  catch (error) { t.skip(`this platform cannot create a symlink without elevation (${error.code})`); return; }

  // Writing through a link like this in place would truncate a file the user keeps outside the store;
  // replacing the link would turn it into a regular file. The relative-path check refuses it while it
  // resolves the link, and the publish refuses again if a link appears after that check - so this
  // asserts that nothing is written, not which of the two layers said no.
  assert.throws(() => publishStoreFile(store, 'note.md', 'updated\n'), /Symlink escapes root|outside the store through a symlink/);
  assert.equal(fs.readFileSync(path.join(outside, 'note.md'), 'utf8'), 'original\n', 'a refused publish must not touch the target');
  assert.equal(fs.lstatSync(path.join(store, 'note.md')).isSymbolicLink(), true, 'and must not replace the link');
});

test('a link at the target that leaves the store is refused on every platform', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'store');
  const outside = path.join(root, 'shared');
  fs.mkdirSync(store); fs.mkdirSync(outside);
  const link = path.join(store, 'linked.md');
  // The same refusal as the file symlink above, reached through a directory link, which Windows can
  // create without elevation - so the escape policy is exercised on the platform where the file-symlink
  // case skips rather than only on the CI runners.
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`this platform cannot create a directory link (${error.code})`); return; }

  assert.throws(() => publishStoreFile(store, 'linked.md', 'x\n'), /Symlink escapes root/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be published outside the store');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'and the link must be left alone');
});

test('isInsidePath answers for a resolved path the way `inside` answers for a relative one', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-inside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'store');
  fs.mkdirSync(store);
  assert.equal(isInsidePath(path.join(store, 'note.md'), store), true);
  assert.equal(isInsidePath(store, store), true, 'the root itself is inside itself');
  assert.equal(isInsidePath(path.join(store, '..', 'other.md'), store), false, 'a sibling is not inside');
  assert.equal(isInsidePath(root, store), false, 'an ancestor is not inside');
  // The bug a prefix comparison would have: the root's own name as a prefix of a neighbouring path.
  assert.equal(isInsidePath(`${store}-sibling${path.sep}note.md`, store), false, 'a name that merely starts with the root is not inside');
});

test('a symlink that resolves inside the store is followed, and the link survives', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'store');
  fs.mkdirSync(path.join(store, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(store, 'notes', 'real.md'), 'original\n');
  try { fs.symlinkSync(path.join(store, 'notes', 'real.md'), path.join(store, 'alias.md'), 'file'); }
  catch (error) { t.skip(`this platform cannot create a symlink without elevation (${error.code})`); return; }

  publishStoreFile(store, 'alias.md', 'updated\n');
  assert.equal(fs.readFileSync(path.join(store, 'notes', 'real.md'), 'utf8'), 'updated\n');
  assert.equal(fs.lstatSync(path.join(store, 'alias.md')).isSymbolicLink(), true, 'the link must survive the publish');
  assert.deepEqual(fs.readdirSync(path.join(store, 'notes')), ['real.md'], 'and the publish must leave no temporary behind');
});

test('a broken link and a link to a directory are refused instead of being replaced', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'store');
  fs.mkdirSync(path.join(store, 'dir'), { recursive: true });
  const broken = path.join(store, 'broken.md');
  const toDir = path.join(store, 'todir.md');
  // Directory links rather than file links, because they are the one kind Windows can create without
  // elevation - so these two refusals are checked on every platform rather than only in CI.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(path.join(store, 'missing-dir'), broken, linkType);
    fs.symlinkSync(path.join(store, 'dir'), toDir, linkType);
  } catch (error) { t.skip(`this platform cannot create a directory link (${error.code})`); return; }

  // There is nothing safe to publish to in either case: a broken link has no target to hold the bytes,
  // and a link to a directory has no file to replace. Both are refused rather than resolved into
  // something the user did not ask for.
  assert.throws(() => publishStoreFile(store, 'broken.md', 'x\n'), /cannot be resolved/);
  assert.throws(() => publishStoreFile(store, 'todir.md', 'x\n'), /over a directory/);
  assert.equal(fs.lstatSync(broken).isSymbolicLink(), true, 'the broken link must be left alone');
  assert.equal(fs.lstatSync(toDir).isSymbolicLink(), true, 'and so must the link to a directory');
});

test('a directory link that leaves the store is refused before anything is written', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'store');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(store); fs.mkdirSync(outside);
  // A directory link rather than a file link: `inside` resolves the nearest existing ancestor, so this
  // is the shape that catches an escape before the final component is even considered. Directory links
  // are also the one kind Windows can create without elevation, so this check runs on every platform.
  const linked = path.join(store, 'linked');
  try { fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`this platform cannot create a directory link (${error.code})`); return; }

  assert.throws(() => publishStoreFile(store, 'linked/note.md', 'x\n'), /escapes root/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be written outside the store');
});

test('the root real path is cached, and caching it changes none of the checks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-memory-inside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);

  // Resolving a normal path works, and the caller gets the path as spelled from the root it passed —
  // `inside` returns `path.resolve(root, relative)`, not the root's real path. Asserting against
  // `realpathSync` here would fail on macOS, where the temporary directory is spelled `/var/...` and
  // resolves to `/private/var/...`; the difference is the whole point of keeping the two apart.
  assert.equal(inside(vaultRoot, 'note.md'), path.resolve(vaultRoot, 'note.md'));

  // Containment is still enforced. Caching the root must not turn the escape check into a formality.
  assert.throws(() => inside(vaultRoot, '../escape.md'), /escapes root/);
  assert.throws(() => inside(vaultRoot, '/etc/passwd'), /Expected relative path/);

  // A symlink that leaves the root is still refused. This is the check the cache could plausibly have
  // broken, because it is the one that depends on a real path being resolved at all.
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  let linked = true;
  try { fs.symlinkSync(outside, path.join(vaultRoot, 'link'), 'junction'); }
  catch { linked = false; }
  if (linked) assert.throws(() => inside(vaultRoot, 'link/x.md'), /Symlink escapes root/);

  // A root that does not exist must still fail on *every* call: only successful resolutions are cached,
  // so a missing root cannot become a cached success.
  const missing = path.join(root, 'nope');
  assert.throws(() => inside(missing, 'note.md'), /ENOENT|no such file/i);
  assert.throws(() => inside(missing, 'note.md'), /ENOENT|no such file/i);
});
