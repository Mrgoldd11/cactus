/**
 * Файловая часть главного процесса без Electron: поиск игры, список модов, чтение всего,
 * что нужно окну для контекста, запись мода. Подтверждения и диалоги — в `index.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { decodeText, readModHeader, splitModList, VANILLA_FILES } from '@kenshi-editor/core';
import {
  detectGameInstalls,
  gamedataPoPath,
  installedModFiles,
  isInGameFolders,
  isKenshiDir,
  listWorldFiles,
  manualInstall,
  planModLoad,
  readIfUnknown,
  readModsCfg,
  SCHEMA_FILES,
  translationFilePath,
  vanillaFilePaths,
  worldDirs,
} from '@kenshi-editor/core/node';
import type { GameInstallInfo, ModEntry, NamedBytes, ProjectBundle, ProjectRequest, WorldFileBytes, WorldRequest } from '../shared/api.ts';

export function detectGames(cwd?: string): GameInstallInfo[] {
  return detectGameInstalls(cwd).map((g) => ({ kenshi: g.kenshi, workshop: g.workshop, source: g.source }));
}

export function gameFromDir(dir: string): GameInstallInfo | undefined {
  if (!isKenshiDir(dir)) return undefined;
  const g = manualInstall(dir);
  return { kenshi: g.kenshi, workshop: g.workshop, source: 'manual' };
}

export function describeMod(path: string, source: ModEntry['source'], cfg: readonly string[]): ModEntry {
  const fileName = basename(path);
  const entry: ModEntry = { fileName, path, source };
  const idx = cfg.indexOf(fileName.toLowerCase());
  if (idx >= 0) entry.loadIndex = idx;
  try {
    const { header, recordCount } = readModHeader(readFileSync(path));
    if (header) {
      entry.author = decodeText(header.author);
      entry.description = decodeText(header.description);
      entry.dependencies = splitModList(header.dependencies);
      entry.references = splitModList(header.references);
    }
    if (recordCount !== undefined) entry.recordCount = recordCount;
  } catch (e) {
    entry.error = e instanceof Error ? e.message : String(e);
  }
  return entry;
}

/** Моды из `mods/` и мастерской с заголовками; порядок `mods.cfg` — в `loadIndex`. */
export function listMods(game: GameInstallInfo): ModEntry[] {
  const cfg = readModsCfg(game).map((s) => s.toLowerCase());
  return installedModFiles(game).map((m) => describeMod(m.path, m.source, cfg));
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
    schema: {
      fcsDef: readFileSync(join(game.kenshi, SCHEMA_FILES.fcsDef), 'utf8'),
      ...(fcsEnums !== undefined ? { fcsEnums } : {}),
      ...(fcsLayout !== undefined ? { fcsLayout } : {}),
    },
    suggestedPath: plan.modPath ?? join(game.kenshi, 'mods', plan.modName.replace(/\.mod$/i, ''), plan.modName),
  };
  if (plan.modPath !== undefined) bundle.mod = readNamed(plan.modName, plan.modPath);
  if (po !== undefined) bundle.po = po;
  return bundle;
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

export function writeMod(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** Файлы уровня ванили и модов, сырыми байтами (разбирает окно). */
export function loadWorldBytes(req: WorldRequest): WorldFileBytes[] {
  const known = new Set(req.known ?? []);
  return listWorldFiles(worldDirs(req.game, req.modPaths)).map((f) => {
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

/** Перевод текстов записей (реплик) игры; null — файла нет. */
export function readTranslationBytes(game: GameInstallInfo): Uint8Array | null {
  const path = translationFilePath(game);
  return existsSync(path) ? readFileSync(path) : null;
}
