/**
 * Слияние модов на диске: файл-спутник решений рядом с активным модом
 * (`<имя>.kedit-merge.json`, не часть .mod), чтение мода-источника и определение данных
 * уровня рядом с ним. Сама логика слияния — `model/merge.ts`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readDataFile } from '../format/read.ts';
import { FileType } from '../format/types.ts';
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

/** `<папка мода>/<имя без .mod>.kedit-merge.json`. */
export function mergeStorePath(modPath: string): string {
  return join(dirname(modPath), `${basename(modPath).replace(/\.(mod|base)$/i, '')}${MERGE_STORE_SUFFIX}`);
}

/** Файл-спутник; нет файла — пустой. Битый файл — `MergeError`. */
export function readMergeStore(modPath: string): MergeStore {
  const p = mergeStorePath(modPath);
  return existsSync(p) ? parseMergeStore(readFileSync(p, 'utf8')) : emptyMergeStore();
}

/** Записать файл-спутник (сначала во временный файл, потом на место). */
export function writeMergeStore(modPath: string, store: MergeStore): string {
  const p = mergeStorePath(modPath);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, serializeMergeStore(store), 'utf8');
  renameSync(tmp, p);
  return p;
}

/** Решения слияния мода по пути его файла; нового мода (пути нет) — пустые. */
export function loadMergeLedger(modPath: string | undefined): MergeLedger {
  return new MergeLedger(modPath !== undefined ? readMergeStore(modPath) : emptyMergeStore());
}

/**
 * После сохранения мода: действующие слияния становятся постоянными, файл-спутник
 * записывается, если в нём что-то изменилось. Возвращает путь файла или undefined.
 */
export function saveMergeLedger(ctx: ModContext, ledger: MergeLedger, modPath: string): string | undefined {
  if (!ledger.hasChanges(ctx)) return undefined;
  return writeMergeStore(modPath, ledger.commit(ctx));
}

/** Прочитать мод-источник (.mod / .base) целиком. */
export function readMergeSource(path: string): MergeSource {
  let file;
  try {
    file = readDataFile(readFileSync(path));
  } catch (e) {
    throw new MergeError(`Не удалось прочитать мод «${basename(path)}»: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (file.fileType !== FileType.Mod && file.fileType !== FileType.MergeMod) {
    throw new MergeError(`«${basename(path)}» — не мод (.mod / .base): слияние берёт записи только из них.`);
  }
  return { name: basename(path), file };
}

const LEVEL_FILE = /\.(zone|level)$/i;

/**
 * Данные уровня источника: файлы `leveldata/*.zone`, `leveldata.level`, `interiors.level` рядом с его .mod.
 * undefined — их нет. Файлы только перечисляются.
 */
export function detectLevelData(sourcePath: string): LevelDataInfo | undefined {
  const dir = join(dirname(sourcePath), 'leveldata');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const files = readdirSync(dir).filter((n) => LEVEL_FILE.test(n)).sort();
  return files.length > 0 ? { dir, files } : undefined;
}
