/**
 * Постоянные id новых записей по их уникальному имени: номер выдаётся один раз и больше не
 * меняется (на строковые id ссылаются сохранения игры). Таблица — JSON `{ next, ids }`, как
 * `ids.json` у Vanilla Talk; читать и писать её — дело вызывающего (CLI кладёт рядом со скриптом).
 */
export interface StableIdData {
  /** Следующий свободный номер. */
  next: number;
  /** Имя записи → номер. */
  ids: Record<string, number>;
}

export class StableIds {
  readonly data: StableIdData;
  /** Имена, которым номер выдан в этой сборке. */
  readonly added: string[] = [];
  private readonly used = new Set<string>();

  readonly modName: string;

  constructor(modName: string, data?: StableIdData, start = 100) {
    this.modName = modName;
    this.data = data ? { next: data.next, ids: { ...data.ids } } : { next: start, ids: {} };
  }

  /** Строковый id `номер-Имя.mod` для записи с этим именем. */
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

  /** Имена из таблицы, которые в этой сборке не запрашивались (номера не переиспользуются). */
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

/** Таблица из JSON с проверкой формы. */
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
