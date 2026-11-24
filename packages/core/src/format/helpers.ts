import { decodeText, encodeText, type TextEncoding } from '../text.ts';
import type { DataFile, GameRecord } from './types.ts';
import { itemTypeName, type ItemTypes } from './item-types.ts';

/** Mod list from the header ("a.mod,b.mod") → array of names; empty elements are dropped. */
export function splitModList(bytes: Uint8Array): string[] {
  return decodeText(bytes)
    .split(',')
    .filter((s) => s.length > 0);
}

export function joinModList(names: readonly string[], encoding: TextEncoding = 'utf-8'): Uint8Array {
  return encodeText(names.join(','), encoding);
}

export function recordName(rec: GameRecord, encoding: TextEncoding | 'auto' = 'auto'): string {
  return decodeText(rec.name, encoding);
}

/** Name of the record's type; `types` adds the types of schema extensions. */
export function recordTypeName(rec: GameRecord, types?: ItemTypes): string {
  return itemTypeName(rec.type, types);
}

/** Short file summary, handy for debugging and reports. */
export function summarize(file: DataFile, types?: ItemTypes): { fileType: number; records: number; byType: Map<string, number> } {
  const byType = new Map<string, number>();
  for (const r of file.records) {
    const t = itemTypeName(r.type, types);
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  return { fileType: file.fileType, records: file.records.length, byType };
}
