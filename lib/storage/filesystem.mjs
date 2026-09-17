import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inside, sha } from '../transport.mjs';
import { MANAGED_END, MANAGED_START, escapeManagedMarkers } from '../markers.mjs';

// Pure-filesystem storage backend. No Obsidian process or CLI is required, so a
// headless or non-Windows deployment can run the whole memory system on a plain
// Markdown directory. Semantics mirror VaultTransport: disk bytes are authoritative,
// appends are exact-or-rollback, replacements are guarded by an expected value.
export class FilesystemTransport {
  constructor(config) { this.config = config; this.spawnSync = config.spawnSync ?? spawnSync; }

  read(relative) {
    return fs.readFileSync(inside(this.config.vaultRoot, relative), 'utf8');
  }

  verify(relative) {
    return this.read(relative).replaceAll('\r\n', '\n').trim();
  }

  create(relative, content) {
    const target = inside(this.config.vaultRoot, relative);
    if (fs.existsSync(target)) throw new Error(`Refusing duplicate create: ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    if (fs.readFileSync(target, 'utf8') !== content) {
      fs.rmSync(target, { force: true });
      throw new Error(`Create content mismatch: ${relative}`);
    }
    return target;
  }

  append(relative, content) {
    const target = inside(this.config.vaultRoot, relative);
    const before = fs.readFileSync(target, 'utf8');
    const next = `${before}\n\n${content.trim()}`;
    fs.writeFileSync(target, next, 'utf8');
    if (fs.readFileSync(target, 'utf8') !== next) {
      fs.writeFileSync(target, before, 'utf8');
      throw new Error(`Append mismatch: ${relative}`);
    }
  }

  replace(relative, expected, next) {
    const target = inside(this.config.vaultRoot, relative);
    const current = fs.readFileSync(target, 'utf8');
    if (current !== expected) throw new Error(`Concurrent edit detected: ${relative}`);
    if (current === next) return false;
    const backupDir = path.join(this.config.policyRoot, 'backups', 'replacements');
    fs.mkdirSync(backupDir, { recursive: true });
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    fs.copyFileSync(target, path.join(backupDir, `${id}.md`));
    fs.writeFileSync(path.join(backupDir, `${id}.json`), `${JSON.stringify({ relative, before: sha(current), after: sha(next) }, null, 2)}\n`, 'utf8');
    if (fs.readFileSync(target, 'utf8') !== current) throw new Error('Target changed after preflight');
    fs.writeFileSync(target, next, 'utf8');
    this.verify(relative);
    return true;
  }

  managed(relative, header, body) {
    // Content can mention the markers by accident, and a marker inside the block forges a second
    // one, which makes the note unmanageable with no way back. Escape it before it goes in.
    const block = `${MANAGED_START}\n${escapeManagedMarkers(body).trim()}\n${MANAGED_END}`;
    const target = inside(this.config.vaultRoot, relative);
    if (!fs.existsSync(target)) { this.create(relative, `${escapeManagedMarkers(header).trim()}\n\n${block}\n`); return; }
    const old = fs.readFileSync(target, 'utf8');
    if (old.split(MANAGED_START).length !== 2 || old.split(MANAGED_END).length !== 2 || old.indexOf(MANAGED_END) < old.indexOf(MANAGED_START)) {
      throw new Error(`Expected exactly one managed block: ${relative}`);
    }
    this.replace(relative, old, old.slice(0, old.indexOf(MANAGED_START)) + block + old.slice(old.indexOf(MANAGED_END) + MANAGED_END.length));
  }
}

export function temporaryRoot(prefix = 'agent-memory-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
