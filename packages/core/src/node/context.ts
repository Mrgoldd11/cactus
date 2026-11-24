/**
 * Loading the editing context from disk: vanilla in order, the mod's dependencies (from the game's `mods/`
 * and the Workshop, in `data/mods.cfg` order), then the mod itself. Saving the mod to a file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { readDataFile } from '../format/read.ts';
import { writeDataFile } from '../format/write.ts';
import { splitModList } from '../format/helpers.ts';
import type { DataFile } from '../format/types.ts';
import { ModContext, type Layer } from '../model/context.ts';
import type { PoFile } from '../locale/po.ts';
import type { GameSchema } from '../schema/game-schema.ts';
import { assertReadable, writeFileAtomic } from './backup.ts';
import { extensionsFor, type ExtensionChoice, type FoundExtension } from './extensions.ts';
import { installedModFiles, VANILLA_FILES, vanillaFilePaths, type GamePaths } from './paths.ts';
import { gamedataPoPath, loadGamedataPo, loadGameSchema } from './schema.ts';
import { resolveDataLocale } from './locales.ts';

export interface LoadContextOptions {
  paths: GamePaths;
  /** Path to the edited .mod. If the file does not exist, a new mod with this name is created. */
  modPath?: string;
  /** Name of the new mod if `modPath` is not set (default `new.mod`). */
  modName?: string;
  /**
   * Dependencies (.mod names) to load as lower layers. Defaults to the dependencies and
   * references from the mod header. Vanilla names are skipped: vanilla is always loaded.
   */
  dependencies?: readonly string[];
  /**
   * Other mods for the context (.mod names): loaded as layers at their places per `mods.cfg`,
   * but not written to the mod header. This shows how the mod sits on top of other mods.
   */
  context?: readonly string[];
  /** Load the FCS schema (yes by default, if fcs.def exists) or take an already read one. */
  schema?: boolean | GameSchema;
  /**
   * Schema extensions (FCS Extended files in mod folders) to add to the schema read from disk.
   * Default: those of the mod and of the mods loaded under it; a choice changes the set, `false`
   * turns extensions off. Not used when `schema` is `false` or a ready schema.
   */
  extensions?: ExtensionChoice | false;
  /**
   * Load `gamedata.po` of the data language for names and search (default: yes, if the file
   * exists) or take one already read.
   */
  po?: boolean | PoFile;
  /** Data language: a locale code or `none`; default — the language of the game's `settings.cfg`. */
  dataLocale?: string;
  /** Already read vanilla layers (so they are not read again). */
  vanilla?: readonly Layer[];
}

export interface LoadedContext {
  ctx: ModContext;
  /** Dependencies found neither in `mods/` nor in the Workshop. */
  missingDependencies: string[];
  /** Paths of loaded dependencies, in order. */
  dependencyPaths: string[];
  /** Context mods that were found (not dependencies). */
  context: string[];
  /** Schema extensions found for the mod, in load order; their def files are in `ctx.schema`. */
  extensions: FoundExtension[];
}

export function loadVanillaLayers(paths: GamePaths): Layer[] {
  return vanillaFilePaths(paths).map((p, i) => ({ name: VANILLA_FILES[i]!, file: readDataFile(readFileSync(p)) }));
}

/** Load order of the player's mods from `data/mods.cfg` (.mod file names). */
export function readModsCfg(paths: GamePaths): string[] {
  const p = join(paths.kenshi, 'data', 'mods.cfg');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Find a .mod by file name: `mods/` first, then the Workshop. */
export function findInstalledMod(paths: GamePaths, fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  return installedModFiles(paths).find((m) => basename(m.path).toLowerCase() === lower)?.path;
}

export interface ModLoadPlan {
  modName: string;
  /** Existing mod file (if any). */
  modPath?: string;
  mod?: DataFile;
  /** Dependencies that were found, in load order (`mods.cfg`). */
  dependencies: { name: string; path: string }[];
  /** Dependencies found neither in `mods/` nor in the Workshop. */
  missingDependencies: string[];
  /**
   * Context mods (`options.context`) that were found and are not dependencies: they sit
   * among `dependencies` at their places per `mods.cfg` and do not go into the mod header.
   */
  context: string[];
}

/**
 * What to load: the mod file (if any), its dependencies in `mods.cfg` order, the missing ones.
 * Vanilla names and the mod itself are removed from the dependencies.
 */
export function planModLoad(
  paths: GamePaths,
  options: { modPath?: string; modName?: string; dependencies?: readonly string[]; context?: readonly string[] },
): ModLoadPlan {
  let mod: DataFile | undefined;
  let modName = options.modName ?? 'new.mod';
  let modPath: string | undefined;
  if (options.modPath) {
    modName = basename(options.modPath);
    if (existsSync(options.modPath)) {
      mod = readDataFile(readFileSync(options.modPath));
      modPath = options.modPath;
    }
  }
  const vanillaNames = new Set<string>(VANILLA_FILES.map((f) => f.toLowerCase()));
  const requested =
    options.dependencies ?? (mod?.header ? [...splitModList(mod.header.dependencies), ...splitModList(mod.header.references)] : []);
  const keep = (d: string): boolean => !vanillaNames.has(d.toLowerCase()) && d.toLowerCase() !== modName.toLowerCase();
  const requestedLower = new Set(requested.map((d) => d.toLowerCase()));
  const contextOnly = (options.context ?? []).filter((d) => keep(d) && !requestedLower.has(d.toLowerCase()));
  const seen = new Set<string>();
  const unique = [...requested.filter(keep), ...contextOnly].filter((d) => {
    const k = d.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const contextLower = new Set(contextOnly.map((d) => d.toLowerCase()));
  const cfg = readModsCfg(paths).map((s) => s.toLowerCase());
  const rank = (n: string): number => {
    const i = cfg.indexOf(n.toLowerCase());
    return i < 0 ? cfg.length : i;
  };
  unique.sort((a, b) => rank(a) - rank(b));
  const dependencies: { name: string; path: string }[] = [];
  const missingDependencies: string[] = [];
  const context: string[] = [];
  for (const dep of unique) {
    const p = findInstalledMod(paths, dep);
    if (p) {
      dependencies.push({ name: dep, path: p });
      if (contextLower.has(dep.toLowerCase())) context.push(dep);
    } else if (!contextLower.has(dep.toLowerCase())) missingDependencies.push(dep);
  }
  return { modName, ...(modPath !== undefined ? { modPath } : {}), ...(mod ? { mod } : {}), dependencies, missingDependencies, context };
}

export function loadModContext(options: LoadContextOptions): LoadedContext {
  const { paths } = options;
  const vanilla = options.vanilla ?? loadVanillaLayers(paths);
  const plan = planModLoad(paths, {
    ...(options.modPath !== undefined ? { modPath: options.modPath } : {}),
    ...(options.modName !== undefined ? { modName: options.modName } : {}),
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
  const layers: Layer[] = [...vanilla];
  for (const dep of plan.dependencies) layers.push({ name: dep.name, file: readDataFile(readFileSync(dep.path)) });
  const wantSchema = options.schema ?? existsSync(join(paths.kenshi, 'fcs.def'));
  const dataLocale = typeof options.po === 'object' ? options.dataLocale : resolveDataLocale(paths, options.dataLocale);
  const wantPo = options.po ?? (dataLocale !== undefined && existsSync(gamedataPoPath(paths, dataLocale)));
  const dependencyPaths = plan.dependencies.map((d) => d.path);
  let schema: GameSchema | undefined;
  let extensions: FoundExtension[] = [];
  if (typeof wantSchema === 'object') schema = wantSchema;
  else if (wantSchema) {
    if (options.extensions !== false) {
      // The folder of the mod counts even before the mod file exists: a new mod may be started
      // in a folder that already has its fcs.def.
      const modFiles = [...(options.modPath !== undefined ? [options.modPath] : []), ...dependencyPaths];
      extensions = extensionsFor(paths, modFiles, options.extensions);
    }
    schema = loadGameSchema(paths, { extensions });
  }
  const ctx = new ModContext({
    layers,
    modName: plan.modName,
    ...(plan.mod ? { mod: plan.mod } : {}),
    ...(schema ? { schema } : {}),
    ...(typeof wantPo === 'object' ? { po: wantPo } : wantPo && dataLocale !== undefined ? { po: loadGamedataPo(paths, dataLocale) } : {}),
    ...(dataLocale !== undefined ? { dataLocale } : {}),
  });
  return { ctx, missingDependencies: plan.missingDependencies, dependencyPaths, context: plan.context, extensions };
}

/**
 * Write the mod (changes only) to a file and mark the context as saved. The write is atomic
 * (temp file, read back and parsed, then renamed into place), so a crash or a full disk never
 * leaves half a mod on disk.
 */
export function saveModContext(ctx: ModContext, path: string): DataFile {
  const file = ctx.buildModFile();
  writeFileAtomic(path, writeDataFile(file), { check: assertReadable });
  ctx.markSaved();
  return file;
}

/**
 * Mod path from what the user typed: an existing file (relative to `cwd`) or the name of an
 * installed mod (`My mod.mod`, `.mod` may be omitted).
 */
export function resolveModPath(paths: GamePaths, spec: string, cwd = '.'): string | undefined {
  const asPath = resolve(cwd, spec);
  if (existsSync(asPath)) return asPath;
  return findInstalledMod(paths, spec.toLowerCase().endsWith('.mod') ? spec : `${spec}.mod`);
}

function isInside(root: string, path: string): boolean {
  const r = relative(resolve(root).toLowerCase(), resolve(path).toLowerCase());
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Whether the path is in the game or Workshop folder (we don't write there without explicit permission). */
export function isInGameFolders(paths: GamePaths, path: string): boolean {
  return isInside(paths.kenshi, path) || isInside(paths.workshop, path);
}

/**
 * Whether the path is in the Steam Workshop. We never write there, even with permission: these are
 * someone else's files and Steam overwrites them on update. Edit a copy instead (`copyModForEditing`).
 */
export function isInWorkshop(paths: GamePaths, path: string): boolean {
  return isInside(paths.workshop, path);
}
