/**
 * Загрузка контекста редактирования с диска: ваниль по порядку, зависимости мода (из `mods/`
 * игры и мастерской, в порядке `data/mods.cfg`), затем сам мод. Сохранение мода в файл.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readDataFile } from '../format/read.ts';
import { writeDataFile } from '../format/write.ts';
import { splitModList } from '../format/helpers.ts';
import type { DataFile } from '../format/types.ts';
import { ModContext, type Layer } from '../model/context.ts';
import type { PoFile } from '../locale/po.ts';
import type { GameSchema } from '../schema/game-schema.ts';
import { extensionsFor, type ExtensionChoice, type FoundExtension } from './extensions.ts';
import { installedModFiles, VANILLA_FILES, vanillaFilePaths, type GamePaths } from './paths.ts';
import { gamedataPoPath, loadGamedataPo, loadGameSchema } from './schema.ts';

export interface LoadContextOptions {
  paths: GamePaths;
  /** Путь к редактируемому .mod. Если файла нет — создаётся новый мод с этим именем. */
  modPath?: string;
  /** Имя нового мода, если `modPath` не задан (по умолчанию `new.mod`). */
  modName?: string;
  /**
   * Зависимости (имена .mod), которые грузить как нижние слои. По умолчанию — зависимости и
   * references из заголовка мода. Ванильные имена пропускаются: ваниль грузится всегда.
   */
  dependencies?: readonly string[];
  /**
   * Другие моды для контекста (имена .mod): грузятся слоями на своих местах по `mods.cfg`,
   * но в заголовок мода не пишутся. Так видно, как мод ляжет поверх других модов.
   */
  context?: readonly string[];
  /** Загрузить схему FCS (по умолчанию да, если fcs.def есть) или взять уже прочитанную. */
  schema?: boolean | GameSchema;
  /**
   * Schema extensions (FCS Extended files in mod folders) to add to the schema read from disk.
   * Default: those of the mod and of the mods loaded under it; a choice changes the set, `false`
   * turns extensions off. Not used when `schema` is `false` or a ready schema.
   */
  extensions?: ExtensionChoice | false;
  /** Загрузить русский gamedata.po для поиска (по умолчанию да, если файл есть) или взять уже прочитанный. */
  po?: boolean | PoFile;
  /** Уже прочитанные ванильные слои (чтобы не читать их заново). */
  vanilla?: readonly Layer[];
}

export interface LoadedContext {
  ctx: ModContext;
  /** Зависимости, которых нет ни в `mods/`, ни в мастерской. */
  missingDependencies: string[];
  /** Пути загруженных зависимостей по порядку. */
  dependencyPaths: string[];
  /** Моды контекста, которые нашлись (не зависимости). */
  context: string[];
  /** Schema extensions found for the mod, in load order; their def files are in `ctx.schema`. */
  extensions: FoundExtension[];
}

export function loadVanillaLayers(paths: GamePaths): Layer[] {
  return vanillaFilePaths(paths).map((p, i) => ({ name: VANILLA_FILES[i]!, file: readDataFile(readFileSync(p)) }));
}

/** Порядок загрузки модов игрока из `data/mods.cfg` (имена файлов .mod). */
export function readModsCfg(paths: GamePaths): string[] {
  const p = join(paths.kenshi, 'data', 'mods.cfg');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Найти .mod по имени файла: сначала `mods/`, затем мастерская. */
export function findInstalledMod(paths: GamePaths, fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  return installedModFiles(paths).find((m) => basename(m.path).toLowerCase() === lower)?.path;
}

export interface ModLoadPlan {
  modName: string;
  /** Существующий файл мода (если есть). */
  modPath?: string;
  mod?: DataFile;
  /** Зависимости, которые нашлись, в порядке загрузки (`mods.cfg`). */
  dependencies: { name: string; path: string }[];
  /** Зависимости, которых нет ни в `mods/`, ни в мастерской. */
  missingDependencies: string[];
  /**
   * Моды контекста (`options.context`), которые нашлись и не входят в зависимости: стоят
   * среди `dependencies` на своих местах по `mods.cfg`, в заголовок мода не попадают.
   */
  context: string[];
}

/**
 * Что грузить: файл мода (если есть), его зависимости по порядку `mods.cfg`, отсутствующие.
 * Ванильные имена и сам мод из зависимостей убираются.
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
  const wantPo = options.po ?? existsSync(gamedataPoPath(paths));
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
    ...(typeof wantPo === 'object' ? { po: wantPo } : wantPo ? { po: loadGamedataPo(paths) } : {}),
  });
  return { ctx, missingDependencies: plan.missingDependencies, dependencyPaths, context: plan.context, extensions };
}

/** Записать мод (только изменения) в файл и считать контекст сохранённым. */
export function saveModContext(ctx: ModContext, path: string): DataFile {
  const file = ctx.buildModFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, writeDataFile(file));
  ctx.markSaved();
  return file;
}

/**
 * Путь к моду по тому, что ввёл пользователь: существующий файл (относительно `cwd`) или имя
 * установленного мода (`Мой мод.mod`, можно без `.mod`).
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

/** Лежит ли путь в папке игры или мастерской (туда без явного разрешения не пишем). */
export function isInGameFolders(paths: GamePaths, path: string): boolean {
  return isInside(paths.kenshi, path) || isInside(paths.workshop, path);
}

/**
 * Лежит ли путь в мастерской Steam. Туда не пишем никогда, даже с разрешением: это чужие
 * файлы, Steam перезапишет их при обновлении. Править — копию (`copyModForEditing`).
 */
export function isInWorkshop(paths: GamePaths, path: string): boolean {
  return isInside(paths.workshop, path);
}
