/**
 * Окно «Мир»: рендер, свет, камера-полёт, рельеф, объекты, подписи городов, подсветка и замеры.
 * Кадр рисуется только когда что-то изменилось (камера, загрузка) — в покое видеокарта отдыхает.
 * Тяжёлое — в фоновых потоках (`WorkerPool`), здесь только сборка объектов three.js.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { type ModContext, type Vec3, type Vec4, type WorldChange, type WorldEdits, type WorldIndex } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../../shared/api.ts';
import { WorkerPool } from './protocol.ts';
import { TerrainLod, type TerrainQuality } from './terrain.ts';
import { readBiomes } from './biomes.ts';
import { FoliageScatter, type FoliageQuality } from './foliage.ts';
import { WorldObjects, type ObjectsQuality, type WorldObject } from './objects.ts';
import { FlyControls } from './fly.ts';
import { letterOf } from '../../keys.ts';

export type QualityLevel = 'low' | 'medium' | 'high';

export interface WorldSettings {
  quality: QualityLevel;
  /** Дальность прорисовки объектов (маркеров), единиц мира. */
  drawDistance: number;
}

export const DEFAULT_SETTINGS: WorldSettings = { quality: 'medium', drawDistance: 25000 };

const QUALITY: Record<QualityLevel, { terrain: TerrainQuality; foliage: FoliageQuality; models: number; modelDist: number; protos: number; markers: number; pixelRatio: number }> = {
  low: { terrain: { split: 1.6, maxLevel: 6, cache: 300, fullColour: 2 }, foliage: { radius: 2500, maxInstances: 1500 }, models: 400, modelDist: 3000, protos: 60, markers: 3000, pixelRatio: 1 },
  medium: { terrain: { split: 2.4, maxLevel: 7, cache: 600, fullColour: 4 }, foliage: { radius: 4000, maxInstances: 4000 }, models: 1500, modelDist: 6000, protos: 160, markers: 8000, pixelRatio: 1 },
  high: { terrain: { split: 3.4, maxLevel: 7, cache: 1000, fullColour: 8 }, foliage: { radius: 6500, maxInstances: 10000 }, models: 4000, modelDist: 10000, protos: 400, markers: 15000, pixelRatio: 2 },
};

export interface TownLabel {
  sid: string;
  name: string;
  pos: THREE.Vector3;
}

export interface WorldStatsView {
  fps: number;
  /** Среднее время кадра на процессоре, мс. */
  frameMs: number;
  /** От открытия окна до первой картинки рельефа, мс (undefined — ещё нет). */
  firstFrameMs: number | undefined;
  /** Память JS (МБ), если браузер её даёт. */
  heapMb: number | undefined;
  geometries: number;
  textures: number;
  drawCalls: number;
  triangles: number;
  /** Тайлов с рисунком биома. */
  detailed: number;
  tiles: number;
  tilesDrawn: number;
  models: number;
  markers: number;
  loading: number;
  /** Загруженных моделей (разных) и записей без модели. */
  protos: number;
  failed: number;
  /** Растительность: экземпляров вокруг камеры и нарисовано (в кадре). */
  foliage: number;
  foliageDrawn: number;
  overview: number;
  /** Где камера (для e2e и «Показать в игре»). */
  camera: { x: number; y: number; z: number };
  /** Гизмо на экране (пиксели холста): центр и точка на стрелке X — для e2e. */
  gizmo: string;
}

/** Правка объектов гизмо: режим, шаг сетки (0 — без), шаг поворота в градусах (0 — без), к земле. */
export interface EditSettings {
  mode: 'move' | 'rotate';
  grid: number;
  angle: number;
  ground: boolean;
}

export const DEFAULT_EDIT: EditSettings = { mode: 'move', grid: 0, angle: 15, ground: true };

/** Куда поставить экземпляр после перетаскивания. */
export interface EditCommit {
  /** Позиция экземпляра (y — как в файле: над землёй). */
  position: Vec3;
  /** Кватернион в порядке файла (w, x, y, z). */
  rotation: Vec4;
  /** Высота в мире для состояния здания (`world Y pos`). */
  worldY?: number;
}

function qualityOf(s: WorldSettings): { terrain: TerrainQuality; objects: ObjectsQuality; foliage: FoliageQuality; pixelRatio: number } {
  const q = QUALITY[s.quality];
  return {
    terrain: q.terrain,
    foliage: { radius: Math.min(q.foliage.radius, s.drawDistance), maxInstances: q.foliage.maxInstances },
    objects: { markerDist: s.drawDistance, modelDist: Math.min(q.modelDist, s.drawDistance), maxModels: q.models, maxProtos: q.protos, maxMarkers: q.markers },
    pixelRatio: Math.min(window.devicePixelRatio || 1, q.pixelRatio),
  };
}

export class WorldView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly fly: FlyControls;
  readonly terrain: TerrainLod;
  readonly objects: WorldObjects;
  readonly foliage: FoliageScatter;
  readonly towns: TownLabel[];
  private readonly pool: WorkerPool;
  private readonly host: HTMLElement;
  private readonly labels: HTMLDivElement;
  private readonly labelEls = new Map<string, HTMLDivElement>();
  private readonly hoverBox: THREE.LineSegments;
  private readonly selectBox: THREE.LineSegments;
  private readonly resize: ResizeObserver;
  private readonly fog: THREE.Fog;
  private raf = 0;
  private dirty = true;
  private lastObjects = 0;
  private objectsDirty = true;
  private last = performance.now();
  private readonly started = performance.now();
  private frames: number[] = [];
  private cpu: number[] = [];
  private firstFrame: number | undefined;
  hovered: WorldObject | undefined;
  selected: WorldObject | undefined;
  settings: WorldSettings;
  /** Вызывается после выбора кликом (или снятия выбора). */
  onSelect: (o: WorldObject | undefined) => void = () => undefined;
  /** Гизмо отпустили: записать правку. false — правка не прошла, объект вернётся на место. */
  onCommit: (o: WorldObject, c: EditCommit) => boolean = () => false;
  /** Клавиша Delete на выбранном объекте. */
  onRemove: (o: WorldObject) => void = () => undefined;
  /** Сменился режим гизмо (клавиши G / R). */
  onEditChange: (e: EditSettings) => void = () => undefined;
  /** Можно ли править (открыт мод). */
  editable = false;
  edit: EditSettings = { ...DEFAULT_EDIT };
  readonly gizmo: TransformControls;
  private readonly pivot = new THREE.Object3D();
  private dragStart: { pos: THREE.Vector3; quat: THREE.Quaternion; above: number | undefined } | undefined;
  /** Последний pointerdown пришёлся на гизмо — щелчок после него не выбирает. */
  private gizmoDown = false;

  constructor(host: HTMLElement, game: GameInstallInfo, ctx: ModContext, world: WorldIndex, settings: WorldSettings, lang: 'en' | 'ru' = 'ru') {
    this.host = host;
    this.settings = settings;
    const q = qualityOf(settings);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(q.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.style.outline = 'none';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.dataset['testid'] = 'world-canvas';
    host.appendChild(this.renderer.domElement);

    this.labels = document.createElement('div');
    this.labels.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;font-size:12px';
    host.appendChild(this.labels);

    const sky = new THREE.Color(0xc8c2b0);
    this.scene.background = sky;
    // Дымка зависит от высоты камеры (см. `loop`): сверху весь мир чистый, у земли даль тает.
    this.fog = new THREE.Fog(sky, 60000, 300000);
    this.scene.fog = this.fog;
    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x6b5a45, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(0.5, 1, 0.3);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(55, 1, 2, 600000);
    this.pool = new WorkerPool(Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)));
    const biomes = readBiomes(ctx);
    this.terrain = new TerrainLod(game, this.pool, q.terrain, biomes);
    // Пока у растительности нет подробного рельефа, новые тайлы — повод пересчитать её.
    this.terrain.onChange = () => { this.invalidate(this.foliage.incomplete); };
    this.scene.add(this.terrain.group);
    this.objects = new WorldObjects(game, this.pool, ctx, world, q.objects);
    this.objects.groundAt = (x, z) => this.terrain.heightAt(x, z);
    this.objects.groundMap = this.terrain.colourMap;
    this.objects.onChange = () => { this.invalidate(true); };
    this.scene.add(this.objects.group);

    this.towns = [];
    for (const t of world.allTowns()) {
      const name = (lang === 'ru' ? ctx.localizedName(t.target) : undefined) ?? ctx.name(t.target) ?? t.target;
      this.towns.push({ sid: t.target, name: name || t.target, pos: new THREE.Vector3(t.position[0], t.position[1], t.position[2]) });
    }
    this.foliage = new FoliageScatter(biomes, this.terrain, this.towns.map((t) => t.pos), this.objects.list.map((o) => o.pos), q.foliage);

    // Рамки подсветки: под мышью — светло-серая, выбранный — ярко-синяя (видны сквозь всё).
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.hoverBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xdddddd, depthTest: false, transparent: true, opacity: 0.8 }));
    this.selectBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x3fa9ff, depthTest: false }));
    for (const h of [this.hoverBox, this.selectBox]) {
      h.visible = false;
      h.matrixAutoUpdate = false;
      h.renderOrder = 10;
      h.frustumCulled = false;
      this.scene.add(h);
    }

    this.fly = new FlyControls(this.camera, this.renderer.domElement);
    this.fly.groundAt = (x, z) => this.terrain.heightAt(x, z);
    this.fly.onChange = () => { this.invalidate(true); };

    // Гизмо: стрелки сдвига / кольцо поворота на выбранном объекте.
    this.pivot.name = 'pivot';
    this.scene.add(this.pivot);
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('world');
    this.gizmo.size = 1.1;
    const helper = this.gizmo.getHelper();
    helper.name = 'gizmo';
    this.scene.add(helper);
    this.fly.blocked = () => this.gizmoOn() && this.gizmo.axis !== null;
    this.gizmo.addEventListener('change', () => { this.invalidate(); });
    this.gizmo.addEventListener('mouseDown', () => { this.gizmoDown = true; });
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const o = this.selected;
      if (!o) return;
      if (e.value) {
        const g = this.terrain.heightAt(o.pos.x, o.pos.z);
        this.dragStart = { pos: o.pos.clone(), quat: o.quat.clone(), above: g === undefined ? undefined : o.pos.y - g };
      } else this.commitDrag(o);
    });
    this.gizmo.addEventListener('objectChange', () => { this.onGizmoMove(); });
    this.applyEdit();
    // Начало — над серединой карты, весь мир в кадре.
    this.fly.set(new THREE.Vector3(0, 200000, 160000), new THREE.Vector3(0, 0, 0));

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('click', this.onClick);
    el.addEventListener('dblclick', this.onDouble);
    el.addEventListener('keydown', this.onKey);

    this.resize = new ResizeObserver(() => { this.fit(); });
    this.resize.observe(host);
    this.fit();
    this.raf = requestAnimationFrame(this.loop);
  }

  private fit(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate(true);
  }

  invalidate(objects = false): void {
    this.dirty = true;
    if (objects) this.objectsDirty = true;
  }

  applySettings(s: WorldSettings): void {
    this.settings = s;
    const q = qualityOf(s);
    this.terrain.quality = q.terrain;
    this.objects.quality = q.objects;
    this.foliage.quality = q.foliage;
    this.renderer.setPixelRatio(q.pixelRatio);
    this.fit();
  }

  private ray(e: { clientX: number; clientY: number }): THREE.Ray {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc.ray;
  }

  private pending: PointerEvent | undefined;
  private readonly onMove = (e: PointerEvent): void => {
    if (e.buttons !== 0) return;
    this.pending = e;
    this.dirty = true;
  };

  private readonly onLeave = (): void => {
    this.pending = undefined;
    this.setHover(undefined);
  };

  private readonly onClick = (e: MouseEvent): void => {
    if (this.gizmoDown) {
      this.gizmoDown = false;
      return;
    }
    if (this.fly.dragged || e.button !== 0) return;
    this.select(this.objects.pick(this.ray(e)));
  };

  /** Двойной клик по земле — подлететь к этой точке (ближе — подробнее). */
  private readonly onDouble = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const p = this.groundHit(this.ray(e));
    if (!p) return;
    const cam = this.camera.position;
    this.fly.flyTo(p, Math.max(600, Math.min(cam.distanceTo(p) * 0.35, 40000)));
  };

  /** Точка земли под лучом: шаг по лучу, потом уточнение делением пополам. */
  groundHit(ray: THREE.Ray): THREE.Vector3 | undefined {
    const above = (t: number): number | undefined => {
      const p = ray.at(t, new THREE.Vector3());
      const g = this.terrain.heightAt(p.x, p.z);
      return g === undefined ? undefined : p.y - g;
    };
    const far = 600000;
    let t0 = 0;
    let step = Math.max(50, (above(0) ?? 0) / 50);
    for (let t = step; t < far; t += step) {
      const a = above(t);
      if (a === undefined) {
        t0 = t;
        continue;
      }
      if (a <= 0) {
        let lo = t0;
        let hi = t;
        for (let k = 0; k < 24; k++) {
          const mid = (lo + hi) / 2;
          if ((above(mid) ?? 1) > 0) lo = mid;
          else hi = mid;
        }
        return ray.at(hi, new THREE.Vector3());
      }
      t0 = t;
      step = Math.max(50, a / 4);
    }
    return undefined;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const letter = letterOf(e);
    if (letter === 'f' && this.selected) {
      this.focus(this.selected);
      e.preventDefault();
    } else if ((letter === 'g' || letter === 'r') && this.editable) {
      this.setEdit({ ...this.edit, mode: letter === 'g' ? 'move' : 'rotate' });
      this.onEditChange(this.edit);
      e.preventDefault();
    } else if (e.key === 'Delete' && this.selected && this.editable && !this.gizmo.dragging) {
      this.onRemove(this.selected);
      e.preventDefault();
    } else if (e.key === 'Escape') this.select(undefined);
  };

  /** Сменить настройки гизмо (режим, сетка, угол, к земле). */
  setEdit(e: EditSettings): void {
    this.edit = e;
    this.applyEdit();
  }

  setEditable(on: boolean): void {
    this.editable = on;
    this.attachGizmo();
  }

  private applyEdit(): void {
    const e = this.edit;
    const g = this.gizmo;
    g.setMode(e.mode === 'move' ? 'translate' : 'rotate');
    g.setTranslationSnap(e.grid > 0 ? e.grid : null);
    g.setRotationSnap(e.angle > 0 ? THREE.MathUtils.degToRad(e.angle) : null);
    // Поворот — только вокруг вертикали (как в игре). Зелёная стрелка (Y) — вверх-вниз всегда;
    // «к земле» действует на сдвиг по земле (X/Z): высота над землёй сохраняется.
    const rotate = e.mode === 'rotate';
    g.showX = !rotate;
    g.showZ = !rotate;
    g.showY = true;
    this.invalidate();
  }

  private attachGizmo(): void {
    const o = this.selected;
    if (o && this.editable) {
      this.pivot.position.copy(o.pos);
      this.pivot.quaternion.copy(o.quat);
      this.pivot.updateMatrixWorld();
      if (this.gizmo.object !== this.pivot) this.gizmo.attach(this.pivot);
    } else if (this.gizmoOn()) this.gizmo.detach();
    this.invalidate();
  }

  private onGizmoMove(): void {
    const o = this.selected;
    const start = this.dragStart;
    if (!o || !start) return;
    const vertical = this.gizmo.axis?.includes('Y') === true;
    if (this.edit.mode === 'move' && this.edit.ground && !vertical && start.above !== undefined) {
      const g = this.terrain.heightAt(this.pivot.position.x, this.pivot.position.z);
      if (g !== undefined) this.pivot.position.y = g + start.above;
    }
    o.pos.copy(this.pivot.position);
    o.quat.copy(this.pivot.quaternion);
    this.place(this.selectBox, o);
    this.objects.update(this.camera);
  }

  private commitDrag(o: WorldObject): void {
    const start = this.dragStart;
    this.dragStart = undefined;
    if (!start) return;
    if (o.pos.equals(start.pos) && o.quat.equals(start.quat)) return;
    const c = this.commitOf(o, start.pos);
    if (!this.onCommit(o, c)) {
      o.pos.copy(start.pos);
      o.quat.copy(start.quat);
      this.attachGizmo();
      this.place(this.selectBox, o);
      this.invalidate(true);
    }
  }

  /** Что записать в файл для объекта, стоящего сейчас в `o.pos`/`o.quat` (раньше — в `from`). */
  commitOf(o: WorldObject, from: THREE.Vector3): EditCommit {
    // y экземпляра — над землёй: старая высота + подъём − подъём земли.
    const g0 = this.terrain.heightAt(from.x, from.z);
    const g1 = this.terrain.heightAt(o.pos.x, o.pos.z);
    const y = o.p.position[1] + (o.pos.y - from.y) - (g0 !== undefined && g1 !== undefined ? g1 - g0 : 0);
    const q = o.quat;
    const c: EditCommit = { position: [o.pos.x, y, o.pos.z], rotation: [q.w, q.x, q.y, q.z] };
    if (o.b) c.worldY = o.pos.y;
    return c;
  }

  /** Подтянуть правки мира мода (свои, отмена/повтор, правки ИИ). */
  sync(edits: WorldEdits, changes: readonly WorldChange[]): void {
    const touched = this.objects.sync(edits, changes);
    if (this.selected?.gone) this.select(undefined);
    else if (this.selected && touched.includes(this.selected) && !this.gizmo.dragging) {
      this.attachGizmo();
      this.place(this.selectBox, this.selected);
    }
    if (this.hovered?.gone) this.setHover(undefined);
    this.objects.update(this.camera);
    this.invalidate(true);
  }

  /** Точка земли в середине экрана (куда ставить новый объект). */
  centreGround(): THREE.Vector3 | undefined {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    return this.groundHit(rc.ray);
  }

  private setHover(o: WorldObject | undefined): void {
    if (o === this.hovered) return;
    this.hovered = o;
    this.renderer.domElement.style.cursor = o ? 'pointer' : 'default';
    this.place(this.hoverBox, o && o !== this.selected ? o : undefined);
  }

  select(o: WorldObject | undefined): void {
    this.selected = o;
    this.attachGizmo();
    this.place(this.selectBox, o);
    this.place(this.hoverBox, this.hovered && this.hovered !== o ? this.hovered : undefined);
    this.onSelect(o);
  }

  private place(helper: THREE.LineSegments, o: WorldObject | undefined): void {
    helper.visible = o !== undefined;
    if (o) {
      const box = this.objects.boxOf(o);
      const local = new THREE.Matrix4().compose(box.getCenter(new THREE.Vector3()), new THREE.Quaternion(), box.getSize(new THREE.Vector3()).multiplyScalar(1.04));
      helper.matrix.copy(this.objects.matrixOf(o)).multiply(local);
      helper.matrixWorldNeedsUpdate = true;
    }
    this.invalidate();
  }

  /** Перелететь к объекту. */
  focus(o: WorldObject): void {
    const size = this.objects.boxOf(o).getSize(new THREE.Vector3()).length();
    this.fly.flyTo(o.pos, Math.max(250, size * 2.2));
  }

  /** Перелететь к точке (город): смотрим на землю в этой точке. */
  flyToPoint(p: THREE.Vector3, dist = 2500): void {
    const look = p.clone();
    const g = this.terrain.heightAt(p.x, p.z);
    if (g !== undefined) look.y = g;
    this.fly.flyTo(look, dist);
  }

  private readonly loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    // Вкладка скрыта — не считаем и не рисуем.
    if (!this.host.isConnected || this.host.clientWidth === 0) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.fly.update(dt)) this.objectsDirty = true;
    const t0 = performance.now();
    this.camera.updateMatrixWorld();
    // LOD рельефа — каждый кадр (дёшево); объекты — не чаще ~6 раз в секунду.
    this.terrain.update(this.camera);
    if (this.objectsDirty && now - this.lastObjects > 150) {
      if (this.foliage.update(this.camera.position)) this.objects.setFoliage(this.foliage.byTarget);
      this.objects.update(this.camera);
      // Растительность досчитывается по частям — пока не всё, обновляем ещё.
      this.objectsDirty = this.foliage.incomplete;
      this.lastObjects = now;
      this.dirty = true;
    }
    if (this.pending) {
      const e = this.pending;
      this.pending = undefined;
      this.setHover(this.objects.pick(this.ray(e)));
    }
    if (!this.dirty && !this.fly.moving) return;
    this.dirty = false;
    const cam = this.camera.position;
    const above = Math.max(0, cam.y - (this.terrain.heightAt(cam.x, cam.z) ?? 0));
    this.fog.near = Math.max(40000, above * 2.5);
    this.fog.far = this.fog.near * 5;
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    this.cpu.push(performance.now() - t0);
    if (this.cpu.length > 60) this.cpu.shift();
    this.frames.push(now);
    while (this.frames.length > 0 && now - this.frames[0]! > 1000) this.frames.shift();
    if (this.firstFrame === undefined && this.terrain.ready) this.firstFrame = now - this.started;
  };

  private updateLabels(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const cam = this.camera.position;
    // Сверху видно дальше: подписи — на расстоянии до трёх высот камеры.
    const reach = Math.max(90000, (cam.y - (this.terrain.heightAt(cam.x, cam.z) ?? 0)) * 3);
    const shown = this.towns
      .map((t) => ({ t, d: t.pos.distanceTo(cam) }))
      .filter((x) => x.d < reach)
      .sort((a, b) => a.d - b.d)
      .slice(0, 60);
    const keep = new Set<string>();
    const v = new THREE.Vector3();
    for (const { t } of shown) {
      v.copy(t.pos);
      v.y += 300;
      v.project(this.camera);
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) continue;
      const key = `${t.sid}@${Math.round(t.pos.x)}`;
      keep.add(key);
      let el = this.labelEls.get(key);
      if (!el) {
        el = document.createElement('div');
        el.textContent = t.name;
        el.style.cssText = 'position:absolute;transform:translate(-50%,-100%);color:#fff;text-shadow:0 0 3px #000,0 0 2px #000;white-space:nowrap;pointer-events:auto;cursor:pointer';
        el.dataset['town'] = t.name;
        // Клик по названию — перелёт к городу.
        const pos = t.pos;
        el.addEventListener('click', () => { this.flyToPoint(pos); });
        this.labels.appendChild(el);
        this.labelEls.set(key, el);
      }
      el.style.left = `${((v.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - v.y) / 2) * h}px`;
    }
    for (const [k, el] of this.labelEls)
      if (!keep.has(k)) {
        el.remove();
        this.labelEls.delete(k);
      }
  }

  stats(): WorldStatsView {
    const info = this.renderer.info;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const avg = this.cpu.length ? this.cpu.reduce((a, b) => a + b, 0) / this.cpu.length : 0;
    return {
      fps: this.frames.length,
      frameMs: Math.round(avg * 10) / 10,
      firstFrameMs: this.firstFrame === undefined ? undefined : Math.round(this.firstFrame),
      heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : undefined,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      tiles: this.terrain.tileCount,
      detailed: this.terrain.detailed,
      tilesDrawn: this.terrain.drawn,
      models: this.objects.drawnModels,
      markers: this.objects.drawnMarkers,
      loading: this.objects.busy,
      protos: this.objects.protoCount,
      failed: this.objects.failed,
      foliage: this.foliage.count,
      foliageDrawn: this.objects.drawnFoliage,
      overview: Math.round(this.terrain.overviewProgress * 100),
      camera: this.cameraState(),
      gizmo: this.gizmoProbe(),
    };
  }

  /** Гизмо прикреплено к объекту (в типах three `object` всегда есть, на деле — нет). */
  private gizmoOn(): boolean {
    return (this.gizmo.object as THREE.Object3D | undefined) !== undefined;
  }

  /** Центр гизмо и точка на стрелке X в пикселях холста ('' — гизмо нет). */
  private gizmoProbe(): string {
    if (!this.gizmoOn()) return '';
    const cam = this.camera;
    const c = this.pivot.position.clone();
    // Размер гизмо — как в TransformControls: от расстояния до камеры и угла обзора.
    const factor = c.distanceTo(cam.position) * Math.min((1.9 * Math.tan((Math.PI * cam.fov) / 360)) / cam.zoom, 7);
    const ax = c.clone().add(new THREE.Vector3(0.45 * factor * this.gizmo.size / 4, 0, 0));
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const px = (v: THREE.Vector3): string => {
      v.project(cam);
      return `${Math.round(((v.x + 1) / 2) * w)},${Math.round(((1 - v.y) / 2) * h)}`;
    };
    return `${px(c)},${px(ax)}`;
  }

  /** Камера: позиция и куда смотрит (для «Показать в игре» и e2e). */
  cameraState(): { x: number; y: number; z: number } {
    const p = this.camera.position;
    return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerleave', this.onLeave);
    el.removeEventListener('click', this.onClick);
    el.removeEventListener('dblclick', this.onDouble);
    el.removeEventListener('keydown', this.onKey);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.fly.dispose();
    this.terrain.dispose();
    this.objects.dispose();
    this.pool.dispose();
    this.renderer.dispose();
    el.remove();
    this.labels.remove();
  }
}
