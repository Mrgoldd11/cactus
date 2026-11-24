/**
 * In-memory cache of parsed data files (vanilla, dependencies, level files).
 *
 * The key is the cache format version, path, size and modification time of the file (`fileCacheKey`). Whoever
 * reads the files (the main process, `node/file-cache.ts`) compares the key with the ones known to
 * the window and does not send the bytes if the file has not changed; the window takes the parsed file from here.
 * If the file changed (size or time), there is a new key, and the old entry for the same path is dropped.
 *
 * A parsed `DataFile` is shared by all projects opened in a row: the core does not change layers
 * (edits go into mod records). The cache never goes into the mod; it is only window memory.
 */
import { readDataFile, readDataFileSliced } from './read.ts';
import type { DataFile } from './types.ts';

/** Version of the key and parse format. Bump it if the way a file is parsed changes. */
export const PARSED_CACHE_VERSION = 1;

export interface FileStamp {
  path: string;
  size: number;
  mtimeMs: number;
}

export function fileCacheKey(s: FileStamp): string {
  return `v${PARSED_CACHE_VERSION}|${s.size}|${Math.round(s.mtimeMs)}|${s.path}`;
}

/** Path from the key (to evict the previous version of the same file). */
function pathOfKey(key: string): string {
  const parts = key.split('|');
  return parts.slice(3).join('|').toLowerCase();
}

export class CacheMissError extends Error {
  override name = 'CacheMissError';
}

export class ParsedFileCache {
  /** Key → file; Map order is last-use order (LRU). */
  private readonly entries = new Map<string, DataFile>();
  private readonly limit: number;
  hits = 0;
  misses = 0;

  constructor(limit = 64) {
    this.limit = limit;
  }

  /** Keys of parsed files; the window reports them to main so it does not receive the bytes again. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): DataFile | undefined {
    const f = this.entries.get(key);
    if (f) {
      this.entries.delete(key);
      this.entries.set(key, f);
    }
    return f;
  }

  /**
   * File by key: from the cache if it is there, otherwise parse `bytes` and remember it.
   * Not in the cache and no bytes: `CacheMissError` (the window will ask for the file again).
   */
  take(key: string, bytes: Uint8Array | undefined): DataFile {
    const hit = this.get(key);
    if (hit) {
      this.hits++;
      return hit;
    }
    if (bytes === undefined || bytes.length === 0) throw new CacheMissError(`Not in the cache: ${key}`);
    this.misses++;
    const file = readDataFile(bytes);
    this.put(key, file);
    return file;
  }

  /** Like `take`, but parses in slices with pauses (`readDataFileSliced`), for background preparation. */
  async takeSliced(key: string, bytes: Uint8Array | undefined, pause: () => Promise<void>): Promise<DataFile> {
    const hit = this.get(key);
    if (hit) return hit;
    if (bytes === undefined || bytes.length === 0) throw new CacheMissError(`Not in the cache: ${key}`);
    const file = await readDataFileSliced(bytes, pause);
    // While parsing, someone else may have parsed the same file; take the one already stored.
    const again = this.get(key);
    if (again) return again;
    this.misses++;
    this.put(key, file);
    return file;
  }

  put(key: string, file: DataFile): void {
    const path = pathOfKey(key);
    for (const k of this.entries.keys()) if (k !== key && pathOfKey(k) === path) this.entries.delete(k);
    this.entries.delete(key);
    this.entries.set(key, file);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
}
