/**
 * File side of the main process without Electron: game lookup, mod list, reading everything
 * the window needs for its context, writing the mod. Confirmations and dialogs — in `index.ts`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { VANILLA_FILES } from '@kenshi-editor/core';
import {
  Heightmap,
  heightmapPath,
  detectGameInstalls,
  gamedataPoPath,
  listGameLocales,
  copyModForEditing,
  isInGameFolders,
  isInWorkshop,
  isKenshiDir,
  listInstalledMods,
  listWorldFiles,
  manualInstall,
  detectLevelData,
  extensionsFor,
  mergeStorePath,
  modsCfgPath,
  originChanged,
  planModCopy,
  planModLoad,
  readModOrigin,
  readIfUnknown,
  readModSummary,
  readExtensionLayers,
  safeSaveMod,
  readModsCfgText,
  SCHEMA_FILES,
  translationFilePath,
  vanillaFilePaths,
  workshopIdOf,
  worldDirs,
  writeModsCfg,
  type ModCopyPlan,
  type SafeSaveResult,
} from '@kenshi-editor/core/node';
import type { GameInstallInfo, GameLocaleInfo, MergeSourceResult, ModEntry, ModOrderResult, ModProvenance, NamedBytes, ProjectBundle, ProjectRequest, WorldFileBytes, WorldRequest } from '../shared/api.ts';

export function detectGames(cwd?: string): GameInstallInfo[] {
  return detectGameInstalls(cwd).map((g) => ({ kenshi: g.kenshi, workshop: g.workshop, source: g.source }));
}

export function gameFromDir(dir: string): GameInstallInfo | undefined {
  if (!isKenshiDir(dir)) return undefined;
  const g = manualInstall(dir);
  return { kenshi: g.kenshi, workshop: g.workshop, source: 'manual' };
}

/** Mod with header (only the start of the file is read). */
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

/** Load order as it is in `mods.cfg` (including lines that have no file). */
export function readModOrder(game: GameInstallInfo): string[] {
  return readModsCfgText(game).names;
}

/**
 * Write the load order (`index.ts` asks for confirmation). `expected` — the order the
 * window saw: if the file has changed since (launcher, another program) — do not write.
 */
export function writeModOrder(game: GameInstallInfo, names: readonly string[], expected: readonly string[]): ModOrderResult {
  const now = readModOrder(game);
  if (now.join('\n').toLowerCase() !== expected.join('\n').toLowerCase()) {
    return { ok: false, cancelled: false, error: `${modsCfgPath(game)} changed on disk; refresh the list`, stale: true };
  }
  const r = writeModsCfg(game, names);
  return { ok: true, path: r.path, changed: r.changed, ...(r.backup !== undefined ? { backup: r.backup } : {}) };
}

/** Mods from `mods/` and the Workshop with headers; `mods.cfg` order — in `loadIndex`. */
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

/** A file the window may keep cached: bytes only if the window does not know it yet. */
function readCached(name: string, path: string, known: ReadonlySet<string>): NamedBytes {
  const { key, bytes } = readIfUnknown(path, known);
  return { name, path, key, bytes: bytes ?? new Uint8Array() };
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** Bytes of vanilla, dependencies and the mod, schema and translation texts — for the window context. */
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
  const po = req.dataLocale !== undefined ? readOptional(gamedataPoPath(game, req.dataLocale)) : undefined;
  // Schema extensions of the mod folder and of the folders of its dependencies, the same set
  // the MCP session takes for a mod opened in the window. The folder counts even when the mod
  // file itself comes from the window (`extensionsOf`) or does not exist yet.
  const modFile = req.modPath ?? req.extensionsOf;
  const extensions = extensionsFor(game, [...(modFile !== undefined ? [modFile] : []), ...plan.dependencies.map((d) => d.path)]);
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
    ...(extensions.length ? { extensions: readExtensionLayers(extensions) } : {}),
    suggestedPath: plan.modPath ?? join(game.kenshi, 'mods', plan.modName.replace(/\.mod$/i, ''), plan.modName),
  };
  if (plan.modPath !== undefined) {
    bundle.mod = readNamed(plan.modName, plan.modPath);
    const provenance = provenanceOf(game, plan.modPath);
    if (provenance) bundle.provenance = provenance;
    const mergeStore = readOptional(mergeStorePath(plan.modPath));
    if (mergeStore !== undefined) bundle.mergeStore = mergeStore;
  }
  if (po !== undefined) {
    bundle.po = po;
    bundle.dataLocale = req.dataLocale!;
  }
  return bundle;
}

/** Where the mod file comes from: the Workshop (cannot be saved) or a copy of someone else's mod (`.kedit-origin.json`). */
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

/** Path in the Steam Workshop: never written to. */
export function isWorkshopPath(games: readonly GameInstallInfo[], path: string): boolean {
  return games.some((g) => isInWorkshop(g, path));
}

/** Plan for copying someone else's mod (writes nothing). */
export function planCopy(game: GameInstallInfo, path: string): ModCopyPlan {
  return planModCopy(game, path);
}

/** Copy the mod to `mods/<name>/<name>.mod` (after confirmation in main). */
export function copyMod(game: GameInstallInfo, path: string): { path: string; provenance?: ModProvenance } {
  const plan = copyModForEditing(game, path);
  const provenance = provenanceOf(game, plan.dest);
  return { path: plan.dest, ...(provenance ? { provenance } : {}) };
}

/** Whether confirmation is needed: path in the game folder or the Workshop. */
export function needsConfirmation(game: GameInstallInfo | undefined, path: string): boolean {
  return game !== undefined && isInGameFolders(game, path);
}

/**
 * Path for the «Save as» dialog: if the folder does not exist yet (new mod, `mods/<name>/`), Windows
 * opens «Documents» — so we suggest the nearest existing folder above, with the same file name.
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
 * The launcher sees a mod only as `mods/<name>/<name>.mod`. A file saved directly into `mods/`
 * goes into its own folder: `mods/X.mod` → `mods/X/X.mod`. Other paths are unchanged.
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

/**
 * Write the mod safely (`safeSaveMod`: temp file → check → copy of the previous version into the
 * data folder → replace), then the merge file and level files.
 */
export function writeMod(
  path: string,
  bytes: Uint8Array,
  mergeStore: string | undefined,
  world: readonly { path: string; bytes: Uint8Array }[],
  backups: { dataDir: string; keep: number },
): SafeSaveResult {
  for (const f of world) if (!isLevelFileName(f.path)) throw new Error(`bad level file name: ${f.path}`);
  mkdirSync(dirname(path), { recursive: true });
  const saved = safeSaveMod(path, bytes, backups);
  if (mergeStore !== undefined) writeMergeStoreText(path, mergeStore);
  if (world.length === 0) return saved;
  const dir = join(dirname(path), 'leveldata');
  mkdirSync(dir, { recursive: true });
  for (const f of world) {
    // Temp file first, then into place: the game never sees half a file.
    const target = join(dir, f.path);
    writeFileSync(`${target}.tmp`, f.bytes);
    renameSync(`${target}.tmp`, target);
  }
  return saved;
}

/** Level file name without folders: `zone.42.22.zone`, `leveldata.level`, `interiors.level`. */
export function isLevelFileName(name: string): boolean {
  return /^(zone\.-?\d+\.-?\d+\.zone|leveldata\.level|interiors\.level)$/i.test(name);
}

/** Merge decisions file next to the mod (temp file first, then into place). */
function writeMergeStoreText(modPath: string, text: string): void {
  const p = mergeStorePath(modPath);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, p);
}

/** Merge source mod: only `.mod` / `.base`, read only; level data next to it (if any). */
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

/** Level files of vanilla and mods, as raw bytes (the window parses them). */
export function loadWorldBytes(req: WorldRequest): WorldFileBytes[] {
  const known = new Set(req.known ?? []);
  // With `interiors` — only `interiors.level` (loaded on demand by the «Inside» panel).
  const only = req.interiors === true;
  return listWorldFiles(worldDirs(req.game, req.modPaths), { interiors: only }).filter((f) => (f.path.toLowerCase() === 'interiors.level') === only).map((f) => {
    const { key, bytes } = readIfUnknown(f.full, known);
    return { layer: f.layer, path: f.path, key, bytes: bytes ?? new Uint8Array() };
  });
}

const ICON_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/**
 * Icon from the `icon` field (`.\data\items\icons\katana.png`, relative to the game folder) as
 * a data URL. Only images inside the game folder; otherwise null.
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

// `.dat` — map features (`data/newland/land/features.dat`).
const ASSET_TYPES = new Set(['.mesh', '.dds', '.png', '.material', '.skeleton', '.dat']);
/** Larger than this — not a game model or texture. */
const MAX_ASSET = 256 * 1024 * 1024;

/**
 * Model or texture file by the path from a record (`.\data\items\a.mesh`). Paths in mod records
 * also start from the game folder (`.\mods\<mod>\…`); if not found — try the same path from the
 * Workshop folder. Read only, only inside these two folders.
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
      // no access — same as no file
    }
  }
  // The game (Ogre) finds resources by file name, so records with a stale folder still work
  // there (`land/textures/RobotArm_DIF.dds` really lives in `Assets/Textures`). Same here.
  const byName = assetIndex(game.kenshi).get(basename(rel).toLowerCase());
  if (byName) {
    try {
      if (statSync(byName).size <= MAX_ASSET) return readFileSync(byName);
    } catch {
      // gone since the index was built
    }
  }
  return null;
}

const assetIndexes = new Map<string, Map<string, string>>();

/** File name → full path for every model and texture under the game's `data` (built once). */
function assetIndex(root: string): Map<string, string> {
  const known = assetIndexes.get(root);
  if (known) return known;
  const index = new Map<string, string>();
  assetIndexes.set(root, index);
  const walk = (dir: string): void => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(dds|mesh|png)$/i.test(e.name) && !index.has(e.name.toLowerCase())) index.set(e.name.toLowerCase(), full);
    }
  };
  walk(join(root, 'data'));
  return index;
}

const heightmaps = new Map<string, Promise<Heightmap | null>>();

/** Terrain tile from `data/newland/land/fullmap.tif` (the file is opened once and read in chunks). */
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

/** Translation of game record texts (lines); null — no file. */
export function readTranslationBytes(game: GameInstallInfo, locale: string): Uint8Array | null {
  const path = translationFilePath(game, locale);
  return existsSync(path) ? readFileSync(path) : null;
}

/** `gamedata.po` of a game locale; null — no file. */
export function readGamedataPoText(game: GameInstallInfo, locale: string): string | null {
  return readOptional(gamedataPoPath(game, locale)) ?? null;
}

/** Translation folders of the game. */
export function listLocales(game: GameInstallInfo): GameLocaleInfo[] {
  return listGameLocales(game);
}
