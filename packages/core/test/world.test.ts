/**
 * Stage 3, "Where in the game": world model (towns, buildings, instances in zones) and the chain of back
 * references from a record to a place in the world — on synthetic data.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyRecord,
  encodeText,
  FileType,
  formatPosition,
  formatWhere,
  itemTypeId,
  ModContext,
  whereInGame,
  WorldIndex,
  zoneOfPath,
  type DataFile,
  type GameRecord,
  type Reference,
  type WorldFile,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);
const T = (n: string): number => itemTypeId(n)!;
const ref = (target: string): Reference => ({ target, v0: 0, v1: 0, v2: 0 });

function rec(type: string, sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(T(type), sid, b(name));
  fill(r);
  return r;
}

function file(records: GameRecord[], fileType: number = FileType.Mod): DataFile {
  return {
    fileType,
    ...(fileType === FileType.Mod
      ? { header: { version: 1, author: b(''), description: b(''), dependencies: b(''), references: b('') } }
      : {}),
    lastId: 0,
    records,
    tail: new Uint8Array(),
  };
}

/** Data: katana → trader list → trader squad → towns Town A and Town B; plus a thief squad. */
function gameData(): DataFile {
  return file([
    rec('WEAPON', 'KAT', 'Katana', (r) => r.files.set('icon', b('.\\data\\items\\icons\\katana.png'))),
    rec('VENDOR_LIST', 'VL', 'weapon vendor list', (r) => r.refs.set('weapons', [ref('KAT')])),
    rec('CHARACTER', 'TRADER', 'Weapon Trader'),
    rec('SQUAD_TEMPLATE', 'SQ', 'weapon vendor', (r) => {
      r.refs.set('vendors', [ref('VL')]);
      r.refs.set('leader', [ref('TRADER')]);
      r.bools.set('is trader', true);
    }),
    rec('TOWN', 'TA', 'Town A', (r) => r.refs.set('residents', [ref('SQ')])),
    rec('TOWN', 'TB', 'Town B', (r) => {
      r.refs.set('residents', [ref('SQ')]);
      r.refs.set('override town', [ref('TB2')]);
    }),
    // A town variant (base → variant via `override town`), it has no place of its own in the world.
    rec('TOWN', 'TB2', 'Town B (override)', (r) => r.refs.set('residents', [ref('SQ')])),
    rec('CHARACTER', 'THIEF', 'Thief', (r) => r.refs.set('weapons', [ref('KAT')])),
    rec('BUILDING', 'SHOP', 'Weapon Shop'),
    rec('BUILDING', 'ROCK', 'Rock'),
  ]);
}

/** Level: the town list (A in zone 1.1, B in zone 2.2) and zone 2.2 with a shop and a rock. */
function worldFiles(): WorldFile[] {
  const level = file(
    [
      rec('GAMESTATE_TOWN_INSTANCE_LIST', '0-townlist', 'towns', (r) => {
        r.instances.set('a', { target: 'TA', position: [100, 0, 200], rotation: [1, 0, 0, 0], states: [b('GA')] });
        r.instances.set('b', { target: 'TB', position: [5000, 10, 6000], rotation: [1, 0, 0, 0], states: [b('GB')] });
      }),
      rec('GAMESTATE_TOWN', 'GA', 'a', (r) => {
        r.ints.set('zones_count', 1);
        r.ints.set('zone_x_0', 1);
        r.ints.set('zone_y_0', 1);
        r.ints.set('handC', 1);
        r.ints.set('handCS', 11);
      }),
      rec('GAMESTATE_TOWN', 'GB', 'b', (r) => {
        r.ints.set('zones_count', 1);
        r.ints.set('zone_x_0', 2);
        r.ints.set('zone_y_0', 2);
        r.ints.set('handC', 2);
        r.ints.set('handCS', 22);
      }),
    ],
    FileType.Data,
  );
  const zone = file(
    [
      rec('INSTANCE_COLLECTION', '0-buildinglist', 'buildings', (r) => {
        r.instances.set('s', { target: 'SHOP', position: [5100, 0, 6050], rotation: [1, 0, 0, 0], states: [b('GS')] });
        r.instances.set('r', { target: 'ROCK', position: [5200, 0, 6100], rotation: [1, 0, 0, 0], states: [] });
      }),
      // The town handle is stale (no such town) — bound to the nearest town of the zone.
      rec('GAMESTATE_BUILDING', 'GS', 'shop state', (r) => {
        r.strings.set('name', b('Weapon Shop'));
        r.strings.set('squad template', b('SQ'));
        r.ints.set('townC', 9);
        r.ints.set('townCS', 99);
      }),
    ],
    FileType.Data,
  );
  return [
    { layer: 'gamedata.base', path: 'leveldata.level', file: level },
    { layer: 'gamedata.base', path: 'zone.2.2.zone', file: zone },
  ];
}

const ctxOf = (): ModContext => new ModContext({ layers: [{ name: 'gamedata.base', file: gameData() }], modName: 'test.mod' });

describe('world: towns and buildings', () => {
  const world = new WorldIndex(worldFiles());

  it('zone from the file name and human-readable coordinates', () => {
    expect(zoneOfPath('zone.42.22.zone')).toEqual({ x: 42, y: 22 });
    expect(zoneOfPath('sub/zone.-3.7.zone')).toEqual({ x: -3, y: 7 });
    expect(zoneOfPath('leveldata.level')).toBeUndefined();
    expect(formatPosition([48030.4, 5, -41953.6], { x: 42, y: 22 })).toBe('48030 -41954 (зона 42.22)');
  });

  it('towns from the town list, with zones', () => {
    const t = world.towns('TB');
    expect(t).toHaveLength(1);
    expect(t[0]!.position).toEqual([5000, 10, 6000]);
    expect(t[0]!.zones).toEqual([{ x: 2, y: 2 }]);
    expect(world.towns('nope')).toEqual([]);
  });

  it('building with a squad; stale town handle → nearest town of the zone', () => {
    const bl = world.buildingsWithSquad('SQ');
    expect(bl).toHaveLength(1);
    expect(bl[0]!.name).toBe('Weapon Shop');
    expect(bl[0]!.town).toBe('TB');
    expect(bl[0]!.zone).toEqual({ x: 2, y: 2 });
    expect(world.instancesOf('ROCK')).toHaveLength(1);
    expect(world.stats()).toMatchObject({ files: 2, towns: 2, buildings: 1, placements: 4 });
  });

  it('layers of one file merge; instance deletion in the mod', () => {
    const modZone = file(
      [
        rec('INSTANCE_COLLECTION', '0-buildinglist', 'buildings', (r) => {
          r.instances.set('r', { target: '', position: [0, 0, 0], rotation: [1, 0, 0, 0], states: [] });
        }),
      ],
      FileType.Data,
    );
    const w = new WorldIndex([...worldFiles(), { layer: 'my.mod', path: 'ZONE.2.2.zone', file: modZone }]);
    // Empty target = deleted instance (as in .mod).
    expect(w.instancesOf('ROCK')).toHaveLength(0);
    expect(w.instancesOf('SHOP')).toHaveLength(1);
    expect(w.files()).toHaveLength(2);
  });
});

describe('where in the game', () => {
  const ctx = ctxOf();
  const world = new WorldIndex(worldFiles());

  it('item → trader list → squad → towns, with coordinates and building', () => {
    const res = whereInGame(ctx, 'KAT', { world });
    expect(res.hasWorld).toBe(true);
    expect(res.root.icon).toBe('.\\data\\items\\icons\\katana.png');
    const sold = res.facts.find((f) => f.role === 'sold')!;
    expect(sold.holder?.id).toBe('SQ');
    expect(sold.path.map((s) => [s.id, s.category])).toEqual([
      ['VL', 'weapons'],
      ['SQ', 'vendors'],
    ]);
    const towns = sold.places.filter((p) => p.kind === 'town');
    expect(towns.map((p) => p.id).sort()).toEqual(['TA', 'TB']);
    const tb = towns.find((p) => p.id === 'TB')!;
    expect(tb.path.map((s) => [s.id, s.category])).toEqual([['TB', 'residents']]);
    expect(tb.positions[0]!.position).toEqual([5000, 10, 6000]);
    // A town variant without its own place is folded into the base town.
    expect(sold.places.some((p) => p.id === 'TB2')).toBe(false);
    const shop = sold.places.find((p) => p.kind === 'building')!;
    expect(shop.positions[0]!.town?.id).toBe('TB');

    const carried = res.facts.find((f) => f.role === 'carried')!;
    expect(carried.holder?.id).toBe('THIEF');

    const text = formatWhere(res, { lang: 'ru' });
    expect(text).toContain('Продаётся у «Weapon Trader» (отряд «weapon vendor»): Town A, Town B');
    expect(text).toContain('← VENDOR_LIST «weapon vendor list» [VL] (weapons) ← SQUAD_TEMPLATE «weapon vendor» [SQ] (vendors)');
    expect(text).toContain('5000 6000 (зона 2.2)');
  });

  it('without the world — a chain without coordinates', () => {
    const res = whereInGame(ctx, 'KAT');
    expect(res.hasWorld).toBe(false);
    const sold = res.facts.find((f) => f.role === 'sold')!;
    expect(sold.places.every((p) => p.positions.length === 0)).toBe(true);
  });

  it('a record placed directly in a zone', () => {
    const res = whereInGame(ctx, 'ROCK', { world });
    const placed = res.facts.find((f) => f.role === 'placed')!;
    expect(placed.places[0]!.id).toBe('TB');
    expect(formatWhere(res, { lang: 'ru' })).toContain('Размещено в мире');
    expect(formatWhere(res)).toContain('Placed in the world');
  });

  it('no upward links', () => {
    const text = formatWhere(whereInGame(ctx, 'TRADER'), { lang: 'ru' });
    expect(text).toContain('Состоит в');
    expect(() => whereInGame(ctx, 'nope')).toThrow();
  });
});
