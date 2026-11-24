import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bytesEqual,
  CacheMissError,
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  ParsedFileCache,
  readDataFile,
  readDataFileSliced,
  writeDataFile,
  type DataFile,
} from '../src/index.ts';
import { readIfUnknown } from '../src/node/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'kedit-cache-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** File with repeated keys (string cache in parsing), long, UTF-8 and latin1 ids. */
function sample(word: string, count = 50): Uint8Array {
  const file: DataFile = { fileType: FileType.MergeMod, lastId: 7, records: [], tail: new Uint8Array() };
  file.header = { version: 1, author: encodeText('a'), description: encodeText(''), dependencies: encodeText(''), references: encodeText('') };
  const long = `x${'y'.repeat(80)}`;
  for (let i = 0; i < count; i++) {
    const r = emptyRecord(itemTypeId('WEAPON')!, `${i}-test.mod`, encodeText(`${word} ${i}`));
    r.floats.set('weight', i).set('cut damage multiplier', 1.5).set(long, 2);
    r.strings.set('description', encodeText(`строка ${word}`));
    r.refs.set('vendors', [{ target: `${(i + 1) % count}-test.mod`, v0: 1, v1: 0, v2: 0 }]);
    r.ints.set('Ключ по-русски', i);
    file.records.push(r);
  }
  file.records.push(emptyRecord(itemTypeId('WEAPON')!, '99-tést.mod'));
  file.latin1Ids = new Set(['99-tést.mod']);
  return writeDataFile(file);
}

describe('parsed file cache', () => {
  it('from the cache — the same result as parsing without the cache, byte for byte', () => {
    const path = join(dir, 'a.mod');
    const bytes = sample('alpha');
    writeFileSync(path, bytes);
    const cache = new ParsedFileCache();
    const first = readIfUnknown(path, new Set(cache.keys()));
    expect(first.bytes).toBeDefined();
    const parsed = cache.take(first.key, first.bytes);
    expect(parsed).toEqual(readDataFile(first.bytes!));
    expect(bytesEqual(writeDataFile(parsed), bytes)).toBe(true);

    // The second time the file is not read or parsed: the same object from memory.
    const second = readIfUnknown(path, new Set(cache.keys()));
    expect(second.bytes).toBeUndefined();
    expect(second.key).toBe(first.key);
    expect(cache.take(second.key, second.bytes)).toBe(parsed);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it('file time changed — new key, the file is read again, the old entry is dropped', () => {
    const path = join(dir, 'b.mod');
    writeFileSync(path, sample('beta'));
    const cache = new ParsedFileCache();
    const a = readIfUnknown(path, new Set(cache.keys()));
    cache.take(a.key, a.bytes);

    // Same size, different contents and modification time.
    const changed = sample('gamma');
    writeFileSync(path, changed);
    const t = statSync(path).mtimeMs / 1000 + 10;
    utimesSync(path, t, t);
    const b = readIfUnknown(path, new Set(cache.keys()));
    expect(b.key).not.toBe(a.key);
    expect(b.bytes).toBeDefined();
    const file = cache.take(b.key, b.bytes);
    expect(file).toEqual(readDataFile(b.bytes!));
    expect(bytesEqual(writeDataFile(file), changed)).toBe(true);
    expect(cache.keys()).toEqual([b.key]);
  });

  it('not in cache and no bytes — CacheMissError; extras are evicted by the limit', () => {
    const cache = new ParsedFileCache(2);
    expect(() => cache.take('v1|1|1|nope', undefined)).toThrow(CacheMissError);
    const bytes = sample('d');
    cache.take('v1|1|1|p1', bytes);
    cache.take('v1|1|1|p2', bytes);
    cache.take('v1|1|1|p1', undefined); // p1 — recently used
    cache.take('v1|1|1|p3', bytes);
    expect(cache.keys().sort()).toEqual(['v1|1|1|p1', 'v1|1|1|p3']);
  });

  it('parsing in chunks with pauses — the same file as a normal parse', async () => {
    const bytes = sample('epsilon', 300);
    let pauses = 0;
    const sliced = await readDataFileSliced(bytes, () => { pauses++; return Promise.resolve(); }, 0);
    expect(pauses).toBe(2); // 301 records: a pause after the 128th and 256th
    expect(sliced).toEqual(readDataFile(bytes));
    const cache = new ParsedFileCache();
    const a = await cache.takeSliced('v1|1|1|s', bytes, () => Promise.resolve());
    expect(cache.take('v1|1|1|s', undefined)).toBe(a);
    expect(bytesEqual(writeDataFile(a), bytes)).toBe(true);
  });
});
