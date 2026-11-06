/**
 * Карта высот мира с диска: `data/newland/land/fullmap.tif` (TIFF, 16 бит, без сжатия, 537 МБ).
 * Файл целиком не читается: тайл квадродерева — это 129 строк, из каждой берётся нужный
 * отрезок, так что любой тайл — 129 коротких чтений (уровень 0, весь мир — 4 МБ).
 */
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { HEIGHTMAP_SIZE, HEIGHTMAP_STEP, TILE_SAMPLES, WORLD_HALF, heightOfRaw, tileBounds } from '../world/terrain.ts';

export function heightmapPath(kenshiDir: string): string {
  return join(kenshiDir, 'data', 'newland', 'land', 'fullmap.tif');
}

export interface HeightmapLayout {
  width: number;
  height: number;
  /** Где в файле начинаются пиксели (строки подряд, слева направо). */
  offset: number;
}

const TYPE_SIZE: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 16: 8 };

/** Разбор заголовка TIFF: только то, что нужно, и только тот вид, что лежит в игре. */
export function parseHeightmapHeader(head: Uint8Array): HeightmapLayout {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (v.getUint16(0, true) !== 0x4949 || v.getUint16(2, true) !== 42) throw new Error('Карта высот: не TIFF (little-endian)');
  const ifd = v.getUint32(4, true);
  const n = v.getUint16(ifd, true);
  const tags = new Map<number, { count: number; values: number[] }>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = v.getUint16(e, true);
    const type = v.getUint16(e + 2, true);
    const count = v.getUint32(e + 4, true);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const values: number[] = [];
    if ((type === 3 || type === 4) && size <= 4) {
      for (let k = 0; k < count; k++) values.push(type === 3 ? v.getUint16(e + 8 + k * 2, true) : v.getUint32(e + 8, true));
    } else if (type === 3 || type === 4) {
      const at = v.getUint32(e + 8, true);
      for (let k = 0; k < count && at + (k + 1) * (type === 3 ? 2 : 4) <= head.length; k++)
        values.push(type === 3 ? v.getUint16(at + k * 2, true) : v.getUint32(at + k * 4, true));
    }
    tags.set(tag, { count, values });
  }
  const one = (tag: number): number | undefined => tags.get(tag)?.values[0];
  const width = one(256);
  const height = one(257);
  if (width === undefined || height === undefined) throw new Error('Карта высот: нет размеров');
  if (one(258) !== 16) throw new Error('Карта высот: ожидалось 16 бит на точку');
  if ((one(259) ?? 1) !== 1) throw new Error('Карта высот: сжатый TIFF не поддерживается');
  if ((one(277) ?? 1) !== 1) throw new Error('Карта высот: ожидался один канал');
  const strips = tags.get(273);
  const rowsPerStrip = one(278) ?? height;
  const offset = strips?.values[0];
  if (offset === undefined) throw new Error('Карта высот: нет смещения данных');
  // Несколько полос допустимы, только если они идут подряд (тогда это один сплошной блок).
  if (strips && strips.count > 1) {
    const counts = tags.get(279)?.values ?? [];
    if (strips.values.length !== strips.count || counts.length !== strips.count) throw new Error('Карта высот: полосы не прочитаны');
    for (let k = 1; k < strips.count; k++)
      if (strips.values[k] !== strips.values[k - 1]! + counts[k - 1]!) throw new Error('Карта высот: полосы не подряд');
  } else if (rowsPerStrip < height) throw new Error('Карта высот: неполная полоса');
  return { width, height, offset };
}

export class Heightmap {
  private readonly fh: FileHandle;
  readonly layout: HeightmapLayout;

  private constructor(fh: FileHandle, layout: HeightmapLayout) {
    this.fh = fh;
    this.layout = layout;
  }

  static async open(path: string): Promise<Heightmap> {
    const fh = await open(path, 'r');
    try {
      const head = new Uint8Array(64 * 1024);
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      const layout = parseHeightmapHeader(head.subarray(0, bytesRead));
      if (layout.width !== HEIGHTMAP_SIZE || layout.height !== HEIGHTMAP_SIZE)
        throw new Error(`Карта высот ${layout.width}×${layout.height}, ожидалось ${HEIGHTMAP_SIZE}×${HEIGHTMAP_SIZE}`);
      return new Heightmap(fh, layout);
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  /** Значения карты высот тайла: TILE_SAMPLES × TILE_SAMPLES, строка за строкой (по z). */
  async readTile(level: number, tx: number, ty: number): Promise<Uint16Array> {
    const b = tileBounds(level, tx, ty);
    const out = new Uint16Array(TILE_SAMPLES * TILE_SAMPLES);
    const span = (TILE_SAMPLES - 1) * b.step + 1;
    const W = this.layout.width;
    await Promise.all(
      Array.from({ length: TILE_SAMPLES }, async (_, i) => {
        const row = b.row + i * b.step;
        const buf = Buffer.alloc(span * 2);
        await this.fh.read(buf, 0, buf.length, this.layout.offset + (row * W + b.col) * 2);
        for (let k = 0; k < TILE_SAMPLES; k++) out[i * TILE_SAMPLES + k] = buf.readUInt16LE(k * b.step * 2);
      }),
    );
    return out;
  }

  /** Высоты в точках мира (ближайший пиксель); для привязки к рельефу. */
  async heightsAt(points: readonly { x: number; z: number }[]): Promise<number[]> {
    const W = this.layout.width;
    return Promise.all(
      points.map(async ({ x, z }) => {
        const c = Math.min(W - 1, Math.max(0, Math.round((x + WORLD_HALF) / HEIGHTMAP_STEP)));
        const r = Math.min(this.layout.height - 1, Math.max(0, Math.round((z + WORLD_HALF) / HEIGHTMAP_STEP)));
        const buf = Buffer.alloc(2);
        await this.fh.read(buf, 0, 2, this.layout.offset + (r * W + c) * 2);
        return heightOfRaw(buf.readUInt16LE(0));
      }),
    );
  }

  close(): Promise<void> {
    return this.fh.close();
  }
}
