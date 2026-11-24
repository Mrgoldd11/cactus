/**
 * Reading the world from disk: `leveldata` folders of vanilla and mods → `WorldIndex`.
 *
 * Vanilla: `data/newland/leveldata` (base layer, top-level files only), then the
 * subfolders `Newwworld`, `Dialogue`, `rebirth` — in `VANILLA_FILES` order. A mod: the
 * `leveldata` folder next to its .mod. `leveldata.level` and `*.zone` are read; the huge
 * `interiors.level` (interiors, megabytes per layer) is skipped by default.
 * The old `data/leveldata` is not used by the game and is not read.
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
  /** Also read `interiors.level` (slow, lots of memory). No by default. */
  interiors?: boolean;
}

export interface WorldReadResult {
  files: WorldFile[];
  /** Files that could not be read (old formats etc.). */
  errors: { path: string; message: string }[];
}

/** Vanilla level folders per layer. */
export function vanillaWorldDirs(paths: GamePaths): WorldDir[] {
  const root = join(paths.kenshi, 'data', 'newland', 'leveldata');
  return VANILLA_FILES.map((f, i) => ({ layer: f, dir: i === 0 ? root : join(root, f.replace(/\.(base|mod)$/i, '')) }));
}

/** The mod's level folder (`leveldata` next to the .mod), if any. */
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
  /** File name in the `leveldata` folder. */
  path: string;
  /** Full path on disk. */
  full: string;
}

/** Level files per layer in overlay order (contents not read). */
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

/** Level folders of vanilla and mods (dependencies in order, then the mod itself). */
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
  /** .mod files (dependencies in order, then the mod itself) whose `leveldata` folders overlay vanilla. */
  modFiles?: readonly string[];
}

export interface LoadedWorld {
  world: WorldIndex;
  dirs: WorldDir[];
  errors: { path: string; message: string }[];
}

/** World of vanilla and mods. If there are no level folders — an empty world. */
export function loadWorld(paths: GamePaths, options: LoadWorldOptions = {}): LoadedWorld {
  const dirs = worldDirs(paths, options.modFiles);
  const { files, errors } = readWorldFiles(dirs, options);
  return { world: new WorldIndex(files), dirs: dirs.filter((d) => existsSync(d.dir)), errors };
}
