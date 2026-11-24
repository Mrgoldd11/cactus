/**
 * Vegetation and rocks near the camera.
 *
 * The game files have no positions for trees and rocks: the game places them itself by biome rules
 * (`biomes.ts` → `FoliageRule`). Here — the same idea: the world is split into cells, each cell has
 * its own fixed random seed (the same cell always gives the same result), by the rules of the
 * point's biome: density, clumps, height above sea, slope, size, downward offset, avoiding towns
 * and buildings. It looks like the game, but **not the same positions** as in the game.
 *
 * To avoid lag: only cells in a small circle around the camera, a cap on the instance count,
 * computed cells are cached, only a few new cells at a time. Height is taken only from
 * detailed terrain tiles; until they exist, the cell waits (`incomplete`).
 *
 * Not verified: the density unit (we assume «pieces per 4608² zone») and the slope unit
 * (we assume 100 × tangent of the angle).
 */
import * as THREE from 'three';
import { TERRAIN_MAX_LEVEL, WORLD_HALF, ZONE_SIZE } from '@kenshi-editor/core';
import type { Biome, FoliageRule } from './biomes.ts';
import type { DumpFoliageZone } from './dump.ts';

export interface FoliageQuality {
  /** Radius of the vegetation circle around the camera; 0 — off. */
  radius: number;
  /** Instance cap. */
  maxInstances: number;
}

export interface FoliageGround {
  heightAt(x: number, z: number, minLevel?: number): number | undefined;
  biomeAt(x: number, z: number): number | undefined;
}

/** Real foliage places dumped from the running game (`dump.ts`). */
export interface FoliageDumpSource {
  version: number;
  foliage(zx: number, zy: number): DumpFoliageZone | 'loading' | undefined;
}

interface Item {
  target: string;
  matrix: THREE.Matrix4;
}

const CELL = 1024;
const DENSITY_AREA = ZONE_SIZE * ZONE_SIZE;
const MIN_LEVEL = TERRAIN_MAX_LEVEL - 1;
const TOWN_RADIUS = 2200;
const BUILDING_RADIUS = 450;
const NEW_CELLS_PER_UPDATE = 16;
const MAX_CACHED = 600;
const UP = new THREE.Vector3(0, 1, 0);

/** Deterministic random number generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cellSeed(ix: number, iz: number): number {
  return Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663) ^ 0x5bd1e995;
}

export class FoliageScatter {
  /** What to draw: model → matrices. */
  readonly byTarget = new Map<string, THREE.Matrix4[]>();
  count = 0;
  /** How many of them stand exactly where the game put them (zones with a dump). */
  fromGame = 0;
  /** Game dump: zones that have it take foliage from it instead of the random scatter. */
  dump: FoliageDumpSource | undefined;
  private dumpVersion = -1;
  /** There are cells without detailed terrain yet, or a queue of new cells. */
  incomplete = false;
  quality: FoliageQuality;
  private readonly cells = new Map<string, { items: Item[]; used: number; fromGame: number }>();
  private readonly towns: { x: number; z: number }[];
  private readonly buildings = new Map<string, { x: number; z: number }[]>();
  private readonly biomes: Map<number, Biome>;
  private readonly ground: FoliageGround;
  private signature = '';
  private tick = 0;

  constructor(biomes: Map<number, Biome>, ground: FoliageGround, towns: readonly THREE.Vector3[], buildings: readonly THREE.Vector3[], quality: FoliageQuality) {
    this.biomes = biomes;
    this.ground = ground;
    this.quality = quality;
    this.towns = towns.map((t) => ({ x: t.x, z: t.z }));
    for (const b of buildings) {
      const k = `${Math.floor(b.x / CELL)},${Math.floor(b.z / CELL)}`;
      const l = this.buildings.get(k);
      if (l) l.push({ x: b.x, z: b.z });
      else this.buildings.set(k, [{ x: b.x, z: b.z }]);
    }
  }

  /** Recompute the set around the camera. true — the set changed. */
  update(cam: THREE.Vector3): boolean {
    this.tick++;
    if (this.dump && this.dump.version !== this.dumpVersion) {
      // Dumped zones changed: cells may now come from the dump (or from a newer one).
      this.dumpVersion = this.dump.version;
      this.cells.clear();
      this.signature = '?';
    }
    const r = this.quality.radius;
    const g = this.ground.heightAt(cam.x, cam.z);
    // High above the ground vegetation is not visible — do not waste time.
    if (r <= 0 || g === undefined || cam.y - g > r * 1.2) return this.set([], '');
    const cx = Math.floor(cam.x / CELL);
    const cz = Math.floor(cam.z / CELL);
    const n = Math.ceil(r / CELL);
    const order: { ix: number; iz: number; d: number }[] = [];
    for (let iz = cz - n; iz <= cz + n; iz++)
      for (let ix = cx - n; ix <= cx + n; ix++) {
        const dx = Math.max(0, Math.abs(cam.x - (ix + 0.5) * CELL) - CELL / 2);
        const dz = Math.max(0, Math.abs(cam.z - (iz + 0.5) * CELL) - CELL / 2);
        const d = Math.hypot(dx, dz);
        if (d <= r) order.push({ ix, iz, d });
      }
    order.sort((a, b) => a.d - b.d);
    let made = 0;
    let incomplete = false;
    const keys: string[] = [];
    const parts: Item[][] = [];
    let total = 0;
    let fromGame = 0;
    for (const { ix, iz } of order) {
      const k = `${ix},${iz}`;
      let c = this.cells.get(k);
      if (!c) {
        if (made >= NEW_CELLS_PER_UPDATE) {
          incomplete = true;
          continue;
        }
        const made1 = this.makeCell(ix, iz);
        if (!made1) {
          incomplete = true;
          continue;
        }
        made++;
        c = { items: made1.items, used: this.tick, fromGame: made1.fromGame };
        this.cells.set(k, c);
      }
      c.used = this.tick;
      if (total + c.items.length > this.quality.maxInstances) break;
      total += c.items.length;
      fromGame += c.fromGame;
      keys.push(k);
      parts.push(c.items);
    }
    this.incomplete = incomplete;
    this.fromGame = fromGame;
    this.trim();
    return this.set(parts, keys.join(';'));
  }

  private set(parts: Item[][], signature: string): boolean {
    if (signature === this.signature) return false;
    this.signature = signature;
    this.byTarget.clear();
    let count = 0;
    for (const items of parts)
      for (const it of items) {
        const l = this.byTarget.get(it.target);
        if (l) l.push(it.matrix);
        else this.byTarget.set(it.target, [it.matrix]);
        count++;
      }
    this.count = count;
    return true;
  }

  private trim(): void {
    if (this.cells.size <= MAX_CACHED) return;
    const list = [...this.cells.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k] of list.slice(0, this.cells.size - MAX_CACHED)) this.cells.delete(k);
  }

  /** Slope at a point: 100 × tangent of the angle; undefined — no terrain yet. */
  private ground3(x: number, z: number): { h: number; slope: number; normal: THREE.Vector3 } | undefined {
    const e = 18;
    const h = this.ground.heightAt(x, z, MIN_LEVEL);
    const hx0 = this.ground.heightAt(x - e, z, MIN_LEVEL);
    const hx1 = this.ground.heightAt(x + e, z, MIN_LEVEL);
    const hz0 = this.ground.heightAt(x, z - e, MIN_LEVEL);
    const hz1 = this.ground.heightAt(x, z + e, MIN_LEVEL);
    if (h === undefined || hx0 === undefined || hx1 === undefined || hz0 === undefined || hz1 === undefined) return undefined;
    const gx = (hx1 - hx0) / (2 * e);
    const gz = (hz1 - hz0) / (2 * e);
    const normal = new THREE.Vector3(-gx, 1, -gz).normalize();
    return { h, slope: 100 * Math.hypot(gx, gz), normal };
  }

  private nearBuilding(x: number, z: number): boolean {
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    for (let j = iz - 1; j <= iz + 1; j++)
      for (let i = ix - 1; i <= ix + 1; i++)
        for (const b of this.buildings.get(`${i},${j}`) ?? []) if (Math.hypot(b.x - x, b.z - z) < BUILDING_RADIUS) return true;
    return false;
  }

  private nearTown(x: number, z: number): boolean {
    for (const t of this.towns) if (Math.abs(t.x - x) < TOWN_RADIUS && Math.abs(t.z - z) < TOWN_RADIUS && Math.hypot(t.x - x, t.z - z) < TOWN_RADIUS) return true;
    return false;
  }

  /** Cell seeding; undefined — no detailed terrain here yet. */
  private makeCell(ix: number, iz: number): { items: Item[]; fromGame: number } | undefined {
    const x0 = ix * CELL;
    const z0 = iz * CELL;
    if (Math.abs(x0 + CELL / 2) > WORLD_HALF || Math.abs(z0 + CELL / 2) > WORLD_HALF) return { items: [], fromGame: 0 };
    // Zones under the cell (a cell can straddle a zone border). Those that have a game dump
    // take their foliage from it; the scatter fills only the rest.
    const items: Item[] = [];
    const dumped = new Set<number>();
    let zones = 0;
    if (this.dump) {
      const zx0 = Math.floor(x0 / ZONE_SIZE);
      const zx1 = Math.floor((x0 + CELL - 0.01) / ZONE_SIZE);
      const zz0 = Math.floor(z0 / ZONE_SIZE);
      const zz1 = Math.floor((z0 + CELL - 0.01) / ZONE_SIZE);
      const half = WORLD_HALF / ZONE_SIZE;
      for (let zz = zz0; zz <= zz1; zz++)
        for (let zx = zx0; zx <= zx1; zx++) {
          zones++;
          const d = this.dump.foliage(zx + half, zz + half);
          if (d === 'loading') return undefined;
          if (!d) continue;
          dumped.add(zz * 4096 + zx);
          // Buckets of the dump use the same cell grid.
          for (const it of d.cells.get(`${ix},${iz}`) ?? []) items.push(it);
        }
    }
    const fromGame = items.length;
    if (dumped.size > 0 && dumped.size === zones) return { items, fromGame };
    const inDumped = (x: number, z: number): boolean => dumped.size > 0 && dumped.has(Math.floor(z / ZONE_SIZE) * 4096 + Math.floor(x / ZONE_SIZE));
    if (this.ground.heightAt(x0 + CELL / 2, z0 + CELL / 2, MIN_LEVEL) === undefined) return undefined;
    // Which biomes are in the cell (4×4 grid).
    const present = new Set<number>();
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const b = this.ground.biomeAt(x0 + ((i + 0.5) / 4) * CELL, z0 + ((j + 0.5) / 4) * CELL);
        if (b === undefined) return undefined;
        if (this.biomes.get(b)?.foliage.length) present.add(b);
      }
    const rand = rng(cellSeed(ix, iz));
    const between = (p: [number, number]): number => p[0] + (p[1] - p[0]) * rand();
    for (const index of [...present].sort((a, b) => a - b)) {
      const biome = this.biomes.get(index)!;
      for (const rule of biome.foliage) {
        const expected = (rule.density * CELL * CELL) / DENSITY_AREA;
        const clusters = Math.floor(expected + rand());
        for (let c = 0; c < clusters; c++) {
          const px = x0 + rand() * CELL;
          const pz = z0 + rand() * CELL;
          if (this.ground.biomeAt(px, pz) !== index) continue;
          if (rule.avoidTowns && this.nearTown(px, pz)) continue;
          const members = rule.clustered ? Math.round(between(rule.cluster)) : 1;
          const radius = between(rule.radius);
          for (let m = 0; m < members; m++) {
            let x = px;
            let z = pz;
            if (m > 0) {
              const a = rand() * Math.PI * 2;
              const d = Math.sqrt(rand()) * radius;
              x += Math.cos(a) * d;
              z += Math.sin(a) * d;
            }
            const yaw = rand() * Math.PI * 2;
            const scale = between(rule.scale);
            const offset = between(rule.offset);
            if (inDumped(x, z)) continue;
            const it = this.place(rule, x, z, yaw, scale, offset);
            if (it) items.push(it);
          }
        }
      }
    }
    return { items, fromGame };
  }

  private place(rule: FoliageRule, x: number, z: number, yaw: number, scale: number, offset: number): Item | undefined {
    const g = this.ground3(x, z);
    if (!g) return undefined;
    if (g.h < rule.altitude[0] || g.h > rule.altitude[1]) return undefined;
    if (g.slope < rule.slope[0] || g.slope > rule.slope[1]) return undefined;
    if (this.nearBuilding(x, z)) return undefined;
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    if (rule.slopeAlign && !rule.upright) q.premultiply(new THREE.Quaternion().setFromUnitVectors(UP, g.normal));
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, g.h + offset, z), q, new THREE.Vector3(scale, scale, scale));
    return { target: rule.target, matrix };
  }
}
