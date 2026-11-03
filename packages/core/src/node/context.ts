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
  /** Загрузить схему FCS (по умолчанию да, если fcs.def есть) или взять уже прочитанную. */
  schema?: boolean | GameSchema;
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

export function loadModContext(options: LoadContextOptions): LoadedContext {
  const { paths } = options;
  const vanilla = options.vanilla ?? loadVanillaLayers(paths);
  let mod: DataFile | undefined;
  let modName = options.modName ?? 'new.mod';
  if (options.modPath) {
    modName = basename(options.modPath);
    if (existsSync(options.modPath)) mod = readDataFile(readFileSync(options.modPath));
  }
  const vanillaNames = new Set<string>(VANILLA_FILES.map((f) => f.toLowerCase()));
  const requested =
    options.dependencies ?? (mod?.header ? [...splitModList(mod.header.dependencies), ...splitModList(mod.header.references)] : []);
  const unique = [...new Set(requested.filter((d) => !vanillaNames.has(d.toLowerCase()) && d.toLowerCase() !== modName.toLowerCase()))];
  const cfg = readModsCfg(paths).map((s) => s.toLowerCase());
  const rank = (n: string): number => {
    const i = cfg.indexOf(n.toLowerCase());
    return i < 0 ? cfg.length : i;
  };
  unique.sort((a, b) => rank(a) - rank(b));
  const layers: Layer[] = [...vanilla];
  const missingDependencies: string[] = [];
  const dependencyPaths: string[] = [];
  for (const dep of unique) {
    const p = findInstalledMod(paths, dep);
    if (!p) {
      missingDependencies.push(dep);
      continue;
    }
    dependencyPaths.push(p);
    layers.push({ name: dep, file: readDataFile(readFileSync(p)) });
  }
  const wantSchema = options.schema ?? existsSync(join(paths.kenshi, 'fcs.def'));
  const wantPo = options.po ?? existsSync(gamedataPoPath(paths));
  const ctx = new ModContext({
    layers,
    modName,
    ...(mod ? { mod } : {}),
    ...(typeof wantSchema === 'object' ? { schema: wantSchema } : wantSchema ? { schema: loadGameSchema(paths) } : {}),
    ...(typeof wantPo === 'object' ? { po: wantPo } : wantPo ? { po: loadGamedataPo(paths) } : {}),
  });
  return { ctx, missingDependencies, dependencyPaths };
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

/** Лежит ли путь в папке игры или мастерской (туда без явного разрешения не пишем). */
export function isInGameFolders(paths: GamePaths, path: string): boolean {
  const inside = (root: string): boolean => {
    const r = relative(resolve(root).toLowerCase(), resolve(path).toLowerCase());
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  };
  return inside(paths.kenshi) || inside(paths.workshop);
}
