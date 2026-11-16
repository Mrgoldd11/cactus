/**
 * Comparison tables (stage 5): records of one type (weapons, crossbows, armour, items, bags…)
 * in columns from the schema. For each cell: the value, who changed it (the mod itself or other mods
 * over vanilla), for numeric columns the highest and lowest value (outliers).
 */
import { decodeText } from '../text.ts';
import type { GameRecord } from '../format/types.ts';
import { DICT_FOR_KIND } from '../schema/game-schema.ts';
import { isVanillaLayer } from '../vanilla.ts';
import { plainName } from '../world/where.ts';
import type { ModContext, RecordStatus } from './context.ts';
import { enumValue, fieldEnum } from './enums.ts';
import { formatFloat } from './present.ts';
import { applyLayer, isRemovalMarker, scalarEqual, scalarMap, type ScalarDict, type ScalarValue } from './record-ops.ts';

/** Default types for comparison (as in the FCS menu: weapons, crossbows, armour, items, bags). */
export const COMPARE_TYPES = ['WEAPON', 'CROSSBOW', 'ARMOUR', 'ITEM', 'CONTAINER'] as const;

/** Default columns for types without a preset: numeric fields that differ. */
const DEFAULT_COLUMNS = 8;
/** Column presets: what is usually compared (price, weight, damage, protection). */
const PRESET_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  WEAPON: ['value', 'weight kg', 'cut damage multiplier', 'blunt damage multiplier', 'armour penetration', 'attack mod', 'defence mod', 'bleed mult', 'length', 'material cost'],
  CROSSBOW: ['value', 'weight kg', 'pierce damage', 'range', 'shot speed', 'reload time min', 'reload time max', 'accuracy perfect skill', 'bleed mult'],
  ARMOUR: ['value', 'weight kg', 'cut def bonus', 'blunt def bonus', 'pierce def mult', 'hardness', 'combat def bonus', 'dexterity mult', 'stealth mult', 'relative price mult'],
  ITEM: ['value', 'weight kg', 'stackable', 'charges', 'production time', 'quality'],
  CONTAINER: ['value', 'weight kg', 'storage size width', 'storage size height', 'encumbrance effect', 'stackable bonus mult', 'stealth mult'],
};
/** Appearance and inventory placement are not taken into default columns. */
const COSMETIC = /icon|offset|scale|footprint|sound|zoom|equip/i;
const COMPARABLE: readonly ScalarDict[] = ['bools', 'ints', 'floats', 'strings'];

export type CompareKind = 'number' | 'bool' | 'text' | 'enum';

export interface CompareColumn {
  key: string;
  dict: ScalarDict;
  kind: CompareKind;
  category?: string;
  description?: string;
  /** The values differ between the table's records. */
  varies: boolean;
}

/** Who changed the value: the mod itself (`mine`) or other loaded mods over vanilla (`mods`). */
export type CompareMark = 'mine' | 'mods';

export interface CompareCell {
  value?: ScalarValue;
  /** Display value (enum by name). */
  text: string;
  mark?: CompareMark;
  /** Mods (other than this one) that set this field differently from vanilla. */
  layers?: string[];
}

export interface CompareRow {
  sid: string;
  name: string;
  localized?: string;
  status: RecordStatus | undefined;
  /** The record is added by a mod (not from vanilla): the first layer where it exists, or the mod itself. */
  addedBy?: string;
  cells: Map<string, CompareCell>;
}

export interface CompareTable {
  type: string;
  columns: CompareColumn[];
  rows: CompareRow[];
  /** Default columns. */
  defaultColumns: string[];
  /** Lowest and highest value of a numeric column (if they differ). */
  range(key: string): { min: number; max: number } | undefined;
}

function kindOf(dict: ScalarDict, isEnum: boolean): CompareKind {
  if (isEnum) return 'enum';
  if (dict === 'bools') return 'bool';
  if (dict === 'ints' || dict === 'floats') return 'number';
  return 'text';
}

/** Value shown in a cell: number, "yes/no" as true/false, text as is, enum by name. */
export function compareText(ctx: ModContext, typeName: string, rec: GameRecord, dict: ScalarDict, key: string, v: ScalarValue | undefined): string {
  if (v === undefined) return '';
  if (dict === 'ints') {
    const e = fieldEnum(ctx.schema, typeName, key, rec);
    const name = e ? enumValue(e, v as number)?.name : undefined;
    return name ?? String(v);
  }
  if (dict === 'floats') return formatFloat(v as number);
  if (dict === 'bools') return v ? 'true' : 'false';
  if (dict === 'strings' || dict === 'files') return decodeText(v as Uint8Array);
  return (v as number[]).map(formatFloat).join(', ');
}

/**
 * Comparison table of records of type `typeName`. `ids`: prebuilt id list of this type (editor
 * index); otherwise all records are scanned. Records deleted by the mod are not included.
 */
export function compareTable(ctx: ModContext, typeName: string, options: { ids?: Iterable<string> } = {}): CompareTable {
  const type = ctx.typeId(typeName);
  const recs: GameRecord[] = [];
  for (const sid of options.ids ?? ctx.allStringIds()) {
    const rec = ctx.get(sid);
    if (rec && rec.type === type) recs.push(rec);
  }
  const want = new Set(recs.map((r) => r.stringId));

  // Vanilla by layers (for the "changed by mods" mark) and what each non-base layer sets.
  const vanilla = new Map<string, GameRecord | undefined>();
  const firstLayer = new Map<string, string>();
  const modEntries = new Map<string, { layer: string; rec: GameRecord }[]>();
  for (const layer of ctx.layers) {
    const base = isVanillaLayer(layer.name);
    for (const rec of layer.file.records) {
      if (!want.has(rec.stringId)) continue;
      if (!firstLayer.has(rec.stringId)) firstLayer.set(rec.stringId, layer.name);
      if (base) vanilla.set(rec.stringId, applyLayer(vanilla.get(rec.stringId), rec));
      else {
        let list = modEntries.get(rec.stringId);
        if (!list) modEntries.set(rec.stringId, (list = []));
        list.push({ layer: layer.name, rec });
      }
    }
  }

  // Columns: schema fields (in fcs.def order), then fields from the data that are not in the schema.
  const columns = new Map<string, CompareColumn>();
  const ts = ctx.schema?.types.get(typeName);
  for (const f of ts?.fields.values() ?? []) {
    const dict = COMPARABLE.find((d) => d === DICT_FOR_KIND[f.kind]);
    if (dict === undefined) continue;
    columns.set(f.name, {
      key: f.name,
      dict,
      kind: kindOf(dict, f.kind === 'enum'),
      ...(f.category !== undefined ? { category: f.category } : {}),
      ...(f.description !== undefined ? { description: f.description } : {}),
      varies: false,
    });
  }
  for (const rec of recs) {
    for (const dict of COMPARABLE) {
      for (const key of scalarMap(rec, dict).keys()) {
        if (!columns.has(key)) columns.set(key, { key, dict, kind: kindOf(dict, fieldEnum(ctx.schema, typeName, key, rec) !== undefined), varies: false });
      }
    }
  }

  const rows: CompareRow[] = recs.map((rec) => {
    const sid = rec.stringId;
    const status = ctx.status(sid);
    const lower = ctx.lower(sid);
    const delta = ctx.delta(sid);
    const van = vanilla.get(sid);
    const loc = ctx.localizedName(sid);
    const plain = loc === undefined ? undefined : plainName(loc);
    const cells = new Map<string, CompareCell>();
    for (const col of columns.values()) {
      const value = scalarMap(rec, col.dict).get(col.key);
      const cell: CompareCell = { text: compareText(ctx, typeName, rec, col.dict, col.key, value) };
      if (value !== undefined) cell.value = value;
      if (delta && lower && !isRemovalMarker(delta) && !scalarEqual(scalarMap(lower, col.dict).get(col.key), value)) cell.mark = 'mine';
      if (van) {
        const vv = scalarMap(van, col.dict).get(col.key);
        const layers = (modEntries.get(sid) ?? []).filter((e) => {
          const lv = scalarMap(e.rec, col.dict).get(col.key);
          return lv !== undefined && !scalarEqual(lv, vv);
        });
        if (layers.length > 0) {
          cell.layers = layers.map((e) => e.layer);
          if (cell.mark === undefined && lower && !scalarEqual(scalarMap(lower, col.dict).get(col.key), vv)) cell.mark = 'mods';
        }
      }
      cells.set(col.key, cell);
    }
    const row: CompareRow = { sid, name: decodeText(rec.name) || sid, status, cells };
    if (plain !== undefined && plain !== '') row.localized = plain;
    if (!van) row.addedBy = status === 'new' ? ctx.modName : (firstLayer.get(sid) ?? ctx.modName);
    return row;
  });

  // Whether the values differ; range of numeric ones.
  const ranges = new Map<string, { min: number; max: number }>();
  for (const col of columns.values()) {
    const seen = new Set<string>();
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      const c = r.cells.get(col.key)!;
      seen.add(c.text);
      if (col.kind === 'number' && typeof c.value === 'number' && Number.isFinite(c.value)) {
        min = Math.min(min, c.value);
        max = Math.max(max, c.value);
      }
    }
    col.varies = seen.size > 1;
    if (col.kind === 'number' && min < max) ranges.set(col.key, { min, max });
  }
  const list = [...columns.values()];
  const preset = (PRESET_COLUMNS[typeName] ?? []).filter((k) => columns.has(k));
  const defaultColumns = preset.length > 0 ? preset : list.filter((c) => c.kind === 'number' && c.varies && !COSMETIC.test(c.key)).slice(0, DEFAULT_COLUMNS).map((c) => c.key);
  return { type: typeName, columns: list, rows, defaultColumns, range: (key) => ranges.get(key) };
}
