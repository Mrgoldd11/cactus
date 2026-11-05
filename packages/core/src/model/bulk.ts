/**
 * Массовые правки (этап 5): записи одного типа по условиям полей → одна операция над полем
 * (задать, умножить, прибавить, заменить текст, в том числе по regex). Сначала предпросмотр
 * «было → станет», потом применение одной правкой (одна отмена на всю пачку). Правки
 * выражены обычными операциями `set`/`rename` — их же отправляет MCP в окно редактора.
 */
import { decodeText } from '../text.ts';
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import { DICT_FOR_KIND, findField } from '../schema/game-schema.ts';
import { EditError, type ModContext } from './context.ts';
import { compareText } from './compare.ts';
import { fieldEnum, parseEnumValue } from './enums.ts';
import { applyOps, coerceValue, type EditOp } from './ops.ts';
import { scalarEqual, scalarMap, type ScalarDict, type ScalarValue } from './record-ops.ts';
import { matchesFilter, type FieldFilter } from './search.ts';

export type BulkKind = 'set' | 'mul' | 'add' | 'replace';
export const BULK_KINDS: readonly BulkKind[] = ['set', 'mul', 'add', 'replace'];

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
  const type = typeof query.type === 'number' ? query.type : /^\d+$/.test(query.type) ? Number(query.type) : itemTypeId(query.type.toUpperCase());
  if (type === undefined) throw new EditError(`Неизвестный тип записи «${String(query.type)}»`);
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
  if (find === '') throw new EditError('Замена текста: укажите, что искать');
  const flags = `g${op.caseSensitive ? '' : 'i'}u`;
  try {
    return new RegExp(op.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch (e) {
    throw new EditError(`Неверное регулярное выражение «${find}»: ${(e as Error).message}`);
  }
}

function number(text: string, what: string): number {
  const n = Number(text.trim().replace('−', '-').replace(',', '.'));
  if (text.trim() === '' || !Number.isFinite(n)) throw new EditError(`${what}: нужно число, а не «${text}»`);
  return n;
}

/** Поле записи: словарь и значение; нет в записи — по схеме (значение по умолчанию). */
function fieldOf(ctx: ModContext, rec: GameRecord, key: string): { dict: ScalarDict; value: ScalarValue | undefined } | undefined {
  for (const dict of ['bools', 'ints', 'floats', 'strings', 'files'] as const) {
    const v = scalarMap(rec, dict).get(key);
    if (v !== undefined) return { dict, value: v };
  }
  const ts = ctx.schema?.types.get(itemTypeName(rec.type));
  const f = ts ? findField(ts, key) : undefined;
  const dict = f ? DICT_FOR_KIND[f.kind] : undefined;
  if (!f || dict === undefined || dict === 'refs' || dict === 'instances' || dict === 'vec3s' || dict === 'vec4s') return undefined;
  let value: ScalarValue | undefined;
  if (typeof f.default === 'number' && (dict === 'ints' || dict === 'floats')) value = f.default;
  else if (typeof f.default === 'boolean' && dict === 'bools') value = f.default;
  return { dict, value };
}

const KIND_RU: Record<BulkKind, string> = { set: '=', mul: '×', add: '+', replace: 'замена' };

/** Подпись шага: `массово: WEAPON.value × 1.5 (12 записей)`. */
export function bulkLabel(typeName: string, op: BulkOperation, count: number): string {
  const what = op.kind === 'replace' ? `«${op.find ?? ''}» → «${op.value}»` : `${KIND_RU[op.kind]} ${op.value}`;
  return `массово: ${typeName}.${op.field} ${what} (${count} записей)`;
}

/**
 * Предпросмотр: что изменится у подходящих записей. Ничего не меняет. Ошибки ввода (не число,
 * неверный regex, неизвестный тип) — исключение `EditError`.
 */
export function previewBulk(ctx: ModContext, query: BulkQuery, op: BulkOperation): BulkPreview {
  if (!BULK_KINDS.includes(op.kind)) throw new EditError(`Неизвестная операция «${op.kind as string}»: ${BULK_KINDS.join(', ')}`);
  const key = op.field.trim();
  if (key === '') throw new EditError('Укажите поле');
  const recs = bulkSelect(ctx, query);
  const typeName = typeof query.type === 'number' ? itemTypeName(query.type) : query.type.toUpperCase();
  const re = op.kind === 'replace' ? pattern(op) : undefined;
  const factor = op.kind === 'mul' || op.kind === 'add' ? number(op.value, op.kind === 'mul' ? 'Умножить на' : 'Прибавить') : 0;
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
      skip(`нет поля «${key}»`);
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
          skip(`«${key}» — не текст`);
          continue;
        }
        next = coerceValue(dict, decodeText((value as Uint8Array | undefined) ?? new Uint8Array()).replace(re!, op.value), key);
      } else {
        if (dict !== 'ints' && dict !== 'floats') {
          skip(`«${key}» — не число`);
          continue;
        }
        if (typeof value !== 'number') {
          skip(`у «${key}» нет значения`);
          continue;
        }
        let n = op.kind === 'mul' ? value * factor : value + factor;
        if (dict === 'ints') n = Math.round(n);
        next = coerceValue(dict, n, key);
      }
    } catch (e) {
      skip((e as Error).message);
      continue;
    }
    if (value !== undefined && scalarEqual(value, next)) continue;
    const typeOf = itemTypeName(rec.type);
    changes.push({ sid, name, field: key, before: compareText(ctx, typeOf, rec, dict, key, value), after: compareText(ctx, typeOf, rec, dict, key, next) });
    ops.push({ op: 'set', id: sid, field: key, value: jsonOf(dict, next), dict });
  }
  return { matched: recs.length, changes, skipped, ops, label: bulkLabel(typeName, op, changes.length) };
}

/** Значение для `set` из текста: как в applyOps (enum по имени, bool, число). */
function applyProbe(ctx: ModContext, rec: GameRecord, dict: ScalarDict, key: string, text: string): ScalarValue {
  const trimmed = text.trim();
  if (dict === 'ints' && !/^-?\d+$/.test(trimmed)) {
    const def = fieldEnum(ctx.schema, itemTypeName(rec.type), key, rec);
    const n = def ? parseEnumValue(def, trimmed) : undefined;
    if (n === undefined) throw new EditError(`«${trimmed}» — не число${def ? ` и не значение ${def.name}` : ''}`);
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
export function formatBulkPreview(p: BulkPreview, limit: number): string[] {
  const lines = p.changes.slice(0, limit).map((c) => `${c.sid}  «${c.name}»  ${c.field}: ${c.before === '' ? '—' : c.before} → ${c.after}`);
  if (p.changes.length > limit) lines.push(`… ещё изменений: ${p.changes.length - limit} (--limit 0 — все)`);
  for (const s of p.skipped.slice(0, 10)) lines.push(`пропуск ${s.sid} «${s.name}»: ${s.reason}`);
  if (p.skipped.length > 10) lines.push(`… ещё пропусков: ${p.skipped.length - 10}`);
  lines.push(`подошло записей ${p.matched}, изменится ${p.changes.length}, пропущено ${p.skipped.length}`);
  return lines;
}

/** Применить предпросмотр одной правкой (одна отмена). Возвращает число изменённых записей. */
export function applyBulk(ctx: ModContext, preview: BulkPreview): number {
  if (preview.ops.length === 0) return 0;
  applyOps(ctx, preview.ops, preview.label);
  return preview.changes.length;
}
