/**
 * Record search: by name (English and Russian from gamedata.po), string id, type,
 * status and field values; plus "anywhere" — a substring in any value of the record.
 */
import { decodeText } from '../text.ts';
import { itemTypeId, type ItemTypes } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import type { ModContext, RecordStatus } from './context.ts';
import { SCALAR_DICTS, scalarMap } from './record-ops.ts';
import { formatScalar } from './present.ts';
import { UiTextError } from '../ui-text.ts';

/** `~` and `:` — "contains", `!:` — "does not contain", `regex` — regular expression (`field?pattern`). */
export type FilterOp = '=' | '!=' | '~' | '!~' | 'regex' | '<' | '>' | '<=' | '>=' | 'exists';

/** Field condition: a key of any dictionary or a reference category (then the value is a target id or name). */
export interface FieldFilter {
  key: string;
  op: FilterOp;
  value?: string;
  /** The key was quoted (`"type"=…`): a field of that name, never a keyword or a path through references. */
  literal?: boolean;
}

export interface SearchQuery {
  /** Substring of the name (English or Russian) or string id, case-insensitive. */
  text?: string;
  /** Exact name match only. */
  exact?: boolean;
  /** Type: name (`DIALOGUE`) or number. */
  type?: string | number;
  fields?: readonly FieldFilter[];
  status?: readonly RecordStatus[];
  /** Substring in anything: name, id, keys, values, reference targets. */
  anywhere?: string;
  /** Only records the mod defines (new, changed, deleted). */
  modOnly?: boolean;
  /** Search-box syntax (`parseSearchQuery`): words and `;`-separated conditions, all must match. */
  query?: string;
}

export interface SearchHit {
  stringId: string;
  type: string;
  name: string;
  localizedName?: string;
  status: RecordStatus;
}

/**
 * `key=value`, `key!=value`, `key~text` (or `key:text`), `key!:text` (does not contain), `key?pattern`
 * (regular expression, case-insensitive), `key>=3`, `key?` (field present). As in the FCS search.
 * Keywords: `type` (record type), `state` (base/new/changed/deleted/mod), `ref` (a referenced record;
 * with a number — how many records reference this one). `list.key=…` — some record of the reference
 * list `list` matches `key=…` (any depth). A quoted key (`"type"=…`) is always a plain field.
 */
export function parseFieldFilter(text: string): FieldFilter {
  const exists = /^(.+)\?$/.exec(text);
  if (exists) return withKey(exists[1]!, { op: 'exists' });
  const m = /^(.+?)(!=|!:|!~|<=|>=|=|~|:|\?|<|>)(.*)$/.exec(text);
  if (!m) throw new UiTextError({ en: `Cannot read condition “${text}”: use key=value, key~text, key>number or key?`, ru: `Не понял условие «${text}»: нужно ключ=значение, ключ~текст, ключ>число или ключ?`, zh: `无法理解条件 “${text}”：应为 键=值、键~文本、键>数字 或 键?` });
  const raw = m[2]!;
  const op: FilterOp = raw === ':' ? '~' : raw === '!:' ? '!~' : raw === '?' ? 'regex' : (raw as FilterOp);
  const value = m[3]!.trim();
  if (op === 'regex') regexOf(value);
  return withKey(m[1]!, { op, value });
}

function withKey(rawKey: string, rest: Omit<FieldFilter, 'key'>): FieldFilter {
  const key = rawKey.trim();
  const quoted = /^"(.+)"$/.exec(key);
  return quoted ? { key: quoted[1]!, ...rest, literal: true } : { key, ...rest };
}

const CONDITION = /!=|!:|!~|<=|>=|=|~|:|\?|<|>/;

/** Parsed search-box text: plain words (lowercase) and conditions. */
export interface ParsedQuery {
  /** Every word must be in the name, the translated name or the string id. */
  words: string[];
  filters: FieldFilter[];
}

/**
 * Search-box syntax shared by the record list, `kedit find --query` and MCP `find` `query`:
 * parts separated by `;`; a part with an operator is a condition (`parseFieldFilter`), any other
 * part is plain words. Text without operators is plain words only, exactly as before.
 * Throws UiTextError on an unreadable condition or a bad regular expression.
 */
export function parseSearchQuery(text: string): ParsedQuery {
  const { errors, ...parsed } = parseSearchQueryParts(text);
  if (errors.length) throw errors[0];
  return parsed;
}

/** Like `parseSearchQuery`, but unreadable conditions are skipped and returned as `errors` (for live typing). */
export function parseSearchQueryParts(text: string): ParsedQuery & { errors: unknown[] } {
  const words: string[] = [];
  const filters: FieldFilter[] = [];
  const errors: unknown[] = [];
  for (const part of text.split(';')) {
    const p = part.trim();
    if (!p) continue;
    if (!CONDITION.test(p)) {
      words.push(...p.toLowerCase().split(/\s+/).filter(Boolean));
      continue;
    }
    try {
      filters.push(parseFieldFilter(p));
    } catch (e) {
      errors.push(e);
    }
  }
  return { words, filters, errors };
}

type Keyword = 'type' | 'state' | 'ref';

function keywordOf(key: string): Keyword | undefined {
  const k = key.toLowerCase();
  return k === 'type' || k === 'state' || k === 'ref' ? k : undefined;
}

/**
 * Condition keys that are neither keywords nor fields of any schema type (each step of a `list.key` path is
 * checked). Empty without a schema. For a hint near the search box: such a condition matches nothing.
 */
export function unknownFilterKeys(ctx: ModContext, filters: readonly FieldFilter[]): string[] {
  const schema = ctx.schema;
  if (!schema) return [];
  const known = (k: string): boolean => {
    if (k === 'name') return true;
    for (const t of schema.types.values()) if (t.fields.has(k)) return true;
    return false;
  };
  const out: string[] = [];
  for (const f of filters) {
    if (!f.literal && keywordOf(f.key)) continue;
    if (known(f.key)) continue;
    if (f.literal) {
      out.push(f.key);
      continue;
    }
    const steps = f.key.split('.').map((s) => s.replace(/^"(.+)"$/, '$1'));
    if (steps.length > 1 && /^v[012]$/.test(steps[steps.length - 1]!)) steps.pop();
    // A keyword as the last step of a path (`vendors.type=ITEM`) is the target's record type.
    if (steps.length > 1 && keywordOf(steps[steps.length - 1]!) && !/"$/.test(f.key)) steps.pop();
    if (!steps.every(known)) out.push(f.key);
  }
  return out;
}

const regexCache = new Map<string, RegExp>();

/** Regular expression of a `field?pattern` condition; an invalid pattern gives a clear error. */
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

/** Field values of a record as text (for references — target ids and names). */
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
  // `name` is not a field: the record name and its translation.
  if (key === 'name') return [decodeText(rec.name), ctx.localizedName(rec.stringId) ?? ''];
  return undefined;
}

const NUMERIC_OPS: readonly FilterOp[] = ['<', '>', '<=', '>='];
const REF_VALUE = /^(.+)\.v([012])$/;

/**
 * Reference conditions, as in FCS: `list>5` — how many references are in the list, `list.v0=4` — a reference
 * value (at least one), `Ref>0` — how many records reference this one. undefined — not such a condition.
 */
function matchRefs(ctx: ModContext, rec: GameRecord, f: FieldFilter): boolean | undefined {
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

const NEGATIVE: readonly FilterOp[] = ['!=', '!~'];

/** Positive operators need one matching value, negative ones — all values. */
function anyOrAll(values: readonly string[], f: FieldFilter): boolean {
  if (f.op === 'exists') return values.length > 0;
  return NEGATIVE.includes(f.op) ? values.every((v) => compare(v, f.op, f.value ?? '')) : values.some((v) => compare(v, f.op, f.value ?? ''));
}

/** `type`, `state`, `ref` conditions. */
function matchKeyword(ctx: ModContext, rec: GameRecord, kw: Keyword, f: FieldFilter): boolean {
  switch (kw) {
    case 'type': {
      // Type names compare case-insensitively: `type=character` works too.
      const g = { ...f, value: (f.value ?? '').toUpperCase() };
      return anyOrAll([ctx.typeName(rec.type).toUpperCase(), String(rec.type)], g);
    }
    case 'state': {
      const st = ctx.status(rec.stringId) ?? 'base';
      const g = { ...f, value: (f.value ?? '').toLowerCase() };
      return anyOrAll(st === 'base' ? [st] : [st, 'mod'], g);
    }
    case 'ref': {
      // A number or `ref?`: how many records reference this one (FCS `Ref>0`); text: a record this one references.
      const count = (): number => ctx.referencesTo(rec.stringId).length;
      if (f.op === 'exists') return count() > 0;
      if (NUMERIC_OPS.includes(f.op) || ((f.op === '=' || f.op === '!=') && /^\d+$/.test(f.value ?? ''))) return compare(String(count()), f.op, f.value ?? '');
      const values: string[] = [];
      for (const list of rec.refs.values()) for (const r of list) values.push(r.target, ctx.name(r.target) ?? '', ctx.localizedName(r.target) ?? '');
      return anyOrAll(values, f);
    }
  }
}

/** Record by string id, or its last state in the lower layers if the mod deleted it. */
function recordOf(ctx: ModContext, sid: string): GameRecord | undefined {
  return ctx.get(sid) ?? ctx.lower(sid);
}

/** Paths deeper than this stop matching: a guard against absurd keys, not a real limit. */
const MAX_PATH_DEPTH = 8;

/**
 * `list.key…` path: the condition `key…` on the records of the reference list `list` (recursively).
 * undefined — the key is not such a path.
 */
function matchPath(ctx: ModContext, rec: GameRecord, f: FieldFilter, depth: number): boolean | undefined {
  const dot = f.key.indexOf('.');
  if (dot <= 0 || dot === f.key.length - 1) return undefined;
  const list = rec.refs.get(f.key.slice(0, dot));
  const negative = NEGATIVE.includes(f.op);
  if (!list || list.length === 0) return negative;
  // `list."type"` — the rest is a plain field of the target, not a keyword.
  const rest = f.key.slice(dot + 1);
  const quoted = /^"(.+)"$/.exec(rest);
  const sub: FieldFilter = quoted ? { ...f, key: quoted[1]!, literal: true } : { ...f, key: rest };
  const test = (sid: string): boolean => {
    const target = recordOf(ctx, sid);
    // A broken reference has no properties: only a negative condition holds.
    return target ? matchFilterAt(ctx, target, sub, depth + 1) : negative;
  };
  return negative ? list.every((r) => test(r.target)) : list.some((r) => test(r.target));
}

function matchFilterAt(ctx: ModContext, rec: GameRecord, f: FieldFilter, depth: number): boolean {
  if (!f.literal) {
    const kw = keywordOf(f.key);
    if (kw) return matchKeyword(ctx, rec, kw, f);
    const special = matchRefs(ctx, rec, f);
    if (special !== undefined) return special;
  }
  const values = fieldValues(ctx, rec, f.key);
  if (values === undefined && !f.literal && depth < MAX_PATH_DEPTH) {
    const path = matchPath(ctx, rec, f, depth);
    if (path !== undefined) return path;
  }
  if (f.op === 'exists') return values !== undefined && (!rec.refs.has(f.key) || values.length > 0);
  if (values === undefined) return NEGATIVE.includes(f.op);
  return anyOrAll(values, f);
}

/** Does the record satisfy the condition (keywords, reference counts and values, `list.key` paths, fields). */
export function matchesFilter(ctx: ModContext, rec: GameRecord, f: FieldFilter): boolean {
  return matchFilterAt(ctx, rec, f, 0);
}

/** All record contents as one lowercase string — for the "anywhere" search. */
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

/** All matches in layer order (order of first appearance of records). */
export function searchRecords(ctx: ModContext, q: SearchQuery): SearchHit[] {
  const type = q.type === undefined ? undefined : resolveTypeFilter(q.type, ctx.schema?.itemTypes);
  const text = q.text?.toLowerCase();
  const anywhere = q.anywhere?.toLowerCase();
  const statuses = q.status ? new Set(q.status) : undefined;
  const parsed = q.query !== undefined ? parseSearchQuery(q.query) : undefined;
  const ids = q.modOnly ? ctx.modRecords().map((r) => r.stringId) : ctx.allStringIds();
  const out: SearchHit[] = [];
  for (const sid of ids) {
    const status = ctx.status(sid);
    if (!status) continue;
    if (statuses && !statuses.has(status)) continue;
    // Records deleted by the mod are searched by their last state in the lower layers.
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
    if (parsed) {
      const hay = `${name}\n${ru ?? ''}\n${sid}`.toLowerCase();
      if (!parsed.words.every((w) => hay.includes(w))) continue;
      if (!parsed.filters.every((f) => matchesFilter(ctx, rec, f))) continue;
    }
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
  /** The found record, if there is exactly one. */
  stringId?: string;
  /** Matching records, if there are several (or none). */
  candidates: SearchHit[];
}

/**
 * Record by string id or name (English or Russian): id first, then exact name, then
 * substring. `preferTypes` — with several matches keep records of these types (for
 * `tree` — dialogues), if there are any.
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
