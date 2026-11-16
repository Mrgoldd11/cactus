/**
 * Interiors: building layouts, objects, a new object with state (copy of a sample, floor, faction),
 * move with floor, deletion, undo; lazy reading of `interiors.level`; lossless writing.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeText,
  emptyRecord,
  encodeText,
  FileType,
  interiorLayouts,
  INTERIORS,
  itemTypeId,
  layoutObjects,
  layoutOfBuilding,
  moveInterior,
  placeInterior,
  readDataFile,
  removeInterior,
  WorldEdits,
  writeDataFile,
  type DataFile,
  type GameRecord,
  type RecordTypes,
  type WorldFile,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);

function rec(type: string, sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, b(name));
  fill(r);
  return r;
}

function level(records: GameRecord[], lastId = 0): DataFile {
  return { fileType: FileType.Data, lastId, records, tail: new Uint8Array() };
}

const LAYOUT = 'HOUSE-Noble House';

/** .mod record types: building, bed, chest, item spot, character. */
const types: RecordTypes = {
  headline: (sid) => {
    const t = { HOUSE: 'BUILDING', BED: 'BUILDING', CHEST: 'BUILDING', LOOT: 'ITEM_PLACEMENT_GROUP', GUY: 'CHARACTER' }[sid];
    return t ? { type: itemTypeId(t)!, name: b(sid.toLowerCase()) } : undefined;
  },
};

function interiors(): WorldFile {
  return {
    layer: 'gamedata.base',
    path: INTERIORS,
    file: level(
      [
        rec('INSTANCE_COLLECTION', LAYOUT, 'Noble House', (r) => {
          r.strings.set('associated building', b('HOUSE'));
          r.bools.set('is exterior', false);
          r.instances.set('10-base', { target: 'BED', position: [0, 182, 0], rotation: [1, 0, 0, 0], states: [b('10-base-S23')] });
          r.instances.set('12-base', { target: 'CHEST', position: [5, 229, 5], rotation: [1, 0, 0, 0], states: [b('12-base-S23')] });
          r.instances.set('14-base', { target: 'LOOT', position: [3, 182, 3], rotation: [1, 0, 0, 0], states: [b('15-base')] });
        }),
        rec('INSTANCE_COLLECTION', 'EXT-HOUSE-Sign', 'Sign', (r) => {
          r.strings.set('associated building', b('HOUSE'));
          r.bools.set('is exterior', true);
        }),
        rec('GAMESTATE_BUILDING', '10-base-S23', '0', (r) => {
          r.strings.set('name', b('Bed'));
          r.strings.set('owner faction ID', b('NOBLES'));
          r.strings.set('usagenode_0', b('bed01'));
          r.ints.set('floornum', 0);
          r.floats.set('player furniture Y offset', 181);
        }),
        rec('GAMESTATE_BUILDING', '12-base-S23', '0', (r) => {
          r.strings.set('name', b('Chest'));
          r.ints.set('floornum', 1);
          r.bools.set('locked', true);
          r.ints.set('lock lvl', 40);
        }),
        rec('ITEM_PLACEMENT_GROUP', '15-base', '0', (r) => {
          r.strings.set('base data sid', b('LOOT'));
          r.ints.set('floornum', 0);
        }),
      ],
      15,
    ),
  };
}

function edits(): WorldEdits {
  const e = new WorldEdits([], 'My Mod.mod');
  e.addFiles([interiors()]);
  return e;
}

describe('interiors', () => {
  it('without addFiles interiors cannot be edited', () => {
    const e = new WorldEdits([], 'My Mod.mod');
    expect(e.isLoaded(INTERIORS)).toBe(false);
    expect(() => interiorLayouts(e)).toThrow(/not read yet/);
    expect(() => e.place(INTERIORS, LAYOUT, 'BED', [0, 0, 0], [1, 0, 0, 0])).toThrow(/addFiles/);
    e.addFiles([]);
    expect(e.isLoaded(INTERIORS)).toBe(true);
    expect(() => { e.addFiles([]); }).toThrow(/already read/);
  });

  it('building layouts and objects', () => {
    const e = edits();
    const ls = interiorLayouts(e, 'HOUSE');
    expect(ls.map((l) => [l.name, l.exterior, l.objects])).toEqual([
      ['Noble House', false, 3],
      ['Sign', true, 0],
    ]);
    const objs = layoutObjects(e, types, LAYOUT);
    expect(objs.map((o) => [o.key, o.kind, o.floor])).toEqual([
      ['10-base', 'furniture', 0],
      ['12-base', 'furniture', 1],
      ['14-base', 'items', 0],
    ]);
    expect(objs[1]).toMatchObject({ locked: true, lockLevel: 40 });
    expect(objs[2]!.items).toBe('LOOT');
    expect(layoutOfBuilding(e, { target: 'HOUSE', interior: 'noble house' })?.sid).toBe(LAYOUT);
    expect(layoutOfBuilding(e, { target: 'HOUSE' })).toBeUndefined();
    // The world files for WorldIndex have no interiors.
    expect(e.files().some((f) => f.path === INTERIORS)).toBe(false);
    expect(e.files({ interiors: true }).some((f) => f.path === INTERIORS)).toBe(true);
  });

  it('new furniture: copy of the sample state, neighbour floor, layout faction', () => {
    const e = edits();
    const r = placeInterior(e, types, LAYOUT, 'BED', [1, 230, 1], [1, 0, 0, 0]);
    expect(r).toEqual({ key: '1-My Mod-INGAME', state: '1-My Mod-INGAME-S23', floor: 1, template: '10-base-S23' });
    const st = e.record(INTERIORS, r.state)!;
    expect(decodeText(st.strings.get('usagenode_0')!)).toBe('bed01');
    expect(decodeText(st.strings.get('owner faction ID')!)).toBe('NOBLES');
    expect(st.ints.get('floornum')).toBe(1);
    expect(st.floats.get('player furniture Y offset')).toBe(181 + 48);
    expect(e.history().undo).toEqual(['New object in an interior']);
    const file = e.buildFile(INTERIORS)!;
    expect(file.lastId).toBe(1);
    // The layout in the mod — with fields, but only with the new instance.
    const holder = file.records.find((x) => x.stringId === LAYOUT)!;
    expect([...holder.instances.keys()]).toEqual(['1-My Mod-INGAME']);
    expect(decodeText(holder.strings.get('associated building')!)).toBe('HOUSE');
    // Lossless writing.
    expect(writeDataFile(readDataFile(writeDataFile(file)))).toEqual(writeDataFile(file));
  });

  it('new item spot: own state with the next id; without a sample — built from scratch', () => {
    const e = edits();
    const r = placeInterior(e, types, LAYOUT, 'LOOT', [0, 183, 0], [1, 0, 0, 0]);
    expect(r).toMatchObject({ key: '1-My Mod-INGAME', state: '2-My Mod-INGAME', floor: 0 });
    expect(e.buildFile(INTERIORS)!.lastId).toBe(2);
    expect(decodeText(e.record(INTERIORS, r.state)!.strings.get('base data sid')!)).toBe('LOOT');
    // Furniture without a sample: state with the record name.
    const c = placeInterior(e, types, LAYOUT, 'HOUSE', [0, 183, 0], [1, 0, 0, 0]);
    expect(c.template).toBeUndefined();
    const st = e.record(INTERIORS, c.state)!;
    expect(decodeText(st.strings.get('name')!)).toBe('house');
    expect(st.bools.get('is inside building')).toBe(true);
    expect(() => placeInterior(e, types, LAYOUT, 'GUY', [0, 0, 0], [1, 0, 0, 0])).toThrow(/furniture/);
    expect(() => placeInterior(e, types, 'NOPE', 'BED', [0, 0, 0], [1, 0, 0, 0])).toThrow(/No layout/);
  });

  it('move: floor and height in the state; horizontally — the state is not touched', () => {
    const e = edits();
    moveInterior(e, types, LAYOUT, '10-base', [7, 182, 0], [1, 0, 0, 0]);
    expect(e.buildFile(INTERIORS)!.records.map((x) => x.stringId)).toEqual([LAYOUT]);
    moveInterior(e, types, LAYOUT, '10-base', [7, 228, 0], [1, 0, 0, 0]);
    const st = e.record(INTERIORS, '10-base-S23')!;
    expect(st.ints.get('floornum')).toBe(1);
    expect(st.floats.get('player furniture Y offset')).toBe(181 + 46);
    // State — as a full copy.
    expect(e.buildFile(INTERIORS)!.records.find((x) => x.stringId === '10-base-S23')!.strings.size).toBe(3);
    e.undo();
    e.undo();
    expect(e.buildFile(INTERIORS)?.records ?? []).toEqual([]);
  });

  it('deletion: own — erased with its state, from vanilla — marked "deleted"', () => {
    const e = edits();
    const r = placeInterior(e, types, LAYOUT, 'LOOT', [0, 183, 0], [1, 0, 0, 0]);
    removeInterior(e, LAYOUT, r.key);
    expect(e.record(INTERIORS, r.state)).toBeUndefined();
    removeInterior(e, LAYOUT, '12-base');
    const holder = e.buildFile(INTERIORS)!.records.find((x) => x.stringId === LAYOUT)!;
    expect(holder.instances.get('12-base')).toEqual({ target: '', position: [0, 0, 0], rotation: [1, 0, 0, 0], states: [] });
    expect(layoutObjects(e, types, LAYOUT).map((o) => o.key)).toEqual(['10-base', '14-base']);
    while (e.canUndo()) e.undo();
    expect(e.isDirty()).toBe(false);
  });

  it('the mod own interiors.level is read in and edited on top', () => {
    const mine: WorldFile = {
      layer: 'My Mod.mod',
      path: INTERIORS,
      file: level(
        [
          rec('INSTANCE_COLLECTION', LAYOUT, 'Noble House', (r) => {
            r.strings.set('associated building', b('HOUSE'));
            r.instances.set('3-My Mod-INGAME', { target: 'CHEST', position: [9, 182, 9], rotation: [1, 0, 0, 0], states: [b('3-My Mod-INGAME-S23')] });
          }),
          rec('GAMESTATE_BUILDING', '3-My Mod-INGAME-S23', '0', (r) => r.ints.set('floornum', 0)),
        ],
        3,
      ),
    };
    const e = new WorldEdits([], 'My Mod.mod');
    e.addFiles([interiors(), mine]);
    expect(layoutObjects(e, types, LAYOUT)).toHaveLength(4);
    const before = writeDataFile(e.buildFile(INTERIORS)!);
    expect(before).toEqual(writeDataFile(mine.file));
    const r = placeInterior(e, types, LAYOUT, 'CHEST', [0, 182, 0], [1, 0, 0, 0]);
    expect(r.key).toBe('4-My Mod-INGAME');
    expect(r.template).toBe('12-base-S23');
    e.undo();
    expect(writeDataFile(e.buildFile(INTERIORS)!)).toEqual(before);
  });
});
