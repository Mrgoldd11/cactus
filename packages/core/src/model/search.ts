/**
 * Поиск записей: по имени (английскому и русскому из gamedata.po), строковому id, типу,
 * статусу и значениям полей; плюс «где угодно» — подстрока в любом значении записи.
 */
import { decodeText } from '../text.ts';
import { itemTypeId, type ItemTypes } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import type { ModContext, RecordStatus } from './context.ts';
import { SCALAR_DICTS, scalarMap } from './record-ops.ts';
import { formatScalar } from './present.ts';
import { UiTextError } from '../ui-text.ts';

/** `~` и `:` — «содержит», `!:` — «не содержит», `regex` — регулярное выражение (`поле?шаблон`). */
export type FilterOp = '=' | '!=' | '~' | '!~' | 'regex' | '<' | '>' | '<=' | '>=' | 'exists';

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

/**
 * `key=value`, `key!=value`, `key~text` (или `key:text`), `key!:text` (не содержит), `key?шаблон`
 * (регулярное выражение, без учёта регистра), `key>=3`, `key?` (поле есть). Как в поиске FCS.
 */
export function parseFieldFilter(text: string): FieldFilter {
  const exists = /^(.+)\?$/.exec(text);
  if (exists) return { key: exists[1]!.trim(), op: 'exists' };
  const m = /^(.+?)(!=|!:|!~|<=|>=|=|~|:|\?|<|>)(.*)$/.exec(text);
  if (!m) throw new UiTextError({ en: `Cannot read condition “${text}”: use key=value, key~text, key>number or key?`, ru: `Не понял условие «${text}»: нужно ключ=значение, ключ~текст, ключ>число или ключ?`, zh: `无法理解条件 “${text}”：应为 键=值、键~文本、键>数字 或 键?` });
  const raw = m[2]!;
  const op: FilterOp = raw === ':' ? '~' : raw === '!:' ? '!~' : raw === '?' ? 'regex' : (raw as FilterOp);
  const value = m[3]!.trim();
  if (op === 'regex') regexOf(value);
  return { key: m[1]!.trim(), op, value };
}

const regexCache = new Map<string, RegExp>();

/** Регулярное выражение условия `поле?шаблон`; неверный шаблон — понятная ошибка. */
function regexOf(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    try {
      re = new RegExp(pattern, 'i');
    } catch (e) {
      throw new UiTextError({ en: `Invalid regular expression “${pattern}”: ${(e as Error).message}`, ru: `Неверное регулярное выражение «${pattern}»: ${(e as Error).message}`, zh: `无效的正则表达式 “${pattern}”：${(e as Error).message}` }, { cause: e });
    }
    if (regexCache.size > 200) regexCache.clear();
    regexCache.set(pattern, re);
  }
  return re;
}

/** Record type by number or name; `types` adds the types of schema extensions. */
export function resolveTypeFilter(type: string | number, types?: ItemTypes): number {
  if (typeof type === 'number') return type;
  if (/^\d+$/.test(type)) return Number(type);
  const id = itemTypeId(type.toUpperCase(), types);
  if (id === undefined) throw new UiTextError({ en: `Unknown record type “${type}”`, ru: `Неизвестный тип записи «${type}»`, zh: `未知的记录类型 “${type}”` });
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
    case '!~':
      return !actual.toLowerCase().includes(expected.toLowerCase());
    case 'regex':
      return regexOf(expected).test(actual);
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

const NUMERIC_OPS: readonly FilterOp[] = ['<', '>', '<=', '>='];
const REF_VALUE = /^(.+)\.v([012])$/;

/**
 * Условия по ссылкам, как в FCS: `список>5` — сколько ссылок в списке, `список.v0=4` — значение
 * ссылки (хотя бы одной), `Ref>0` — сколько записей ссылаются на эту. undefined — не такое условие.
 */
function matchRefs(ctx: ModContext, rec: GameRecord, f: FieldFilter): boolean | undefined {
  if (f.key === 'Ref') return compare(String(ctx.referencesTo(rec.stringId).length), f.op === 'exists' ? '>=' : f.op, f.op === 'exists' ? '0' : (f.value ?? ''));
  const v = REF_VALUE.exec(f.key);
  if (v) {
    const list = rec.refs.get(v[1]!);
    if (!list) return f.op === '!=' || f.op === '!~' ? true : undefined;
    const pick = Number(v[2]);
    const nums = list.map((r) => String([r.v0, r.v1, r.v2][pick]));
    if (f.op === 'exists') return list.length > 0;
    return f.op === '!=' || f.op === '!~' ? nums.every((n) => compare(n, f.op, f.value ?? '')) : nums.some((n) => compare(n, f.op, f.value ?? ''));
  }
  if (NUMERIC_OPS.includes(f.op) && rec.refs.has(f.key)) return compare(String(rec.refs.get(f.key)!.length), f.op, f.value ?? '');
  return undefined;
}

export function matchesFilter(ctx: ModContext, rec: GameRecord, f: FieldFilter): boolean {
  const special = matchRefs(ctx, rec, f);
  if (special !== undefined) return special;
  const values = fieldValues(ctx, rec, f.key);
  if (f.op === 'exists') return values !== undefined && (!rec.refs.has(f.key) || values.length > 0);
  if (values === undefined) return f.op === '!=' || f.op === '!~';
  if (f.op === '!=' || f.op === '!~') return values.every((v) => compare(v, f.op, f.value ?? ''));
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
  const type = q.type === undefined ? undefined : resolveTypeFilter(q.type, ctx.schema?.itemTypes);
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
    const hit: SearchHit = { stringId: sid, type: ctx.typeName(rec.type), name, status };
    if (ru !== undefined) hit.localizedName = ru;
    out.push(hit);
  }
  return out;
}

export function formatHit(h: SearchHit): string {
  return `${h.stringId}  ${h.type}  «${h.name}»${h.localizedName ? ` (${h.localizedName})` : ''}${h.status !== 'base' ? `  [${h.status}]` : ''}`;
}

export interface RecordLookup {
  /** Найденная запись, если она одна. */
  stringId?: string;
  /** Подходящие записи, если их несколько (или ни одной). */
  candidates: SearchHit[];
}

/**
 * Запись по строковому id или имени (англ. или рус.): сначала id, потом точное имя, потом
 * подстрока. `preferTypes` — при нескольких совпадениях оставить записи этих типов (для
 * `tree` — диалоги), если такие есть.
 */
export function lookupRecord(ctx: ModContext, spec: string, options: { preferTypes?: readonly string[] } = {}): RecordLookup {
  if (ctx.get(spec) ?? ctx.lower(spec)) return { stringId: spec, candidates: [] };
  const narrow = (hits: SearchHit[]): SearchHit[] => {
    if (hits.length <= 1 || !options.preferTypes) return hits;
    const pref = hits.filter((h) => options.preferTypes!.includes(h.type));
    return pref.length ? pref : hits;
  };
  for (const exact of [true, false]) {
    const hits = narrow(searchRecords(ctx, { text: spec, exact }));
    if (hits.length === 1) return { stringId: hits[0]!.stringId, candidates: [] };
    if (hits.length > 1) return { candidates: hits };
  }
  return { candidates: [] };
}
