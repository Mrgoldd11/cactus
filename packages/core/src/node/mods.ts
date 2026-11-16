/**
 * Installed mods: `Kenshi/mods/<name>/`, Workshop `workshop/content/233860/<id>/` and
 * load order `data/mods.cfg`. The list is built without reading whole mods: only file
 * names and `mods.cfg`; the header (author, dependencies, record count) is `readModSummary`,
 * from the first kilobytes of the file.
 *
 * Only `writeModsCfg` writes `mods.cfg`: line endings as they were (CRLF by default), a copy
 * next to it before writing. `__mods.list` (the launcher maintains it) is not touched.
 *
 * A foreign mod (from the Workshop) is edited only as a copy: `copyModForEditing` puts it byte for byte
 * into `mods/<name>/<name>.mod` and next to it `<name>.kedit-origin.json` — where the copy came from (path,
 * Workshop number, date, SHA-256 of the original). The original is never changed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readModHeader } from '../format/read.ts';
import { decodeText } from '../text.ts';
import { splitModList } from '../format/helpers.ts';
import { formatModsCfg, parseModsCfg, type ModsCfgText } from '../model/load-order.ts';
import type { ConflictLayer } from '../model/conflicts.ts';
import type { DataFile, GameRecord } from '../format/types.ts';
import { readDataFile } from '../format/read.ts';
import { installedModFiles, type GamePaths } from './paths.ts';
import { UiTextError, type UiText } from '../ui-text.ts';

export type ModSource = 'mods' | 'workshop';

export interface InstalledMod {
  /** File name: `My mod.mod`. */
  fileName: string;
  /** Name without `.mod`. */
  name: string;
  path: string;
  source: ModSource;
  /** Workshop item number (folder name), for `source: 'workshop'`. */
  workshopId?: string;
  /** Listed in `mods.cfg`. */
  enabled: boolean;
  /** Position in `mods.cfg` (0 — first, loads before all). */
  loadIndex?: number;
  /** The same file exists elsewhere and the game will take that one (`mods/` wins over the Workshop). */
  shadowedBy?: string;
}

export interface InstalledMods {
  mods: InstalledMod[];
  /** `mods.cfg` lines that have no file. */
  missing: { fileName: string; loadIndex: number }[];
  /** `mods.cfg` order as is. */
  order: string[];
}

export function modsCfgPath(paths: GamePaths): string {
  return join(paths.kenshi, 'data', 'mods.cfg');
}

export function readModsCfgText(paths: GamePaths): ModsCfgText {
  const p = modsCfgPath(paths);
  return existsSync(p) ? parseModsCfg(readFileSync(p, 'utf-8')) : { names: [], eol: '\r\n' };
}

/** Workshop item number from a mod path: `<workshop>/<id>/X.mod` → id. */
export function workshopIdOf(paths: GamePaths, path: string): string | undefined {
  const dir = dirname(resolve(path));
  return resolve(dirname(dir)).toLowerCase() === resolve(paths.workshop).toLowerCase() ? basename(dir) : undefined;
}

/** All mods from `mods/` and the Workshop, with `mods.cfg` order. Mod files are not read. */
export function listInstalledMods(paths: GamePaths): InstalledMods {
  const order = readModsCfgText(paths).names;
  const rank = new Map<string, number>();
  order.forEach((n, i) => {
    if (!rank.has(n.toLowerCase())) rank.set(n.toLowerCase(), i);
  });
  const files = installedModFiles(paths);
  // Which file with this name the game/editor takes: the first found (`mods/` before the Workshop).
  const winner = new Map<string, string>();
  for (const f of files) {
    const k = basename(f.path).toLowerCase();
    if (!winner.has(k)) winner.set(k, f.path);
  }
  const mods = files.map((f): InstalledMod => {
    const fileName = basename(f.path);
    const k = fileName.toLowerCase();
    const idx = rank.get(k);
    const m: InstalledMod = { fileName, name: fileName.replace(/\.mod$/i, ''), path: f.path, source: f.source, enabled: idx !== undefined };
    if (idx !== undefined) m.loadIndex = idx;
    if (f.source === 'workshop') m.workshopId = basename(dirname(f.path));
    const w = winner.get(k)!;
    if (w !== f.path) m.shadowedBy = w;
    return m;
  });
  const missing = order.map((fileName, loadIndex) => ({ fileName, loadIndex })).filter((e) => !winner.has(e.fileName.toLowerCase()));
  return { mods, missing, order };
}

export interface ModSummary {
  version?: number;
  author?: string;
  description?: string;
  dependencies?: string[];
  references?: string[];
  recordCount?: number;
  size: number;
  mtimeMs: number;
  error?: string;
}

/** First `n` bytes of a file. */
function readHead(path: string, n: number): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** Mod header from the first kilobytes (if the description is long — from the whole file). */
export function readModSummary(path: string): ModSummary {
  const st = statSync(path);
  const out: ModSummary = { size: st.size, mtimeMs: st.mtimeMs };
  try {
    let parsed: ReturnType<typeof readModHeader>;
    try {
      parsed = readModHeader(readHead(path, Math.min(st.size, 64 * 1024)));
    } catch (e) {
      if (st.size <= 64 * 1024) throw e;
      parsed = readModHeader(readFileSync(path));
    }
    const { header, recordCount } = parsed;
    if (header) {
      out.version = header.version;
      out.author = decodeText(header.author);
      out.description = decodeText(header.description);
      out.dependencies = splitModList(header.dependencies);
      out.references = splitModList(header.references);
    }
    if (recordCount !== undefined) out.recordCount = recordCount;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

/** Game process names: while they run, `mods.cfg` must not be rewritten (the launcher would overwrite it). */
export const GAME_PROCESSES = ['kenshi_x64.exe', 'kenshi.exe'];

/** Running game processes (Windows, `tasklist`); empty on other systems. */
export function runningGameProcesses(): string[] {
  if (process.platform !== 'win32') return [];
  let text: string;
  try {
    text = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const name = /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase();
    if (name && GAME_PROCESSES.includes(name)) found.add(name);
  }
  return [...found];
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface WriteModsCfgResult {
  path: string;
  /** Copy of the previous file; none — there was no file. */
  backup?: string;
  changed: boolean;
}

/**
 * Write the load order. Line endings as in the previous file (no file — CRLF).
 * Before writing — a copy `mods.cfg.bak-YYYYMMDDhhmmss`. If the game is running — error
 * (the check can be disabled for tests: `checkGame: false` or `KEDIT_SKIP_GAME_CHECK=1`).
 */
export function writeModsCfg(paths: GamePaths, names: readonly string[], options: { checkGame?: boolean; now?: Date } = {}): WriteModsCfgResult {
  // KEDIT_SKIP_GAME_CHECK=1 — only for tests on a temporary copy of the game folder.
  if (options.checkGame ?? process.env['KEDIT_SKIP_GAME_CHECK'] !== '1') {
    const running = runningGameProcesses();
    if (running.length > 0) {
      const list = running.join(', ');
      throw new UiTextError({
        en: `Close the game and the launcher (${list}): otherwise they will overwrite mods.cfg`,
        ru: `Закройте игру и лаунчер (${list}): иначе они перезапишут mods.cfg`,
        zh: `请关闭游戏和启动器（${list}）：否则它们会覆盖 mods.cfg`,
      });
    }
  }
  const path = modsCfgPath(paths);
  const prev = existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
  const eol = prev !== undefined ? parseModsCfg(prev).eol : '\r\n';
  const text = formatModsCfg({ names: [...names], eol });
  if (prev === text) return { path, changed: false };
  let backup: string | undefined;
  if (prev !== undefined) {
    backup = `${path}.bak-${stamp(options.now ?? new Date())}`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, text, 'utf-8');
  return { path, ...(backup !== undefined ? { backup } : {}), changed: true };
}

/** Where a mod copy came from: the `<name>.kedit-origin.json` file next to the copy. */
export interface ModOrigin {
  /** Path of the original at copy time. */
  source: string;
  /** File name of the original. */
  sourceFileName: string;
  /** Workshop item number, if the original came from there. */
  workshopId?: string;
  author?: string;
  /** When copied (ISO). */
  copiedAt: string;
  size: number;
  /** SHA-256 of the original — to tell whether it has been updated since. */
  sha256: string;
}

export const ORIGIN_SUFFIX = '.kedit-origin.json';

export interface ModCopyPlan {
  source: string;
  /** Copy name without `.mod`. */
  name: string;
  /** `mods/<name>/<name>.mod`. */
  dest: string;
  originPath: string;
  origin: ModOrigin;
  /** A copy with the same name will shadow the original: the game takes the file from `mods/`. */
  shadowsOriginal: boolean;
  /** The original is in `mods.cfg` — a copy with the same name takes its place. */
  enabled: boolean;
  /** Why copying is impossible (the folder already exists, bad name…). */
  error?: string;
  /** The same reason in every interface language (`error` is its English text). */
  errorText?: UiText;
  /** Warnings for the user. */
  warnings: string[];
  /** The same warnings in every interface language (`warnings` are their English texts). */
  warningTexts: UiText[];
}

const BAD_NAME = /[<>:"/\\|?*]/;
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return true;
  return false;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What `copyModForEditing` would do (writes nothing). `name` — copy name, defaults to the original's. */
export function planModCopy(paths: GamePaths, source: string, options: { name?: string } = {}): ModCopyPlan {
  const src = resolve(source);
  const sourceFileName = basename(src);
  const name = (options.name ?? sourceFileName).trim().replace(/\.mod$/i, '');
  const dest = join(paths.kenshi, 'mods', name, `${name}.mod`);
  const originPath = join(dirname(dest), `${name}${ORIGIN_SUFFIX}`);
  const bytes = readFileSync(src);
  const workshopId = workshopIdOf(paths, src);
  const origin: ModOrigin = { source: src, sourceFileName, ...(workshopId !== undefined ? { workshopId } : {}), copiedAt: new Date().toISOString(), size: bytes.length, sha256: sha256(bytes) };
  try {
    const author = readModHeader(bytes).header?.author;
    if (author && author.length > 0) origin.author = decodeText(author);
  } catch {
    // The header could not be read — copy anyway, byte for byte.
  }
  const shadowsOriginal = `${name}.mod`.toLowerCase() === sourceFileName.toLowerCase();
  const enabled = readModsCfgText(paths).names.some((n) => n.toLowerCase() === sourceFileName.toLowerCase());
  const plan: ModCopyPlan = { source: src, name, dest, originPath, origin, shadowsOriginal, enabled, warnings: [], warningTexts: [] };
  const warn = (t: UiText): void => {
    plan.warnings.push(t.en);
    plan.warningTexts.push(t);
  };
  let why: UiText | undefined;
  if (name === '' || BAD_NAME.test(name) || hasControlChar(name) || name.endsWith('.') || name.endsWith(' ')) why = { en: `Bad mod name: “${name}”`, ru: `Плохое имя мода: «${name}»`, zh: `Mod 名称无效：“${name}”` };
  else if (resolve(dest).toLowerCase() === src.toLowerCase()) why = { en: 'This is the file in mods/ itself — nowhere to copy it; give the copy another name', ru: 'Это и есть файл в mods/ — копировать некуда; дайте копии другое имя', zh: '这就是 mods/ 中的文件本身——无处可复制；请给副本另起名称' };
  else if (existsSync(dirname(dest))) why = { en: `Folder ${dirname(dest)} already exists — choose another name or delete it yourself`, ru: `Папка ${dirname(dest)} уже есть — выберите другое имя или удалите её сами`, zh: `文件夹 ${dirname(dest)} 已存在——请换个名称或自行删除它` };
  if (why) {
    plan.error = why.en;
    plan.errorText = why;
  }
  if (shadowsOriginal) {
    warn(
      workshopId !== undefined
        ? {
            en: 'The copy has the same name and hides the workshop original: the game and the editor will use the file from mods/. Delete the copy folder to get the original back.',
            ru: 'Копия с тем же именем закроет оригинал из мастерской: игра и редактор возьмут файл из mods/. Чтобы вернуть оригинал, удалите папку копии.',
            zh: '副本与原文件同名并会遮盖创意工坊的原文件：游戏和编辑器将使用 mods/ 中的文件。删除副本文件夹即可恢复原文件。',
          }
        : { en: 'The copy has the same name and hides the original.', ru: 'Копия с тем же именем закроет оригинал.', zh: '副本与原文件同名并会遮盖原文件。' },
    );
  } else if (enabled) {
    warn({
      en: `The copy has another name: mods.cfg enables the original “${sourceFileName}”; enable the copy separately (and disable the original if the edits should replace it).`,
      ru: `Копия под другим именем: в mods.cfg включён оригинал «${sourceFileName}», копию надо включить отдельно (и выключить оригинал, если правки должны его заменить).`,
      zh: `副本使用了其他名称：mods.cfg 中启用的是原文件 “${sourceFileName}”，需要单独启用副本（如果修改应替换原文件，请禁用原文件）。`,
    });
  }
  if (workshopId !== undefined) {
    warn({
      en: "The author may update the mod; the copy stays as it is. Do not upload the copy to the workshop without the author's permission.",
      ru: 'Автор мода может его обновить — копия останется прежней. Не выкладывайте копию в мастерскую без разрешения автора.',
      zh: '作者可能会更新这个 Mod；副本保持不变。未经作者许可，请勿将副本上传到创意工坊。',
    });
  }
  return plan;
}

/**
 * Copy a mod for editing: byte for byte into `mods/<name>/<name>.mod` plus the origin file.
 * The original is only read. If the copy folder already exists — error (we overwrite nothing).
 */
export function copyModForEditing(paths: GamePaths, source: string, options: { name?: string } = {}): ModCopyPlan {
  const plan = planModCopy(paths, source, options);
  if (plan.error !== undefined) throw new UiTextError(plan.errorText ?? plan.error);
  const bytes = readFileSync(plan.source);
  if (sha256(bytes) !== plan.origin.sha256) throw new UiTextError({ en: `${plan.source} changed while copying`, ru: `${plan.source} изменился во время копирования`, zh: `${plan.source} 在复制过程中发生了变化` });
  mkdirSync(dirname(plan.dest), { recursive: true });
  writeFileSync(plan.dest, bytes, { flag: 'wx' });
  writeFileSync(plan.originPath, `${JSON.stringify(plan.origin, null, 2)}\n`, { flag: 'wx' });
  return plan;
}

/** Origin file of the copy next to the mod (`<name>.kedit-origin.json`), if any. */
export function readModOrigin(modPath: string): ModOrigin | undefined {
  const p = join(dirname(modPath), `${basename(modPath).replace(/\.mod$/i, '')}${ORIGIN_SUFFIX}`);
  if (!existsSync(p)) return undefined;
  try {
    const o = JSON.parse(readFileSync(p, 'utf8')) as Partial<ModOrigin>;
    return typeof o.source === 'string' && typeof o.sha256 === 'string' ? (o as ModOrigin) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the copy's original changed since copying: `undefined` — the original is gone. */
export function originChanged(origin: ModOrigin): boolean | undefined {
  if (!existsSync(origin.source)) return undefined;
  return sha256(readFileSync(origin.source)) !== origin.sha256;
}

export interface ModLayers {
  layers: ConflictLayer[];
  /** Mods that could not be read: name and error. */
  broken: { name: string; error: string }[];
}

export interface ModLayersOptions {
  /** Also disabled mods (after enabled ones, by name). */
  all?: boolean;
  /**
   * Own mod: takes its place in `mods.cfg` (instead of the installed file with the same name)
   * or, if it is not there, goes last. `records` — records as they are now (unsaved edits).
   */
  extra?: { name: string; path?: string; records?: readonly GameRecord[] };
  /** Reading a mod file (optionally cached); defaults to parsing the file from disk. */
  read?: (path: string) => DataFile;
}

/**
 * Layers for conflict search: `vanilla`, then mods. Without `all` — enabled mods in `mods.cfg`
 * order. Mods from `mods/` win over the same mods from the Workshop (as in the game).
 */
export function loadModLayers(paths: GamePaths, vanilla: readonly ConflictLayer[], options: ModLayersOptions = {}): ModLayers {
  const read = options.read ?? ((p: string) => readDataFile(readFileSync(p)));
  const { mods } = listInstalledMods(paths);
  const loaded = mods.filter((m) => !m.shadowedBy && (options.all || m.enabled));
  const rank = (m: InstalledMod): number => m.loadIndex ?? Number.MAX_SAFE_INTEGER;
  loaded.sort((a, b) => rank(a) - rank(b) || a.fileName.localeCompare(b.fileName));
  type Item = { name: string; path?: string; records?: readonly GameRecord[] };
  const items: Item[] = loaded.map((m) => ({ name: m.fileName, path: m.path }));
  const extra = options.extra;
  if (extra) {
    const i = items.findIndex((f) => f.name.toLowerCase() === extra.name.toLowerCase());
    const item: Item = { name: i >= 0 ? items[i]!.name : extra.name, ...(extra.path !== undefined ? { path: extra.path } : {}), ...(extra.records ? { records: extra.records } : {}) };
    if (i >= 0) items[i] = item;
    else items.push(item);
  }
  const layers: ConflictLayer[] = [...vanilla];
  const broken: ModLayers['broken'] = [];
  for (const it of items) {
    if (it.records) {
      layers.push({ name: it.name, file: { records: it.records } });
      continue;
    }
    try {
      layers.push({ name: it.name, file: read(it.path!) });
    } catch (e) {
      broken.push({ name: it.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { layers, broken };
}
