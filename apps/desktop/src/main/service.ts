/**
 * Файловая часть главного процесса без Electron: поиск игры, список модов, чтение всего,
 * что нужно окну для контекста, запись мода. Подтверждения и диалоги — в `index.ts`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { VANILLA_FILES } from '@kenshi-editor/core';
import {
  Heightmap,
  heightmapPath,
  detectGameInstalls,
  gamedataPoPath,
  copyModForEditing,
  isInGameFolders,
  isInWorkshop,
  isKenshiDir,
  listInstalledMods,
  listWorldFiles,
  manualInstall,
  detectLevelData,
  mergeStorePath,
  modsCfgPath,
  originChanged,
  planModCopy,
  planModLoad,
  readModOrigin,
  readIfUnknown,
  readModSummary,
  readModsCfgText,
  SCHEMA_FILES,
  translationFilePath,
  vanillaFilePaths,
  workshopIdOf,
  worldDirs,
  writeModsCfg,
  type ModCopyPlan,
} from '@kenshi-editor/core/node';
import type { GameInstallInfo, MergeSourceResult, ModEntry, ModOrderResult, ModProvenance, NamedBytes, ProjectBundle, ProjectRequest, WorldFileBytes, WorldRequest } from '../shared/api.ts';

export function detectGames(cwd?: string): GameInstallInfo[] {
  return detectGameInstalls(cwd).map((g) => ({ kenshi: g.kenshi, workshop: g.workshop, source: g.source }));
}

export function gameFromDir(dir: string): GameInstallInfo | undefined {
  if (!isKenshiDir(dir)) return undefined;
  const g = manualInstall(dir);
  return { kenshi: g.kenshi, workshop: g.workshop, source: 'manual' };
}

/** Мод с заголовком (читается только начало файла). */
export function describeMod(path: string, source: ModEntry['source'], extra: Partial<ModEntry> = {}): ModEntry {
  const entry: ModEntry = { fileName: basename(path), path, source, ...extra };
  const h = readModSummary(path);
  if (h.author !== undefined) entry.author = h.author;
  if (h.description !== undefined) entry.description = h.description;
  if (h.dependencies) entry.dependencies = h.dependencies;
  if (h.references) entry.references = h.references;
  if (h.recordCount !== undefined) entry.recordCount = h.recordCount;
  if (h.error !== undefined) entry.error = h.error;
  return entry;
}

/** Порядок загрузки как есть в `mods.cfg` (вместе со строками, для которых нет файла). */
export function readModOrder(game: GameInstallInfo): string[] {
  return readModsCfgText(game).names;
}

/**
 * Записать порядок загрузки (подтверждение спрашивает `index.ts`). `expected` — порядок,
 * который видело окно: если файл с тех пор поменяли (лаунчер, другая программа) — не писать.
 */
export function writeModOrder(game: GameInstallInfo, names: readonly string[], expected: readonly string[]): ModOrderResult {
  const now = readModOrder(game);
  if (now.join('\n').toLowerCase() !== expected.join('\n').toLowerCase()) {
    return { ok: false, cancelled: false, error: `${modsCfgPath(game)} changed on disk; refresh the list`, stale: true };
  }
  const r = writeModsCfg(game, names);
  return { ok: true, path: r.path, changed: r.changed, ...(r.backup !== undefined ? { backup: r.backup } : {}) };
}

/** Моды из `mods/` и мастерской с заголовками; порядок `mods.cfg` — в `loadIndex`. */
export function listMods(game: GameInstallInfo): ModEntry[] {
  return listInstalledMods(game).mods.map((m) =>
    describeMod(m.path, m.source, {
      enabled: m.enabled,
      ...(m.loadIndex !== undefined ? { loadIndex: m.loadIndex } : {}),
      ...(m.workshopId !== undefined ? { workshopId: m.workshopId } : {}),
      ...(m.shadowedBy !== undefined ? { shadowedBy: m.shadowedBy } : {}),
      ...copyOfEntry(m.source, m.path),
    }),
  );
}

function copyOfEntry(source: string, path: string): { copyOf?: string } {
  if (source !== 'mods') return {};
  const o = readModOrigin(path);
  return o ? { copyOf: o.workshopId ?? o.source } : {};
}

function readNamed(name: string, path: string): NamedBytes {
  return { name, path, bytes: readFileSync(path) };
}

/** Файл, который окно может держать в кэше: байты — только если окно его ещё не знает. */
function readCached(name: string, path: string, known: ReadonlySet<string>): NamedBytes {
  const { key, bytes } = readIfUnknown(path, known);
  return { name, path, key, bytes: bytes ?? new Uint8Array() };
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** Байты ванили, зависимостей и мода, тексты схемы и перевода — для контекста в окне. */
export function loadProject(req: ProjectRequest): ProjectBundle {
  const game = req.game;
  const plan = planModLoad(game, {
    ...(req.modPath !== undefined ? { modPath: req.modPath } : {}),
    ...(req.modName !== undefined ? { modName: req.modName } : {}),
    ...(req.dependencies ? { dependencies: req.dependencies } : {}),
    ...(req.contextMods ? { context: req.contextMods } : {}),
  });
  const known = new Set(req.known ?? []);
  const vanilla = vanillaFilePaths(game).map((p, i) => readCached(VANILLA_FILES[i]!, p, known));
  const fcsEnums = readOptional(join(game.kenshi, SCHEMA_FILES.fcsEnums));
  const fcsLayout = readOptional(join(game.kenshi, SCHEMA_FILES.fcsLayout));
  const po = readOptional(gamedataPoPath(game));
  const bundle: ProjectBundle = {
    game,
    modName: plan.modName,
    vanilla,
    dependencies: plan.dependencies.map((d) => readCached(d.name, d.path, known)),
    missingDependencies: plan.missingDependencies,
    ...(plan.context.length ? { contextMods: plan.context } : {}),
    schema: {
      fcsDef: readFileSync(join(game.kenshi, SCHEMA_FILES.fcsDef), 'utf8'),
      ...(fcsEnums !== undefined ? { fcsEnums } : {}),
      ...(fcsLayout !== undefined ? { fcsLayout } : {}),
    },
    suggestedPath: plan.modPath ?? join(game.kenshi, 'mods', plan.modName.replace(/\.mod$/i, ''), plan.modName),
  };
  if (plan.modPath !== undefined) {
    bundle.mod = readNamed(plan.modName, plan.modPath);
    const provenance = provenanceOf(game, plan.modPath);
    if (provenance) bundle.provenance = provenance;
    const mergeStore = readOptional(mergeStorePath(plan.modPath));
    if (mergeStore !== undefined) bundle.mergeStore = mergeStore;
  }
  if (po !== undefined) bundle.po = po;
  return bundle;
}

/** Откуда файл мода: из мастерской (сохранять нельзя) или копия чужого мода (`.kedit-origin.json`). */
export function provenanceOf(game: GameInstallInfo, path: string): ModProvenance | undefined {
  if (isInWorkshop(game, path)) {
    const id = workshopIdOf(game, path);
    return { inWorkshop: true, ...(id !== undefined ? { workshopId: id } : {}) };
  }
  const o = readModOrigin(path);
  if (!o) return undefined;
  const changed = originChanged(o);
  return {
    copyOf: {
      source: o.source,
      copiedAt: o.copiedAt,
      ...(o.workshopId !== undefined ? { workshopId: o.workshopId } : {}),
      ...(o.author !== undefined ? { author: o.author } : {}),
      ...(changed === undefined ? { gone: true } : changed ? { changed: true } : {}),
    },
  };
}

/** Путь в мастерской Steam: туда не пишем никогда. */
export function isWorkshopPath(games: readonly GameInstallInfo[], path: string): boolean {
  return games.some((g) => isInWorkshop(g, path));
}

/** План копии чужого мода (ничего не пишет). */
export function planCopy(game: GameInstallInfo, path: string): ModCopyPlan {
  return planModCopy(game, path);
}

/** Скопировать мод в `mods/<имя>/<имя>.mod` (после подтверждения в main). */
export function copyMod(game: GameInstallInfo, path: string): { path: string; provenance?: ModProvenance } {
  const plan = copyModForEditing(game, path);
  const provenance = provenanceOf(game, plan.dest);
  return { path: plan.dest, ...(provenance ? { provenance } : {}) };
}

/** Нужно ли подтверждение: путь в папке игры или мастерской. */
export function needsConfirmation(game: GameInstallInfo | undefined, path: string): boolean {
  return game !== undefined && isInGameFolders(game, path);
}

/**
 * Путь для окна «Сохранить как»: если папки ещё нет (новый мод, `mods/<имя>/`), Windows
 * открывает «Документы» — тогда предлагаем ближайшую существующую папку выше с тем же именем файла.
 */
export function saveDialogDefaultPath(path: string): string {
  let dir = dirname(path);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return basename(path);
    dir = up;
  }
  return join(dir, basename(path));
}

/**
 * Лаунчер видит мод только как `mods/<имя>/<имя>.mod`. Файл, сохранённый прямо в `mods/`,
 * кладём в свою папку: `mods/X.mod` → `mods/X/X.mod`. Остальные пути не меняются.
 */
export function modInstallPath(games: readonly GameInstallInfo[], path: string): string {
  const dir = resolve(dirname(path)).toLowerCase();
  for (const g of games) {
    if (resolve(g.kenshi, 'mods').toLowerCase() !== dir) continue;
    const name = basename(path).replace(/\.mod$/i, '');
    return join(dirname(path), name, `${name}.mod`);
  }
  return path;
}

export function writeMod(path: string, bytes: Uint8Array, mergeStore?: string, world: readonly { path: string; bytes: Uint8Array }[] = []): void {
  for (const f of world) if (!isLevelFileName(f.path)) throw new Error(`bad level file name: ${f.path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  if (mergeStore !== undefined) writeMergeStoreText(path, mergeStore);
  if (world.length === 0) return;
  const dir = join(dirname(path), 'leveldata');
  mkdirSync(dir, { recursive: true });
  for (const f of world) {
    // Сначала во временный файл, потом на место: игра не увидит половину файла.
    const target = join(dir, f.path);
    writeFileSync(`${target}.tmp`, f.bytes);
    renameSync(`${target}.tmp`, target);
  }
}

/** Имя файла уровня без папок: `zone.42.22.zone`, `leveldata.level`, `interiors.level`. */
export function isLevelFileName(name: string): boolean {
  return /^(zone\.-?\d+\.-?\d+\.zone|leveldata\.level|interiors\.level)$/i.test(name);
}

/** Файл решений слияния рядом с модом (сначала во временный файл, потом на место). */
function writeMergeStoreText(modPath: string, text: string): void {
  const p = mergeStorePath(modPath);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, p);
}

/** Мод-источник слияния: только `.mod` / `.base`, только чтение; рядом — данные уровня (если есть). */
export function readMergeSourceBytes(path: string): MergeSourceResult {
  if (!/\.(mod|base)$/i.test(path)) return { ok: false, error: 'not a .mod / .base file' };
  try {
    const bytes = readFileSync(path);
    const levelData = detectLevelData(path);
    return { ok: true, name: basename(path), path, bytes, ...(levelData ? { levelData } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Файлы уровня ванили и модов, сырыми байтами (разбирает окно). */
export function loadWorldBytes(req: WorldRequest): WorldFileBytes[] {
  const known = new Set(req.known ?? []);
  // С `interiors` — только `interiors.level` (дочитываются по запросу панели «Внутри»).
  const only = req.interiors === true;
  return listWorldFiles(worldDirs(req.game, req.modPaths), { interiors: only }).filter((f) => (f.path.toLowerCase() === 'interiors.level') === only).map((f) => {
    const { key, bytes } = readIfUnknown(f.full, known);
    return { layer: f.layer, path: f.path, key, bytes: bytes ?? new Uint8Array() };
  });
}

const ICON_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/**
 * Иконка по полю `icon` (`.\data\items\icons\katana.png`, относительно папки игры) как
 * data URL. Только картинки внутри папки игры; иначе null.
 */
export function readIconDataUrl(game: GameInstallInfo, iconPath: string): string | null {
  const mime = ICON_TYPES[extname(iconPath).toLowerCase()];
  if (!mime) return null;
  const full = resolve(game.kenshi, iconPath.replace(/\\/g, '/'));
  const rel = relative(resolve(game.kenshi), full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (!existsSync(full)) return null;
  return `data:${mime};base64,${readFileSync(full).toString('base64')}`;
}

const ASSET_TYPES = new Set(['.mesh', '.dds', '.png', '.material', '.skeleton']);
/** Больше этого — не модель и не текстура игры. */
const MAX_ASSET = 256 * 1024 * 1024;

/**
 * Файл модели или текстуры по пути из записи (`.\data\items\a.mesh`). Пути в записях модов
 * тоже идут от папки игры (`.\mods\<мод>\…`); не нашёлся — пробуем тот же путь от папки
 * мастерской. Только чтение, только внутри этих двух папок.
 */
export function readGameAsset(game: GameInstallInfo, relPath: string): Uint8Array | null {
  if (!ASSET_TYPES.has(extname(relPath).toLowerCase())) return null;
  const rel = relPath.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  for (const root of [game.kenshi, game.workshop]) {
    if (!root) continue;
    const full = resolve(root, rel);
    const inside = relative(resolve(root), full);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue;
    try {
      if (existsSync(full) && statSync(full).size <= MAX_ASSET) return readFileSync(full);
    } catch {
      // нет доступа — как нет файла
    }
  }
  return null;
}

const heightmaps = new Map<string, Promise<Heightmap | null>>();

/** Тайл рельефа из `data/newland/land/fullmap.tif` (файл открыт один раз, читается кусками). */
export async function readTerrainTile(game: GameInstallInfo, level: number, tx: number, ty: number): Promise<Uint16Array | null> {
  const path = heightmapPath(game.kenshi);
  let hm = heightmaps.get(path);
  if (!hm) {
    hm = existsSync(path) ? Heightmap.open(path) : Promise.resolve(null);
    hm.catch(() => heightmaps.delete(path));
    heightmaps.set(path, hm);
  }
  const map = await hm;
  return map ? map.readTile(level, tx, ty) : null;
}

/** Перевод текстов записей (реплик) игры; null — файла нет. */
export function readTranslationBytes(game: GameInstallInfo): Uint8Array | null {
  const path = translationFilePath(game);
  return existsSync(path) ? readFileSync(path) : null;
}
