/**
 * Record types added by a schema extension, seen through a mod context: names instead of
 * `TYPE_<number>`, fields with descriptions, search and edits by type name, and a byte-exact
 * write. The mod and the extension are small fixtures written for this test.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  bulkSelect,
  compareTable,
  emptyRecord,
  encodeText,
  fieldRows,
  FileType,
  firstDifference,
  inspectRecord,
  itemTypeId,
  itemTypeName,
  ModContext,
  parseExtendedSchema,
  parseGameSchema,
  readDataFile,
  recordHeadline,
  recordToJson,
  recordTypeName,
  refGroups,
  searchRecords,
  summarize,
  validateMod,
  withInferredFields,
  writeDataFile,
  type DataFile,
  type GameRecord,
  type GameSchema,
  type SchemaSources,
} from '../src/index.ts';

const BASE: SchemaSources = {
  fcsDef: ['[DIALOGUE_LINE]', 'text0:   "" looped', '', '[ITEM]', 'value:   1 "price"'].join('\r\n'),
  fcsLayout: ['[FCS_LAYOUT]', 'Items: ITEM'].join('\r\n'),
};

const COUNTERS_DEF = [
  '// enum itemType { COUNTER=900 }',
  '[COUNTER]',
  'amount:          0 "how much"',
  '',
  '[FCS_LAYOUT]',
  'Counters: COUNTER',
  '',
  '[DIALOGUE_LINE]',
  'counter equals:  COUNTER (0) "checks a counter"',
].join('\r\n');

const COUNTER = 900;
const LINE = itemTypeId('DIALOGUE_LINE')!;
const NEW_RECORD = 0x80000002;

function extended(): GameSchema {
  return parseExtendedSchema(BASE, [{ name: 'Counters', def: { path: 'mods/Counters/fcs.def', text: COUNTERS_DEF } }]);
}

function record(type: number, sid: string, name: string, fill: (r: GameRecord) => void): GameRecord {
  const r = emptyRecord(type, sid, encodeText(name));
  r.changeFlags = NEW_RECORD;
  fill(r);
  return r;
}

/** Bytes of a mod with one COUNTER record and a dialogue line that refers to it. */
function modBytes(): Uint8Array {
  const b = encodeText;
  const file: DataFile = {
    fileType: FileType.Mod,
    header: { version: 3, author: b('me'), description: b('counters'), dependencies: b(''), references: b('') },
    lastId: 2,
    records: [
      record(COUNTER, '1-Counters.mod', 'Days passed', (r) => r.ints.set('amount', 5)),
      record(LINE, '2-Counters.mod', 'line', (r) => {
        r.strings.set('text0', b('Three days already.'));
        r.refs.set('counter equals', [{ target: '1-Counters.mod', v0: 3, v1: 0, v2: 0 }]);
      }),
    ],
    tail: new Uint8Array(),
  };
  return writeDataFile(file);
}

function open(schema: GameSchema | undefined): { ctx: ModContext; bytes: Uint8Array } {
  const bytes = modBytes();
  const ctx = new ModContext({ layers: [], mod: readDataFile(bytes), modName: 'Counters.mod', ...(schema && { schema }) });
  return { ctx, bytes };
}

describe('record types of a schema extension in a mod context', () => {
  it('the type has a name with the extension and a placeholder without it', () => {
    const { ctx } = open(extended());
    expect(ctx.typeName(COUNTER)).toBe('COUNTER');
    expect(ctx.typeId('COUNTER')).toBe(COUNTER);
    expect(ctx.typeName(LINE)).toBe('DIALOGUE_LINE');
    expect(ctx.typeId('DIALOGUE_LINE')).toBe(LINE);
    expect(ctx.typeName(901)).toBe('TYPE_901');
    expect(ctx.typeId('NO_SUCH_TYPE')).toBeUndefined();

    const plain = open(parseGameSchema(BASE)).ctx;
    expect(plain.typeName(COUNTER)).toBe('TYPE_900');
    expect(plain.typeId('COUNTER')).toBeUndefined();
    const bare = open(undefined).ctx;
    expect(bare.typeName(COUNTER)).toBe('TYPE_900');

    // There is no global registry: the plain functions know the type only with a table.
    expect(itemTypeName(COUNTER)).toBe('TYPE_900');
    expect(itemTypeName(COUNTER, ctx.schema!.itemTypes)).toBe('COUNTER');
    expect(itemTypeId('COUNTER')).toBeUndefined();
  });

  it('records show the name of the type, the fields their descriptions', () => {
    const { ctx } = open(extended());
    const counter = ctx.get('1-Counters.mod')!;
    expect(recordHeadline(ctx, counter)).toContain('COUNTER 1-Counters.mod «Days passed»');
    expect(recordToJson(ctx, counter)).toMatchObject({ type: 'COUNTER', fields: { int: { amount: 5 } } });
    expect(inspectRecord(ctx, '1-Counters.mod')).toMatchObject({ type: 'COUNTER', usedByTotal: 1 });
    expect(recordTypeName(counter, ctx.schema!.itemTypes)).toBe('COUNTER');
    expect([...summarize(ctx.buildModFile(), ctx.schema!.itemTypes).byType]).toEqual([
      ['COUNTER', 1],
      ['DIALOGUE_LINE', 1],
    ]);

    const rows = fieldRows(ctx, '1-Counters.mod');
    expect(rows.map((r) => r.key)).toEqual(['amount']);
    expect(rows[0]).toMatchObject({ value: 5, def: { kind: 'int', description: 'how much', extension: 'Counters' } });

    const group = refGroups(ctx, '2-Counters.mod').find((g) => g.category === 'counter equals')!;
    expect(group).toMatchObject({ targetType: 'COUNTER', def: { description: 'checks a counter', extension: 'Counters' } });
    expect(group.valueLabels).toHaveLength(1);
    expect(group.rows).toHaveLength(1);
    expect(group.rows[0]).toMatchObject({ ref: { target: '1-Counters.mod', v0: 3 }, targetName: 'Days passed', targetType: 'COUNTER' });
  });

  it('search, tables and bulk selection take the type by name', () => {
    const { ctx } = open(extended());
    expect(searchRecords(ctx, { type: 'counter' }).map((h) => [h.stringId, h.type])).toEqual([['1-Counters.mod', 'COUNTER']]);
    expect(searchRecords(ctx, { type: 900 })).toHaveLength(1);
    expect(bulkSelect(ctx, { type: 'COUNTER' }).map((r) => r.stringId)).toEqual(['1-Counters.mod']);
    expect(compareTable(ctx, 'COUNTER').rows.map((r) => r.sid)).toEqual(['1-Counters.mod']);

    const plain = open(parseGameSchema(BASE)).ctx;
    expect(() => searchRecords(plain, { type: 'counter' })).toThrow();
    expect(searchRecords(plain, { type: 900 }).map((h) => h.type)).toEqual(['TYPE_900']);
  });

  it('the checker knows the type and the target of the reference', () => {
    const { ctx } = open(extended());
    expect(validateMod(ctx).filter((i) => i.code === 'unknown-type' || i.code === 'wrong-target-type' || i.code === 'unknown-field')).toEqual([]);

    const plain = open(parseGameSchema(BASE)).ctx;
    const unknown = validateMod(plain).filter((i) => i.code === 'unknown-type');
    expect(unknown.map((i) => i.stringId)).toEqual(['1-Counters.mod']);
    expect(unknown[0]!.message).toContain('TYPE_900');
  });

  it('data of the mod does not turn the type into a guessed one', () => {
    const schema = extended();
    const { ctx } = open(schema);
    const inferred = withInferredFields(schema, [ctx.buildModFile()]);
    expect(inferred.itemTypes).toBe(schema.itemTypes);
    expect(inferred.types.has('TYPE_900')).toBe(false);
    expect([...inferred.types.get('COUNTER')!.fields.keys()]).toEqual(['amount']);
  });

  it('an untouched mod is written byte for byte', () => {
    for (const schema of [extended(), parseGameSchema(BASE), undefined]) {
      const { ctx, bytes } = open(schema);
      const out = writeDataFile(ctx.buildModFile());
      expect(firstDifference(bytes, out)).toBe(-1);
      expect(out.length).toBe(bytes.length);
    }
  });

  it('a record of the new type can be created by name and survives a write and a read', () => {
    const { ctx } = open(extended());
    const { created } = applyOps(ctx, [
      { op: 'create', type: 'COUNTER', name: 'Bandits killed', as: '$c' },
      { op: 'set', id: '$c', field: 'amount', value: 12 },
    ]);
    expect(created).toHaveLength(1);
    const sid = created[0]!;
    expect(ctx.get(sid)!.type).toBe(COUNTER);
    ctx.addReference('2-Counters.mod', 'counter equals', sid);
    expect(ctx.get('2-Counters.mod')!.refs.get('counter equals')!.at(-1)).toMatchObject({ target: sid, v0: 0 });

    const again = readDataFile(writeDataFile(ctx.buildModFile()));
    expect(again.records.map((r) => [r.type, r.stringId])).toEqual([
      [COUNTER, '1-Counters.mod'],
      [LINE, '2-Counters.mod'],
      [COUNTER, sid],
    ]);
    expect(again.records[2]!.ints.get('amount')).toBe(12);

    const plain = open(parseGameSchema(BASE)).ctx;
    expect(() => applyOps(plain, [{ op: 'create', type: 'COUNTER', name: 'x' }])).toThrow();
  });
});
