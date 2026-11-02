import { readFileSync, writeFileSync } from 'node:fs';
import { readDataFile, type ReadOptions } from '../format/read.ts';
import { writeDataFile, type WriteOptions } from '../format/write.ts';
import type { DataFile } from '../format/types.ts';

export * from './paths.ts';
export * from './schema.ts';

export function readDataFileSync(path: string, options?: ReadOptions): DataFile {
  return readDataFile(readFileSync(path), options);
}

export function writeDataFileSync(path: string, file: DataFile, options?: WriteOptions): void {
  writeFileSync(path, writeDataFile(file, options));
}
