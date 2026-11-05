/**
 * Установленные моды: `Kenshi/mods/<имя>/`, мастерская `workshop/content/233860/<id>/` и
 * порядок загрузки `data/mods.cfg`. Список строится без чтения модов целиком: только имена
 * файлов и `mods.cfg`; заголовок (автор, зависимости, число записей) — `readModSummary`,
 * по первым килобайтам файла.
 *
 * `mods.cfg` пишет только `writeModsCfg`: конец строки как был (CRLF по умолчанию), копия
 * рядом перед записью. `__mods.list` (его ведёт лаунчер) не трогается.
 *
 * Чужой мод (из мастерской) правят только в копии: `copyModForEditing` кладёт его байт в байт
 * в `mods/<имя>/<имя>.mod` и рядом `<имя>.kedit-origin.json` — откуда копия (путь, номер
 * мастерской, дата, SHA-256 оригинала). Оригинал не меняется никогда.
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

export type ModSource = 'mods' | 'workshop';

export interface InstalledMod {
  /** Имя файла: `Мой мод.mod`. */
  fileName: string;
  /** Имя без `.mod`. */
  name: string;
  path: string;
  source: ModSource;
  /** Номер предмета мастерской (имя папки), для `source: 'workshop'`. */
  workshopId?: string;
  /** Есть в `mods.cfg`. */
  enabled: boolean;
  /** Место в `mods.cfg` (0 — первый, грузится раньше всех). */
  loadIndex?: number;
  /** Такой же файл есть в другом месте и игра возьмёт его (`mods/` важнее мастерской). */
  shadowedBy?: string;
}

export interface InstalledMods {
  mods: InstalledMod[];
  /** Строки `mods.cfg`, для которых файла нет. */
  missing: { fileName: string; loadIndex: number }[];
  /** Порядок `mods.cfg` как есть. */
  order: string[];
}

export function modsCfgPath(paths: GamePaths): string {
  return join(paths.kenshi, 'data', 'mods.cfg');
}

export function readModsCfgText(paths: GamePaths): ModsCfgText {
  const p = modsCfgPath(paths);
  return existsSync(p) ? parseModsCfg(readFileSync(p, 'utf-8')) : { names: [], eol: '\r\n' };
}

/** Номер предмета мастерской по пути мода: `<workshop>/<id>/X.mod` → id. */
export function workshopIdOf(paths: GamePaths, path: string): string | undefined {
  const dir = dirname(resolve(path));
  return resolve(dirname(dir)).toLowerCase() === resolve(paths.workshop).toLowerCase() ? basename(dir) : undefined;
}

/** Все моды из `mods/` и мастерской, с порядком `mods.cfg`. Файлы модов не читаются. */
export function listInstalledMods(paths: GamePaths): InstalledMods {
  const order = readModsCfgText(paths).names;
  const rank = new Map<string, number>();
  order.forEach((n, i) => {
    if (!rank.has(n.toLowerCase())) rank.set(n.toLowerCase(), i);
  });
  const files = installedModFiles(paths);
  // Какой файл с этим именем возьмёт игра/редактор: первый найденный (`mods/` раньше мастерской).
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

/** Первые `n` байт файла. */
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

/** Заголовок мода по первым килобайтам (если описание длинное — по всему файлу). */
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

/** Имена процессов игры: пока они работают, `mods.cfg` переписывать нельзя (лаунчер перезапишет). */
export const GAME_PROCESSES = ['kenshi_x64.exe', 'kenshi.exe'];

/** Запущенные процессы игры (Windows, `tasklist`); на других системах — пусто. */
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
  /** Копия прежнего файла; нет — файла не было. */
  backup?: string;
  changed: boolean;
}

/**
 * Записать порядок загрузки. Конец строки — как в прежнем файле (нет файла — CRLF).
 * Перед записью — копия `mods.cfg.bak-ГГГГММДДччммсс`. Если игра запущена — ошибка
 * (проверку можно выключить для тестов: `checkGame: false` или `KEDIT_SKIP_GAME_CHECK=1`).
 */
export function writeModsCfg(paths: GamePaths, names: readonly string[], options: { checkGame?: boolean; now?: Date } = {}): WriteModsCfgResult {
  // KEDIT_SKIP_GAME_CHECK=1 — только для тестов на временной копии папки игры.
  if (options.checkGame ?? process.env['KEDIT_SKIP_GAME_CHECK'] !== '1') {
    const running = runningGameProcesses();
    if (running.length > 0) throw new Error(`Закройте игру и лаунчер (${running.join(', ')}): иначе они перезапишут mods.cfg`);
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

/** Откуда взята копия мода: файл `<имя>.kedit-origin.json` рядом с копией. */
export interface ModOrigin {
  /** Путь оригинала на момент копирования. */
  source: string;
  /** Имя файла оригинала. */
  sourceFileName: string;
  /** Номер предмета мастерской, если оригинал оттуда. */
  workshopId?: string;
  author?: string;
  /** Когда скопирован (ISO). */
  copiedAt: string;
  size: number;
  /** SHA-256 оригинала — понять, обновился ли он с тех пор. */
  sha256: string;
}

export const ORIGIN_SUFFIX = '.kedit-origin.json';

export interface ModCopyPlan {
  source: string;
  /** Имя копии без `.mod`. */
  name: string;
  /** `mods/<имя>/<имя>.mod`. */
  dest: string;
  originPath: string;
  origin: ModOrigin;
  /** Копия с тем же именем закроет оригинал: игра возьмёт файл из `mods/`. */
  shadowsOriginal: boolean;
  /** Оригинал в `mods.cfg` — копия с тем же именем встанет на его место. */
  enabled: boolean;
  /** Почему копировать нельзя (папка уже есть, плохое имя…). */
  error?: string;
  /** Предупреждения для пользователя. */
  warnings: string[];
}

const BAD_NAME = /[<>:"/\\|?*]/;
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return true;
  return false;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Что сделает `copyModForEditing` (ничего не пишет). `name` — имя копии, по умолчанию как у оригинала. */
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
    // Заголовок не прочитался — копируем всё равно, байт в байт.
  }
  const shadowsOriginal = `${name}.mod`.toLowerCase() === sourceFileName.toLowerCase();
  const enabled = readModsCfgText(paths).names.some((n) => n.toLowerCase() === sourceFileName.toLowerCase());
  const plan: ModCopyPlan = { source: src, name, dest, originPath, origin, shadowsOriginal, enabled, warnings: [] };
  if (name === '' || BAD_NAME.test(name) || hasControlChar(name) || name.endsWith('.') || name.endsWith(' ')) plan.error = `Плохое имя мода: «${name}»`;
  else if (resolve(dest).toLowerCase() === src.toLowerCase()) plan.error = 'Это и есть файл в mods/ — копировать некуда; дайте копии другое имя';
  else if (existsSync(dirname(dest))) plan.error = `Папка ${dirname(dest)} уже есть — выберите другое имя или удалите её сами`;
  if (shadowsOriginal) {
    plan.warnings.push(
      workshopId !== undefined
        ? 'Копия с тем же именем закроет оригинал из мастерской: игра и редактор возьмут файл из mods/. Чтобы вернуть оригинал, удалите папку копии.'
        : 'Копия с тем же именем закроет оригинал.',
    );
  } else if (enabled) {
    plan.warnings.push(`Копия под другим именем: в mods.cfg включён оригинал «${sourceFileName}», копию надо включить отдельно (и выключить оригинал, если правки должны его заменить).`);
  }
  if (workshopId !== undefined) plan.warnings.push('Автор мода может его обновить — копия останется прежней. Не выкладывайте копию в мастерскую без разрешения автора.');
  return plan;
}

/**
 * Скопировать мод для правки: байт в байт в `mods/<имя>/<имя>.mod` плюс файл происхождения.
 * Оригинал только читается. Если папка копии уже есть — ошибка (ничего не перезаписываем).
 */
export function copyModForEditing(paths: GamePaths, source: string, options: { name?: string } = {}): ModCopyPlan {
  const plan = planModCopy(paths, source, options);
  if (plan.error !== undefined) throw new Error(plan.error);
  const bytes = readFileSync(plan.source);
  if (sha256(bytes) !== plan.origin.sha256) throw new Error(`${plan.source} изменился во время копирования`);
  mkdirSync(dirname(plan.dest), { recursive: true });
  writeFileSync(plan.dest, bytes, { flag: 'wx' });
  writeFileSync(plan.originPath, `${JSON.stringify(plan.origin, null, 2)}\n`, { flag: 'wx' });
  return plan;
}

/** Файл происхождения копии рядом с модом (`<имя>.kedit-origin.json`), если есть. */
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

/** Изменился ли оригинал копии с момента копирования: `undefined` — оригинала больше нет. */
export function originChanged(origin: ModOrigin): boolean | undefined {
  if (!existsSync(origin.source)) return undefined;
  return sha256(readFileSync(origin.source)) !== origin.sha256;
}

export interface ModLayers {
  layers: ConflictLayer[];
  /** Моды, которые не удалось прочитать: имя и ошибка. */
  broken: { name: string; error: string }[];
}

export interface ModLayersOptions {
  /** Ещё и выключенные моды (после включённых, по имени). */
  all?: boolean;
  /**
   * Свой мод: встаёт на своё место в `mods.cfg` (вместо установленного файла с тем же именем)
   * или, если его там нет, последним. `records` — записи как есть сейчас (несохранённые правки).
   */
  extra?: { name: string; path?: string; records?: readonly GameRecord[] };
  /** Чтение файла мода (можно с кэшем); по умолчанию — разбор файла с диска. */
  read?: (path: string) => DataFile;
}

/**
 * Слои для поиска конфликтов: `vanilla`, затем моды. Без `all` — включённые по порядку
 * `mods.cfg`. Моды из `mods/` важнее таких же из мастерской (как в игре).
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
