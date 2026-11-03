/**
 * Поиск записей: по имени (английскому и русскому из gamedata.po), строковому id, типу,
 * статусу и значениям полей; плюс «где угодно» — подстрока в любом значении записи.
 */
import { decodeText } from '../text.ts';
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import type { ModContext, RecordStatus } from './context.ts';
import { SCALAR_DICTS, scalarMap } from './record-ops.ts';
import { formatScalar } from './present.ts';

export type FilterOp = '=' | '!=' | '~' | '<' | '>' | '<=' | '>=' | 'exists';

/** Условие на поле: ключ любого словаря или категория ссылок (тогда значение — id или имя цели). */
export interface FieldFilter {
  key: string;
  op: FilterOp;
  value?: string;
}

export interface SearchQuery {
  /** Подстрока имени (англ. или рус.) или строкового id, без учёта регистра. */
  text?: string;
  /** Только точное совпадение имени. */
  exact?: boolean;
  /** Тип: имя (`DIALOGUE`) или номер. */
  type?: string | number;
  fields?: readonly FieldFilter[];
  status?: readonly RecordStatus[];
  /** Подстрока в чём угодно: имени, id, ключах, значениях, целях ссылок. */
  anywhere?: string;
  /** Только записи, которые задаёт мод (новые, изменённые, удалённые). */
  modOnly?: boolean;
}

export interface SearchHit {
  stringId: string;
  type: string;
  name: string;
  localizedName?: string;
  status: RecordStatus;
}

/** `key=value`, `key!=value`, `key~text`, `key>=3`, `key?` (поле есть). */
export function parseFieldFilter(text: string): FieldFilter {
  const exists = /^(.+)\?$/.exec(text);
  if (exists) return { key: exists[1]!.trim(), op: 'exists' };
  const m = /^(.+?)(!=|<=|>=|=|~|<|>)(.*)$/.exec(text);
  if (!m) throw new Error(`Не понял условие «${text}»: нужно ключ=значение, ключ~текст, ключ>число или ключ?`);
  return { key: m[1]!.trim(), op: m[2] as FilterOp, value: m[3]!.trim() };
}

export function resolveTypeFilter(type: string | number): number {
  if (typeof type === 'number') return type;
  if (/^\d+$/.test(type)) return Number(type);
  const id = itemTypeId(type.toUpperCase());
  if (id === undefined) throw new Error(`Неизвестный тип записи «${type}»`);
  return id;
}

function compare(actual: string, op: FilterOp, expected: string): boolean {
  const a = Number(actual);
  const e = Number(expected);
  const numeric = actual !== '' && expected !== '' && Number.isFinite(a) && Number.isFinite(e);
  switch (op) {
    case '=':
      return numeric ? a === e : actual === expected;
    case '!=':
      return numeric ? a !== e : actual !== expected;
    case '~':
      return actual.toLowerCase().includes(expected.toLowerCase());
    case '<':
      return numeric && a < e;
    case '>':
      return numeric && a > e;
    case '<=':
      return numeric && a <= e;
    case '>=':
      return numeric && a >= e;
    case 'exists':
      return true;
  }
}

/** Значения поля записи текстом (для ссылок — id и имена целей). */
function fieldValues(ctx: ModContext, rec: GameRecord, key: string): string[] | undefined {
  for (const dict of SCALAR_DICTS) {
    const v = scalarMap(rec, dict).get(key);
    if (v === undefined) continue;
    if (dict === 'strings' || dict === 'files') return [decodeText(v as Uint8Array)];
    if (dict === 'bools') return [v ? 'true' : 'false', v ? '1' : '0'];
    return [formatScalar(dict, v)];
  }
  const refs = rec.refs.get(key);
  if (refs) return refs.flatMap((r) => [r.target, ctx.name(r.target) ?? '']);
  return undefined;
}

export function matchesFilter(ctx: ModContext, rec: GameRecord, f: FieldFilter): boolean {
  const values = fieldValues(ctx, rec, f.key);
  if (f.op === 'exists') return values !== undefined && (!rec.refs.has(f.key) || values.length > 0);
  if (values === undefined) return f.op === '!=';
  if (f.op === '!=') return values.every((v) => compare(v, '!=', f.value ?? ''));
  return values.some((v) => compare(v, f.op, f.value ?? ''));
}

/** Всё содержимое записи одной строкой в нижнем регистре — для поиска «где угодно». */
export function recordHaystack(ctx: ModContext, rec: GameRecord): string {
  const parts = [rec.stringId, decodeText(rec.name), ctx.localizedName(rec.stringId) ?? ''];
  for (const dict of SCALAR_DICTS) {
    for (const [k, v] of scalarMap(rec, dict)) parts.push(k, dict === 'strings' || dict === 'files' ? decodeText(v as Uint8Array) : formatScalar(dict, v));
  }
  for (const [cat, list] of rec.refs) {
    parts.push(cat);
    for (const r of list) parts.push(r.target, ctx.name(r.target) ?? '');
  }
  for (const [k, i] of rec.instances) parts.push(k, i.target);
  return parts.join('\n').toLowerCase();
}

/** Все совпадения по порядку слоёв (порядку первого появления записей). */
export function searchRecords(ctx: ModContext, q: SearchQuery): SearchHit[] {
  const type = q.type === undefined ? undefined : resolveTypeFilter(q.type);
  const text = q.text?.toLowerCase();
  const anywhere = q.anywhere?.toLowerCase();
  const statuses = q.status ? new Set(q.status) : undefined;
  const ids = q.modOnly ? ctx.modRecords().map((r) => r.stringId) : ctx.allStringIds();
  const out: SearchHit[] = [];
  for (const sid of ids) {
    const status = ctx.status(sid);
    if (!status) continue;
    if (statuses && !statuses.has(status)) continue;
    // Удалённые модом записи ищутся по их последнему состоянию в нижних слоях.
    const rec = ctx.get(sid) ?? ctx.lower(sid);
    if (!rec) continue;
    if (type !== undefined && rec.type !== type) continue;
    const name = decodeText(rec.name);
    const ru = ctx.localizedName(sid);
    if (text !== undefined) {
      const names = [name.toLowerCase(), (ru ?? '').toLowerCase()];
      const ok = q.exact ? names.includes(text) || sid.toLowerCase() === text : names.some((n) => n.includes(text)) || sid.toLowerCase().includes(text);
      if (!ok) continue;
    }
    if (q.fields && !q.fields.every((f) => matchesFilter(ctx, rec, f))) continue;
    if (anywhere !== undefined && !recordHaystack(ctx, rec).includes(anywhere)) continue;
    const hit: SearchHit = { stringId: sid, type: itemTypeName(rec.type), name, status };
    if (ru !== undefined) hit.localizedName = ru;
    out.push(hit);
  }
  return out;
}

export function formatHit(h: SearchHit): string {
  return `${h.stringId}  ${h.type}  «${h.name}»${h.localizedName ? ` (${h.localizedName})` : ''}${h.status !== 'base' ? `  [${h.status}]` : ''}`;
}
