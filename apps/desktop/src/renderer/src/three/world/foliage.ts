/**
 * Растительность и камни вблизи камеры.
 *
 * В файлах игры мест у деревьев и камней нет: игра раскладывает их сама по правилам биома
 * (`biomes.ts` → `FoliageRule`). Здесь — та же идея: мир поделён на клетки, в каждой клетке
 * свой постоянный случайный посев (одна и та же клетка всегда даёт одно и то же), по правилам
 * биома точки: плотность, кучки, высота над морем, склон, размер, сдвиг вниз, обход городов
 * и зданий. Это похоже на игру, но **не те же места**, что в игре.
 *
 * Чтобы не лагало: только клетки в небольшом круге вокруг камеры, предел числа экземпляров,
 * посчитанные клетки — в кэше, новых клеток за раз — немного. Высота берётся только с
 * подробных тайлов рельефа; пока их нет, клетка ждёт (`incomplete`).
 *
 * Не проверено: единица плотности (считаем «штук на зону 4608²») и единица склона
 * (считаем 100 × тангенс угла).
 */
import * as THREE from 'three';
import { TERRAIN_MAX_LEVEL, WORLD_HALF, ZONE_SIZE } from '@kenshi-editor/core';
import type { Biome, FoliageRule } from './biomes.ts';

export interface FoliageQuality {
  /** Радиус круга с растительностью вокруг камеры; 0 — выключено. */
  radius: number;
  /** Предел экземпляров. */
  maxInstances: number;
}

export interface FoliageGround {
  heightAt(x: number, z: number, minLevel?: number): number | undefined;
  biomeAt(x: number, z: number): number | undefined;
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

/** Постоянный генератор случайных чисел (mulberry32). */
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
  /** Что рисовать: модель → матрицы. */
  readonly byTarget = new Map<string, THREE.Matrix4[]>();
  count = 0;
  /** Есть клетки, для которых ещё нет подробного рельефа или очередь новых клеток. */
  incomplete = false;
  quality: FoliageQuality;
  private readonly cells = new Map<string, { items: Item[]; used: number }>();
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

  /** Пересчитать набор вокруг камеры. true — набор изменился. */
  update(cam: THREE.Vector3): boolean {
    this.tick++;
    const r = this.quality.radius;
    const g = this.ground.heightAt(cam.x, cam.z);
    // Высоко над землёй растительность не видна — не тратим время.
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
    for (const { ix, iz } of order) {
      const k = `${ix},${iz}`;
      let c = this.cells.get(k);
      if (!c) {
        if (made >= NEW_CELLS_PER_UPDATE) {
          incomplete = true;
          continue;
        }
        const items = this.makeCell(ix, iz);
        if (!items) {
          incomplete = true;
          continue;
        }
        made++;
        c = { items, used: this.tick };
        this.cells.set(k, c);
      }
      c.used = this.tick;
      if (total + c.items.length > this.quality.maxInstances) break;
      total += c.items.length;
      keys.push(k);
      parts.push(c.items);
    }
    this.incomplete = incomplete;
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

  /** Склон в точке: 100 × тангенс угла; undefined — рельефа ещё нет. */
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

  /** Посев клетки; undefined — подробного рельефа здесь ещё нет. */
  private makeCell(ix: number, iz: number): Item[] | undefined {
    const x0 = ix * CELL;
    const z0 = iz * CELL;
    if (Math.abs(x0 + CELL / 2) > WORLD_HALF || Math.abs(z0 + CELL / 2) > WORLD_HALF) return [];
    if (this.ground.heightAt(x0 + CELL / 2, z0 + CELL / 2, MIN_LEVEL) === undefined) return undefined;
    // Какие биомы есть в клетке (сетка 4×4).
    const present = new Set<number>();
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const b = this.ground.biomeAt(x0 + ((i + 0.5) / 4) * CELL, z0 + ((j + 0.5) / 4) * CELL);
        if (b === undefined) return undefined;
        if (this.biomes.get(b)?.foliage.length) present.add(b);
      }
    const items: Item[] = [];
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
            const it = this.place(rule, x, z, yaw, scale, offset);
            if (it) items.push(it);
          }
        }
      }
    }
    return items;
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
