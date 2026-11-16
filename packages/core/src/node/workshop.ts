/**
 * Workshop files on disk: `_<mod>.info` / `_<mod>.img` next to the mod, the list of files that
 * go to Steam, and the staged copy of them the uploader hands to Steam.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { formatWorkshopInfo, imageFormat, newWorkshopInfo, parseWorkshopInfo, workshopFileNames, type ImageFormat, type WorkshopInfo, type WorkshopInfoFile } from '../workshop/info.ts';
import { excludeReason, type ExcludeReason } from '../workshop/publish.ts';
import { writeFileAtomic } from './backup.ts';

export interface WorkshopPaths {
  dir: string;
  info: string;
  img: string;
  mod: string;
}

/** `_<mod>.info` and `_<mod>.img` paths for a `.mod` path. */
export function workshopPaths(modPath: string): WorkshopPaths {
  const dir = dirname(resolve(modPath));
  const names = workshopFileNames(basename(modPath));
  return { dir, info: join(dir, names.info), img: join(dir, names.img), mod: names.mod };
}

export type ReadInfoResult =
  | { state: 'missing' }
  | { state: 'ok'; file: WorkshopInfoFile }
  | { state: 'unreadable'; error: string };

/** Read `_<mod>.info` next to a mod. */
export function readWorkshopInfo(modPath: string): ReadInfoResult {
  const p = workshopPaths(modPath).info;
  if (!existsSync(p)) return { state: 'missing' };
  try {
    return { state: 'ok', file: parseWorkshopInfo(readFileSync(p, 'utf8')) };
  } catch (e) {
    return { state: 'unreadable', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Write `_<mod>.info` next to a mod (atomically; keeps the old layout when `base` is given). */
export function writeWorkshopInfo(modPath: string, info: WorkshopInfo, base?: WorkshopInfoFile): void {
  writeFileAtomic(workshopPaths(modPath).info, new TextEncoder().encode(formatWorkshopInfo(info, base)));
}

/** Info for the mod as it is on disk, or a fresh one if none / unreadable. */
export function workshopInfoOrNew(modPath: string): WorkshopInfo {
  const r = readWorkshopInfo(modPath);
  return r.state === 'ok' ? r.file.info : newWorkshopInfo(workshopPaths(modPath).mod);
}

export interface PreviewInfo {
  path: string;
  size: number;
  format: ImageFormat | undefined;
}

/** Size and format of a picture file; `undefined` if it does not exist. */
export function previewInfo(path: string): PreviewInfo | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    const head = new Uint8Array(16);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, head, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    return { path, size: st.size, format: imageFormat(head) };
  } catch {
    return undefined;
  }
}

export interface UploadFile {
  /** Path relative to the mod folder, `/`-separated. */
  rel: string;
  size: number;
}

export interface UploadList {
  files: UploadFile[];
  excluded: (UploadFile & { reason: ExcludeReason })[];
  totalSize: number;
}

/**
 * Files of the mod folder that go to Steam: everything except what `excludeReason` names
 * (Cactus companion files, backups, temp files, OS files, version control folders). The
 * `_<mod>.info` / `_<mod>.img` files stay in, as FCS uploads them too.
 */
export function listUploadFiles(modDir: string): UploadList {
  const files: UploadFile[] = [];
  const excluded: (UploadFile & { reason: ExcludeReason })[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(modDir, full).split(sep).join('/');
      if (e.isDirectory()) {
        const reason = excludeReason(e.name, true);
        if (reason) excluded.push({ rel: `${rel}/`, size: dirSize(full), reason });
        else walk(full);
      } else if (e.isFile()) {
        const size = statSync(full).size;
        const reason = excludeReason(e.name, false);
        if (reason) excluded.push({ rel, size, reason });
        else files.push({ rel, size });
      }
      // Symlinks and other entries are skipped: Steam would follow them unpredictably.
    }
  };
  walk(modDir);
  return { files, excluded, totalSize: files.reduce((s, f) => s + f.size, 0) };
}

function dirSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else if (e.isFile()) total += statSync(full).size;
  }
  return total;
}

/**
 * Put the upload files into `stageDir` (hard links, copies where links fail) so Steam sees only
 * them. `stageDir` is emptied first. Returns the number of files copied rather than linked.
 */
export function stageUploadFiles(modDir: string, files: readonly UploadFile[], stageDir: string): { linked: number; copied: number } {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  let linked = 0;
  let copied = 0;
  for (const f of files) {
    const src = join(modDir, ...f.rel.split('/'));
    const dst = join(stageDir, ...f.rel.split('/'));
    mkdirSync(dirname(dst), { recursive: true });
    try {
      linkSync(src, dst);
      linked++;
    } catch {
      copyFileSync(src, dst);
      copied++;
    }
  }
  return { linked, copied };
}

/** Remove a staged folder (never throws). */
export function removeStaging(stageDir: string): void {
  try {
    rmSync(stageDir, { recursive: true, force: true });
  } catch {
    // best effort: it lives in the editor's data folder
  }
}

/**
 * True if a Steam client process runs on this machine (local process list only; Steam itself is
 * not asked). Tells "Steam is not running" apart from other init failures, which steamworks.js
 * reports with one and the same text. `undefined` — could not tell.
 */
export function isSteamProcessRunning(): boolean | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      return /"steam\.exe"/i.test(out);
    }
    const out = execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
    return out.split(/\r?\n/).some((l) => /(^|\/)steam(\.sh)?$/i.test(l.trim()) || /steam_osx$/i.test(l.trim()));
  } catch {
    return undefined;
  }
}
