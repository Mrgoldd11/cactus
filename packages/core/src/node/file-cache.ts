/**
 * Reading a file for the window with its cache in mind (`ParsedFileCache`): if the window already knows this
 * file (same path, size and modification time), the bytes are not read or sent.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileCacheKey, type FileStamp } from '../format/file-cache.ts';

export function fileStamp(path: string): FileStamp {
  const st = statSync(path);
  return { path: resolve(path), size: st.size, mtimeMs: st.mtimeMs };
}

/** File key and bytes; no bytes if the key is among `known`. */
export function readIfUnknown(path: string, known: ReadonlySet<string>): { key: string; bytes?: Uint8Array } {
  const key = fileCacheKey(fileStamp(path));
  if (known.has(key)) return { key };
  const bytes = readFileSync(path);
  // The key comes from the file state after reading: if the file changed during the read, the key is new.
  return { key: fileCacheKey(fileStamp(path)), bytes };
}
