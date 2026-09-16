// The published artifact has to be self-sufficient.
//
// `npm pack` had only ever been dry-run, so nobody had checked that what a user actually installs
// can run. This unpacks the real tarball into a directory that holds nothing else and exercises the
// commands the documentation promises, against a home and store outside the checkout. Nothing here
// may reach back into the repository: if it did, the test would pass while a real install failed.
//
// It also stands in for the parts of the container check that cannot run without a container
// runtime. The image copies a subset of this tree, so proving the unpacked tree is enough to serve
// the console proves the image does not need the Vite app source either.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

/** Pack, unpack, and return a CLI that only knows about the unpacked copy. */
function installed(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const packed = spawnSync('npm', ['pack', '--pack-destination', root, '--json'], { cwd: repo, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = path.join(root, JSON.parse(packed.stdout)[0].filename);
  const into = path.join(root, 'installed');
  fs.mkdirSync(into, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', into], { encoding: 'utf8', windowsHide: true });
  assert.equal(untar.status, 0, untar.stderr);

  const pkg = path.join(into, 'package');
  const home = path.join(root, 'home');
  const store = path.join(root, 'store');
  const cli = (...args) => spawnSync(process.execPath, [path.join(pkg, 'memory.mjs'), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, MEMKEEL_HOME: home },
  });
  return { root, pkg, home, store, cli, tarball };
}

test('the published tree is the runtime set, not the checkout', (t) => {
  const { pkg, cli } = installed(t);
  // The entry point resolves and its whole import graph loads with no repository in sight.
  const help = cli('help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /bootstrap --cwd PATH/);
  assert.match(help.stdout, /config validate\|show\|migrate/);

  for (const needed of ['bin', 'lib', 'scripts', 'vendor', 'dashboard/static', 'memory.mjs', 'mcp-server.mjs', 'hook-runner.mjs', 'dsh-memory-plugin.mjs', 'setup.mjs', 'dashboard.mjs', 'bootstrap.md', 'event-schema.md']) {
    assert.equal(fs.existsSync(path.join(pkg, needed)), true, `${needed} is missing from the published package`);
  }
  // Development-only material must not ship: the Vite app source, the console build tooling, the
  // suite, and the repository's own gates configuration.
  for (const excluded of ['dashboard/app', 'test', 'node_modules', '.github', '.gitignore']) {
    assert.equal(fs.existsSync(path.join(pkg, excluded)), false, `${excluded} should not be published`);
  }
});

test('a fresh install can create a store, validate its config and report healthy', (t) => {
  const { home, store, cli } = installed(t);
  // The documented first run, exactly: no home exists yet.
  const before = cli('doctor');
  assert.equal(before.status, 1);
  assert.match(before.stderr, /No memory home at/);

  const init = cli('init', '--store', store);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).store, store);

  const validate = cli('config', 'validate');
  assert.equal(validate.status, 0, validate.stdout);
  assert.equal(JSON.parse(validate.stdout).ok, true);

  const doctor = cli('doctor');
  assert.equal(doctor.status, 0, doctor.stdout);
  const report = JSON.parse(doctor.stdout);
  assert.deepEqual(report.missing, []);
  assert.equal(report.launcher.ok, true);
  // The launcher checks name the scripts the bindings invoke; they must exist in the installed copy.
  assert.deepEqual(report.launcher.checks.map((check) => check.label), ['launcher', 'mcp-server.mjs', 'hook-runner.mjs', 'dsh-memory-plugin.mjs']);
  assert.equal(report.effectiveHome.path, home);

  // vendor/ is a runtime import, not just an asset: a read-only projection in lib/core.mjs uses it.
  const bootstrap = cli('bootstrap', '--cwd', store, '--query', 'anything');
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.match(bootstrap.stdout, /Agent 启动摘要|Agent/);
});

/** Start the console from an installed copy and resolve the URL it prints. */
function startConsole(pkg, home, port) {
  const child = spawn(process.execPath, [path.join(pkg, 'memory.mjs'), 'dashboard', '--port', String(port), '--home', home], {
    env: { ...process.env, MEMKEEL_HOME: home }, windowsHide: true,
  });
  const url = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`the console never reported a URL: ${output}`)), 30000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = /Memkeel dashboard: (\S+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the console exited early (code ${code}): ${output}`)); });
  });
  return { child, url };
}

test('the console serves from the published package, which needs no app source', async (t) => {
  const { pkg, home, store, cli } = installed(t);
  assert.equal(cli('init', '--store', store).status, 0);

  const port = 30000 + (process.pid % 2000);
  const { child, url } = startConsole(pkg, home, port);
  t.after(() => child.kill());

  const base = await url;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  // The committed bundle is what is served, so dashboard/app is not needed to run the console.
  assert.match(html, /<html|<!doctype html>/i);

  // A cross-origin page must not be able to reach the console, and a loopback Host is required.
  const foreign = await fetch(base, { headers: { Origin: 'https://example.com' } });
  assert.equal(foreign.status, 403);
});

// ------------------------------------------------------ the image builds the same set

/** The source paths every COPY instruction names, with line continuations joined. */
function dockerCopySources() {
  const text = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8').replace(/\\\r?\n/g, ' ');
  const sources = [];
  for (const line of text.split('\n')) {
    const match = /^\s*COPY\s+(.*)$/.exec(line);
    if (!match) continue;
    const tokens = match[1].split(/\s+/).filter(Boolean).filter((token) => !token.startsWith('--'));
    // The last token is the destination.
    sources.push(...tokens.slice(0, -1));
  }
  return sources;
}

test('every Dockerfile COPY source exists, and the image does not ship the app source', () => {
  const sources = dockerCopySources();
  assert.ok(sources.length > 5, `expected several COPY sources, got ${JSON.stringify(sources)}`);
  for (const source of sources) {
    assert.equal(fs.existsSync(path.join(repo, source)), true, `Dockerfile copies ${source}, which does not exist`);
  }
  // dashboard/app is the Vite source and is not in package.json "files"; copying all of dashboard/
  // would put it back into the image.
  assert.ok(sources.includes('dashboard/static/'), `expected dashboard/static/ in ${JSON.stringify(sources)}`);
  assert.equal(sources.includes('dashboard/'), false, 'the image must not copy the whole dashboard tree');
  // The runtime imports this module directly (lib/core.mjs), so it cannot be dropped as an asset.
  assert.ok(sources.includes('vendor/'), 'vendor/ is a runtime import and must be copied');
});
