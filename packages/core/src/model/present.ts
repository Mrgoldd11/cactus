/**
 * Компактное текстовое представление записей, ссылок и разниц — для CLI и MCP.
 * Ссылки всегда показываются с именем цели: `Имя [sid]`.
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Instance, Reference } from '../format/types.ts';
import { applyLayer, isRemovedRef, SCALAR_DICTS, scalarMap, type ScalarDict, type ScalarValue } from './record-ops.ts';
import type { Changeset, ModContext } from './context.ts';
import { diffRecordStates, type FieldChange, type RecordDiff } from './diff.ts';
import { describeDialogAction, describeRefValues, enumValue, fieldEnum, formatEnumValue } from './enums.ts';

/** Кратчайшая запись float32, которая читается обратно в то же число. */
export function formatFloat(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  for (let p = 1; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(Number(s)) === v) return String(Number(s));
  }
  return String(v);
}

export function formatScalar(dict: ScalarDict, v: ScalarValue): string {
  switch (dict) {
    case 'bools':
      return v ? 'true' : 'false';
    case 'floats':
      return formatFloat(v as number);
    case 'ints':
      return String(v);
    case 'vec3s':
    case 'vec4s':
      return `(${(v as number[]).map(formatFloat).join(', ')})`;
    case 'strings':
    case 'files':
      return JSON.stringify(decodeText(v as Uint8Array));
  }
}

const DICT_LABEL: Record<ScalarDict, string> = {
  bools: 'bool',
  floats: 'float',
  ints: 'int',
  vec3s: 'vec3',
  vec4s: 'vec4',
  strings: 'str',
  files: 'file',
};

export function dictLabel(dict: ScalarDict): string {
  return DICT_LABEL[dict];
}

/** `Имя [sid]`; для отсутствующей цели — `<нет> [sid]`, для удалённой — `<удалена> Имя [sid]`. */
export function refLabel(ctx: ModContext, target: string): string {
  const rec = ctx.get(target);
  if (rec) return `${decodeText(rec.name)} [${target}]`;
  const lower = ctx.lower(target);
  if (lower || ctx.status(target) === 'deleted') return `<удалена> ${decodeText((lower ?? ctx.delta(target))!.name)} [${target}]`;
  return `<нет> [${target}]`;
}

export function formatRefValues(r: Reference): string {
  if (isRemovedRef(r)) return 'удалить';
  return `${r.v0} ${r.v1} ${r.v2}`;
}

function formatInstance(ctx: ModContext, i: Instance): string {
  return `${refLabel(ctx, i.target)} pos (${i.position.map(formatFloat).join(', ')}) rot (${i.rotation.map(formatFloat).join(', ')})${i.states.length ? ` states ${i.states.length}` : ''}`;
}

/** Заголовок записи: `ТИП sid «имя» (рус.) — статус`. */
export function recordHeadline(ctx: ModContext, rec: GameRecord): string {
  const ru = ctx.localizedName(rec.stringId);
  const status = ctx.status(rec.stringId);
  return `${itemTypeName(rec.type)} ${rec.stringId} «${decodeText(rec.name)}»${ru ? ` (${ru})` : ''}${status && status !== 'base' ? ` — ${status}` : ''}`;
}

export interface FormatRecordOptions {
  /** Категории ссылок, которые не показывать. */
  hideCategories?: readonly string[];
  /** Сколько ссылок показывать в одной категории (остальные — «… ещё N»). */
  maxRefsPerCategory?: number;
  /** Показывать слои, в которых задана запись. */
  showLayers?: boolean;
}

/** Запись построчно: поля по словарям, затем ссылки с именами целей и объекты. */
export function formatRecord(ctx: ModContext, rec: GameRecord, options: FormatRecordOptions = {}): string[] {
  const out = [recordHeadline(ctx, rec)];
  if (options.showLayers) {
    const o = ctx.origin(rec.stringId);
    if (o) out.push(`  слои: ${o.layers.join(' → ')}${o.deletedBelow ? ` (удалена в ${o.deletedBelow})` : ''}`);
  }
  for (const dict of SCALAR_DICTS) {
    for (const [k, v] of scalarMap(rec, dict)) out.push(`  ${DICT_LABEL[dict]} ${k} = ${formatFieldValue(ctx, rec, dict, k, v)}`);
  }
  const typeName = itemTypeName(rec.type);
  const hide = new Set(options.hideCategories ?? []);
  const max = options.maxRefsPerCategory ?? Infinity;
  for (const [cat, list] of rec.refs) {
    if (hide.has(cat)) {
      out.push(`  ref ${cat}: ${list.length} (скрыто)`);
      continue;
    }
    if (list.length === 0) continue;
    out.push(`  ref ${cat}:`);
    for (const r of list.slice(0, max)) {
      const note = isRemovedRef(r) ? undefined : (describeDialogAction(ctx, r, cat) ?? describeRefValues(ctx.schema, typeName, cat, r));
      out.push(`    → ${refLabel(ctx, r.target)}  ${formatRefValues(r)}${note !== undefined ? `  — ${note}` : ''}`);
    }
    if (list.length > max) out.push(`    … ещё ${list.length - max}`);
  }
  for (const [k, i] of rec.instances) out.push(`  inst ${k}: ${formatInstance(ctx, i)}`);
  return out;
}

/**
 * Значение поля для показа: у enum — имя (`DR_ONCE_ONLY «один раз» (5)`), иначе как
 * `formatScalar`.
 */
export function formatFieldValue(ctx: ModContext, rec: GameRecord, dict: ScalarDict, key: string, v: ScalarValue): string {
  if (dict === 'ints') {
    const def = fieldEnum(ctx.schema, itemTypeName(rec.type), key, rec);
    if (def) return formatEnumValue(def, v as number);
  }
  return formatScalar(dict, v);
}

/** Одна строка изменения поля/ссылки; `rec` — запись после изменения (для имён enum). */
export function formatFieldChange(ctx: ModContext, c: FieldChange, rec?: GameRecord): string {
  const fmt = (dict: ScalarDict, key: string, v: ScalarValue): string => (rec ? formatFieldValue(ctx, rec, dict, key, v) : formatScalar(dict, v));
  switch (c.kind) {
    case 'name':
      return `имя: «${decodeText(c.before)}» → «${decodeText(c.after)}»`;
    case 'type':
      return `тип: ${itemTypeName(c.before)} → ${itemTypeName(c.after)}`;
    case 'flags':
      return `флаги: 0x${c.before.toString(16)} → 0x${c.after.toString(16)}`;
    case 'field': {
      const label = `${DICT_LABEL[c.dict]} ${c.key}`;
      if (c.before === undefined) return `+ ${label} = ${fmt(c.dict, c.key, c.after!)}`;
      if (c.after === undefined) return `− ${label} (было ${fmt(c.dict, c.key, c.before)})`;
      return `~ ${label}: ${fmt(c.dict, c.key, c.before)} → ${fmt(c.dict, c.key, c.after)}`;
    }
    case 'ref': {
      const label = `ref ${c.category} → ${refLabel(ctx, c.target.replace(/#\d+$/, ''))}`;
      if (!c.before) return `+ ${label}  ${formatRefValues(c.after!)}`;
      if (!c.after) return `− ${label}`;
      return `~ ${label}: ${formatRefValues(c.before)} → ${formatRefValues(c.after)}`;
    }
    case 'refOrder':
      return `~ ref ${c.category}: порядок ${c.before.length} ссылок изменён`;
    case 'instance':
      if (!c.before) return `+ inst ${c.key}: ${formatInstance(ctx, c.after!)}`;
      if (!c.after) return `− inst ${c.key}`;
      return `~ inst ${c.key}: ${formatInstance(ctx, c.before)} → ${formatInstance(ctx, c.after)}`;
  }
}

export function formatRecordDiff(ctx: ModContext, d: RecordDiff): string[] {
  const rec = (d.after ?? d.before)!;
  const mark = d.change === 'added' ? '+' : d.change === 'removed' ? '−' : '~';
  const head = `${mark} ${itemTypeName(rec.type)} ${d.stringId} «${decodeText(rec.name)}»`;
  if (d.change !== 'changed') return [head];
  return [head, ...d.fields.map((c) => `    ${formatFieldChange(ctx, c, rec)}`)];
}

/** Что мод меняет в записи относительно нижних слоёв. */
export function modRecordDiff(ctx: ModContext, stringId: string): RecordDiff | undefined {
  return diffRecordStates(ctx.lower(stringId), ctx.get(stringId));
}

/** Итоговые разницы правки (по записям): состояние до и после. */
export function changesetDiff(ctx: ModContext, cs: Changeset): RecordDiff[] {
  const first = new Map<string, GameRecord | undefined>();
  const last = new Map<string, GameRecord | undefined>();
  for (const op of cs.ops) {
    if (op.kind !== 'record') continue;
    const lower = ctx.lower(op.stringId);
    const resolve = (delta: GameRecord | undefined): GameRecord | undefined => (delta ? applyLayer(lower, delta) : lower);
    if (!first.has(op.stringId)) first.set(op.stringId, resolve(op.before?.delta));
    last.set(op.stringId, resolve(op.after?.delta));
  }
  const out: RecordDiff[] = [];
  for (const [sid, before] of first) {
    const d = diffRecordStates(before, last.get(sid));
    if (d) out.push(d);
  }
  return out;
}

/** Правка текстом: заголовок и изменения по записям. */
export function formatChangeset(ctx: ModContext, cs: Changeset): string[] {
  const lines = [`#${cs.id} ${cs.label}`];
  for (const op of cs.ops) {
    if (op.kind === 'info') {
      for (const k of Object.keys(op.after) as (keyof typeof op.after)[]) {
        const a = JSON.stringify(op.before[k]);
        const b = JSON.stringify(op.after[k]);
        if (a !== b) lines.push(`  заголовок ${k}: ${a} → ${b}`);
      }
    }
  }
  for (const d of changesetDiff(ctx, cs)) lines.push(...formatRecordDiff(ctx, d).map((l) => `  ${l}`));
  return lines;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  /** Смещение следующей страницы, если она есть. */
  next?: number;
}

export function page<T>(items: readonly T[], offset = 0, limit = 50): Page<T> {
  const start = Math.max(0, offset);
  const slice = items.slice(start, start + limit);
  const out: Page<T> = { items: slice, total: items.length, offset: start };
  if (start + slice.length < items.length) out.next = start + slice.length;
  return out;
}

/** Строка «показано a–b из N; дальше: offset=…». */
export function pageFooter(p: Page<unknown>): string {
  if (p.total === 0) return 'ничего не найдено';
  const tail = p.next !== undefined ? `; дальше offset=${p.next}` : '';
  return `показано ${p.offset + 1}–${p.offset + p.items.length} из ${p.total}${tail}`;
}

export interface RecordJson {
  stringId: string;
  type: string;
  name: string;
  localizedName?: string;
  status?: string;
  layers?: string[];
  fields: Record<string, Record<string, boolean | number | string | number[]>>;
  /** Имена значений enum-полей: поле → имя (`repetition limit` → `DR_ONCE_ONLY`). */
  enums?: Record<string, string>;
  /** `note` — условие/действие диалога или имя события пакета. */
  refs: Record<string, { target: string; name: string; values: number[]; note?: string }[]>;
  instances: Record<string, { target: string; name: string; position: number[]; rotation: number[]; states: number }>;
}

/** Запись как JSON: поля по словарям, ссылки с именами целей. */
export function recordToJson(ctx: ModContext, rec: GameRecord, options: { maxRefsPerCategory?: number } = {}): RecordJson {
  const out: RecordJson = { stringId: rec.stringId, type: itemTypeName(rec.type), name: decodeText(rec.name), fields: {}, refs: {}, instances: {} };
  const ru = ctx.localizedName(rec.stringId);
  if (ru) out.localizedName = ru;
  const st = ctx.status(rec.stringId);
  if (st) out.status = st;
  const o = ctx.origin(rec.stringId);
  if (o) out.layers = o.layers;
  for (const dict of SCALAR_DICTS) {
    const m = scalarMap(rec, dict);
    if (m.size === 0) continue;
    const d: Record<string, boolean | number | string | number[]> = {};
    for (const [k, v] of m) d[k] = v instanceof Uint8Array ? decodeText(v) : Array.isArray(v) ? [...v] : (v);
    out.fields[DICT_LABEL[dict]] = d;
  }
  const typeName = itemTypeName(rec.type);
  for (const [k, v] of rec.ints) {
    const def = fieldEnum(ctx.schema, typeName, k, rec);
    const ev = def && enumValue(def, v);
    if (ev) (out.enums ??= {})[k] = ev.name;
  }
  const max = options.maxRefsPerCategory ?? Infinity;
  for (const [cat, list] of rec.refs) {
    if (list.length === 0) continue;
    out.refs[cat] = list.slice(0, max).map((r) => {
      const item: RecordJson['refs'][string][number] = { target: r.target, name: ctx.name(r.target) ?? '<нет>', values: [r.v0, r.v1, r.v2] };
      const note = isRemovedRef(r) ? undefined : (describeDialogAction(ctx, r, cat) ?? describeRefValues(ctx.schema, typeName, cat, r));
      if (note !== undefined) item.note = note;
      return item;
    });
  }
  for (const [k, i] of rec.instances) {
    out.instances[k] = { target: i.target, name: ctx.name(i.target) ?? '<нет>', position: [...i.position], rotation: [...i.rotation], states: i.states.length };
  }
  return out;
}
