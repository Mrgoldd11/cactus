/**
 * Таблицы сравнения (этап 5): записи одного типа (оружие, арбалеты, броня, предметы, сумки…)
 * в столбцах из схемы. Для каждой ячейки — значение, кто его поменял (сам мод или другие моды
 * поверх ванили), для числовых столбцов — наибольшее и наименьшее значение (выбросы).
 */
import { decodeText } from '../text.ts';
import { itemTypeId } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import { DICT_FOR_KIND } from '../schema/game-schema.ts';
import { isVanillaLayer } from '../vanilla.ts';
import { plainRuName } from '../world/where.ts';
import type { ModContext, RecordStatus } from './context.ts';
import { enumValue, fieldEnum } from './enums.ts';
import { formatFloat } from './present.ts';
import { applyLayer, isRemovalMarker, scalarEqual, scalarMap, type ScalarDict, type ScalarValue } from './record-ops.ts';

/** Типы для сравнения по умолчанию (как в меню FCS: оружие, арбалеты, броня, предметы, сумки). */
export const COMPARE_TYPES = ['WEAPON', 'CROSSBOW', 'ARMOUR', 'ITEM', 'CONTAINER'] as const;

/** Столбцов по умолчанию для типов без готового набора: числовые поля, которые различаются. */
const DEFAULT_COLUMNS = 8;
/** Готовые наборы столбцов: то, что обычно сравнивают (цена, вес, урон, защита). */
const PRESET_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  WEAPON: ['value', 'weight kg', 'cut damage multiplier', 'blunt damage multiplier', 'armour penetration', 'attack mod', 'defence mod', 'bleed mult', 'length', 'material cost'],
  CROSSBOW: ['value', 'weight kg', 'pierce damage', 'range', 'shot speed', 'reload time min', 'reload time max', 'accuracy perfect skill', 'bleed mult'],
  ARMOUR: ['value', 'weight kg', 'cut def bonus', 'blunt def bonus', 'pierce def mult', 'hardness', 'combat def bonus', 'dexterity mult', 'stealth mult', 'relative price mult'],
  ITEM: ['value', 'weight kg', 'stackable', 'charges', 'production time', 'quality'],
  CONTAINER: ['value', 'weight kg', 'storage size width', 'storage size height', 'encumbrance effect', 'stackable bonus mult', 'stealth mult'],
};
/** Внешний вид и место в инвентаре — в столбцы по умолчанию не берём. */
const COSMETIC = /icon|offset|scale|footprint|sound|zoom|equip/i;
const COMPARABLE: readonly ScalarDict[] = ['bools', 'ints', 'floats', 'strings'];

export type CompareKind = 'number' | 'bool' | 'text' | 'enum';

export interface CompareColumn {
  key: string;
  dict: ScalarDict;
  kind: CompareKind;
  category?: string;
  description?: string;
  /** Значения у записей таблицы различаются. */
  varies: boolean;
}

/** Кто поменял значение: сам мод (`mine`) или другие загруженные моды поверх ванили (`mods`). */
export type CompareMark = 'mine' | 'mods';

export interface CompareCell {
  value?: ScalarValue;
  /** Значение для показа (enum — имя). */
  text: string;
  mark?: CompareMark;
  /** Моды (кроме самого), которые задают это поле не как в ванили. */
  layers?: string[];
}

export interface CompareRow {
  sid: string;
  name: string;
  ru?: string;
  status: RecordStatus | undefined;
  /** Запись добавлена модом (не из ванили): первый слой, где она есть, или сам мод. */
  addedBy?: string;
  cells: Map<string, CompareCell>;
}

export interface CompareTable {
  type: string;
  columns: CompareColumn[];
  rows: CompareRow[];
  /** Столбцы по умолчанию. */
  defaultColumns: string[];
  /** Наименьшее и наибольшее значение числового столбца (если различаются). */
  range(key: string): { min: number; max: number } | undefined;
}

function kindOf(dict: ScalarDict, isEnum: boolean): CompareKind {
  if (isEnum) return 'enum';
  if (dict === 'bools') return 'bool';
  if (dict === 'ints' || dict === 'floats') return 'number';
  return 'text';
}

/** Значение для показа в ячейке: число, «да/нет» как true/false, текст как есть, enum — имя. */
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
 * Таблица сравнения записей типа `typeName`. `ids` — готовый список id этого типа (индекс
 * редактора), иначе перебираются все записи. Удалённые модом записи не входят.
 */
export function compareTable(ctx: ModContext, typeName: string, options: { ids?: Iterable<string> } = {}): CompareTable {
  const type = itemTypeId(typeName);
  const recs: GameRecord[] = [];
  for (const sid of options.ids ?? ctx.allStringIds()) {
    const rec = ctx.get(sid);
    if (rec && rec.type === type) recs.push(rec);
  }
  const want = new Set(recs.map((r) => r.stringId));

  // Ваниль по слоям (для отметки «поменяли моды») и что задаёт каждый небазовый слой.
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

  // Столбцы: поля схемы (по порядку fcs.def), затем поля из данных, которых нет в схеме.
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
    const ru = ctx.localizedName(sid);
    const plain = ru === undefined ? undefined : plainRuName(ru);
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
    if (plain !== undefined && plain !== '') row.ru = plain;
    if (!van) row.addedBy = status === 'new' ? ctx.modName : (firstLayer.get(sid) ?? ctx.modName);
    return row;
  });

  // Различаются ли значения; диапазон числовых.
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
