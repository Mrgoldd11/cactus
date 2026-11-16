/**
 * Компактное текстовое представление записей, ссылок и разниц — для CLI и MCP.
 * Ссылки всегда показываются с именем цели: `Имя [sid]`.
 */
import { decodeText } from '../text.ts';
import type { GameRecord, Instance, Reference } from '../format/types.ts';
import { applyLayer, isRemovedRef, SCALAR_DICTS, scalarMap, type ScalarDict, type ScalarValue } from './record-ops.ts';
import type { Changeset, ModContext } from './context.ts';
import { diffRecordStates, type FieldChange, type RecordDiff } from './diff.ts';
import { describeDialogAction, describeRefValues, enumValue, fieldEnum, formatEnumValue } from './enums.ts';

/** Words of the record texts in one interface language. */
interface PresentWords {
  deleted: string;
  missing: string;
  remove: string;
  layers: string;
  deletedIn: (layer: string) => string;
  hidden: string;
  more: (n: number) => string;
  name: string;
  type: string;
  flags: string;
  was: string;
  order: (n: number) => string;
  header: string;
  nothingFound: string;
  shown: (from: number, to: number, total: number) => string;
  next: (offset: number) => string;
}

const EN: PresentWords = {
  deleted: '<deleted>',
  missing: '<missing>',
  remove: 'remove',
  layers: 'layers',
  deletedIn: (l) => `deleted in ${l}`,
  hidden: 'hidden',
  more: (n) => `… ${n} more`,
  name: 'name',
  type: 'type',
  flags: 'flags',
  was: 'was',
  order: (n) => `order of ${n} references changed`,
  header: 'header',
  nothingFound: 'nothing found',
  shown: (a, b, t) => `shown ${a}–${b} of ${t}`,
  next: (o) => `; next offset=${o}`,
};

const RU: PresentWords = {
  deleted: '<удалена>',
  missing: '<нет>',
  remove: 'удалить',
  layers: 'слои',
  deletedIn: (l) => `удалена в ${l}`,
  hidden: 'скрыто',
  more: (n) => `… ещё ${n}`,
  name: 'имя',
  type: 'тип',
  flags: 'флаги',
  was: 'было',
  order: (n) => `порядок ${n} ссылок изменён`,
  header: 'заголовок',
  nothingFound: 'ничего не найдено',
  shown: (a, b, t) => `показано ${a}–${b} из ${t}`,
  next: (o) => `; дальше offset=${o}`,
};

const ZH: PresentWords = {
  deleted: '<已删除>',
  missing: '<不存在>',
  remove: '删除',
  layers: '图层',
  deletedIn: (l) => `已在 ${l} 中删除`,
  hidden: '已隐藏',
  more: (n) => `… 还有 ${n} 个`,
  name: '名称',
  type: '类型',
  flags: '标志',
  was: '原为',
  order: (n) => `${n} 个引用的顺序已更改`,
  header: '头部',
  nothingFound: '未找到任何内容',
  shown: (a, b, t) => `显示 ${a}–${b}，共 ${t}`,
  next: (o) => `；下一页 offset=${o}`,
};

const PRESENT_WORDS: Record<string, PresentWords> = { en: EN, ru: RU, zh: ZH };
const words = (lang: string): PresentWords => PRESENT_WORDS[lang] ?? EN;

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
export function refLabel(ctx: ModContext, target: string, lang = 'en'): string {
  const w = words(lang);
  const rec = ctx.get(target);
  if (rec) return `${decodeText(rec.name)} [${target}]`;
  const lower = ctx.lower(target);
  if (lower || ctx.status(target) === 'deleted') return `${w.deleted} ${decodeText((lower ?? ctx.delta(target))!.name)} [${target}]`;
  return `${w.missing} [${target}]`;
}

export function formatRefValues(r: Reference, lang = 'en'): string {
  if (isRemovedRef(r)) return words(lang).remove;
  return `${r.v0} ${r.v1} ${r.v2}`;
}

function formatInstance(ctx: ModContext, i: Instance, lang = 'en'): string {
  return `${refLabel(ctx, i.target, lang)} pos (${i.position.map(formatFloat).join(', ')}) rot (${i.rotation.map(formatFloat).join(', ')})${i.states.length ? ` states ${i.states.length}` : ''}`;
}

/** Заголовок записи: `ТИП sid «имя» (рус.) — статус`. */
export function recordHeadline(ctx: ModContext, rec: GameRecord): string {
  const ru = ctx.localizedName(rec.stringId);
  const status = ctx.status(rec.stringId);
  return `${ctx.typeName(rec.type)} ${rec.stringId} «${decodeText(rec.name)}»${ru ? ` (${ru})` : ''}${status && status !== 'base' ? ` — ${status}` : ''}`;
}

export interface FormatRecordOptions {
  /** Категории ссылок, которые не показывать. */
  hideCategories?: readonly string[];
  /** Сколько ссылок показывать в одной категории (остальные — «… ещё N»). */
  maxRefsPerCategory?: number;
  /** Показывать слои, в которых задана запись. */
  showLayers?: boolean;
  /** Interface language of the words (English by default). */
  lang?: string;
}

/** Запись построчно: поля по словарям, затем ссылки с именами целей и объекты. */
export function formatRecord(ctx: ModContext, rec: GameRecord, options: FormatRecordOptions = {}): string[] {
  const lang = options.lang ?? 'en';
  const w = words(lang);
  const out = [recordHeadline(ctx, rec)];
  if (options.showLayers) {
    const o = ctx.origin(rec.stringId);
    if (o) out.push(`  ${w.layers}: ${o.layers.join(' → ')}${o.deletedBelow ? ` (${w.deletedIn(o.deletedBelow)})` : ''}`);
  }
  for (const dict of SCALAR_DICTS) {
    for (const [k, v] of scalarMap(rec, dict)) out.push(`  ${DICT_LABEL[dict]} ${k} = ${formatFieldValue(ctx, rec, dict, k, v, lang)}`);
  }
  const typeName = ctx.typeName(rec.type);
  const hide = new Set(options.hideCategories ?? []);
  const max = options.maxRefsPerCategory ?? Infinity;
  for (const [cat, list] of rec.refs) {
    if (hide.has(cat)) {
      out.push(`  ref ${cat}: ${list.length} (${w.hidden})`);
      continue;
    }
    if (list.length === 0) continue;
    out.push(`  ref ${cat}:`);
    for (const r of list.slice(0, max)) {
      const note = isRemovedRef(r) ? undefined : (describeDialogAction(ctx, r, cat) ?? describeRefValues(ctx.schema, typeName, cat, r));
      out.push(`    → ${refLabel(ctx, r.target, lang)}  ${formatRefValues(r, lang)}${note !== undefined ? `  — ${note}` : ''}`);
    }
    if (list.length > max) out.push(`    ${w.more(list.length - max)}`);
  }
  for (const [k, i] of rec.instances) out.push(`  inst ${k}: ${formatInstance(ctx, i, lang)}`);
  return out;
}

/**
 * Значение поля для показа: у enum — имя (`DR_ONCE_ONLY «один раз» (5)`), иначе как
 * `formatScalar`.
 */
export function formatFieldValue(ctx: ModContext, rec: GameRecord, dict: ScalarDict, key: string, v: ScalarValue, lang = 'en'): string {
  if (dict === 'ints') {
    const def = fieldEnum(ctx.schema, ctx.typeName(rec.type), key, rec);
    if (def) return formatEnumValue(def, v as number, lang);
  }
  return formatScalar(dict, v);
}

/** Одна строка изменения поля/ссылки; `rec` — запись после изменения (для имён enum). */
export function formatFieldChange(ctx: ModContext, c: FieldChange, rec?: GameRecord, lang = 'en'): string {
  const w = words(lang);
  const fmt = (dict: ScalarDict, key: string, v: ScalarValue): string => (rec ? formatFieldValue(ctx, rec, dict, key, v, lang) : formatScalar(dict, v));
  switch (c.kind) {
    case 'name':
      return `${w.name}: «${decodeText(c.before)}» → «${decodeText(c.after)}»`;
    case 'type':
      return `${w.type}: ${ctx.typeName(c.before)} → ${ctx.typeName(c.after)}`;
    case 'flags':
      return `${w.flags}: 0x${c.before.toString(16)} → 0x${c.after.toString(16)}`;
    case 'field': {
      const label = `${DICT_LABEL[c.dict]} ${c.key}`;
      if (c.before === undefined) return `+ ${label} = ${fmt(c.dict, c.key, c.after!)}`;
      if (c.after === undefined) return `− ${label} (${w.was} ${fmt(c.dict, c.key, c.before)})`;
      return `~ ${label}: ${fmt(c.dict, c.key, c.before)} → ${fmt(c.dict, c.key, c.after)}`;
    }
    case 'ref': {
      const label = `ref ${c.category} → ${refLabel(ctx, c.target.replace(/#\d+$/, ''), lang)}`;
      if (!c.before) return `+ ${label}  ${formatRefValues(c.after!, lang)}`;
      if (!c.after) return `− ${label}`;
      return `~ ${label}: ${formatRefValues(c.before, lang)} → ${formatRefValues(c.after, lang)}`;
    }
    case 'refOrder':
      return `~ ref ${c.category}: ${w.order(c.before.length)}`;
    case 'instance':
      if (!c.before) return `+ inst ${c.key}: ${formatInstance(ctx, c.after!, lang)}`;
      if (!c.after) return `− inst ${c.key}`;
      return `~ inst ${c.key}: ${formatInstance(ctx, c.before, lang)} → ${formatInstance(ctx, c.after, lang)}`;
  }
}

export function formatRecordDiff(ctx: ModContext, d: RecordDiff, lang = 'en'): string[] {
  const rec = (d.after ?? d.before)!;
  const mark = d.change === 'added' ? '+' : d.change === 'removed' ? '−' : '~';
  const head = `${mark} ${ctx.typeName(rec.type)} ${d.stringId} «${decodeText(rec.name)}»`;
  if (d.change !== 'changed') return [head];
  return [head, ...d.fields.map((c) => `    ${formatFieldChange(ctx, c, rec, lang)}`)];
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
export function formatChangeset(ctx: ModContext, cs: Changeset, lang = 'en'): string[] {
  const lines = [`#${cs.id} ${cs.label}`];
  for (const op of cs.ops) {
    if (op.kind === 'info') {
      for (const k of Object.keys(op.after) as (keyof typeof op.after)[]) {
        const a = JSON.stringify(op.before[k]);
        const b = JSON.stringify(op.after[k]);
        if (a !== b) lines.push(`  ${words(lang).header} ${k}: ${a} → ${b}`);
      }
    }
  }
  for (const d of changesetDiff(ctx, cs)) lines.push(...formatRecordDiff(ctx, d, lang).map((l) => `  ${l}`));
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
export function pageFooter(p: Page<unknown>, lang = 'en'): string {
  const w = words(lang);
  if (p.total === 0) return w.nothingFound;
  const tail = p.next !== undefined ? w.next(p.next) : '';
  return `${w.shown(p.offset + 1, p.offset + p.items.length, p.total)}${tail}`;
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
  const out: RecordJson = { stringId: rec.stringId, type: ctx.typeName(rec.type), name: decodeText(rec.name), fields: {}, refs: {}, instances: {} };
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
  const typeName = ctx.typeName(rec.type);
  for (const [k, v] of rec.ints) {
    const def = fieldEnum(ctx.schema, typeName, k, rec);
    const ev = def && enumValue(def, v);
    if (ev) (out.enums ??= {})[k] = ev.name;
  }
  const max = options.maxRefsPerCategory ?? Infinity;
  for (const [cat, list] of rec.refs) {
    if (list.length === 0) continue;
    out.refs[cat] = list.slice(0, max).map((r) => {
      const item: RecordJson['refs'][string][number] = { target: r.target, name: ctx.name(r.target) ?? EN.missing, values: [r.v0, r.v1, r.v2] };
      const note = isRemovedRef(r) ? undefined : (describeDialogAction(ctx, r, cat) ?? describeRefValues(ctx.schema, typeName, cat, r));
      if (note !== undefined) item.note = note;
      return item;
    });
  }
  for (const [k, i] of rec.instances) {
    out.instances[k] = { target: i.target, name: ctx.name(i.target) ?? EN.missing, position: [...i.position], rotation: [...i.rotation], states: i.states.length };
  }
  return out;
}
