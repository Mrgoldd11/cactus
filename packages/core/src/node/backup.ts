/**
 * Safe mod save, autosave and backups (like "safe save", `.bak` and
 * "A more recent backup exists" in the official FCS) — without Electron, so tests can cover it.
 *
 * Rules:
 * - Saving a mod: bytes → temp file next to it → check (the core reads it and it matches what was
 *   written) → copy of the previous version into the backup folder → replace. A failure at any step
 *   leaves the existing mod as it was; the temp file is deleted.
 * - Backups and autosaves live ONLY in the app data folder
 *   (`<data>/backups/<key>/`, `<data>/autosave/<key>.mod`): not in the mod folder (it is uploaded
 *   to the Workshop as a whole) and not in the game folder. The write path is built here from the key,
 *   not taken from outside; a folder inside the game or Workshop is refused (`forbidden`).
 * - Mod key — file name + hash of the full path (a new mod without a path — hash of the name).
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readDataFile } from '../format/read.ts';

/** Which mod: a file on disk (`path`) or a new, not yet saved one (`modName`). */
export interface ModRef {
  path?: string | undefined;
  modName: string;
}

export type BackupKind = 'backup' | 'autosave' | 'restore-point';

export interface BackupEntry {
  /** File name in the backup folder; for the autosave — `autosave`. */
  id: string;
  kind: BackupKind;
  /** When the copy was made (ms since 1970): for `backup` — when it was replaced by a newer version. */
  time: number;
  size: number;
}

export const AUTOSAVE_ID = 'autosave';
export const DEFAULT_AUTOSAVE_MINUTES = 5;
export const DEFAULT_BACKUP_COUNT = 5;
export const MAX_BACKUP_COUNT = 50;

export const autosaveDir = (dataDir: string): string => join(dataDir, 'autosave');
export const backupsRoot = (dataDir: string): string => join(dataDir, 'backups');

function normalizePath(p: string): string {
  const full = resolve(p);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/** Mod name without `.mod`/`.base`, safe for a file name. */
function safeName(modName: string): string {
  const base = basename(modName).replace(/\.(mod|base)$/i, '');
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '_').trim();
  return (clean || 'mod').slice(0, 40).toLowerCase();
}

/** Mod key: `<name>-<8 chars of path hash>`. The same mod always has the same key. */
export function modKey(ref: ModRef): string {
  const seed = ref.path !== undefined && ref.path !== '' ? `file:${normalizePath(ref.path)}` : `new:${ref.modName.toLowerCase()}`;
  const hash = createHash('sha1').update(seed).digest('hex').slice(0, 8);
  return `${safeName(ref.path !== undefined && ref.path !== '' ? basename(ref.path) : ref.modName)}-${hash}`;
}

export const autosaveFile = (dataDir: string, ref: ModRef): string => join(autosaveDir(dataDir), `${modKey(ref)}.mod`);
const autosaveMetaFile = (dataDir: string, ref: ModRef): string => join(autosaveDir(dataDir), `${modKey(ref)}.json`);
export const backupDir = (dataDir: string, ref: ModRef): string => join(backupsRoot(dataDir), modKey(ref));

/** Path `p` is inside `root` (or equals it). */
export function isInside(p: string, root: string): boolean {
  const rel = relative(normalizePath(root), normalizePath(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The app data folder must not be inside the game and Workshop folders. */
function assertDataDirAllowed(dataDir: string, forbidden: readonly string[]): void {
  for (const f of forbidden) if (f && isInside(dataDir, f)) throw new Error(`refusing to write backups inside ${f}`);
}

/** File operations; overriding is only for tests (simulating a write failure). */
export interface FileOps {
  writeFile: (path: string, bytes: Uint8Array) => void;
  rename: (from: string, to: string) => void;
}

const REAL_OPS: FileOps = {
  writeFile(path, bytes) {
    const fd = openSync(path, 'w');
    try {
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(ops: FileOps, from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      ops.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Windows: an antivirus or indexer holds the file for a moment — retry.
      if (attempt >= 3 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      sleepSync(60 * (attempt + 1));
    }
  }
}

function readBytes(path: string): Uint8Array {
  const b = readFileSync(path);
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

/**
 * Write a file so the old one is not harmed: temp file next to it → check → replace.
 * `check` gets the bytes read back from disk; if it throws, the write is cancelled.
 */
export function writeFileAtomic(path: string, bytes: Uint8Array, options: { check?: (written: Uint8Array) => void; ops?: FileOps } = {}): void {
  const ops = options.ops ?? REAL_OPS;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    ops.writeFile(tmp, bytes);
    const back = readFileSync(tmp);
    if (!sameBytes(back, bytes)) throw new Error(`verification failed: ${tmp} differs from the data being saved`);
    options.check?.(back);
    renameWithRetry(ops, tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the temp file was not deleted — harmless: its name contains .tmp-
    }
    throw e;
  }
}

/** The core reads the file as Kenshi data (otherwise it is not a mod). */
export function assertReadable(bytes: Uint8Array): void {
  readDataFile(bytes);
}

// ---------------------------------------------------------------------------------------------
// Backups

const BACKUP_NAME = /^(\d{1,16})(?:-\d+)?\.(backup|autosave|restore-point)\.mod$/;

function listBackupFiles(dir: string): BackupEntry[] {
  if (!existsSync(dir)) return [];
  const out: BackupEntry[] = [];
  for (const name of readdirSync(dir)) {
    const m = BACKUP_NAME.exec(name);
    if (!m) continue;
    try {
      out.push({ id: name, kind: m[2] as BackupKind, time: Number(m[1]), size: statSync(join(dir, name)).size });
    } catch {
      // the file vanished between reading the folder and stat
    }
  }
  return out.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
}

function normalizeKeep(keep: number): number {
  return Number.isFinite(keep) ? Math.max(0, Math.min(MAX_BACKUP_COUNT, Math.floor(keep))) : DEFAULT_BACKUP_COUNT;
}

/** Keep the `keep` newest copies, delete the rest. */
export function rotateBackups(dataDir: string, ref: ModRef, keep: number): string[] {
  const dir = backupDir(dataDir, ref);
  const removed: string[] = [];
  for (const e of listBackupFiles(dir).slice(normalizeKeep(keep))) {
    try {
      unlinkSync(join(dir, e.id));
      removed.push(e.id);
    } catch {
      // not deleted — it stays until the next rotation
    }
  }
  return removed;
}

function backupName(dir: string, kind: BackupKind, now: number): string {
  let name = `${now}.${kind}.mod`;
  for (let i = 1; existsSync(join(dir, name)); i++) name = `${now}-${i}.${kind}.mod`;
  return name;
}

/** Put a copy of `bytes` into the mod's backup folder and rotate. null — the copy equals the last one. */
export function addBackup(dataDir: string, ref: ModRef, bytes: Uint8Array, kind: BackupKind, keep: number, now = Date.now()): BackupEntry | null {
  if (normalizeKeep(keep) === 0) return null;
  const dir = backupDir(dataDir, ref);
  const newest = listBackupFiles(dir)[0];
  if (newest && newest.size === bytes.length && sameBytes(readBytes(join(dir, newest.id)), bytes)) return null;
  mkdirSync(dir, { recursive: true });
  const id = backupName(dir, kind, now);
  writeFileAtomic(join(dir, id), bytes);
  rotateBackups(dataDir, ref, keep);
  writeFileSync(join(dir, 'source.json'), JSON.stringify({ path: ref.path ?? null, modName: ref.modName }, null, 2));
  return { id, kind, time: now, size: bytes.length };
}

export interface SafeSaveOptions {
  dataDir: string;
  /** How many previous versions to keep (0 — keep none). */
  keep: number;
  now?: number;
  ops?: FileOps;
}

export interface SafeSaveResult {
  path: string;
  /** Copy of the previous version, if there was one. */
  backup?: BackupEntry;
  /** Copying the previous version failed (the mod is still saved). */
  backupError?: string;
}

/**
 * Save a mod: temp file next to it, check, copy of the previous version, replace. If something
 * breaks before the replace, the mod on disk is untouched.
 */
export function safeSaveMod(path: string, bytes: Uint8Array, options: SafeSaveOptions): SafeSaveResult {
  assertReadable(bytes);
  const ref: ModRef = { path, modName: basename(path) };
  const out: SafeSaveResult = { path };
  const previous = existsSync(path) ? readBytes(path) : undefined;
  let backupBeforeReplace: (() => void) | undefined;
  if (previous !== undefined && !sameBytes(previous, bytes)) {
    backupBeforeReplace = () => {
      try {
        const b = addBackup(options.dataDir, ref, previous, 'backup', options.keep, options.now);
        if (b) out.backup = b;
      } catch (e) {
        out.backupError = e instanceof Error ? e.message : String(e);
      }
    };
  }
  // Copy of the previous version — after the temp file is written and checked, but before the replace.
  const tmpCheck = (written: Uint8Array): void => {
    assertReadable(written);
    backupBeforeReplace?.();
  };
  writeFileAtomic(path, bytes, { check: tmpCheck, ...(options.ops ? { ops: options.ops } : {}) });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Autosave

export interface AutosaveMeta {
  path: string | null;
  modName: string;
  savedAt: number;
  size: number;
}

export interface AutosaveInfo {
  savedAt: number;
  size: number;
}

/**
 * Write the mod's autosave. Writes only to `<data>/autosave/<key>.mod`; the mod, the game folder
 * and the Workshop are not touched (data folder inside `forbidden` — refused).
 */
export function writeAutosave(dataDir: string, ref: ModRef, bytes: Uint8Array, options: { forbidden?: readonly string[]; now?: number; ops?: FileOps } = {}): AutosaveInfo {
  assertDataDirAllowed(dataDir, options.forbidden ?? []);
  assertReadable(bytes);
  const savedAt = options.now ?? Date.now();
  writeFileAtomic(autosaveFile(dataDir, ref), bytes, { check: assertReadable, ...(options.ops ? { ops: options.ops } : {}) });
  const meta: AutosaveMeta = { path: ref.path ?? null, modName: ref.modName, savedAt, size: bytes.length };
  writeFileSync(autosaveMetaFile(dataDir, ref), JSON.stringify(meta, null, 2));
  return { savedAt, size: bytes.length };
}

export function autosaveInfo(dataDir: string, ref: ModRef): AutosaveInfo | undefined {
  const file = autosaveFile(dataDir, ref);
  if (!existsSync(file)) return undefined;
  try {
    const st = statSync(file);
    return { savedAt: Math.round(st.mtimeMs), size: st.size };
  } catch {
    return undefined;
  }
}

export function readAutosave(dataDir: string, ref: ModRef): Uint8Array | undefined {
  const file = autosaveFile(dataDir, ref);
  return existsSync(file) ? readBytes(file) : undefined;
}

/** Delete the mod's autosave (after saving or discarding edits). */
export function clearAutosave(dataDir: string, ref: ModRef): boolean {
  let removed = false;
  for (const f of [autosaveFile(dataDir, ref), autosaveMetaFile(dataDir, ref)]) {
    if (existsSync(f)) {
      rmSync(f, { force: true });
      removed = true;
    }
  }
  return removed;
}

export interface Recovery extends AutosaveInfo {
  /** The mod file exists on disk. */
  modExists: boolean;
  /** Modification time and size of the mod file (if it exists). */
  modTime?: number;
  modSize?: number;
}

/**
 * An autosave worth offering to restore: it is newer than the mod file (or there is no mod
 * file) and differs from it. A copy left over from a long-saved mod is not offered.
 */
export function findRecovery(dataDir: string, ref: ModRef): Recovery | undefined {
  const info = autosaveInfo(dataDir, ref);
  if (!info) return undefined;
  const path = ref.path;
  if (path === undefined || path === '' || !existsSync(path)) return { ...info, modExists: false };
  const st = statSync(path);
  if (st.mtimeMs >= info.savedAt) return undefined;
  const same = st.size === info.size && sameBytes(readFileSync(path), readFileSync(autosaveFile(dataDir, ref)));
  if (same) return undefined;
  return { ...info, modExists: true, modTime: Math.round(st.mtimeMs), modSize: st.size };
}

/** "Open the mod as is": the autosave is not lost but moves into the backup list. */
export function keepAutosaveAsBackup(dataDir: string, ref: ModRef, keep: number): BackupEntry | null {
  const bytes = readAutosave(dataDir, ref);
  if (!bytes) return null;
  const info = autosaveInfo(dataDir, ref);
  const entry = addBackup(dataDir, ref, bytes, 'autosave', keep, info?.savedAt);
  clearAutosave(dataDir, ref);
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Listing and reading copies

/** The autosave (if any) and the mod's copies, newest first. */
export function listBackups(dataDir: string, ref: ModRef): BackupEntry[] {
  const out: BackupEntry[] = [];
  const auto = autosaveInfo(dataDir, ref);
  if (auto) out.push({ id: AUTOSAVE_ID, kind: 'autosave', time: auto.savedAt, size: auto.size });
  out.push(...listBackupFiles(backupDir(dataDir, ref)));
  return out.sort((a, b) => b.time - a.time);
}

/** Bytes of a copy by `id` from `listBackups`; foreign names (with paths) are rejected. */
export function readBackup(dataDir: string, ref: ModRef, id: string): Uint8Array | undefined {
  if (id === AUTOSAVE_ID) return readAutosave(dataDir, ref);
  if (!BACKUP_NAME.test(id)) throw new Error(`bad backup id: ${id}`);
  const file = join(backupDir(dataDir, ref), id);
  return existsSync(file) ? readBytes(file) : undefined;
}
