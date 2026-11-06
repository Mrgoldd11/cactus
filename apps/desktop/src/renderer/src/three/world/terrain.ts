/**
 * Рельеф всей карты: квадродерево тайлов (`tileBounds` из ядра), уровень выбирается по
 * расстоянию до камеры. Правило без щелей и наложений: тайл делится на четыре, только когда
 * все четыре уже загружены, иначе рисуется он сам (и заказываются дети). Края тайлов
 * опущены «юбкой» — щелей между соседями разного уровня не видно.
 *
 * Высоты читает main (`readTerrainTile`), вершины и нормали считает фоновый поток. Кэш
 * тайлов ограничен числом; выгружаются самые давно не нужные.
 *
 * Цвет земли — `overlaymaps/colour.I.J.png` (8×8 картинок 2048²). Крупные тайлы (уровни 0–2)
 * берут общий обзор 1024² из уменьшенных картинок; мелкие — свою картинку целиком (уровни 3–4
 * — 512², дальше — полная, число полных ограничено).
 *
 * Вблизи (тайлы от уровня 5) на цвет ложится рисунок текстур биома тайла (`biomes.ts`).
 */
import * as THREE from 'three';
import { COLOUR_TILES, TERRAIN_MAX_LEVEL, TILE_CELLS, TILE_SAMPLES, WORLD_HALF, sampleTile, tileBounds, type TileBounds } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../../shared/api.ts';
import type { WorkerPool } from './protocol.ts';
import { BIOME_MAP_PATH, averageColour, detailMaterial, type Biome, type DetailTexture } from './biomes.ts';

export interface TerrainQuality {
  /** Тайл делится, если камера ближе `split × сторона`. */
  split: number;
  /** Наибольший уровень (до 7 — пиксель карты высот). */
  maxLevel: number;
  /** Сколько тайлов держать в памяти. */
  cache: number;
  /** Сколько картинок цвета держать в полном размере. */
  fullColour: number;
}

interface Tile {
  key: string;
  level: number;
  tx: number;
  ty: number;
  b: TileBounds;
  state: 'loading' | 'ready' | 'failed';
  mesh?: THREE.Mesh;
  heights?: Uint16Array;
  min: number;
  max: number;
  used: number;
  started?: boolean;
  /** Биом тайла (`index`), null — нет или карта ещё не прочитана. */
  biome?: number | null;
}

const OVERVIEW = 1024;
const COLOUR_PATH = (i: number, j: number): string => `data/newland/land/overlaymaps/colour.${i}.${j}.png`;
/** С какого уровня тайл лежит в одной картинке цвета. */
const COLOUR_LEVEL = Math.log2(COLOUR_TILES);
/** С какого уровня на землю ложится рисунок биома. */
const DETAIL_LEVEL = COLOUR_LEVEL + 2;
const BIOME_MAP = 1024;

export class TerrainLod {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, Tile>();
  private readonly index: THREE.BufferAttribute;
  private readonly overviewCanvas: HTMLCanvasElement;
  private readonly overviewTex: THREE.CanvasTexture;
  private readonly overviewMat: THREE.MeshLambertMaterial;
  private readonly colourMats = new Map<string, { mat: THREE.MeshLambertMaterial; used: number; full: boolean }>();
  private readonly colourLoading = new Set<string>();
  private readonly detailMats = new Map<string, { mat: THREE.MeshLambertMaterial; used: number; texs: THREE.Texture[] }>();
  private readonly detailTex = new Map<string, { tex?: DetailTexture; used: number; loading: boolean }>();
  private biomeMap: Uint8Array | undefined;
  /** Сколько тайлов нарисовано с рисунком биома. */
  detailed = 0;
  private inflight = 0;
  private frame = 0;
  private overviewDone = 0;
  private disposed = false;
  quality: TerrainQuality;
  /** Сколько тайлов нарисовано в последнем кадре и треугольников в них. */
  drawn = 0;
  missing = false;
  onChange: () => void = () => undefined;

  private readonly game: GameInstallInfo;
  private readonly pool: WorkerPool;
  private readonly biomes: Map<number, Biome>;

  constructor(game: GameInstallInfo, pool: WorkerPool, quality: TerrainQuality, biomes: Map<number, Biome> = new Map()) {
    this.game = game;
    this.pool = pool;
    this.quality = quality;
    this.biomes = biomes;
    this.group.name = 'terrain';
    // Общий индекс сетки и юбки для всех тайлов.
    const n = TILE_SAMPLES;
    const idx: number[] = [];
    for (let r = 0; r < TILE_CELLS; r++)
      for (let c = 0; c < TILE_CELLS; c++) {
        const a = r * n + c;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    const perim: number[] = [];
    for (let c = 0; c < n - 1; c++) perim.push(c);
    for (let r = 0; r < n - 1; r++) perim.push(r * n + n - 1);
    for (let c = n - 1; c > 0; c--) perim.push((n - 1) * n + c);
    for (let r = n - 1; r > 0; r--) perim.push(r * n);
    for (let k = 0; k < perim.length; k++) {
      const a = perim[k]!;
      const b = perim[(k + 1) % perim.length]!;
      const sa = n * n + k;
      const sb = n * n + ((k + 1) % perim.length);
      idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
    }
    this.index = new THREE.BufferAttribute(new Uint32Array(idx), 1);

    this.overviewCanvas = document.createElement('canvas');
    this.overviewCanvas.width = OVERVIEW;
    this.overviewCanvas.height = OVERVIEW;
    const ctx = this.overviewCanvas.getContext('2d')!;
    ctx.fillStyle = '#8a7a62';
    ctx.fillRect(0, 0, OVERVIEW, OVERVIEW);
    this.overviewTex = new THREE.CanvasTexture(this.overviewCanvas);
    this.overviewTex.colorSpace = THREE.SRGBColorSpace;
    this.overviewTex.anisotropy = 4;
    this.overviewTex.flipY = false;
    this.overviewMat = new THREE.MeshLambertMaterial({ map: this.overviewTex });
    void this.loadOverview();
    void this.loadBiomeMap();
  }

  private async loadBiomeMap(): Promise<void> {
    try {
      const bytes = await window.kedit.readGameAsset(this.game, BIOME_MAP_PATH);
      if (!bytes || this.disposed) return;
      const img = await this.pool.run<'png'>({ type: 'png', bytes, size: BIOME_MAP }, [bytes.buffer]);
      if (img.width !== BIOME_MAP || img.height !== BIOME_MAP) return;
      this.biomeMap = img.rgba;
      for (const t of this.tiles.values()) if (t.biome === null) delete t.biome;
      this.onChange();
    } catch (e) {
      console.warn('biome map failed', e);
    }
  }

  /** Биом, которого в тайле больше всего (по сетке 8×8 точек). */
  private biomeOf(t: Tile): number | null {
    if (t.biome !== undefined) return t.biome;
    const map = this.biomeMap;
    if (!map) return null;
    const count = new Map<number, number>();
    const px = BIOME_MAP / (2 * WORLD_HALF);
    for (let j = 0; j < 8; j++)
      for (let i = 0; i < 8; i++) {
        const x = Math.min(BIOME_MAP - 1, Math.floor((t.b.x + ((i + 0.5) / 8) * t.b.size + WORLD_HALF) * px));
        const y = Math.min(BIOME_MAP - 1, Math.floor((t.b.z + ((j + 0.5) / 8) * t.b.size + WORLD_HALF) * px));
        const o = (y * BIOME_MAP + x) * 4;
        const c = (map[o]! << 16) | (map[o + 1]! << 8) | map[o + 2]!;
        if (this.biomes.has(c)) count.set(c, (count.get(c) ?? 0) + 1);
      }
    let best: number | null = null;
    let n = 0;
    for (const [c, k] of count)
      if (k > n) {
        n = k;
        best = c;
      }
    t.biome = best;
    return best;
  }

  /** Текстура рисунка земли; undefined — ещё грузится (или её нет). */
  private detailTexture(path: string): DetailTexture | undefined {
    const k = path.toLowerCase();
    const have = this.detailTex.get(k);
    if (have) {
      have.used = this.frame;
      return have.tex;
    }
    let loading = 0;
    for (const v of this.detailTex.values()) if (v.loading) loading++;
    if (loading >= 3) return undefined;
    const entry: { tex?: DetailTexture; used: number; loading: boolean } = { used: this.frame, loading: true };
    this.detailTex.set(k, entry);
    void (async () => {
      try {
        const bytes = await window.kedit.readGameAsset(this.game, path);
        if (!bytes || this.disposed) return;
        const r = await this.pool.run<'dds'>({ type: 'dds', bytes, maxSize: 512 }, [bytes.buffer]);
        const avg = averageColour(r.rgba);
        const tex = new THREE.DataTexture(r.rgba, r.width, r.height, THREE.RGBAFormat);
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = 8;
        tex.needsUpdate = true;
        entry.tex = { tex, avg };
        this.onChange();
      } catch (e) {
        console.warn('detail texture failed', path, e);
      } finally {
        entry.loading = false;
      }
    })();
    return undefined;
  }

  /** Цвет + рисунок биома; undefined — рисунка нет или он ещё грузится. */
  private withDetail(colourKey: string, colour: THREE.MeshLambertMaterial, t: Tile): THREE.Material | undefined {
    const index = this.biomeOf(t);
    const biome = index === null ? undefined : this.biomes.get(index);
    if (!biome?.base || !colour.map) return undefined;
    const key = `${colourKey}|${index}`;
    const have = this.detailMats.get(key);
    if (have) {
      have.used = this.frame;
      return have.mat;
    }
    const base = this.detailTexture(biome.base);
    const slope = biome.slope ? this.detailTexture(biome.slope) : base;
    const cliff = biome.cliff ? this.detailTexture(biome.cliff) : base;
    if (!base || !slope || !cliff) return undefined;
    const mat = detailMaterial(colour.map, biome, base, slope, cliff);
    this.detailMats.set(key, { mat, used: this.frame, texs: [base.tex, slope.tex, cliff.tex] });
    return mat;
  }

  /** Обзор цвета: сначала `distant.png`, потом 64 картинки, уменьшенные в фоновом потоке. */
  private async loadOverview(): Promise<void> {
    const ctx = this.overviewCanvas.getContext('2d')!;
    try {
      const bytes = await window.kedit.readGameAsset(this.game, 'data/newland/land/overlaymaps/distant.png');
      if (bytes) {
        const img = await this.pool.run<'png'>({ type: 'png', bytes, size: OVERVIEW }, [bytes.buffer]);
        const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(img.rgba.buffer as ArrayBuffer), img.width, img.height));
        ctx.drawImage(bitmap, 0, 0, OVERVIEW, OVERVIEW);
        bitmap.close();
        this.overviewTex.needsUpdate = true;
        this.onChange();
      }
    } catch {
      // нет — остаётся ровный цвет
    }
    const cell = OVERVIEW / COLOUR_TILES;
    const queue: [number, number][] = [];
    for (let j = 0; j < COLOUR_TILES; j++) for (let i = 0; i < COLOUR_TILES; i++) queue.push([i, j]);
    const worker = async (): Promise<void> => {
      for (let q = queue.shift(); q && !this.disposed; q = queue.shift()) {
        const [i, j] = q;
        try {
          const bytes = await window.kedit.readGameAsset(this.game, COLOUR_PATH(i, j));
          if (!bytes) continue;
          const img = await this.pool.run<'png'>({ type: 'png', bytes, size: cell }, [bytes.buffer]);
          // `colour.I.J`: I — столбец, J — строка (края соседних картинок совпадают именно так).
          ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer as ArrayBuffer), img.width, img.height), i * cell, j * cell);
          this.overviewTex.needsUpdate = true;
          this.onChange();
        } catch {
          // пропускаем картинку
        }
        this.overviewDone++;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  get overviewProgress(): number {
    return this.overviewDone / (COLOUR_TILES * COLOUR_TILES);
  }

  /** Материал с картинкой цвета для клетки карты (x, y) 0..7; undefined — ещё грузится. */
  private colourMaterial(x: number, y: number, full: boolean): THREE.MeshLambertMaterial | undefined {
    const key = `${x}.${y}.${full ? 'f' : 's'}`;
    const have = this.colourMats.get(key);
    if (have) {
      have.used = this.frame;
      return have.mat;
    }
    if (!this.colourLoading.has(key) && this.colourLoading.size < 3) {
      this.colourLoading.add(key);
      void (async () => {
        try {
          const bytes = await window.kedit.readGameAsset(this.game, COLOUR_PATH(x, y));
          if (!bytes || this.disposed) return;
          const img = await this.pool.run<'png'>({ type: 'png', bytes, size: full ? 2048 : 512 }, [bytes.buffer]);
          const tex = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          tex.flipY = false;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          // UV тайла — общие на весь мир (0..1); картинка занимает 1/8 по каждой оси.
          tex.repeat.set(COLOUR_TILES, COLOUR_TILES);
          tex.offset.set(-x, -y);
          tex.needsUpdate = true;
          this.colourMats.set(key, { mat: new THREE.MeshLambertMaterial({ map: tex }), used: this.frame, full });
          this.trimColour();
          this.onChange();
        } catch {
          // нет картинки — остаётся обзор
        } finally {
          this.colourLoading.delete(key);
        }
      })();
    }
    return undefined;
  }

  private trimColour(): void {
    const drop = (full: boolean, keep: number): void => {
      const list = [...this.colourMats.entries()].filter(([, v]) => v.full === full).sort((a, b) => a[1].used - b[1].used);
      for (const [k, v] of list.slice(0, Math.max(0, list.length - keep))) {
        if (v.used === this.frame) continue;
        v.mat.map?.dispose();
        v.mat.dispose();
        this.colourMats.delete(k);
        for (const [dk, d] of [...this.detailMats])
          if (dk.startsWith(`${k}|`)) {
            d.mat.dispose();
            this.detailMats.delete(dk);
          }
      }
    };
    drop(true, this.quality.fullColour);
    drop(false, 24);
  }

  /** Рисунки земли: давно не нужные материалы — прочь; текстур держим не больше 40. */
  private trimDetail(): void {
    for (const [k, d] of [...this.detailMats])
      if (this.frame - d.used > 600) {
        d.mat.dispose();
        this.detailMats.delete(k);
      }
    if (this.detailTex.size <= 40) return;
    const inUse = new Set<THREE.Texture>();
    for (const d of this.detailMats.values()) for (const t of d.texs) inUse.add(t);
    const list = [...this.detailTex.entries()].filter(([, v]) => !v.loading && v.used !== this.frame).sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of list.slice(0, this.detailTex.size - 40)) {
      if (v.tex && inUse.has(v.tex.tex)) continue;
      v.tex?.tex.dispose();
      this.detailTex.delete(k);
    }
  }

  /** UV тайла в долях всего мира. */
  private uvOf(level: number, tx: number, ty: number): [number, number, number, number] {
    const n = 2 ** level;
    return [tx / n, ty / n, 1 / n, 1 / n];
  }

  private materialOf(t: Tile): THREE.Material {
    if (t.level < COLOUR_LEVEL) return this.overviewMat;
    const per = 2 ** (t.level - COLOUR_LEVEL);
    const x = Math.floor(t.tx / per);
    const y = Math.floor(t.ty / per);
    const full = t.level >= COLOUR_LEVEL + 2;
    let key = `${x}.${y}.${full ? 'f' : 's'}`;
    let colour = this.colourMaterial(x, y, full);
    if (!colour && full) {
      key = `${x}.${y}.s`;
      colour = this.colourMaterial(x, y, false);
    }
    if (!colour) return this.overviewMat;
    if (t.level >= DETAIL_LEVEL) {
      const d = this.withDetail(key, colour, t);
      if (d) {
        this.detailed++;
        return d;
      }
    }
    return colour;
  }

  private tile(level: number, tx: number, ty: number): Tile {
    const key = `${level}/${tx}/${ty}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { key, level, tx, ty, b: tileBounds(level, tx, ty), state: 'loading', min: 0, max: 3000, used: this.frame };
      this.tiles.set(key, t);
    }
    return t;
  }

  private load(t: Tile): void {
    if (t.mesh || t.state === 'failed' || t.started) return;
    t.started = true;
    this.inflight++;
    void (async () => {
      try {
        const heights = await window.kedit.readTerrainTile(this.game, t.level, t.tx, t.ty);
        if (!heights) {
          this.missing = true;
          t.state = 'failed';
          return;
        }
        t.heights = heights.slice();
        const r = await this.pool.run<'terrain'>({ type: 'terrain', heights, size: t.b.size, uv: this.uvOf(t.level, t.tx, t.ty) }, [heights.buffer]);
        if (!this.tiles.has(t.key)) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(r.nor, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(r.uvs, 2));
        geo.setIndex(this.index);
        geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, r.min, 0), new THREE.Vector3(t.b.size, r.max, t.b.size));
        geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
        const mesh = new THREE.Mesh(geo, this.overviewMat);
        mesh.position.set(t.b.x, 0, t.b.z);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.userData['tile'] = t.key;
        t.mesh = mesh;
        t.min = r.min;
        t.max = r.max;
        t.state = 'ready';
        this.onChange();
      } catch {
        t.state = 'failed';
      } finally {
        this.inflight--;
      }
    })();
  }

  /** Расстояние от камеры до коробки тайла. */
  private distance(t: Tile, cam: THREE.Vector3): number {
    const dx = Math.max(t.b.x - cam.x, 0, cam.x - (t.b.x + t.b.size));
    const dz = Math.max(t.b.z - cam.z, 0, cam.z - (t.b.z + t.b.size));
    const dy = Math.max(t.min - cam.y, 0, cam.y - t.max);
    return Math.hypot(dx, dy, dz);
  }

  /** Выбрать тайлы под камеру и заказать нужные. Вызывать каждый кадр (дёшево). */
  update(camera: THREE.Camera): void {
    this.frame++;
    const cam = camera.position;
    const want: { t: Tile; d: number }[] = [];
    const show: Tile[] = [];
    const visit = (t: Tile): void => {
      t.used = this.frame;
      if (!t.mesh) {
        want.push({ t, d: -1 });
        return;
      }
      const d = this.distance(t, cam);
      if (t.level < Math.min(TERRAIN_MAX_LEVEL, this.quality.maxLevel) && d < t.b.size * this.quality.split) {
        const kids = [0, 1, 2, 3].map((k) => this.tile(t.level + 1, t.tx * 2 + (k & 1), t.ty * 2 + (k >> 1)));
        if (kids.every((k) => k.mesh || k.state === 'failed') && kids.some((k) => k.mesh)) {
          for (const k of kids) if (k.mesh) visit(k);
          return;
        }
        for (const k of kids) {
          k.used = this.frame;
          if (!k.mesh) want.push({ t: k, d });
        }
      }
      show.push(t);
    };
    visit(this.tile(0, 0, 0));

    // Заказ: сначала ближние, не больше 6 одновременно.
    want.sort((a, b) => a.d - b.d);
    for (const { t } of want) {
      if (this.inflight >= 6) break;
      this.load(t);
    }

    this.group.clear();
    this.drawn = 0;
    this.detailed = 0;
    for (const t of show) {
      const mesh = t.mesh!;
      mesh.material = this.materialOf(t);
      this.group.add(mesh);
      this.drawn++;
    }
    this.trimTiles();
    if (this.frame % 120 === 0) this.trimDetail();
  }

  private trimTiles(): void {
    if (this.tiles.size <= this.quality.cache) return;
    const old = [...this.tiles.values()].filter((t) => t.used !== this.frame && t.level > 0).sort((a, b) => a.used - b.used);
    for (const t of old.slice(0, this.tiles.size - this.quality.cache)) {
      t.mesh?.geometry.dispose();
      this.tiles.delete(t.key);
    }
  }

  /** Биом (`index`) в точке по карте биомов; undefined — карта ещё не прочитана или вне мира. */
  biomeAt(x: number, z: number): number | undefined {
    const map = this.biomeMap;
    if (!map || Math.abs(x) >= WORLD_HALF || Math.abs(z) >= WORLD_HALF) return undefined;
    const px = BIOME_MAP / (2 * WORLD_HALF);
    const o = (Math.floor((z + WORLD_HALF) * px) * BIOME_MAP + Math.floor((x + WORLD_HALF) * px)) * 4;
    return (map[o]! << 16) | (map[o + 1]! << 8) | map[o + 2]!;
  }

  /**
   * Высота земли в точке по самому подробному загруженному тайлу; undefined — ещё нет.
   * `minLevel` — не грубее этого уровня (для того, что ставится на землю вблизи).
   */
  heightAt(x: number, z: number, minLevel = 0): number | undefined {
    if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return undefined;
    for (let level = TERRAIN_MAX_LEVEL; level >= minLevel; level--) {
      const n = 2 ** level;
      const tx = Math.min(n - 1, Math.floor(((x + WORLD_HALF) / (2 * WORLD_HALF)) * n));
      const ty = Math.min(n - 1, Math.floor(((z + WORLD_HALF) / (2 * WORLD_HALF)) * n));
      const t = this.tiles.get(`${level}/${tx}/${ty}`);
      if (t?.heights) return sampleTile(t.heights, t.b, x, z);
    }
    return undefined;
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  get ready(): boolean {
    return this.tiles.get('0/0/0')?.state === 'ready';
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.tiles.values()) t.mesh?.geometry.dispose();
    this.tiles.clear();
    for (const v of this.colourMats.values()) {
      v.mat.map?.dispose();
      v.mat.dispose();
    }
    for (const d of this.detailMats.values()) d.mat.dispose();
    for (const d of this.detailTex.values()) d.tex?.tex.dispose();
    this.overviewTex.dispose();
    this.overviewMat.dispose();
  }
}
