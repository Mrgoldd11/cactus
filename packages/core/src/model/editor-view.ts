/**
 * Data for the record editor (as in FCS): category tree from `fcs_layout.def` with filters,
 * record field rows by schema (value, lower-layer value, enum, visibility by
 * conditions) and reference groups with value labels and state relative to the lower layers.
 */
import { decodeText, encodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import type { FieldDef } from '../schema/fcs-def.ts';
import type { EnumDef } from '../schema/fcs-enums.ts';
import type { LayoutFilter, LayoutNode } from '../schema/fcs-layout.ts';
import { DICT_FOR_KIND, findField, type GameSchema, type TypeSchema } from '../schema/game-schema.ts';
import type { ModContext, RecordStatus } from './context.ts';
import { fieldEnum, getEnum, parseEnumValue, refValueEnum, refValueLabels } from './enums.ts';
import { isRemovedRef, refValuesEqual, SCALAR_DICTS, scalarEqual, scalarMap, type ScalarDict, type ScalarValue } from './record-ops.ts';

// ---------------------------------------------------------------- category tree

export interface CategoryNode {
  /** Path in the tree (`Items/Weapons`), unique. */
  id: string;
  label: string;
  /** Record type; the "All records" node has none. */
  type?: string;
  filters: LayoutFilter[];
  children: CategoryNode[];
}

/** Type `NULL_ITEM` in fcs_layout.def: "Everything", all records. */
const EVERYTHING_TYPE = 'NULL_ITEM';
export const OTHER_TYPES_ID = '__other__';

/**
 * Category tree: fcs_layout.def nodes, then "other types": types from `presentTypes` that
 * are not in the tree. "Everything" becomes a node without a type (all records).
 */
export function buildCategoryTree(schema: GameSchema | undefined, presentTypes: Iterable<string>): CategoryNode[] {
  const used = new Set<string>();
  const convert = (n: LayoutNode, parent: string): CategoryNode => {
    const id = parent ? `${parent}/${n.label}` : n.label;
    used.add(n.type);
    const node: CategoryNode = { id, label: n.label, filters: n.filters, children: n.children.map((c) => convert(c, id)) };
    if (n.type !== EVERYTHING_TYPE) node.type = n.type;
    return node;
  };
  const roots = (schema?.layout ?? []).map((n) => convert(n, ''));
  const other = [...new Set(presentTypes)].filter((t) => !used.has(t)).sort();
  if (other.length) {
    roots.push({
      id: OTHER_TYPES_ID,
      label: 'Other types',
      filters: [],
      children: other.map((t) => ({ id: `${OTHER_TYPES_ID}/${t}`, label: t, type: t, filters: [], children: [] })),
    });
  }
  if (!roots.some((r) => r.type === undefined && r.id !== OTHER_TYPES_ID)) roots.push({ id: 'Everything', label: 'Everything', filters: [], children: [] });
  return roots;
}

/** Record field value for a filter: from the record, otherwise the schema default. */
function filterFieldValue(schema: GameSchema | undefined, type: TypeSchema | undefined, rec: GameRecord, key: string): { value: ScalarValue; dict: ScalarDict } | undefined {
  for (const dict of SCALAR_DICTS) {
    const v = scalarMap(rec, dict).get(key);
    if (v !== undefined) return { value: v, dict };
  }
  const f = type && findField(type, key);
  if (f?.default === undefined) return undefined;
  const dict = DICT_FOR_KIND[f.kind];
  if (!dict || dict === 'refs' || dict === 'instances') return undefined;
  if (f.kind === 'enum' && typeof f.default === 'string') {
    const e = f.enumName !== undefined ? getEnum(schema, f.enumName) : undefined;
    const n = e ? parseEnumValue(e, f.default) : undefined;
    return n === undefined ? undefined : { value: n, dict: 'ints' };
  }
  return typeof f.default === 'string' ? undefined : { value: f.default, dict };
}

/**
 * Value numbers of enums built into the game that are neither in fcs_enums.def nor in
 * builtin-enums.ts but are needed by fcs_layout.def filters. Established from the data:
 * all vanilla books (140 records) have `item function` = 13.
 */
const LAYOUT_ENUM_VALUES: Record<string, Record<string, number>> = { ItemFunction: { ITEM_BOOK: 13 } };

function layoutEnumValue(schema: GameSchema | undefined, type: TypeSchema | undefined, typeName: string, rec: GameRecord, field: string, value: string): number | undefined {
  const e = fieldEnum(schema, typeName, field, rec);
  if (e) return parseEnumValue(e, value);
  const enumName = type && findField(type, field)?.enumName;
  const known = enumName !== undefined ? LAYOUT_ENUM_VALUES[enumName]?.[value] : undefined;
  if (known !== undefined) return known;
  return /^-?\d+$/.test(value) ? Number(value) : undefined;
}

/** Does the record match the node filters (`building category==DOORS`, `is node=true`). */
export function matchesLayoutFilters(schema: GameSchema | undefined, rec: GameRecord, filters: readonly LayoutFilter[]): boolean {
  if (filters.length === 0) return true;
  const typeName = itemTypeName(rec.type, schema?.itemTypes);
  const type = schema?.types.get(typeName);
  return filters.every((flt) => {
    const got = filterFieldValue(schema, type, rec, flt.field);
    let equal: boolean;
    if (!got) equal = false;
    else if (got.dict === 'bools') equal = String(got.value) === flt.value.toLowerCase();
    else if (got.dict === 'ints') {
      equal = layoutEnumValue(schema, type, typeName, rec, flt.field, flt.value) === got.value;
    } else if (got.dict === 'floats') equal = Number(flt.value) === got.value;
    else if (got.dict === 'strings' || got.dict === 'files') equal = decodeText(got.value as Uint8Array) === flt.value;
    else equal = false;
    return flt.op === '==' ? equal : !equal;
  });
}

/** Record value that makes `field == value` of a layout filter true; undefined — not known how. */
function layoutFilterValue(schema: GameSchema | undefined, type: TypeSchema | undefined, typeName: string, rec: GameRecord, flt: LayoutFilter): { dict: ScalarDict; value: ScalarValue } | undefined {
  const def = type && findField(type, flt.field);
  const dict = def ? DICT_FOR_KIND[def.kind] : undefined;
  const raw = flt.value.trim();
  if (dict === 'bools' || (!def && /^(true|false)$/i.test(raw))) return /^(true|false)$/i.test(raw) ? { dict: 'bools', value: raw.toLowerCase() === 'true' } : undefined;
  if (dict === 'ints' || (!def && /^-?\d+$/.test(raw))) {
    const n = layoutEnumValue(schema, type, typeName, rec, flt.field, raw);
    return n === undefined ? undefined : { dict: 'ints', value: n };
  }
  if (dict === 'floats') return Number.isFinite(Number(raw)) && raw !== '' ? { dict: 'floats', value: Number(raw) } : undefined;
  if (dict === 'strings' || dict === 'files' || !def) return { dict: dict === 'files' ? 'files' : 'strings', value: encodeText(flt.value) };
  return undefined;
}

/**
 * Make a record (a draft) satisfy layout filters, so that a new record created in a category
 * stays in it: `field == value` sets the value; a violated `field != value` drops the field back
 * to its default. Returns the filters still not satisfied afterwards (e.g. an unknown enum value).
 */
export function applyLayoutFilters(schema: GameSchema | undefined, rec: GameRecord, filters: readonly LayoutFilter[]): LayoutFilter[] {
  const typeName = itemTypeName(rec.type, schema?.itemTypes);
  const type = schema?.types.get(typeName);
  const unmet: LayoutFilter[] = [];
  const drop = (key: string): void => {
    for (const dict of SCALAR_DICTS) scalarMap(rec, dict).delete(key);
  };
  for (const flt of filters) {
    if (matchesLayoutFilters(schema, rec, [flt])) continue;
    if (flt.op === '==') {
      const v = layoutFilterValue(schema, type, typeName, rec, flt);
      if (v) {
        drop(flt.field);
        scalarMap(rec, v.dict).set(flt.field, v.value);
      }
    } else drop(flt.field);
    if (!matchesLayoutFilters(schema, rec, [flt])) unmet.push(flt);
  }
  return unmet;
}

/** Does the record match the tree node. */
export function matchesCategory(schema: GameSchema | undefined, rec: GameRecord, node: CategoryNode): boolean {
  if (node.id === OTHER_TYPES_ID) return false;
  if (node.type === undefined) return true;
  return itemTypeName(rec.type, schema?.itemTypes) === node.type && matchesLayoutFilters(schema, rec, node.filters);
}

// ---------------------------------------------------------------- fields

/**
 * Field state relative to the lower layers:
 * `default`: the record has no such field (the default value is shown), `base`: as in the lower layers,
 * `changed`: the mod changes the value, `added`: the field is not in the lower layers, `removed`: the mod removed the field.
 */
export type FieldState = 'default' | 'base' | 'changed' | 'added' | 'removed';

export interface FieldRow {
  key: string;
  dict: ScalarDict;
  def?: FieldDef;
  category: string;
  value?: ScalarValue;
  /** Value in the lower layers (vanilla and dependencies). */
  lower?: ScalarValue;
  state: FieldState;
  enum?: EnumDef;
  /** The field is hidden by an fcs.def condition (`condition "x" if "y" is ...`). */
  hidden: boolean;
}

function scalarOf(rec: GameRecord | undefined, dict: ScalarDict, key: string): ScalarValue | undefined {
  return rec ? scalarMap(rec, dict).get(key) : undefined;
}

/** fcs.def condition value (`MapFeatureMode.FOLIAGE`, `False`, `3`) against the field value. */
function conditionValueMatches(schema: GameSchema | undefined, row: FieldRow | undefined, text: string): boolean {
  const v = row?.value ?? (row?.def?.default !== undefined ? defaultValue(schema, row.def) : undefined);
  if (v === undefined) return false;
  if (typeof v === 'boolean') return String(v) === text.toLowerCase();
  if (typeof v === 'number') {
    const name = text.includes('.') && !/^-?\d/.test(text) ? text.slice(text.indexOf('.') + 1) : text;
    const n = row?.enum ? parseEnumValue(row.enum, name) : Number(name);
    return n === v;
  }
  return false;
}

/** Field default value as a dictionary value (enum as number). */
export function defaultValue(schema: GameSchema | undefined, def: FieldDef): ScalarValue | undefined {
  if (def.default === undefined) return undefined;
  if (def.kind === 'enum') {
    if (typeof def.default !== 'string') return def.default;
    const e = def.enumName !== undefined ? getEnum(schema, def.enumName) : undefined;
    return e ? parseEnumValue(e, def.default) : undefined;
  }
  if (typeof def.default === 'string') return encodeText(def.default);
  return def.default;
}

/**
 * Record field rows: first the schema fields (by fcs.def groups), then fields from the data that
 * are not in the schema (repeated `text3` follow their description). References and objects are separate.
 */
export function fieldRows(ctx: ModContext, stringId: string): FieldRow[] {
  const rec = ctx.get(stringId) ?? ctx.lower(stringId);
  if (!rec) return [];
  const lower = ctx.lower(stringId);
  const touched = ctx.delta(stringId) !== undefined;
  const typeName = ctx.typeName(rec.type);
  const type = ctx.schema?.types.get(typeName);
  const rows: FieldRow[] = [];
  const seen = new Set<string>();

  const push = (key: string, dict: ScalarDict, def: FieldDef | undefined): void => {
    const id = `${dict}:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    const value = scalarOf(rec, dict, key);
    const low = scalarOf(lower, dict, key);
    let state: FieldState;
    if (value === undefined) state = low !== undefined && touched ? 'removed' : 'default';
    else if (!lower) state = touched ? 'added' : 'base';
    else if (low === undefined) state = 'added';
    else state = scalarEqual(low, value) ? 'base' : 'changed';
    const row: FieldRow = { key, dict, category: def?.category ?? '', state, hidden: false };
    if (def) row.def = def;
    if (value !== undefined) row.value = value;
    if (low !== undefined) row.lower = low;
    if (dict === 'ints') {
      const e = fieldEnum(ctx.schema, typeName, key, rec);
      if (e) row.enum = e;
    }
    rows.push(row);
  };

  for (const def of type?.fields.values() ?? []) {
    const dict = DICT_FOR_KIND[def.kind];
    if (!dict || dict === 'refs' || dict === 'instances') continue;
    if (def.looped) {
      const base = def.name.replace(/\d+$/, '');
      const keys = new Set<string>();
      for (const r of [rec, lower]) for (const k of r ? scalarMap(r, dict).keys() : []) if (k.startsWith(base) && /^\d+$/.test(k.slice(base.length))) keys.add(k);
      keys.add(def.name);
      for (const k of [...keys].sort((a, b) => Number(a.slice(base.length)) - Number(b.slice(base.length)))) push(k, dict, def);
    } else push(def.name, dict, def);
  }
  for (const r of [rec, lower]) {
    if (!r) continue;
    for (const dict of SCALAR_DICTS) for (const k of scalarMap(r, dict).keys()) push(k, dict, type && findField(type, k));
  }

  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const c of type?.conditions ?? []) {
    const row = byKey.get(c.field);
    if (!row) continue;
    const match = c.values.some((v) => conditionValueMatches(ctx.schema, byKey.get(c.dependsOn), v));
    if (c.negate ? match : !match) row.hidden = true;
  }
  return rows;
}

// ---------------------------------------------------------------- references

/** `base`: as in the lower layers, `added`/`changed`: the mod added the reference or changed values, `removed`: the mod removed it. */
export type RefState = 'base' | 'added' | 'changed' | 'removed';

export interface RefRow {
  ref: Reference;
  state: RefState;
  /** Values in the lower layers, if the mod changed them. */
  lower?: Reference;
  targetName?: string;
  targetType?: string;
  targetStatus?: RecordStatus;
}

export interface RefGroup {
  category: string;
  def?: FieldDef;
  /** Target type by schema. */
  targetType?: string;
  /** Labels of v0..v2 (the length is how many values are used). */
  valueLabels: string[];
  /** Enum of values v0..v2 (if known). */
  valueEnums: (EnumDef | undefined)[];
  rows: RefRow[];
}

/** Reference groups of the record: schema categories (including empty ones), then categories from the data. */
export function refGroups(ctx: ModContext, stringId: string): RefGroup[] {
  const rec = ctx.get(stringId) ?? ctx.lower(stringId);
  if (!rec) return [];
  const lower = ctx.lower(stringId);
  const touched = ctx.delta(stringId) !== undefined;
  const typeName = ctx.typeName(rec.type);
  const type = ctx.schema?.types.get(typeName);
  const cats: string[] = [];
  for (const def of type?.fields.values() ?? []) if (def.kind === 'reference') cats.push(def.name);
  for (const r of [rec, lower]) for (const c of r?.refs.keys() ?? []) if (!cats.includes(c)) cats.push(c);

  return cats.map((category) => {
    const def = type?.fields.get(category);
    const defaults = def?.refDefaults;
    const named = refValueLabels(typeName, category);
    const count = Math.max(defaults?.length ?? 0, named?.length ?? 0, 1);
    const valueLabels = Array.from({ length: Math.min(count, 3) }, (_, i) => named?.[i] ?? `v${i}`);
    const valueEnums = valueLabels.map((_, i) => refValueEnum(ctx.schema, typeName, category, i));
    const cur = (rec.refs.get(category) ?? []).filter((r) => !isRemovedRef(r));
    const low = (lower?.refs.get(category) ?? []).filter((r) => !isRemovedRef(r));
    const lowByTarget = new Map(low.map((r) => [r.target, r]));
    const curTargets = new Set(cur.map((r) => r.target));
    const rows: RefRow[] = cur.map((ref) => {
      const before = lowByTarget.get(ref.target);
      let state: RefState;
      if (!lower) state = touched ? 'added' : 'base';
      else if (!before) state = 'added';
      else state = refValuesEqual(before, ref) ? 'base' : 'changed';
      const row: RefRow = { ref, state };
      if (before && state === 'changed') row.lower = before;
      return describeTarget(ctx, row);
    });
    for (const ref of low) if (!curTargets.has(ref.target)) rows.push(describeTarget(ctx, { ref, state: 'removed' }));
    const g: RefGroup = { category, valueLabels, valueEnums, rows };
    if (def) g.def = def;
    if (def?.targetType !== undefined) g.targetType = def.targetType;
    return g;
  });
}

function describeTarget(ctx: ModContext, row: RefRow): RefRow {
  const t = ctx.get(row.ref.target) ?? ctx.lower(row.ref.target);
  if (t) {
    row.targetName = decodeText(t.name);
    row.targetType = ctx.typeName(t.type);
  }
  const st = ctx.status(row.ref.target);
  if (st) row.targetStatus = st;
  return row;
}
