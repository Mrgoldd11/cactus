/**
 * Interior floors and strays: floor heights from objects and interior parts, the floor of an
 * object without `floornum`, the cut height, objects far from the building. On the game files:
 * the «Inside» shell of the Metal Warehouse (cavernous, blank interior) and of Outpost s-III.
 */
import { describe, expect, it } from 'vitest';
import { floorCut, interiorFloors, modelOfRecord, objectFloor, strayObjects, type InteriorObject } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const obj = (key: string, y: number, floor?: number, x = 0, z = 0): InteriorObject => {
  const o: InteriorObject = { key, target: 't', kind: 'furniture', position: [x, y, z], rotation: [1, 0, 0, 0] };
  if (floor !== undefined) o.floor = floor;
  return o;
};

describe('interior floors', () => {
  it('heights: lowest object of each floor, growing with the number', () => {
    const objs = [obj('a', 182, 0), obj('b', 200, 0), obj('c', 226, 1), obj('d', 287, 1), obj('lamp', 250)];
    expect(interiorFloors(objs)).toEqual([{ floor: 0, level: 182 }, { floor: 1, level: 226 }]);
  });

  it('a floor with only an interior part takes the part height', () => {
    const floors = interiorFloors([obj('a', 6, 0)], [{ floor: 0, interior: true, minY: 5 }, { floor: 1, interior: true, minY: 54 }, { floor: 2, minY: 57 }]);
    expect(floors).toEqual([{ floor: 0, level: 6 }, { floor: 1, level: 54 }]);
  });

  it('no floor numbers: one floor where the objects stand, strays left out', () => {
    const objs = [obj('a', 94), obj('b', 130), obj('far', -2300, undefined, 113000, -49000)];
    const stray = strayObjects(objs);
    expect([...stray]).toEqual(['far']);
    expect(interiorFloors(objs, [], stray)).toEqual([{ floor: 0, level: 94 }]);
  });

  it('object floor: floornum, otherwise the highest floor at or below it', () => {
    const floors = [{ floor: 0, level: 6 }, { floor: 1, level: 58 }];
    expect(objectFloor(obj('x', 90), floors)).toBe(1);
    expect(objectFloor(obj('x', 20), floors)).toBe(0);
    expect(objectFloor(obj('x', 90, 0), floors)).toBe(0);
    expect(objectFloor(obj('x', -5), floors)).toBe(0);
  });

  it('cut: half a storey over the floor, under the next floor, also on the top floor', () => {
    // Metal Wallhouse: floors at 6 and 58, the ceiling of the upper floor at 90.
    const floors = [{ floor: 0, level: 6 }, { floor: 1, level: 58 }];
    expect(floorCut(floors, 0)).toBe(32);
    expect(floorCut(floors, 1)).toBe(84);
    expect(floorCut(floors, 1)! < 90).toBe(true);
    // One floor: 40 over it; a low mezzanine: never over the next floor.
    expect(floorCut([{ floor: 0, level: 94 }], 0)).toBe(134);
    expect(floorCut([{ floor: 0, level: 0 }, { floor: 1, level: 14 }], 0)).toBe(12);
    expect(floorCut(floors, 5)).toBeUndefined();
  });

  it('strays: a compact layout has none', () => {
    const objs = Array.from({ length: 20 }, (_, i) => obj(`k${i}`, 100 + i, 0, i * 20 - 200, 300 - i * 30));
    expect(strayObjects(objs).size).toBe(0);
  });
});

const paths = resolveGamePaths();
describe.skipIf(!hasGame(paths))('the «Inside» shell on the game files', () => {
  const { ctx } = loadModContext({ paths, schema: false, po: false });

  it('Metal Warehouse: interior is blank, the shell is walls, walkways and a roof', () => {
    const m = modelOfRecord(ctx, '40591-Newwworld.mod', { shell: true });
    expect(modelOfRecord(ctx, '40591-Newwworld.mod', { interior: true }).pieces).toHaveLength(0);
    const names = m.pieces.map((p) => p.mesh.split('/').pop());
    expect(names).toEqual(expect.arrayContaining(['Metal_WareHouse_WALLS.mesh', 'Metal_WareHouse_Walkways.mesh', 'Metal_WareHouse_ROOF.mesh']));
    expect(m.pieces.find((p) => /ROOF/.test(p.mesh))?.roof).toBe(true);
  });

  it('Outpost s-III: exterior and interior parts with floors, and the door', () => {
    const m = modelOfRecord(ctx, '727-gamedata.base', { shell: true });
    const floors = new Set(m.pieces.filter((p) => p.interior).map((p) => p.floor));
    expect([...floors].sort()).toEqual([0, 1]);
    expect(m.pieces.some((p) => !p.interior && p.floor === 2)).toBe(true);
    expect(m.pieces.some((p) => p.door)).toBe(true);
  });
});
