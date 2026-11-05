/**
 * Кэш разобранных файлов данных в памяти (ваниль, зависимости, файлы уровня).
 *
 * Ключ — версия формата кэша, путь, размер и время изменения файла (`fileCacheKey`). Тот,
 * кто читает файлы (main-процесс, `node/file-cache.ts`), сравнивает ключ с известными
 * окну и не пересылает байты, если файл не менялся; окно берёт разобранный файл отсюда.
 * Изменился файл (размер или время) — новый ключ, старая запись того же пути выбрасывается.
 *
 * Разобранный `DataFile` общий для всех открытых подряд проектов: ядро слои не меняет
 * (правки идут в записи мода). В мод кэш не попадает — это только память окна.
 */
import { readDataFile, readDataFileSliced } from './read.ts';
import type { DataFile } from './types.ts';

/** Версия формата ключа и разбора. Поменять, если меняется то, как разбирается файл. */
export const PARSED_CACHE_VERSION = 1;

export interface FileStamp {
  path: string;
  size: number;
  mtimeMs: number;
}

export function fileCacheKey(s: FileStamp): string {
  return `v${PARSED_CACHE_VERSION}|${s.size}|${Math.round(s.mtimeMs)}|${s.path}`;
}

/** Путь из ключа (для вытеснения прежней версии того же файла). */
function pathOfKey(key: string): string {
  const parts = key.split('|');
  return parts.slice(3).join('|').toLowerCase();
}

export class CacheMissError extends Error {
  override name = 'CacheMissError';
}

export class ParsedFileCache {
  /** Ключ → файл; порядок Map — порядок последнего использования (LRU). */
  private readonly entries = new Map<string, DataFile>();
  private readonly limit: number;
  hits = 0;
  misses = 0;

  constructor(limit = 64) {
    this.limit = limit;
  }

  /** Ключи разобранных файлов — их окно сообщает main, чтобы не получать байты повторно. */
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
   * Файл по ключу: из кэша, если он там есть, иначе разобрать `bytes` и запомнить.
   * Нет в кэше и нет байтов — `CacheMissError` (окно попросит файл ещё раз).
   */
  take(key: string, bytes: Uint8Array | undefined): DataFile {
    const hit = this.get(key);
    if (hit) {
      this.hits++;
      return hit;
    }
    if (bytes === undefined || bytes.length === 0) throw new CacheMissError(`Нет в кэше: ${key}`);
    this.misses++;
    const file = readDataFile(bytes);
    this.put(key, file);
    return file;
  }

  /** Как `take`, но разбор кусками с паузами (`readDataFileSliced`) — для фоновой подготовки. */
  async takeSliced(key: string, bytes: Uint8Array | undefined, pause: () => Promise<void>): Promise<DataFile> {
    const hit = this.get(key);
    if (hit) return hit;
    if (bytes === undefined || bytes.length === 0) throw new CacheMissError(`Нет в кэше: ${key}`);
    const file = await readDataFileSliced(bytes, pause);
    // Пока шёл разбор, тот же файл мог разобрать кто-то ещё — берём уже лежащий.
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
