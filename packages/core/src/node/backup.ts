/**
 * Безопасное сохранение мода, автосохранение и резервные копии (как «safe save», `.bak` и
 * «A more recent backup exists» в официальном FCS) — без Electron, чтобы проверять тестами.
 *
 * Правила:
 * - Сохранение мода: байты → временный файл рядом → проверка (читается ядром и совпадает с
 *   записанным) → копия прежней версии в папку резервных копий → замена. Сбой на любом шаге
 *   оставляет существующий мод как был, временный файл удаляется.
 * - Резервные копии и автосохранения лежат ТОЛЬКО в папке данных приложения
 *   (`<данные>/backups/<ключ>/`, `<данные>/autosave/<ключ>.mod`): не в папке мода (её целиком
 *   загружают в мастерскую) и не в папке игры. Путь записи строится здесь из ключа, а не
 *   принимается снаружи; папка в игре или мастерской — отказ (`forbidden`).
 * - Ключ мода — имя файла + хеш полного пути (новый мод без пути — хеш имени).
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readDataFile } from '../format/read.ts';

/** Какой мод: файл на диске (`path`) или новый, ещё не сохранённый (`modName`). */
export interface ModRef {
  path?: string | undefined;
  modName: string;
}

export type BackupKind = 'backup' | 'autosave' | 'restore-point';

export interface BackupEntry {
  /** Имя файла в папке копий; у автосохранения — `autosave`. */
  id: string;
  kind: BackupKind;
  /** Когда создана копия (мс с 1970): для `backup` — когда её заменили новой версией. */
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

/** Имя мода без `.mod`/`.base`, безопасное для имени файла. */
function safeName(modName: string): string {
  const base = basename(modName).replace(/\.(mod|base)$/i, '');
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '_').trim();
  return (clean || 'mod').slice(0, 40).toLowerCase();
}

/** Ключ мода: `<имя>-<8 знаков хеша пути>`. Один и тот же мод — всегда один ключ. */
export function modKey(ref: ModRef): string {
  const seed = ref.path !== undefined && ref.path !== '' ? `file:${normalizePath(ref.path)}` : `new:${ref.modName.toLowerCase()}`;
  const hash = createHash('sha1').update(seed).digest('hex').slice(0, 8);
  return `${safeName(ref.path !== undefined && ref.path !== '' ? basename(ref.path) : ref.modName)}-${hash}`;
}

export const autosaveFile = (dataDir: string, ref: ModRef): string => join(autosaveDir(dataDir), `${modKey(ref)}.mod`);
const autosaveMetaFile = (dataDir: string, ref: ModRef): string => join(autosaveDir(dataDir), `${modKey(ref)}.json`);
export const backupDir = (dataDir: string, ref: ModRef): string => join(backupsRoot(dataDir), modKey(ref));

/** Путь `p` лежит внутри `root` (или равен ему). */
export function isInside(p: string, root: string): boolean {
  const rel = relative(normalizePath(root), normalizePath(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Папка данных приложения не должна быть внутри папок игры и мастерской. */
function assertDataDirAllowed(dataDir: string, forbidden: readonly string[]): void {
  for (const f of forbidden) if (f && isInside(dataDir, f)) throw new Error(`refusing to write backups inside ${f}`);
}

/** Операции с файлами; подмена нужна только тестам (имитация сбоя записи). */
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
      // Windows: антивирус или индексатор на миг держит файл — повторить.
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
 * Записать файл так, чтобы старый не пострадал: временный файл рядом → проверка → замена.
 * `check` получает байты, прочитанные обратно с диска; бросает — запись отменяется.
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
      // временный файл не удалился — он не мешает: имя содержит .tmp-
    }
    throw e;
  }
}

/** Файл читается ядром как данные Kenshi (иначе это не мод). */
export function assertReadable(bytes: Uint8Array): void {
  readDataFile(bytes);
}

// ---------------------------------------------------------------------------------------------
// Резервные копии

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
      // файл исчез между чтением папки и stat
    }
  }
  return out.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
}

function normalizeKeep(keep: number): number {
  return Number.isFinite(keep) ? Math.max(0, Math.min(MAX_BACKUP_COUNT, Math.floor(keep))) : DEFAULT_BACKUP_COUNT;
}

/** Оставить `keep` самых новых копий, остальные удалить. */
export function rotateBackups(dataDir: string, ref: ModRef, keep: number): string[] {
  const dir = backupDir(dataDir, ref);
  const removed: string[] = [];
  for (const e of listBackupFiles(dir).slice(normalizeKeep(keep))) {
    try {
      unlinkSync(join(dir, e.id));
      removed.push(e.id);
    } catch {
      // не удалилась — останется до следующей ротации
    }
  }
  return removed;
}

function backupName(dir: string, kind: BackupKind, now: number): string {
  let name = `${now}.${kind}.mod`;
  for (let i = 1; existsSync(join(dir, name)); i++) name = `${now}-${i}.${kind}.mod`;
  return name;
}

/** Положить копию `bytes` в папку копий мода и провести ротацию. null — копия такая же, как последняя. */
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
  /** Сколько прежних версий хранить (0 — не хранить). */
  keep: number;
  now?: number;
  ops?: FileOps;
}

export interface SafeSaveResult {
  path: string;
  /** Копия прежней версии, если она была. */
  backup?: BackupEntry;
  /** Копию прежней версии сделать не удалось (мод при этом сохранён). */
  backupError?: string;
}

/**
 * Сохранить мод: временный файл рядом, проверка, копия прежней версии, замена. Если что-то
 * сломалось до замены — мод на диске не тронут.
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
  // Копия прежней версии — после успешной записи и проверки временного файла, но до замены.
  const tmpCheck = (written: Uint8Array): void => {
    assertReadable(written);
    backupBeforeReplace?.();
  };
  writeFileAtomic(path, bytes, { check: tmpCheck, ...(options.ops ? { ops: options.ops } : {}) });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Автосохранение

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
 * Записать автосохранение мода. Пишет только в `<данные>/autosave/<ключ>.mod`; мод, папка игры
 * и мастерская не затрагиваются (папка данных внутри `forbidden` — отказ).
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

/** Удалить автосохранение мода (после сохранения или отказа от правок). */
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
  /** Файл мода на диске есть. */
  modExists: boolean;
  /** Время изменения и размер файла мода (если он есть). */
  modTime?: number;
  modSize?: number;
}

/**
 * Автосохранение, которое стоит предложить восстановить: оно новее файла мода (или файла мода
 * нет) и отличается от него. Копию, оставшуюся от давно сохранённого мода, не предлагаем.
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

/** «Открыть мод как есть»: автосохранение не теряется, а уходит в список резервных копий. */
export function keepAutosaveAsBackup(dataDir: string, ref: ModRef, keep: number): BackupEntry | null {
  const bytes = readAutosave(dataDir, ref);
  if (!bytes) return null;
  const info = autosaveInfo(dataDir, ref);
  const entry = addBackup(dataDir, ref, bytes, 'autosave', keep, info?.savedAt);
  clearAutosave(dataDir, ref);
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Список и чтение копий

/** Автосохранение (если есть) и копии мода, самые новые сверху. */
export function listBackups(dataDir: string, ref: ModRef): BackupEntry[] {
  const out: BackupEntry[] = [];
  const auto = autosaveInfo(dataDir, ref);
  if (auto) out.push({ id: AUTOSAVE_ID, kind: 'autosave', time: auto.savedAt, size: auto.size });
  out.push(...listBackupFiles(backupDir(dataDir, ref)));
  return out.sort((a, b) => b.time - a.time);
}

/** Байты копии по `id` из `listBackups`; чужие имена (с путями) отвергаются. */
export function readBackup(dataDir: string, ref: ModRef, id: string): Uint8Array | undefined {
  if (id === AUTOSAVE_ID) return readAutosave(dataDir, ref);
  if (!BACKUP_NAME.test(id)) throw new Error(`bad backup id: ${id}`);
  const file = join(backupDir(dataDir, ref), id);
  return existsSync(file) ? readBytes(file) : undefined;
}
