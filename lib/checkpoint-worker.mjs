import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createTransport } from './storage/index.mjs';
import { drainCheckpoints } from './checkpoints.mjs';
import { atomicJson } from './transport.mjs';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A helper holds the Windows kernel mutex until this process releases it or dies.
export function withQueueMutex(root, callback) {
  if (process.platform !== 'win32') return callback();
  const canonical = fs.realpathSync(root).toLowerCase();
  const name = 'Local\\memkeel-queue-' + crypto.createHash('sha256').update(canonical).digest('hex');
  const control = path.join(os.tmpdir(), 'memkeel-mutex-' + crypto.randomUUID());
  const shell = process.env.MEMKEEL_PWSH ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'Microsoft/WindowsApps/pwsh.exe');
  const helper = spawn(shell, ['-NoProfile', '-File', fileURLToPath(new URL('./kernel-lock.ps1', import.meta.url)), '-Name', name, '-OwnerPid', String(process.pid), '-Control', control], { windowsHide: true, stdio: 'ignore' });
  helper.on('error', () => {});
  try {
    const deadline = Date.now() + 15000;
    let result = '';
    while (!result) {
      if (Date.now() >= deadline) throw new Error('Queue mutex helper startup timed out');
      if (fs.existsSync(control + '.result')) result = fs.readFileSync(control + '.result', 'utf8');
      if (result) break;
      sleep(50);
    }
    if (result === 'busy') return { busy: true };
    if (result !== 'ready') throw new Error(result);
    // Only the kernel owner may migrate a provably dead legacy file lock.
    const legacy = path.join(root, 'writer.lock');
    if (fs.existsSync(legacy)) {
      const record = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (String(record.host).toLowerCase() !== os.hostname().toLowerCase()) throw new Error('Foreign legacy queue lock');
      try { process.kill(record.pid, 0); throw new Error('Legacy queue writer is still running'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.renameSync(legacy, path.join(root, 'recovered-lock-' + crypto.randomUUID() + '.txt'));
    }
    return callback();
  } finally {
    fs.writeFileSync(control + '.release', '');
    const deadline = Date.now() + 3000;
    while (fs.existsSync(control + '.result') && Date.now() < deadline) sleep(25);
    for (const suffix of ['.result', '.release']) fs.rmSync(control + suffix, { force: true });
  }
}

export function startCheckpointWorker(home) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--home', home], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.argv[process.argv.indexOf('--home') + 1];
  const { config } = loadConfig(home);
  const root = path.join(config.policyRoot, 'state/hook-queue');
  fs.mkdirSync(root, { recursive: true });
  const status = path.join(config.policyRoot, 'state/checkpoint-worker.json');
  try {
    let result;
    for (let attempt = 0; attempt < 120; attempt++) {
      result = withQueueMutex(root, () => {
      atomicJson(status, { state: 'running', pid: process.pid, startedAt: new Date().toISOString() });
      let processed = 0;
      for (;;) {
        const batch = drainCheckpoints(config, createTransport(config), { limit: 10, kernelLocked: process.platform === 'win32' });
        processed += batch.processed;
        if (batch.errors.length || batch.processed === 0) {
          atomicJson(status, { state: batch.errors.length ? 'failed' : 'idle', pid: process.pid, at: new Date().toISOString(), processed, errors: batch.errors });
          return batch;
        }
      }
    });
      if (!result?.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (result?.errors?.length) process.exitCode = 1;
  } catch (error) {
    atomicJson(status, { state: 'failed', at: new Date().toISOString(), error: error.message });
    process.exitCode = 1;
  }
}
