/**
 * Установленные моды: `Kenshi/mods/<имя>/`, мастерская `workshop/content/233860/<id>/` и
 * порядок загрузки `data/mods.cfg`. Список строится без чтения модов целиком: только имена
 * файлов и `mods.cfg`; заголовок (автор, зависимости, число записей) — `readModSummary`,
 * по первым килобайтам файла.
 *
 * `mods.cfg` пишет только `writeModsCfg`: конец строки как был (CRLF по умолчанию), копия
 * рядом перед записью. `__mods.list` (его ведёт лаунчер) не трогается.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
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
 * (проверку можно выключить для тестов: `checkGame: false`).
 */
export function writeModsCfg(paths: GamePaths, names: readonly string[], options: { checkGame?: boolean; now?: Date } = {}): WriteModsCfgResult {
  if (options.checkGame !== false) {
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
