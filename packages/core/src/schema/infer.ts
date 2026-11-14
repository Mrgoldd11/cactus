/**
 * Дополнение схемы по данным. fcs.def описывает не всё: часть типов (DIALOG_ACTION, ROAD,
 * CAMERA, …) FCS показывает своими окнами, а часть полей в данных просто не описана.
 * Здесь такие типы и поля выводятся из того, в каком словаре записи лежат значения;
 * у них стоит `inferred: true` и `line: 0`.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { DataFile } from '../format/types.ts';
import type { FieldDef, FieldKind } from './fcs-def.ts';
import { findField, type GameSchema, type RecordDict, type TypeSchema } from './game-schema.ts';

const KIND_FOR_DICT: Record<Exclude<RecordDict, 'refs' | 'instances'>, FieldKind> = {
  bools: 'bool',
  ints: 'int',
  floats: 'float',
  vec3s: 'vec3',
  vec4s: 'vec4',
  strings: 'string',
  files: 'file',
};

interface Candidate {
  kind: FieldKind;
  count: number;
  targets: Map<string, number>;
}

function mostCommon(m: Map<string, number>): string | undefined {
  let best: string | undefined;
  let n = -1;
  for (const [k, v] of m) if (v > n) [best, n] = [k, v];
  return best;
}

/**
 * Вернуть копию схемы, в которую добавлены типы и поля, встреченные в данных, но не
 * описанные в fcs.def. Если одно имя встречается в разных словарях, берётся самый частый.
 */
export function withInferredFields(schema: GameSchema, files: readonly DataFile[]): GameSchema {
  const typeById = new Map<string, string>();
  for (const f of files) for (const r of f.records) typeById.set(r.stringId, itemTypeName(r.type, schema.itemTypes));

  // Тип → имя поля → вид → кандидат.
  const found = new Map<string, Map<string, Map<FieldKind, Candidate>>>();
  const add = (type: string, name: string, kind: FieldKind, target?: string): void => {
    let byName = found.get(type);
    if (!byName) found.set(type, (byName = new Map<string, Map<FieldKind, Candidate>>()));
    let byKind = byName.get(name);
    if (!byKind) byName.set(name, (byKind = new Map<FieldKind, Candidate>()));
    let c = byKind.get(kind);
    if (!c) byKind.set(kind, (c = { kind, count: 0, targets: new Map() }));
    c.count++;
    if (target !== undefined) c.targets.set(target, (c.targets.get(target) ?? 0) + 1);
  };

  // Ответы «описано ли поле» и «есть ли поле для объекта» — по типу один раз (55 тыс. записей).
  const knownByType = new Map<string, Map<string, boolean>>();
  const instByType = new Map<string, Map<string, boolean>>();
  for (const file of files) {
    for (const rec of file.records) {
      const type = itemTypeName(rec.type, schema.itemTypes);
      const ts = schema.types.get(type);
      let memo = knownByType.get(type);
      if (!memo) knownByType.set(type, (memo = new Map<string, boolean>()));
      const known = (key: string): boolean => {
        let k = memo.get(key);
        if (k === undefined) memo.set(key, (k = ts !== undefined && findField(ts, key) !== undefined));
        return k;
      };
      for (const dict of Object.keys(KIND_FOR_DICT) as (keyof typeof KIND_FOR_DICT)[]) {
        for (const key of rec[dict].keys()) if (!known(key)) add(type, key, KIND_FOR_DICT[dict]);
      }
      for (const [cat, list] of rec.refs) {
        if (known(cat)) continue;
        if (list.length === 0) add(type, cat, 'reference');
        for (const ref of list) add(type, cat, 'reference', typeById.get(ref.target));
      }
      for (const inst of rec.instances.values()) {
        const target = typeById.get(inst.target) ?? 'NULL_ITEM';
        let im = instByType.get(type);
        if (!im) instByType.set(type, (im = new Map<string, boolean>()));
        let has = im.get(target);
        if (has === undefined) {
          has = ts !== undefined && [...ts.fields.values()].some((f) => f.kind === 'instance' && (f.targetType === target || f.targetType === 'NULL_ITEM'));
          im.set(target, has);
        }
        if (!has) add(type, `→${target}`, 'instance', target);
      }
    }
  }

  const types = new Map<string, TypeSchema>();
  for (const [name, t] of schema.types) types.set(name, { ...t, fields: new Map(t.fields) });
  for (const [type, byName] of found) {
    let t = types.get(type);
    if (!t) {
      t = { name: type, fields: new Map(), conditions: [], owned: [], translate: [], sectionLines: [], inferred: true };
      types.set(type, t);
    }
    for (const [name, byKind] of byName) {
      const best = [...byKind.values()].sort((a, b) => b.count - a.count)[0]!;
      const def: FieldDef = { name, kind: best.kind, line: 0, inferred: true };
      const target = mostCommon(best.targets);
      if (target !== undefined) def.targetType = target;
      t.fields.set(name, def);
    }
  }
  return { ...schema, types };
}
