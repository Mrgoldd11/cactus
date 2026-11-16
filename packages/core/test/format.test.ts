import { describe, expect, it } from 'vitest';
import {
  FileType,
  FormatError,
  bytesEqual,
  emptyRecord,
  encodeText,
  itemTypeId,
  itemTypeName,
  joinModList,
  readDataFile,
  splitModList,
  writeDataFile,
  type DataFile,
  type GameRecord,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);

function richRecord(): GameRecord {
  const r = emptyRecord(itemTypeId('CHARACTER')!, '100-test.mod', b('Бандит'));
  r.id = 100;
  r.changeFlags = 0x80000003;
  r.bools.set('is trader', true).set('female', false);
  r.floats.set('weight', 1.5).set('broken', Number.NaN);
  r.ints.set('money', -42).set('NPC class', 3);
  r.vec3s.set('offset', [1, 2, 3]);
  r.vec4s.set('quat', [1, 0, 0, 0]);
  r.strings.set('description', b('строка с «кавычками»\n и переводом'));
  r.files.set('mesh', b('data/items/test.mesh'));
  r.refs.set('vendors', [
    { target: '200-test.mod', v0: 1, v1: 2, v2: 3 },
    { target: '200-test.mod', v0: 1, v1: 2, v2: 3 }, // repeats are kept
  ]);
  r.refs.set('empty category', []);
  r.instances.set('inst1', {
    target: '300-test.mod',
    position: [10, 20, 30],
    rotation: [1, 0, Number.NaN, 0],
    states: [b('state a'), b('')],
  });
  r.quirks = { nanBits: new Map([['float:broken', 0x7fc00123], ['inst:inst1:5', 0xffc00000]]) };
  return r;
}

function modFile(fileType: number): DataFile {
  return {
    fileType,
    header: {
      version: 3,
      author: b('Автор'),
      description: b('Описание'),
      dependencies: joinModList(['gamedata.base', 'Newwworld.mod']),
      references: b(''),
    },
    lastId: 1234,
    records: [richRecord(), emptyRecord(itemTypeId('DIALOG_ACTION')!, '5-x.mod')],
    tail: new Uint8Array(),
  };
}

function roundTrip(file: DataFile): { bytes: Uint8Array; back: DataFile; again: Uint8Array } {
  const bytes = writeDataFile(file);
  const back = readDataFile(bytes);
  return { bytes, back, again: writeDataFile(back) };
}

describe('.mod/.base format', () => {
  it('format 16: values of all kinds there and back', () => {
    const { bytes, back, again } = roundTrip(modFile(FileType.Mod));
    expect(bytesEqual(bytes, again)).toBe(true);
    const r = back.records[0]!;
    expect(back.fileType).toBe(16);
    expect(back.lastId).toBe(1234);
    expect(splitModList(back.header!.dependencies)).toEqual(['gamedata.base', 'Newwworld.mod']);
    expect(itemTypeName(r.type)).toBe('CHARACTER');
    expect(r.changeFlags).toBe(0x80000003);
    expect([...r.bools]).toEqual([['is trader', true], ['female', false]]);
    expect(r.floats.get('weight')).toBe(1.5);
    expect(r.floats.get('broken')).toBeNaN();
    expect(r.ints.get('money')).toBe(-42);
    expect(r.vec3s.get('offset')).toEqual([1, 2, 3]);
    expect(r.refs.get('vendors')).toHaveLength(2);
    expect(r.refs.get('empty category')).toEqual([]);
    expect(r.instances.get('inst1')!.states.map((s) => new TextDecoder().decode(s))).toEqual(['state a', '']);
    expect(r.quirks?.nanBits).toEqual(new Map([['float:broken', 0x7fc00123], ['inst:inst1:5', 0xffc00000]]));
  });

  it('format 17: header length, merge data, delete requests and extra bytes', () => {
    const file = modFile(FileType.MergeMod);
    file.header!.merge = {
      saveCount: 7,
      lastMerge: 2,
      mergeEntries: [{ key: 'gamedata.base', a: 1, b: 2 }],
      deleteRequests: [{ key: '1-x.mod', a: 3, value: b('val') }],
    };
    file.header!.extra = new Uint8Array([9, 9, 9]);
    file.records[0]!.lead = 1; // non-zero — will be recalculated
    const { bytes, back, again } = roundTrip(file);
    expect(bytesEqual(bytes, again)).toBe(true);
    expect(back.header!.merge).toEqual(file.header!.merge);
    expect([...back.header!.extra!]).toEqual([9, 9, 9]);
    const lead = back.records[0]!.lead;
    expect(lead).toBeGreaterThan(60);
    expect(back.records[1]!.lead).toBe(0); // zero stays zero
  });

  it('format 17 without a deletion block differs from an empty block', () => {
    const file = modFile(FileType.MergeMod);
    file.header!.merge = { saveCount: 1, lastMerge: 0, mergeEntries: [] };
    const without = writeDataFile(file);
    file.header!.merge.deleteRequests = [];
    const withEmpty = writeDataFile(file);
    expect(withEmpty.length).toBe(without.length + 1);
    expect(readDataFile(without).header!.merge!.deleteRequests).toBeUndefined();
    expect(readDataFile(withEmpty).header!.merge!.deleteRequests).toEqual([]);
  });

  it('format 15: no header, the tail is kept', () => {
    const file: DataFile = { fileType: FileType.Data, lastId: 0, records: [richRecord()], tail: new Uint8Array([1, 2, 3, 4]) };
    const { bytes, back, again } = roundTrip(file);
    expect(bytesEqual(bytes, again)).toBe(true);
    expect(back.header).toBeUndefined();
    expect([...back.tail]).toEqual([1, 2, 3, 4]);
  });

  it('bools other than 0/1 and non-UTF-8 ids are written as they were', () => {
    const file = modFile(FileType.Mod);
    const r = file.records[0]!;
    r.quirks = { ...r.quirks, boolBytes: new Map([['is trader', 2]]) };
    file.latin1Ids = new Set(['100-tést.mod']);
    r.stringId = '100-tést.mod';
    const { bytes, back, again } = roundTrip(file);
    expect(bytesEqual(bytes, again)).toBe(true);
    expect(back.records[0]!.quirks?.boolBytes?.get('is trader')).toBe(2);
    expect(back.latin1Ids?.has('100-tést.mod')).toBe(true);
    expect(back.records[0]!.stringId).toBe('100-tést.mod');
  });

  it('errors: truncated file, unknown type, repeated key', () => {
    const bytes = writeDataFile(modFile(FileType.Mod));
    expect(() => readDataFile(bytes.slice(0, bytes.length - 3))).toThrow(FormatError);
    const unknown = bytes.slice();
    unknown[0] = 99;
    expect(() => readDataFile(unknown)).toThrow();

    // Two bool fields 'aa' and 'ab' → identical keys 'aa'.
    const f = modFile(FileType.Mod);
    f.records[0]!.bools = new Map([['aa', true], ['ab', true]]);
    const dup = writeDataFile(f);
    const pattern = [2, 0, 0, 0, 0x61, 0x62];
    const at = dup.findIndex((_, i) => pattern.every((v, j) => dup[i + j] === v));
    dup[at + 5] = 0x61;
    expect(() => readDataFile(dup)).toThrow(/повтор|Повтор/);
  });
});
