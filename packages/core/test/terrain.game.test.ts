/**
 * Рельеф: математика тайлов и зон без игры; на установленной игре — заголовок карты высот,
 * чтение тайлов и сверка высот с y зданий ванили.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HEIGHTMAP_STEP, TERRAIN_MAX_LEVEL, TILE_SAMPLES, WORLD_HALF, decodeText, sampleTile, tileBounds, zoneOfPoint } from '../src/index.ts';
import { Heightmap, hasGame, heightmapPath, loadWorld, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const map = hasGame(paths) ? heightmapPath(paths.kenshi) : '';
const game = map !== '' && existsSync(map);

describe('рельеф: тайлы и зоны', () => {
  it('квадродерево покрывает мир, самый мелкий шаг — пиксель', () => {
    expect(TERRAIN_MAX_LEVEL).toBe(7);
    expect(HEIGHTMAP_STEP).toBe(18);
    expect(tileBounds(0, 0, 0)).toMatchObject({ x: -WORLD_HALF, z: -WORLD_HALF, size: 2 * WORLD_HALF, col: 0, row: 0, step: 128 });
    const b = tileBounds(7, 127, 3);
    expect(b.step).toBe(1);
    expect(b.x + b.size).toBe(WORLD_HALF);
    expect(() => tileBounds(8, 0, 0)).toThrow();
    expect(() => tileBounds(1, 2, 0)).toThrow();
  });
  it('зона точки как в именах файлов', () => {
    expect(zoneOfPoint(47063, -43572)).toEqual({ x: 42, y: 22 });
    expect(zoneOfPoint(-1, 0)).toEqual({ x: 31, y: 32 });
  });
});

describe.skipIf(!game)('рельеф на файлах игры', () => {
  it('тайлы читаются; соседние уровни сходятся в общих точках', async () => {
    const hm = await Heightmap.open(map);
    try {
      expect(hm.layout).toMatchObject({ width: 16385, height: 16385 });
      const root = await hm.readTile(0, 0, 0);
      expect(root.length).toBe(TILE_SAMPLES * TILE_SAMPLES);
      expect(Math.max(...root)).toBeGreaterThan(10000);
      // Угол тайла 1/1/1 — это центр мира, он же точка (64, 64) корня.
      const child = await hm.readTile(1, 1, 1);
      expect(child[0]).toBe(root[64 * TILE_SAMPLES + 64]);
      const fine = await hm.readTile(7, 64, 64);
      expect(fine[0]).toBe(child[0]);
    } finally {
      await hm.close();
    }
  });

  it('y здания — высота над рельефом: `world Y pos` = рельеф + y у большинства', async () => {
    const { world } = loadWorld(paths);
    const pts: { x: number; z: number; y: number; wy: number }[] = [];
    for (const file of world.files()) {
      if (!file.startsWith('zone.')) continue;
      const rec = world.record(file, '0-buildinglist');
      if (!rec) continue;
      for (const inst of rec.instances.values()) {
        if (!inst.target || pts.length >= 20000) continue;
        // Здания (есть состояние с «world Y pos»).
        const wy = inst.states.map((s) => world.record(file, decodeText(s))?.floats.get('world Y pos')).find((v) => v !== undefined);
        if (wy === undefined) continue;
        pts.push({ x: inst.position[0], z: inst.position[2], y: inst.position[1], wy });
      }
    }
    expect(pts.length).toBeGreaterThan(300);
    const hm = await Heightmap.open(map);
    try {
      const hs = await hm.heightsAt(pts);
      const err = hs.map((h, i) => Math.abs(h + pts[i]!.y - pts[i]!.wy)).sort((a, b) => a - b);
      expect(err[err.length >> 1]).toBeLessThan(3);
      expect(err.filter((e) => e < 3).length / err.length).toBeGreaterThan(0.5);
      // То же через тайл: билинейная выборка из самого подробного уровня.
      const p = pts[0]!;
      const n = 2 ** 7;
      const tx = Math.floor(((p.x + WORLD_HALF) / (2 * WORLD_HALF)) * n);
      const ty = Math.floor(((p.z + WORLD_HALF) / (2 * WORLD_HALF)) * n);
      const tile = await hm.readTile(7, tx, ty);
      expect(Math.abs(sampleTile(tile, tileBounds(7, tx, ty), p.x, p.z) - hs[0]!)).toBeLessThan(20);
    } finally {
      await hm.close();
    }
  });
});
