/**
 * Kenshi world terrain and coordinates (no disk access; reading the heightmap is `node/terrain.ts`).
 *
 * Everything is derived from the game files (see `docs/world-format.md`):
 *  - the world is a square of 64×64 zones of 4608 units, centered at (0, 0): x and z from −147456 to 147456,
 *    zone `zone.X.Y` is `X = floor(x / 4608) + 32`, `Y = floor(z / 4608) + 32` (holds for all
 *    11714 vanilla buildings);
 *  - heightmap `data/newland/land/fullmap.tif` — 16385×16385, 16-bit unsigned, uncompressed;
 *    pixel (column, row) = ((x + 147456) / 18, (z + 147456) / 18), step 18 units;
 *  - height = value × 9800 / 65535 (fitted to the y of building instances in zones: the best match);
 *  - ground color — `overlaymaps/colour.I.J.png`, 8×8 images of 2048², each covering 2048 heightmap
 *    pixels.
 */

export const ZONE_SIZE = 4608;
export const ZONE_COUNT = 64;
/** Half the world side: x and z coordinates lie in [−WORLD_HALF, WORLD_HALF]. */
export const WORLD_HALF = (ZONE_SIZE * ZONE_COUNT) / 2;
export const HEIGHTMAP_SIZE = 16385;
/** World units per heightmap pixel. */
export const HEIGHTMAP_STEP = (2 * WORLD_HALF) / (HEIGHTMAP_SIZE - 1);
/** Height in world units per unit of heightmap value. */
export const HEIGHT_SCALE = 9800 / 65535;
export const COLOUR_TILES = 8;
export const COLOUR_TILE_PX = 2048;

/** Terrain tile side in cells (one more in points). */
export const TILE_CELLS = 128;
export const TILE_SAMPLES = TILE_CELLS + 1;
/** The most detailed level: tile step is one heightmap pixel. */
export const TERRAIN_MAX_LEVEL = Math.log2((HEIGHTMAP_SIZE - 1) / TILE_CELLS);

export interface TileBounds {
  /** Top-left corner of the tile in the world (minimum x and z) and its side. */
  x: number;
  z: number;
  size: number;
  /** First heightmap pixel, step in pixels. */
  col: number;
  row: number;
  step: number;
}

/** Quadtree tile: level 0 is the whole world, level L has 2^L × 2^L tiles. */
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

/** The zone containing the point (as in `zone.X.Y.zone` names). */
export function zoneOfPoint(x: number, z: number): { x: number; y: number } {
  return { x: Math.floor(x / ZONE_SIZE) + ZONE_COUNT / 2, y: Math.floor(z / ZONE_SIZE) + ZONE_COUNT / 2 };
}

/** Ground color image (`colour.I.J.png`) and the point's position in it (0…1). */
export function colourTileOf(x: number, z: number): { i: number; j: number; u: number; v: number } {
  const span = (2 * WORLD_HALF) / COLOUR_TILES;
  const fx = (x + WORLD_HALF) / span;
  const fz = (z + WORLD_HALF) / span;
  const i = Math.min(COLOUR_TILES - 1, Math.max(0, Math.floor(fx)));
  const j = Math.min(COLOUR_TILES - 1, Math.max(0, Math.floor(fz)));
  return { i, j, u: fx - i, v: fz - j };
}

/** Height at a point from the tile grid (bilinear); `heights` — TILE_SAMPLES² heightmap values. */
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
