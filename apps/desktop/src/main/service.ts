/**
 * Файловая часть главного процесса без Electron: поиск игры, список модов, чтение всего,
 * что нужно окну для контекста, запись мода. Подтверждения и диалоги — в `index.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { decodeText, readModHeader, splitModList, VANILLA_FILES } from '@kenshi-editor/core';
import {
  detectGameInstalls,
  gamedataPoPath,
  installedModFiles,
  isInGameFolders,
  isKenshiDir,
  manualInstall,
  planModLoad,
  readModsCfg,
  SCHEMA_FILES,
  vanillaFilePaths,
} from '@kenshi-editor/core/node';
import type { GameInstallInfo, ModEntry, NamedBytes, ProjectBundle, ProjectRequest } from '../shared/api.ts';

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
  const vanilla = vanillaFilePaths(game).map((p, i) => readNamed(VANILLA_FILES[i]!, p));
  const fcsEnums = readOptional(join(game.kenshi, SCHEMA_FILES.fcsEnums));
  const fcsLayout = readOptional(join(game.kenshi, SCHEMA_FILES.fcsLayout));
  const po = readOptional(gamedataPoPath(game));
  const bundle: ProjectBundle = {
    game,
    modName: plan.modName,
    vanilla,
    dependencies: plan.dependencies.map((d) => readNamed(d.name, d.path)),
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
