/**
 * Чтение файла для окна с учётом его кэша (`ParsedFileCache`): если окно уже знает этот
 * файл (тот же путь, размер и время изменения), байты не читаются и не пересылаются.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileCacheKey, type FileStamp } from '../format/file-cache.ts';

export function fileStamp(path: string): FileStamp {
  const st = statSync(path);
  return { path: resolve(path), size: st.size, mtimeMs: st.mtimeMs };
}

/** Ключ файла и байты; байтов нет, если ключ есть среди `known`. */
export function readIfUnknown(path: string, known: ReadonlySet<string>): { key: string; bytes?: Uint8Array } {
  const key = fileCacheKey(fileStamp(path));
  if (known.has(key)) return { key };
  const bytes = readFileSync(path);
  // Ключ — по состоянию файла после чтения: если файл меняли во время чтения, ключ новый.
  return { key: fileCacheKey(fileStamp(path)), bytes };
}
