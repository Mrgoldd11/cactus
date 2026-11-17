/**
 * Files a mod brings along (skeletons with clips, later models and textures): picking one exported from
 * Blender, copying it into the mod folder, reading skeleton links of race models. No Electron here except
 * what `index.ts` passes in.
 *
 * Writes only into `<game>/mods/<mod folder>/<sub>/` — the folder the mod's own records point to
 * (`.\mods\<mod folder>\…`). Nothing is ever overwritten without the window asking first.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { modFileRecordPath, parseOgreMesh } from '@kenshi-editor/core';
import type { GameInstallInfo, ImportModAssetRequest, ImportModAssetResult, ModAssetKind, PickedModAsset } from '../shared/api.ts';
import { modInstallPath, readGameAsset } from './service.ts';

export const MOD_ASSET_EXTENSIONS: Record<ModAssetKind, string[]> = {
  skeleton: ['skeleton'],
  mesh: ['mesh'],
  texture: ['dds', 'png'],
};

/** Larger than this is not an exported model file (guard against a wrong pick). */
const MAX_MOD_ASSET = 64 * 1024 * 1024;

/** Sub-folder inside the mod folder: plain names only (`animations`, `meshes/items`). */
const SUB_PART = /^[A-Za-z0-9 _.-]+$/;

function kindOf(path: string): ModAssetKind | undefined {
  const ext = extname(path).slice(1).toLowerCase();
  return (Object.keys(MOD_ASSET_EXTENSIONS) as ModAssetKind[]).find((k) => MOD_ASSET_EXTENSIONS[k].includes(ext));
}

/** Bytes of a file the user picked (only model file types, size-limited). */
export function readPickedAsset(path: string, kind: ModAssetKind): PickedModAsset | { error: string } {
  if (kindOf(path) !== kind) return { error: 'bad-type' };
  try {
    if (statSync(path).size > MAX_MOD_ASSET) return { error: 'too-big' };
    return { path, name: basename(path), bytes: readFileSync(path) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Folder name of the mod inside `<game>/mods/` (the launcher layout `mods/<name>/<name>.mod`);
 * undefined — the mod lives elsewhere, so `.\mods\…` paths in its records would point nowhere.
 */
export function modFolderIn(game: GameInstallInfo, modPath: string): string | undefined {
  const path = modInstallPath([game], modPath);
  const folder = dirname(resolve(path));
  if (dirname(folder).toLowerCase() !== resolve(game.kenshi, 'mods').toLowerCase()) return undefined;
  return basename(folder);
}

function sameBytes(a: string, b: string): boolean {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    return Buffer.compare(readFileSync(a), readFileSync(b)) === 0;
  } catch {
    return false;
  }
}

/** `name.skeleton` → `name_2.skeleton`, `name_3.skeleton`… — the first free one in `dir`. */
function freeName(dir: string, file: string): string {
  const ext = extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let i = 2; ; i++) {
    const n = `${stem}_${i}${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
}

/**
 * Copy a picked file into the mod folder. The same bytes already there — reused; a different file of
 * the same name — `conflict` unless the request says replace or rename.
 */
export function importModAsset(req: ImportModAssetRequest, picked: (path: string) => boolean): ImportModAssetResult {
  if (!picked(req.source) || kindOf(req.source) === undefined) return { ok: false, error: 'bad-file' };
  const parts = req.sub.split(/[\\/]+/).filter((p) => p !== '');
  if (parts.length === 0 || parts.some((p) => !SUB_PART.test(p) || p === '..' || p === '.')) return { ok: false, error: 'bad-file' };
  const folder = modFolderIn(req.game, req.modPath);
  if (folder === undefined) return { ok: false, error: 'not-in-mods' };
  const dir = join(req.game.kenshi, 'mods', folder, ...parts);
  let file = basename(req.source);
  try {
    if (statSync(req.source).size > MAX_MOD_ASSET) return { ok: false, error: 'bad-file' };
    mkdirSync(dir, { recursive: true });
    let status: 'copied' | 'same' | 'replaced' = 'copied';
    const target = join(dir, file);
    if (resolve(target).toLowerCase() === resolve(req.source).toLowerCase()) status = 'same';
    else if (existsSync(target)) {
      if (sameBytes(target, req.source)) status = 'same';
      else if (req.onConflict === 'replace') status = 'replaced';
      else if (req.onConflict === 'rename') file = freeName(dir, file);
      else return { ok: false, error: 'conflict', existing: file };
    }
    if (status !== 'same') copyFileSync(req.source, join(dir, file));
    return { ok: true, status, fileName: file, recordPath: modFileRecordPath(folder, parts.join('\\'), file) };
  } catch (err) {
    return { ok: false, error: 'io', message: err instanceof Error ? err.message : String(err) };
  }
}

const links = new Map<string, string | null>();

/**
 * Skeleton link of each model (`male_skeleton.skeleton`), null — no file or no skeleton. Models are parsed
 * here so the window gets names, not the 100+ MB of every race body.
 */
export function meshSkeletonNames(game: GameInstallInfo, paths: readonly string[]): (string | null)[] {
  return paths.map((p) => {
    const key = `${game.kenshi}|${p.toLowerCase()}`;
    const known = links.get(key);
    if (known !== undefined) return known;
    let name: string | null;
    try {
      const bytes = readGameAsset(game, p);
      name = bytes ? (parseOgreMesh(bytes).skeleton ?? null) : null;
    } catch {
      name = null;
    }
    links.set(key, name);
    return name;
  });
}

/** The skeleton chooser opens in the user's Blender export folder by default: Documents. */
export function assetDialogFilters(kind: ModAssetKind): { name: string; extensions: string[] }[] {
  return [{ name: kind === 'skeleton' ? 'Ogre skeleton' : kind === 'mesh' ? 'Ogre mesh' : 'Texture', extensions: MOD_ASSET_EXTENSIONS[kind] }];
}
