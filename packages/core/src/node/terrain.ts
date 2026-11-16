/**
 * World heightmap from disk: `data/newland/land/fullmap.tif` (TIFF, 16 bit, uncompressed, 537 MB).
 * The file is never read whole: a quadtree tile is 129 rows, and from each the needed
 * segment is taken, so any tile is 129 short reads (level 0, the whole world — 4 MB).
 */
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { UiTextError } from '../ui-text.ts';
import { HEIGHTMAP_SIZE, HEIGHTMAP_STEP, TILE_SAMPLES, WORLD_HALF, heightOfRaw, tileBounds } from '../world/terrain.ts';

/** Error reading the game heightmap, in every interface language. */
function heightmapError(en: string, ru: string, zh: string): UiTextError {
  return new UiTextError({ en: `Heightmap: ${en}`, ru: `Карта высот: ${ru}`, zh: `高度图：${zh}` });
}

export function heightmapPath(kenshiDir: string): string {
  return join(kenshiDir, 'data', 'newland', 'land', 'fullmap.tif');
}

export interface HeightmapLayout {
  width: number;
  height: number;
  /** Where the pixels start in the file (rows in sequence, left to right). */
  offset: number;
}

const TYPE_SIZE: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 16: 8 };

/** TIFF header parsing: only what is needed, and only the variant the game ships. */
export function parseHeightmapHeader(head: Uint8Array): HeightmapLayout {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (v.getUint16(0, true) !== 0x4949 || v.getUint16(2, true) !== 42) throw heightmapError('not a TIFF (little-endian)', 'не TIFF (little-endian)', '不是 TIFF（little-endian）');
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
  if (width === undefined || height === undefined) throw heightmapError('no dimensions', 'нет размеров', '没有尺寸');
  if (one(258) !== 16) throw heightmapError('expected 16 bits per sample', 'ожидалось 16 бит на точку', '应为每点 16 位');
  if ((one(259) ?? 1) !== 1) throw heightmapError('compressed TIFF is not supported', 'сжатый TIFF не поддерживается', '不支持压缩的 TIFF');
  if ((one(277) ?? 1) !== 1) throw heightmapError('expected one channel', 'ожидался один канал', '应为单通道');
  const strips = tags.get(273);
  const rowsPerStrip = one(278) ?? height;
  const offset = strips?.values[0];
  if (offset === undefined) throw heightmapError('no data offset', 'нет смещения данных', '没有数据偏移');
  // Several strips are allowed only if they are contiguous (then they form one solid block).
  if (strips && strips.count > 1) {
    const counts = tags.get(279)?.values ?? [];
    if (strips.values.length !== strips.count || counts.length !== strips.count) throw heightmapError('strips not read', 'полосы не прочитаны', '未能读取条带');
    for (let k = 1; k < strips.count; k++)
      if (strips.values[k] !== strips.values[k - 1]! + counts[k - 1]!) throw heightmapError('strips are not contiguous', 'полосы не подряд', '条带不连续');
  } else if (rowsPerStrip < height) throw heightmapError('incomplete strip', 'неполная полоса', '条带不完整');
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
        {
        const got = `${layout.width}×${layout.height}`;
        const want = `${HEIGHTMAP_SIZE}×${HEIGHTMAP_SIZE}`;
        throw heightmapError(`size ${got}, expected ${want}`, `размер ${got}, ожидалось ${want}`, `尺寸 ${got}，应为 ${want}`);
      }
      return new Heightmap(fh, layout);
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  /** Heightmap values of a tile: TILE_SAMPLES × TILE_SAMPLES, row by row (along z). */
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

  /** Heights at world points (nearest pixel); for snapping to the terrain. */
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
