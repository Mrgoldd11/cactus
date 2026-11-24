/**
 * Checking the schema (fcs.def) against real data: which types and fields are in the files but not
 * described in the schema, which are described but never occur, and where a field's kind does not match the
 * dictionary its value lives in.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { DataFile } from '../format/types.ts';
import { DICT_FOR_KIND, findField, type GameSchema, type RecordDict } from './game-schema.ts';
import type { FieldKind } from './fcs-def.ts';

export interface CoverageInput {
  /** File name for examples in the report. */
  label: string;
  file: DataFile;
}

interface Occurrence {
  /** How many records contain the key. */
  records: number;
  files: Set<string>;
  /** First example: `file: stringId`. */
  example: string;
}

export interface CoverageTypeStat {
  type: string;
  records: number;
  files: number;
  inSchema: boolean;
}

export interface MissingField {
  type: string;
  dict: RecordDict;
  /** Key from the data; for instances — `→TARGET_TYPE`. */
  key: string;
  records: number;
  files: number;
  example: string;
}

export interface KindMismatch extends MissingField {
  field: string;
  kind: FieldKind;
}

export interface RefTargetMismatch {
  type: string;
  category: string;
  expected: string;
  actual: string;
  refs: number;
  example: string;
}

export interface CoverageReport {
  files: number;
  records: number;
  types: CoverageTypeStat[];
  /** Types from the data with no section at all in fcs.def. */
  typesWithoutSchema: string[];
  /** Types from fcs.def with no records in the data. */
  schemaTypesWithoutData: string[];
  /** Keys from the data absent from fcs.def (for types that have a schema). */
  missingInSchema: MissingField[];
  /** The key is in the schema, but the value lives in the wrong dictionary. */
  kindMismatches: KindMismatch[];
  /** fcs.def fields that never occur in the data (only for types present in the data). */
  unusedFields: { type: string; field: string; kind: FieldKind; line: number }[];
  /** References whose target is a record of a different type than fcs.def says. */
  refTargetMismatches: RefTargetMismatch[];
}

const VALUE_DICTS = ['bools', 'floats', 'ints', 'vec3s', 'vec4s', 'strings', 'files'] as const;

export function analyzeCoverage(schema: GameSchema, inputs: readonly CoverageInput[]): CoverageReport {
  // Types of all records by string id — to check reference and instance targets.
  const typeById = new Map<string, string>();
  for (const { file } of inputs) for (const r of file.records) typeById.set(r.stringId, itemTypeName(r.type, schema.itemTypes));

  const typeStats = new Map<string, { records: number; files: Set<string> }>();
  const missing = new Map<string, Occurrence & { type: string; dict: RecordDict; key: string }>();
  const mismatches = new Map<string, Occurrence & { type: string; dict: RecordDict; key: string; field: string; kind: FieldKind }>();
  const refMismatch = new Map<string, RefTargetMismatch>();
  const used = new Set<string>();
  let records = 0;

  const bump = <T extends Occurrence>(map: Map<string, T>, id: string, label: string, sid: string, make: () => Omit<T, keyof Occurrence>): void => {
    let o = map.get(id);
    if (!o) {
      o = { ...make(), records: 0, files: new Set<string>(), example: `${label}: ${sid}` } as T;
      map.set(id, o);
    }
    o.records++;
    o.files.add(label);
  };

  for (const { label, file } of inputs) {
    for (const rec of file.records) {
      records++;
      const type = itemTypeName(rec.type, schema.itemTypes);
      let st = typeStats.get(type);
      if (!st) {
        st = { records: 0, files: new Set() };
        typeStats.set(type, st);
      }
      st.records++;
      st.files.add(label);
      const ts = schema.types.get(type);
      if (!ts) continue;

      const check = (dict: RecordDict, key: string): boolean => {
        const f = findField(ts, key);
        if (!f) {
          bump(missing, `${type}|${dict}|${key}`, label, rec.stringId, () => ({ type, dict, key }));
          return false;
        }
        used.add(`${type}|${f.name}`);
        if (f.kind !== 'null' && DICT_FOR_KIND[f.kind] !== dict) {
          bump(mismatches, `${type}|${dict}|${key}`, label, rec.stringId, () => ({ type, dict, key, field: f.name, kind: f.kind }));
          return false;
        }
        return true;
      };

      for (const dict of VALUE_DICTS) for (const key of rec[dict].keys()) check(dict, key);

      for (const [cat, list] of rec.refs) {
        if (!check('refs', cat)) continue;
        const expected = findField(ts, cat)!.targetType;
        if (expected === undefined || expected === 'NULL_ITEM') continue;
        for (const ref of list) {
          const actual = typeById.get(ref.target);
          if (actual === undefined || actual === expected) continue;
          const id = `${type}|${cat}|${actual}`;
          const m = refMismatch.get(id);
          if (m) m.refs++;
          else refMismatch.set(id, { type, category: cat, expected, actual, refs: 1, example: `${label}: ${rec.stringId} → ${ref.target}` });
        }
      }

      // Instances are stored by their own id; the fcs.def field is determined by the target type.
      const seen = new Set<string>();
      for (const inst of rec.instances.values()) {
        const target = typeById.get(inst.target) ?? '?';
        if (seen.has(target)) continue;
        seen.add(target);
        const f = [...ts.fields.values()].find((x) => x.kind === 'instance' && (x.targetType === target || x.targetType === 'NULL_ITEM'));
        if (f) used.add(`${type}|${f.name}`);
        else bump(missing, `${type}|instances|→${target}`, label, rec.stringId, () => ({ type, dict: 'instances' as const, key: `→${target}` }));
      }
    }
  }

  const finish = <T extends Occurrence>(o: T): Omit<T, 'files'> & { files: number } => ({ ...o, files: o.files.size });
  const byType = (a: { type: string; records: number }, b: { type: string; records: number }): number =>
    a.type.localeCompare(b.type) || b.records - a.records;

  const unusedFields: CoverageReport['unusedFields'] = [];
  for (const [type, ts] of schema.types) {
    if (!typeStats.has(type)) continue;
    for (const f of ts.fields.values()) {
      if (f.kind === 'null' || used.has(`${type}|${f.name}`)) continue;
      unusedFields.push({ type, field: f.name, kind: f.kind, line: f.line });
    }
  }

  return {
    files: inputs.length,
    records,
    types: [...typeStats]
      .map(([type, s]) => ({ type, records: s.records, files: s.files.size, inSchema: schema.types.has(type) }))
      .sort((a, b) => b.records - a.records),
    typesWithoutSchema: [...typeStats.keys()].filter((t) => !schema.types.has(t)).sort(),
    schemaTypesWithoutData: [...schema.types.keys()].filter((t) => !typeStats.has(t)).sort(),
    missingInSchema: [...missing.values()].map(finish).sort(byType),
    kindMismatches: [...mismatches.values()].map(finish).sort(byType),
    unusedFields,
    refTargetMismatches: [...refMismatch.values()].sort((a, b) => a.type.localeCompare(b.type) || b.refs - a.refs),
  };
}
