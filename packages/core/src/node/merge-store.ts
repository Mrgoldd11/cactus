/**
 * Mod merging on disk: the decision sidecar file next to the active mod
 * (`<name>.kedit-merge.json`, not part of the .mod), reading the source mod and detecting level
 * data next to it. The merge logic itself is `model/merge.ts`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readDataFile } from '../format/read.ts';
import { FileType } from '../format/types.ts';
import { errorMessage } from '../ui-text.ts';

import type { ModContext } from '../model/context.ts';
import {
  MERGE_STORE_SUFFIX,
  MergeError,
  MergeLedger,
  emptyMergeStore,
  parseMergeStore,
  serializeMergeStore,
  type LevelDataInfo,
  type MergeSource,
  type MergeStore,
} from '../model/merge.ts';

/** `<mod folder>/<name without .mod>.kedit-merge.json`. */
export function mergeStorePath(modPath: string): string {
  return join(dirname(modPath), `${basename(modPath).replace(/\.(mod|base)$/i, '')}${MERGE_STORE_SUFFIX}`);
}

/** Sidecar file; no file — empty. A broken file — `MergeError`. */
export function readMergeStore(modPath: string): MergeStore {
  const p = mergeStorePath(modPath);
  return existsSync(p) ? parseMergeStore(readFileSync(p, 'utf8')) : emptyMergeStore();
}

/** Write the sidecar file (to a temp file first, then into place). */
export function writeMergeStore(modPath: string, store: MergeStore): string {
  const p = mergeStorePath(modPath);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, serializeMergeStore(store), 'utf8');
  renameSync(tmp, p);
  return p;
}

/** Merge decisions of a mod by its file path; for a new mod (no path) — empty. */
export function loadMergeLedger(modPath: string | undefined): MergeLedger {
  return new MergeLedger(modPath !== undefined ? readMergeStore(modPath) : emptyMergeStore());
}

/**
 * After the mod is saved: active merges become permanent, the sidecar file is
 * written if anything in it changed. Returns the file path or undefined.
 */
export function saveMergeLedger(ctx: ModContext, ledger: MergeLedger, modPath: string): string | undefined {
  if (!ledger.hasChanges(ctx)) return undefined;
  return writeMergeStore(modPath, ledger.commit(ctx));
}

/** Read the whole source mod (.mod / .base). */
export function readMergeSource(path: string): MergeSource {
  let file;
  try {
    file = readDataFile(readFileSync(path));
  } catch (e) {
    const name = basename(path);
    throw new MergeError({
      en: `Could not read the mod “${name}”: ${errorMessage(e, 'en')}`,
      ru: `Не удалось прочитать мод «${name}»: ${errorMessage(e, 'ru')}`,
      zh: `无法读取模组“${name}”：${errorMessage(e, 'zh')}`,
    });
  }
  if (file.fileType !== FileType.Mod && file.fileType !== FileType.MergeMod) {
    const name = basename(path);
    throw new MergeError({
      en: `“${name}” is not a mod (.mod / .base): merge takes records only from those.`,
      ru: `«${name}» — не мод (.mod / .base): слияние берёт записи только из них.`,
      zh: `“${name}”不是模组（.mod / .base）：合并只从这类文件中读取记录。`,
    });
  }
  return { name: basename(path), file };
}

const LEVEL_FILE = /\.(zone|level)$/i;

/**
 * Source level data: files `leveldata/*.zone`, `leveldata.level`, `interiors.level` next to its .mod.
 * undefined — there are none. Files are only listed.
 */
export function detectLevelData(sourcePath: string): LevelDataInfo | undefined {
  const dir = join(dirname(sourcePath), 'leveldata');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const files = readdirSync(dir).filter((n) => LEVEL_FILE.test(n)).sort();
  return files.length > 0 ? { dir, files } : undefined;
}
