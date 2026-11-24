/**
 * Ignored validation issues per mod, in the editor's data folder (`<data>/validation/<modKey>.json`):
 * not next to the mod, because the mod folder is uploaded to the Workshop.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emptyIgnoreList, parseIgnoreList, serializeIgnoreList, type IgnoreList } from '../model/fixes.ts';
import { modKey, type ModRef } from './backup.ts';

export const ignoreListFile = (dataDir: string, ref: ModRef): string => join(dataDir, 'validation', `${modKey(ref)}.json`);

export function loadIgnoreList(dataDir: string, ref: ModRef): IgnoreList {
  try {
    return parseIgnoreList(readFileSync(ignoreListFile(dataDir, ref), 'utf8'));
  } catch {
    return emptyIgnoreList();
  }
}

export function saveIgnoreList(dataDir: string, ref: ModRef, list: IgnoreList): string {
  const path = ignoreListFile(dataDir, ref);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeIgnoreList(list));
  return path;
}
