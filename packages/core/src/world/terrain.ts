/**
 * Рельеф и координаты мира Kenshi (без доступа к диску; чтение карты высот — `node/terrain.ts`).
 *
 * Всё выведено из файлов игры (см. `docs/world-format.md`):
 *  - мир — квадрат 64×64 зоны по 4608 единиц, центр в (0, 0): x и z от −147456 до 147456,
 *    зона `zone.X.Y` — это `X = floor(x / 4608) + 32`, `Y = floor(z / 4608) + 32` (сходится у всех
 *    11714 зданий ванили);
 *  - карта высот `data/newland/land/fullmap.tif` — 16385×16385, 16 бит без знака, без сжатия;
 *    пиксель (столбец, строка) = ((x + 147456) / 18, (z + 147456) / 18), шаг 18 единиц;
 *  - высота = значение × 9800 / 65535 (подбор по высоте y экземпляров зданий в зонах: лучшее совпадение);
 *  - цвет земли — `overlaymaps/colour.I.J.png`, 8×8 картинок по 2048², каждая на 2048 пикселей
 *    карты высот.
 */

export const ZONE_SIZE = 4608;
export const ZONE_COUNT = 64;
/** Половина стороны мира: координаты x и z лежат в [−WORLD_HALF, WORLD_HALF]. */
export const WORLD_HALF = (ZONE_SIZE * ZONE_COUNT) / 2;
export const HEIGHTMAP_SIZE = 16385;
/** Единиц мира на пиксель карты высот. */
export const HEIGHTMAP_STEP = (2 * WORLD_HALF) / (HEIGHTMAP_SIZE - 1);
/** Высота в единицах мира на единицу значения карты высот. */
export const HEIGHT_SCALE = 9800 / 65535;
export const COLOUR_TILES = 8;
export const COLOUR_TILE_PX = 2048;

/** Сторона тайла рельефа в клетках (точек на одну больше). */
export const TILE_CELLS = 128;
export const TILE_SAMPLES = TILE_CELLS + 1;
/** Самый подробный уровень: шаг тайла — один пиксель карты высот. */
export const TERRAIN_MAX_LEVEL = Math.log2((HEIGHTMAP_SIZE - 1) / TILE_CELLS);

export interface TileBounds {
  /** Левый-верхний угол тайла в мире (минимальные x и z) и сторона. */
  x: number;
  z: number;
  size: number;
  /** Первый пиксель карты высот, шаг в пикселях. */
  col: number;
  row: number;
  step: number;
}

/** Тайл квадродерева: уровень 0 — весь мир, на уровне L — 2^L × 2^L тайлов. */
export function tileBounds(level: number, tx: number, ty: number): TileBounds {
  const n = 2 ** level;
  if (!Number.isInteger(level) || level < 0 || level > TERRAIN_MAX_LEVEL) throw new Error(`Нет уровня рельефа ${level}`);
  if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0 || tx >= n || ty >= n) throw new Error(`Нет тайла ${level}/${tx}/${ty}`);
  const px = (HEIGHTMAP_SIZE - 1) / n;
  const size = (2 * WORLD_HALF) / n;
  return { x: -WORLD_HALF + tx * size, z: -WORLD_HALF + ty * size, size, col: tx * px, row: ty * px, step: px / TILE_CELLS };
}

export function heightOfRaw(raw: number): number {
  return raw * HEIGHT_SCALE;
}

/** Зона, в которой лежит точка (как в именах `zone.X.Y.zone`). */
export function zoneOfPoint(x: number, z: number): { x: number; y: number } {
  return { x: Math.floor(x / ZONE_SIZE) + ZONE_COUNT / 2, y: Math.floor(z / ZONE_SIZE) + ZONE_COUNT / 2 };
}

/** Картинка цвета земли (`colour.I.J.png`) и место точки в ней (0…1). */
export function colourTileOf(x: number, z: number): { i: number; j: number; u: number; v: number } {
  const span = (2 * WORLD_HALF) / COLOUR_TILES;
  const fx = (x + WORLD_HALF) / span;
  const fz = (z + WORLD_HALF) / span;
  const i = Math.min(COLOUR_TILES - 1, Math.max(0, Math.floor(fx)));
  const j = Math.min(COLOUR_TILES - 1, Math.max(0, Math.floor(fz)));
  return { i, j, u: fx - i, v: fz - j };
}

/** Высота в точке по сетке тайла (билинейно); `heights` — TILE_SAMPLES² значений карты. */
export function sampleTile(heights: Uint16Array, b: TileBounds, x: number, z: number): number {
  const cell = b.size / TILE_CELLS;
  const fx = Math.min(TILE_CELLS, Math.max(0, (x - b.x) / cell));
  const fz = Math.min(TILE_CELLS, Math.max(0, (z - b.z) / cell));
  const c = Math.min(TILE_CELLS - 1, Math.floor(fx));
  const r = Math.min(TILE_CELLS - 1, Math.floor(fz));
  const tx = fx - c;
  const tz = fz - r;
  const at = (cc: number, rr: number): number => heights[rr * TILE_SAMPLES + cc]!;
  const h = at(c, r) * (1 - tx) * (1 - tz) + at(c + 1, r) * tx * (1 - tz) + at(c, r + 1) * (1 - tx) * tz + at(c + 1, r + 1) * tx * tz;
  return heightOfRaw(h);
}
