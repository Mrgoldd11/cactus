/**
 * «Где в игре» на файлах установленной игры. Без игры тесты пропускаются.
 * Эталон: катана → список торговца оружием → отряд торговца → города Груз (Heft) и Хэн (Heng).
 */
import { describe, expect, it } from 'vitest';
import { formatWhere, whereInGame } from '../src/index.ts';
import { hasGame, loadModContext, loadWorld, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);

describe.skipIf(!game)('где в игре: ваниль', () => {
  const { ctx } = loadModContext({ paths, schema: false });
  const { world, errors } = loadWorld(paths);

  it('мир ванили читается целиком', () => {
    expect(errors).toEqual([]);
    const s = world.stats();
    expect(s.towns).toBeGreaterThan(100);
    expect(s.buildings).toBeGreaterThan(5000);
  });

  it('катана: VENDOR_LIST 52318 → SQUAD_TEMPLATE 56131 → Heft и Heng с координатами', () => {
    const res = whereInGame(ctx, '476-gamedata.base', { world });
    const f = res.facts.find((x) => x.role === 'sold' && x.holder?.id === '56131-rebirth.mod')!;
    expect(f).toBeDefined();
    expect(f.path.map((s) => [s.id, s.category])).toEqual([
      ['52318-rebirth.mod', 'weapons'],
      ['56131-rebirth.mod', 'vendors'],
    ]);
    const town = (id: string) => f.places.find((p) => p.kind === 'town' && p.id === id)!;
    const heft = town('1078-gamedata.base');
    const heng = town('1074-gamedata.base');
    expect(heft.path.map((s) => s.category)).toEqual(['residents']);
    expect(heng.path.map((s) => s.category)).toEqual(['residents']);
    expect(heft.positions[0]!.zone).toEqual({ x: 46, y: 16 });
    expect(heng.positions[0]!.zone).toEqual({ x: 42, y: 22 });
    expect(heft.positions[0]!.position[0]).toBeCloseTo(68773, -1);
    expect(heng.positions[0]!.position[2]).toBeCloseTo(-41953, -1);
    const shop = f.places.find((p) => p.kind === 'building')!;
    expect(shop.positions.some((p) => p.town?.id === '1074-gamedata.base')).toBe(true);
    const text = formatWhere({ ...res, facts: [f] }, { lang: 'ru' });
    expect(text).toContain('Продаётся у «Оружейник»');
    expect(text).toContain('Груз, Хэн');
  });
});
