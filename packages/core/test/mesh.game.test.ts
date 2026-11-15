/**
 * Модели и текстуры: разбор `.mesh` и `.dds` на файлах установленной игры и выбор модели
 * записи. Без игры игровые тесты пропускаются; распаковка DXT1 проверяется и без неё.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeDds, gamePath, hasModel, itemTypeName, MAP_FEATURES_PATH, modelOfRecord, parseMapFeatures, parseOgreMesh, triangleIndices } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const KATANA = '476-gamedata.base';
const HOUSE = '620-gamedata.base';

/** DDS 4×4 DXT1: один блок, цвет 0 — красный, 1 — синий, индексы по строкам 0,1,2,3. */
function tinyDxt1(): Uint8Array {
  const b = new Uint8Array(128 + 8);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x20534444, true);
  v.setUint32(4, 124, true);
  v.setUint32(12, 4, true);
  v.setUint32(16, 4, true);
  v.setUint32(28, 1, true);
  v.setUint32(76, 32, true);
  v.setUint32(80, 0x4, true);
  b.set([0x44, 0x58, 0x54, 0x31], 84); // 'DXT1'
  v.setUint16(128, 0xf800, true); // красный
  v.setUint16(130, 0x001f, true); // синий
  b.set([0x00, 0x55, 0xaa, 0xff], 132);
  return b;
}

describe('DDS без игры', () => {
  it('DXT1: палитра из двух цветов и двух смесей', () => {
    const img = decodeDds(tinyDxt1());
    expect([img.width, img.height, img.format]).toEqual([4, 4, 'DXT1']);
    const px = (x: number, y: number): number[] => [...img.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    expect(px(0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(0, 1)).toEqual([0, 0, 255, 255]);
    expect(px(0, 2)).toEqual([170, 0, 85, 255]);
    expect(px(0, 3)).toEqual([85, 0, 170, 255]);
  });

  it('пути записей приводятся к папке игры', () => {
    expect(gamePath('.\\data\\items\\weapons\\mesh\\katana05.mesh')).toBe('data/items/weapons/mesh/katana05.mesh');
    expect(gamePath('')).toBeUndefined();
  });
});

describe.skipIf(!game)('модели на файлах игры', () => {
  const { ctx } = game ? loadModContext({ paths, schema: false, po: false }) : ({} as ReturnType<typeof loadModContext>);
  const read = (rel: string): Uint8Array => readFileSync(join(paths.kenshi, rel));

  it('все модели оружия читаются, индексы в пределах вершин', () => {
    const dir = 'data/items/weapons/mesh';
    const files = readdirSync(join(paths.kenshi, dir)).filter((f) => f.endsWith('.mesh'));
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      const m = parseOgreMesh(read(`${dir}/${f}`));
      expect(m.submeshes.length, f).toBeGreaterThan(0);
      for (const s of m.submeshes) {
        const idx = triangleIndices(s);
        expect(idx.length % 3, f).toBe(0);
        expect(Math.max(...idx), f).toBeLessThan(s.geometry.vertexCount);
      }
    }
  });

  it('катана: модель клинка и текстура производителя', () => {
    const model = modelOfRecord(ctx, KATANA);
    expect(model.type).toBe('WEAPON');
    expect(model.pieces).toHaveLength(1);
    const p = model.pieces[0]!;
    expect(p.field).toBe('bare sword');
    expect(p.mesh).toBe('data/items/weapons/mesh/katana05_bare.mesh');
    expect(p.texture).toMatch(/^data\/items\/weapons\/tex\/.+\.dds$/i);
    const mesh = parseOgreMesh(read(p.mesh));
    expect(mesh.submeshes[0]!.geometry.uvs).toBeDefined();
    const img = decodeDds(read(p.texture!), { maxSize: 256 });
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(256);
    expect(img.rgba.length).toBe(img.width * img.height * 4);
  });

  it('дом: части здания со сдвигами и материалами', () => {
    expect(hasModel(ctx, HOUSE)).toBe(true);
    const model = modelOfRecord(ctx, HOUSE);
    expect(model.type).toBe('BUILDING');
    expect(model.pieces.length).toBeGreaterThan(3);
    for (const p of model.pieces) {
      expect(p.mesh).toMatch(/\.mesh$/i);
      expect(() => parseOgreMesh(read(p.mesh))).not.toThrow();
    }
    expect(model.pieces.some((p) => p.texture !== undefined)).toBe(true);
  });

  it('растительность: модель, своя текстура, срез по альфе, листва', () => {
    const list = [...ctx.records()].filter((r) => itemTypeName(r.type) === 'FOLIAGE_MESH' && hasModel(ctx, r.stringId));
    expect(list.length).toBeGreaterThan(20);
    const models = list.map((r) => modelOfRecord(ctx, r.stringId));
    for (const m of models) expect(m.pieces[0]?.mesh).toMatch(/\.mesh$/i);
    expect(models.some((m) => m.pieces.some((p) => p.texture !== undefined && p.alphaTest !== undefined))).toBe(true);
    expect(models.some((m) => m.pieces.some((p) => p.field === 'leaves mesh'))).toBe(true);
    // Маска вырезов — альфа карты нормалей, а не диффузной текстуры (шейдер игры).
    const cut = models.flatMap((m) => m.pieces).filter((p) => p.alphaTest !== undefined);
    for (const p of cut) expect(p.alphaMap).toMatch(/\.dds$/i);
    // Камни с типом материала TERRAIN красятся землёй: своей текстуры нет.
    const terrain = models.flatMap((m) => m.pieces).filter((p) => p.terrain);
    expect(terrain.length).toBeGreaterThan(20);
    for (const p of terrain) expect(p.texture).toBeUndefined();
    // TRIPLANAR / DUAL_TRIPLANAR: the texture is projected in world space; dual carries a second texture.
    const tri = models.flatMap((m) => m.pieces).filter((p) => p.triplanar);
    expect(tri.length).toBeGreaterThan(50);
    for (const p of tri) expect(p.texture).toMatch(/\.dds$/i);
    expect(tri.some((p) => p.texture2 !== undefined)).toBe(true);
  });

  it('map features: features.dat places MAP_FEATURES records that have models', () => {
    const list = parseMapFeatures(read(MAP_FEATURES_PATH));
    expect(list.length).toBeGreaterThan(1500);
    const arms = list.filter((f) => /^RobotArm/.test(ctx.name(f.target) ?? ''));
    expect(arms.length).toBeGreaterThan(3);
    for (const f of arms) {
      const m = modelOfRecord(ctx, f.target);
      expect(m.type).toBe('MAP_FEATURES');
      expect(m.pieces[0]?.mesh).toMatch(/\.mesh$/i);
      expect(Math.hypot(...f.rotation)).toBeCloseTo(1, 2);
    }
    expect(() => parseMapFeatures(new Uint8Array(16))).toThrow();
  });

  it('ore deposit: a building without parts is drawn as its foliage rock', () => {
    const m = modelOfRecord(ctx, '42248-gamedata.base');
    expect(m.type).toBe('BUILDING');
    expect(m.pieces[0]?.mesh).toMatch(/ResourceRock-IRON.*\.mesh$/i);
    expect(hasModel(ctx, '42248-gamedata.base')).toBe(true);
  });
});
