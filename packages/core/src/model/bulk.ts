/**
 * Массовые правки (этап 5): записи одного типа по условиям полей → одна операция над полем
 * (задать, умножить, прибавить, заменить текст, в том числе по regex). Сначала предпросмотр
 * «было → станет», потом применение одной правкой (одна отмена на всю пачку). Правки
 * выражены обычными операциями `set`/`rename` — их же отправляет MCP в окно редактора.
 */
import { decodeText } from '../text.ts';
import { errorMessage, type UiText } from '../ui-text.ts';
import type { GameRecord } from '../format/types.ts';
import { DICT_FOR_KIND, findField } from '../schema/game-schema.ts';
import { EditError, type ModContext } from './context.ts';
import { lookupRecord } from './search.ts';
import { compareText } from './compare.ts';
import { fieldEnum, parseEnumValue } from './enums.ts';
import { applyOps, coerceValue, type EditOp } from './ops.ts';
import { scalarEqual, scalarMap, type ScalarDict, type ScalarValue } from './record-ops.ts';
import { matchesFilter, type FieldFilter } from './search.ts';

/** set/mul/add/replace — поле записи; refAdd/refRemove — ссылки в списке (категории) записи. */
export type BulkKind = 'set' | 'mul' | 'add' | 'replace' | 'refAdd' | 'refRemove';
export const BULK_KINDS: readonly BulkKind[] = ['set', 'mul', 'add', 'replace', 'refAdd', 'refRemove'];
export const BULK_REF_KINDS: readonly BulkKind[] = ['refAdd', 'refRemove'];

/** Имя записи как поле для замены текста. */
export const BULK_NAME_FIELD = 'name';

export interface BulkQuery {
  /** Тип записей: имя (`WEAPON`) или номер. */
  type: string | number;
  /** Все условия должны выполняться (как `--field` у find). */
  fields?: readonly FieldFilter[];
  /** Подстрока имени (англ. или рус.) или id. */
  text?: string;
  /** Только записи, которые уже есть в моде. */
  modOnly?: boolean;
  /** Готовый список id (индекс редактора), иначе перебираются все записи. */
  ids?: Iterable<string>;
}

export interface BulkOperation {
  kind: BulkKind;
  /** Ключ поля; для `replace` можно `name` — имя записи. */
  field: string;
  /** set — новое значение (enum — имя или число); mul/add — число; replace — на что заменить. */
  value: string;
  /** replace: что искать (подстрока или regex). */
  find?: string;
  regex?: boolean;
  /** replace: с учётом регистра (по умолчанию без). */
  caseSensitive?: boolean;
  /** refAdd: значения ссылки v0..v2 (не заданы — у новой ссылки по умолчанию из схемы, у старой не меняются). */
  values?: number[];
}

export interface BulkChange {
  sid: string;
  name: string;
  field: string;
  before: string;
  after: string;
}

export interface BulkSkip {
  sid: string;
  name: string;
  reason: string;
}

export interface BulkPreview {
  /** Сколько записей подошло под условия. */
  matched: number;
  /** Что изменится (записи, где значение станет другим). */
  changes: BulkChange[];
  /** Подошли, но править нельзя (нет поля, не тот вид). */
  skipped: BulkSkip[];
  /** Операции для применения (`applyOps` или набор изменений в окне редактора). */
  ops: EditOp[];
  /** Подпись шага в истории. */
  label: string;
}

/** Записи типа по условиям, без удалённых модом; порядок — как в слоях. */
export function bulkSelect(ctx: ModContext, query: BulkQuery): GameRecord[] {
  const type = typeof query.type === 'number' ? query.type : /^\d+$/.test(query.type) ? Number(query.type) : ctx.typeId(query.type.toUpperCase());
  if (type === undefined) throw new EditError({ en: `Unknown record type “${String(query.type)}”`, ru: `Неизвестный тип записи «${String(query.type)}»`, zh: `未知的记录类型 “${String(query.type)}”` });
  const text = query.text?.trim().toLowerCase();
  const out: GameRecord[] = [];
  for (const sid of query.ids ?? ctx.allStringIds()) {
    const rec = ctx.get(sid);
    if (!rec || rec.type !== type) continue;
    const status = ctx.status(sid);
    if (status === 'deleted') continue;
    if (query.modOnly && status === 'base') continue;
    if (text) {
      const hay = `${sid}\n${decodeText(rec.name)}\n${ctx.localizedName(sid) ?? ''}`.toLowerCase();
      if (!hay.includes(text)) continue;
    }
    if (query.fields && !query.fields.every((f) => matchesFilter(ctx, rec, f))) continue;
    out.push(rec);
  }
  return out;
}

/** Регулярное выражение для замены (всегда глобальное). */
function pattern(op: BulkOperation): RegExp {
  const find = op.find ?? '';
  if (find === '') throw new EditError({ en: 'Text replace: give the text to find', ru: 'Замена текста: укажите, что искать', zh: '替换文本：请指定要查找的内容' });
  const flags = `g${op.caseSensitive ? '' : 'i'}u`;
  try {
    return new RegExp(op.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch (e) {
    throw new EditError({ en: `Invalid regular expression “${find}”: ${(e as Error).message}`, ru: `Неверное регулярное выражение «${find}»: ${(e as Error).message}`, zh: `无效的正则表达式 “${find}”：${(e as Error).message}` });
  }
}

function number(text: string, what: UiText): number {
  const n = Number(text.trim().replace('−', '-').replace(',', '.'));
  if (text.trim() === '' || !Number.isFinite(n)) throw new EditError({ en: `${what.en}: a number is needed, not “${text}”`, ru: `${what.ru ?? what.en}: нужно число, а не «${text}»`, zh: `${what.zh ?? what.en}：需要数字，而不是 “${text}”` });
  return n;
}

/** Поле записи: словарь и значение; нет в записи — по схеме (значение по умолчанию). */
function fieldOf(ctx: ModContext, rec: GameRecord, key: string): { dict: ScalarDict; value: ScalarValue | undefined } | undefined {
  for (const dict of ['bools', 'ints', 'floats', 'strings', 'files'] as const) {
    const v = scalarMap(rec, dict).get(key);
    if (v !== undefined) return { dict, value: v };
  }
  const ts = ctx.schema?.types.get(ctx.typeName(rec.type));
  const f = ts ? findField(ts, key) : undefined;
  const dict = f ? DICT_FOR_KIND[f.kind] : undefined;
  if (!f || dict === undefined || dict === 'refs' || dict === 'instances' || dict === 'vec3s' || dict === 'vec4s') return undefined;
  let value: ScalarValue | undefined;
  if (typeof f.default === 'number' && (dict === 'ints' || dict === 'floats')) value = f.default;
  else if (typeof f.default === 'boolean' && dict === 'bools') value = f.default;
  return { dict, value };
}

/** Words of the bulk edit texts in one interface language. */
interface BulkWords {
  noField: (key: string) => string;
  notText: (key: string) => string;
  notNumber: (key: string) => string;
  noValue: (key: string) => string;
  noRefList: (category: string) => string;
  moreChanges: (n: number) => string;
  skip: (sid: string, name: string, why: string) => string;
  moreSkips: (n: number) => string;
  total: (matched: number, changes: number, skipped: number) => string;
}

const BULK_WORDS: Record<string, BulkWords> = {
  en: {
    noField: (k) => `no field “${k}”`,
    notText: (k) => `“${k}” is not text`,
    notNumber: (k) => `“${k}” is not a number`,
    noValue: (k) => `“${k}” has no value`,
    noRefList: (c) => `no reference list “${c}”`,
    moreChanges: (n) => `… ${n} more changes (--limit 0 — all)`,
    skip: (s, n, w) => `skip ${s} “${n}”: ${w}`,
    moreSkips: (n) => `… ${n} more skipped`,
    total: (m, c, s) => `records matched ${m}, will change ${c}, skipped ${s}`,
  },
  ru: {
    noField: (k) => `нет поля «${k}»`,
    notText: (k) => `«${k}» — не текст`,
    notNumber: (k) => `«${k}» — не число`,
    noValue: (k) => `у «${k}» нет значения`,
    noRefList: (c) => `нет списка ссылок «${c}»`,
    moreChanges: (n) => `… ещё изменений: ${n} (--limit 0 — все)`,
    skip: (s, n, w) => `пропуск ${s} «${n}»: ${w}`,
    moreSkips: (n) => `… ещё пропусков: ${n}`,
    total: (m, c, s) => `подошло записей ${m}, изменится ${c}, пропущено ${s}`,
  },
  zh: {
    noField: (k) => `没有字段 “${k}”`,
    notText: (k) => `“${k}” 不是文本`,
    notNumber: (k) => `“${k}” 不是数字`,
    noValue: (k) => `“${k}” 没有值`,
    noRefList: (c) => `没有引用列表 “${c}”`,
    moreChanges: (n) => `… 还有 ${n} 处更改（--limit 0 显示全部）`,
    skip: (s, n, w) => `跳过 ${s} “${n}”：${w}`,
    moreSkips: (n) => `… 还有 ${n} 个跳过`,
    total: (m, c, s) => `匹配记录 ${m}，将更改 ${c}，跳过 ${s}`,
  },
};
const bulkWords = (lang: string): BulkWords => BULK_WORDS[lang] ?? BULK_WORDS.en!;

const KIND_RU: Record<BulkKind, string> = { set: '=', mul: '×', add: '+', replace: 'замена', refAdd: '+ ссылка', refRemove: '− ссылка' };

/** Подпись шага: `массово: WEAPON.value × 1.5 (12 записей)`. */
export function bulkLabel(typeName: string, op: BulkOperation, count: number): string {
  const what = op.kind === 'replace' ? `«${op.find ?? ''}» → «${op.value}»` : `${KIND_RU[op.kind]} ${op.value}`;
  return `массово: ${typeName}.${op.field} ${what} (${count} записей)`;
}

/**
 * Предпросмотр: что изменится у подходящих записей. Ничего не меняет. Ошибки ввода (не число,
 * неверный regex, неизвестный тип) — исключение `EditError`.
 */
export function previewBulk(ctx: ModContext, query: BulkQuery, op: BulkOperation, lang = 'en'): BulkPreview {
  const w = bulkWords(lang);
  if (!BULK_KINDS.includes(op.kind)) throw new EditError({ en: `Unknown operation «${op.kind as string}»: ${BULK_KINDS.join(', ')}`, ru: `Неизвестная операция «${op.kind as string}»: ${BULK_KINDS.join(', ')}`, zh: `未知操作 «${op.kind as string}»：${BULK_KINDS.join(', ')}` });
  const key = op.field.trim();
  if (key === '') throw new EditError({ en: 'Choose a field', ru: 'Укажите поле', zh: '请指定字段' });
  const recs = bulkSelect(ctx, query);
  const typeName = typeof query.type === 'number' ? ctx.typeName(query.type) : query.type.toUpperCase();
  if (op.kind === 'refAdd' || op.kind === 'refRemove') return previewRefs(ctx, recs, typeName, op, key, lang);
  const re = op.kind === 'replace' ? pattern(op) : undefined;
  const factor = op.kind === 'mul' || op.kind === 'add' ? number(op.value, op.kind === 'mul' ? { en: 'Multiply by', ru: 'Умножить на', zh: '乘以' } : { en: 'Add', ru: 'Прибавить', zh: '加上' }) : 0;
  const changes: BulkChange[] = [];
  const skipped: BulkSkip[] = [];
  const ops: EditOp[] = [];

  for (const rec of recs) {
    const sid = rec.stringId;
    const name = decodeText(rec.name) || sid;
    const skip = (reason: string): void => {
      skipped.push({ sid, name, reason });
    };
    const field = fieldOf(ctx, rec, key);
    if (re && key === BULK_NAME_FIELD && !field) {
      const after = name.replace(re, op.value);
      if (after !== name) {
        changes.push({ sid, name, field: key, before: name, after });
        ops.push({ op: 'rename', id: sid, name: after });
      }
      continue;
    }
    if (!field) {
      skip(w.noField(key));
      continue;
    }
    const { dict, value } = field;
    let next: ScalarValue;
    try {
      if (op.kind === 'set') {
        // Как set в applyOps: enum по имени, bool из true/false, число из текста.
        next = applyProbe(ctx, rec, dict, key, op.value);
      } else if (op.kind === 'replace') {
        if (dict !== 'strings' && dict !== 'files') {
          skip(w.notText(key));
          continue;
        }
        next = coerceValue(dict, decodeText((value as Uint8Array | undefined) ?? new Uint8Array()).replace(re!, op.value), key);
      } else {
        if (dict !== 'ints' && dict !== 'floats') {
          skip(w.notNumber(key));
          continue;
        }
        if (typeof value !== 'number') {
          skip(w.noValue(key));
          continue;
        }
        let n = op.kind === 'mul' ? value * factor : value + factor;
        if (dict === 'ints') n = Math.round(n);
        next = coerceValue(dict, n, key);
      }
    } catch (e) {
      skip(errorMessage(e, lang));
      continue;
    }
    if (value !== undefined && scalarEqual(value, next)) continue;
    const typeOf = ctx.typeName(rec.type);
    changes.push({ sid, name, field: key, before: compareText(ctx, typeOf, rec, dict, key, value), after: compareText(ctx, typeOf, rec, dict, key, next) });
    ops.push({ op: 'set', id: sid, field: key, value: jsonOf(dict, next), dict });
  }
  return { matched: recs.length, changes, skipped, ops, label: bulkLabel(typeName, op, changes.length) };
}

/** Ссылка текстом: `Имя цели (v0, v1, v2)`. */
function refText(ctx: ModContext, ref: { target: string; v0: number; v1: number; v2: number }): string {
  return `${ctx.localizedName(ref.target) ?? ctx.name(ref.target) ?? ref.target} (${ref.v0}, ${ref.v1}, ${ref.v2})`;
}

/** Цель ссылки по id или имени (англ./рус.); неоднозначность и отсутствие — понятная ошибка. */
function refTarget(ctx: ModContext, spec: string): string {
  const text = spec.trim();
  if (text === '') throw new EditError({ en: 'Give the record to reference (id or name)', ru: 'Укажите, на какую запись ссылка (id или имя)', zh: '请指定引用的记录（ID 或名称）' });
  const hit = lookupRecord(ctx, text);
  if (hit.stringId !== undefined) return hit.stringId;
  if (hit.candidates.length === 0) throw new EditError({ en: `Record «${text}» not found`, ru: `Запись «${text}» не найдена`, zh: `未找到记录 «${text}»` });
  const list = hit.candidates.slice(0, 5).map((c) => `${c.stringId} «${c.localizedName ?? c.name}»`).join(', ');
  throw new EditError({ en: `«${text}» matches several records (${hit.candidates.length}): ${list}${hit.candidates.length > 5 ? '…' : ''}. Be more precise or give the id`, ru: `«${text}» подходит нескольким записям (${hit.candidates.length}): ${list}${hit.candidates.length > 5 ? '…' : ''}. Укажите точнее или id`, zh: `«${text}» 匹配多条记录（${hit.candidates.length}）：${list}${hit.candidates.length > 5 ? '…' : ''}。请更精确或使用 ID` });
}

/** Добавить ссылку (или обновить её значения) / убрать ссылку во всех подходящих записях. */
function previewRefs(ctx: ModContext, recs: GameRecord[], typeName: string, op: BulkOperation, category: string, lang: string): BulkPreview {
  const target = refTarget(ctx, op.value);
  const wanted = op.values;
  const changes: BulkChange[] = [];
  const skipped: BulkSkip[] = [];
  const ops: EditOp[] = [];
  for (const rec of recs) {
    const sid = rec.stringId;
    const name = decodeText(rec.name) || sid;
    const list = rec.refs.get(category);
    const ts = ctx.schema?.types.get(ctx.typeName(rec.type));
    const known = list !== undefined || (ts ? findField(ts, category)?.kind === 'reference' : false);
    if (!known) {
      skipped.push({ sid, name, reason: bulkWords(lang).noRefList(category) });
      continue;
    }
    const old = list?.find((r) => r.target === target);
    if (op.kind === 'refRemove') {
      if (!old) continue;
      changes.push({ sid, name, field: category, before: refText(ctx, old), after: '' });
      ops.push({ op: 'removeRef', id: sid, category, target });
      continue;
    }
    const values = wanted ?? (old ? [old.v0, old.v1, old.v2] : ctx.refDefaults(sid, category));
    const next = { target, v0: values[0] ?? 0, v1: values[1] ?? 0, v2: values[2] ?? 0 };
    if (old && old.v0 === next.v0 && old.v1 === next.v1 && old.v2 === next.v2) continue;
    changes.push({ sid, name, field: category, before: old ? refText(ctx, old) : '', after: refText(ctx, next) });
    ops.push({ op: 'addRef', id: sid, category, target, values: [next.v0, next.v1, next.v2] });
  }
  return { matched: recs.length, changes, skipped, ops, label: bulkLabel(typeName, { ...op, value: ctx.localizedName(target) ?? ctx.name(target) ?? target }, changes.length) };
}

/** Оставить в предпросмотре только записи `keep` (галочки в таблице): правки, операции и подпись шага. */
export function restrictBulk(p: BulkPreview, keep: (sid: string) => boolean): BulkPreview {
  const changes = p.changes.filter((c) => keep(c.sid));
  const ops = p.ops.filter((o) => !('id' in o) || typeof o.id !== 'string' || keep(o.id));
  return { ...p, changes, ops, label: p.label.replace(/\(\d+ записей\)$/, `(${changes.length} записей)`) };
}

/** Текущее значение поля записи текстом (как в «было»); у имени — имя; нет поля — undefined. */
export function bulkFieldValue(ctx: ModContext, rec: GameRecord, key: string): string | undefined {
  if (key === BULK_NAME_FIELD) return decodeText(rec.name);
  const f = fieldOf(ctx, rec, key);
  if (!f || f.value === undefined) return undefined;
  return compareText(ctx, ctx.typeName(rec.type), rec, f.dict, key, f.value);
}

/** Значение для `set` из текста: как в applyOps (enum по имени, bool, число). */
function applyProbe(ctx: ModContext, rec: GameRecord, dict: ScalarDict, key: string, text: string): ScalarValue {
  const trimmed = text.trim();
  if (dict === 'ints' && !/^-?\d+$/.test(trimmed)) {
    const def = fieldEnum(ctx.schema, ctx.typeName(rec.type), key, rec);
    const n = def ? parseEnumValue(def, trimmed) : undefined;
    if (n === undefined) throw new EditError({ en: `«${trimmed}» is not a number${def ? ` nor a value of ${def.name}` : ''}`, ru: `«${trimmed}» — не число${def ? ` и не значение ${def.name}` : ''}`, zh: `«${trimmed}» 不是数字${def ? `，也不是 ${def.name} 的值` : ''}` });
    return n;
  }
  if (dict === 'ints' || dict === 'floats' || dict === 'bools') return coerceValue(dict, trimmed.replace(',', '.'), key);
  return coerceValue(dict, text, key);
}

function jsonOf(dict: ScalarDict, v: ScalarValue): string | number | boolean {
  if (dict === 'strings' || dict === 'files') return decodeText(v as Uint8Array);
  if (dict === 'bools') return v as boolean;
  return v as number;
}

/** Строки предпросмотра (CLI и MCP): `id  «имя»  поле: было → станет`, пропуски, итог. */
export function formatBulkPreview(p: BulkPreview, limit: number, lang = 'en'): string[] {
  const w = bulkWords(lang);
  const lines = p.changes.slice(0, limit).map((c) => `${c.sid}  «${c.name}»  ${c.field}: ${c.before === '' ? '—' : c.before} → ${c.after === '' ? '—' : c.after}`);
  if (p.changes.length > limit) lines.push(w.moreChanges(p.changes.length - limit));
  for (const s of p.skipped.slice(0, 10)) lines.push(w.skip(s.sid, s.name, s.reason));
  if (p.skipped.length > 10) lines.push(w.moreSkips(p.skipped.length - 10));
  lines.push(w.total(p.matched, p.changes.length, p.skipped.length));
  return lines;
}

/** Применить предпросмотр одной правкой (одна отмена). Возвращает число изменённых записей. */
export function applyBulk(ctx: ModContext, preview: BulkPreview): number {
  if (preview.ops.length === 0) return 0;
  applyOps(ctx, preview.ops, preview.label);
  return preview.changes.length;
}
