/**
 * Stable ids of new records by their unique name: a number is issued once and never
 * changes (game saves reference string ids). The table is JSON `{ next, ids }`, like
 * Vanilla Talk's `ids.json`; reading and writing it is the caller's job (the CLI keeps it next to the script).
 */
export interface StableIdData {
  /** Next free number. */
  next: number;
  /** Record name → number. */
  ids: Record<string, number>;
}

export class StableIds {
  readonly data: StableIdData;
  /** Names that got a number in this build. */
  readonly added: string[] = [];
  private readonly used = new Set<string>();

  readonly modName: string;

  constructor(modName: string, data?: StableIdData, start = 100) {
    this.modName = modName;
    this.data = data ? { next: data.next, ids: { ...data.ids } } : { next: start, ids: {} };
  }

  /** String id `number-Name.mod` for a record with this name. */
  id(name: string): string {
    let n = this.data.ids[name];
    if (n === undefined) {
      n = this.data.next++;
      this.data.ids[name] = n;
      this.added.push(name);
    }
    this.used.add(name);
    return `${n}-${this.modName}`;
  }

  /** Names from the table not requested in this build (numbers are not reused). */
  orphans(): string[] {
    return Object.keys(this.data.ids).filter((k) => !this.used.has(k));
  }

  get usedCount(): number {
    return this.used.size;
  }

  toJSON(): StableIdData {
    return this.data;
  }
}

/** Table from JSON with a shape check. */
export function parseStableIds(text: string): StableIdData {
  const raw = JSON.parse(text) as { next?: unknown; ids?: unknown };
  if (typeof raw.next !== 'number' || typeof raw.ids !== 'object' || raw.ids === null) {
    throw new Error('таблица id: нужен JSON { "next": число, "ids": { имя: номер } }');
  }
  const ids = raw.ids as Record<string, unknown>;
  for (const [k, v] of Object.entries(ids)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`таблица id: у «${k}» не номер (${String(v)})`);
    if (v >= raw.next) throw new Error(`таблица id: номер ${v} у «${k}» не меньше next=${raw.next}`);
  }
  return { next: raw.next, ids: ids as Record<string, number> };
}
