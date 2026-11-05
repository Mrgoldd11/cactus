/**
 * Чтение мира с диска: папки `leveldata` ванили и модов → `WorldIndex`.
 *
 * Ваниль: `data/newland/leveldata` (базовый слой, только файлы верхнего уровня), затем
 * подпапки `Newwworld`, `Dialogue`, `rebirth` — по порядку `VANILLA_FILES`. Мод: папка
 * `leveldata` рядом с его .mod. Читаются `leveldata.level` и `*.zone`; огромный
 * `interiors.level` (интерьеры, мегабайты на слой) по умолчанию пропускается.
 * Старая `data/leveldata` игрой не используется и не читается.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readDataFile } from '../format/read.ts';
import { VANILLA_FILES } from '../vanilla.ts';
import { WorldIndex, type WorldFile } from '../world/world.ts';
import type { GamePaths } from './paths.ts';

export interface WorldDir {
  layer: string;
  dir: string;
}

export interface ReadWorldOptions {
  /** Читать и `interiors.level` (долго, много памяти). По умолчанию нет. */
  interiors?: boolean;
}

export interface WorldReadResult {
  files: WorldFile[];
  /** Файлы, которые не удалось прочитать (старые форматы и т. п.). */
  errors: { path: string; message: string }[];
}

/** Папки уровня ванили по слоям. */
export function vanillaWorldDirs(paths: GamePaths): WorldDir[] {
  const root = join(paths.kenshi, 'data', 'newland', 'leveldata');
  return VANILLA_FILES.map((f, i) => ({ layer: f, dir: i === 0 ? root : join(root, f.replace(/\.(base|mod)$/i, '')) }));
}

/** Папка уровня мода (`leveldata` рядом с .mod), если есть. */
export function modWorldDir(modFile: string): WorldDir | undefined {
  const dir = join(dirname(modFile), 'leveldata');
  return existsSync(dir) ? { layer: basename(modFile), dir } : undefined;
}

function isWorldFile(name: string, interiors: boolean): boolean {
  const n = name.toLowerCase();
  if (n.endsWith('.zone')) return true;
  if (n === 'leveldata.level') return true;
  return interiors && n === 'interiors.level';
}

export interface WorldFileEntry {
  layer: string;
  /** Имя файла в папке `leveldata`. */
  path: string;
  /** Полный путь на диске. */
  full: string;
}

/** Файлы уровня по слоям в порядке наложения (без чтения содержимого). */
export function listWorldFiles(dirs: readonly WorldDir[], options: ReadWorldOptions = {}): WorldFileEntry[] {
  const out: WorldFileEntry[] = [];
  for (const { layer, dir } of dirs) {
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && isWorldFile(e.name, options.interiors ?? false))
      .map((e) => e.name)
      .sort();
    for (const name of names) out.push({ layer, path: name, full: join(dir, name) });
  }
  return out;
}

/** Папки уровня ванили и модов (зависимости по порядку, затем сам мод). */
export function worldDirs(paths: GamePaths, modFiles: readonly string[] = []): WorldDir[] {
  const dirs = [...vanillaWorldDirs(paths)];
  for (const m of modFiles) {
    const d = modWorldDir(m);
    if (d) dirs.push(d);
  }
  return dirs;
}

export function readWorldFiles(dirs: readonly WorldDir[], options: ReadWorldOptions = {}): WorldReadResult {
  const files: WorldFile[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const { layer, path, full } of listWorldFiles(dirs, options)) {
    try {
      files.push({ layer, path, file: readDataFile(readFileSync(full)) });
    } catch (e) {
      errors.push({ path: full, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { files, errors };
}

export interface LoadWorldOptions extends ReadWorldOptions {
  /** Файлы .mod (зависимости по порядку, затем сам мод), чьи папки `leveldata` наложить на ваниль. */
  modFiles?: readonly string[];
}

export interface LoadedWorld {
  world: WorldIndex;
  dirs: WorldDir[];
  errors: { path: string; message: string }[];
}

/** Мир ванили и модов. Если папок уровня нет — пустой мир. */
export function loadWorld(paths: GamePaths, options: LoadWorldOptions = {}): LoadedWorld {
  const dirs = worldDirs(paths, options.modFiles);
  const { files, errors } = readWorldFiles(dirs, options);
  return { world: new WorldIndex(files), dirs: dirs.filter((d) => existsSync(d.dir)), errors };
}
