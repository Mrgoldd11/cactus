/**
 * «Inside» view: the building shell (exterior parts, interior parts and doors — background, not
 * selectable by mouse) and layout objects — furniture, chests, workbenches, item points. Camera as
 * in «Model» (rotate, pan, wheel); click — select an object, gizmo — move (G) / rotate around the
 * vertical (R) with grid and angle step, Del — delete, F — frame (selection or building), Esc —
 * clear selection. Object coordinates are from the building model origin, as in the game file.
 *
 * Floors as in the game: looking at a floor hides the parts of upper floors and the roofs, cuts the
 * walls a little above the floor (the room is seen from above, like a plan) and hides the objects
 * of upper floors. A grid lies on the floor; the ring shows where a new object goes.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { floorCut, modelOfRecord, type FloorPiece, type InteriorFloor, type InteriorKind, type ModContext } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../shared/api.ts';
import { letterOf } from '../keys.ts';
import { buildModel, disposeModel } from './build.ts';
import { ModelViewer } from './viewer.ts';

export interface InteriorEditSettings {
  mode: 'move' | 'rotate';
  /** Grid step (0 — no snapping). */
  grid: number;
  /** Angle step in degrees (0 — no snapping). */
  angle: number;
}

export const DEFAULT_INTERIOR_EDIT: InteriorEditSettings = { mode: 'move', grid: 0, angle: 15 };

/** Layout object for the view. */
export interface InteriorItem {
  key: string;
  target: string;
  kind: InteriorKind;
  position: [number, number, number];
  /** w, x, y, z — as in the file. */
  rotation: [number, number, number, number];
}

interface Entry {
  item: InteriorItem;
  group: THREE.Group;
}

/** What the view shows of the floors. */
export interface InteriorFloorView {
  floors: readonly InteriorFloor[];
  /** Floor looked at (game number); undefined — the whole building, nothing cut or hidden. */
  floor: number | undefined;
  /** Floor of every object (game number). */
  floorOf: ReadonlyMap<string, number>;
  /** Objects far from the building (world coordinates in the layout): not framed. */
  stray: ReadonlySet<string>;
}

/** A shell piece: one building part. */
interface ShellPiece {
  holder: THREE.Object3D;
  floor: number;
  interior: boolean;
  roof: boolean;
  door: boolean;
  minY: number;
  materials: THREE.MeshStandardMaterial[];
}

const NO_CUT = 1e9;

/** Box colour of an object without a model: item point — yellow, others — grey-blue. */
const MARKER: Record<InteriorKind, number> = { furniture: 0x8fa3b8, items: 0xe0b040, other: 0x9a8fb8 };
const MARKER_SIZE = 6;

export class InteriorView {
  readonly viewer: ModelViewer;
  readonly gizmo: TransformControls;
  onSelect: (key: string | undefined) => void = () => undefined;
  /** End of drag: write the move. false — failed, the object returns to its place. */
  onCommit: (key: string, position: [number, number, number], rotation: [number, number, number, number]) => boolean = () => false;
  onRemove: (key: string) => void = () => undefined;
  onEditChange: (e: InteriorEditSettings) => void = () => undefined;
  /** Object models are loaded (for e2e and the status bar). */
  onLoaded: () => void = () => undefined;
  edit: InteriorEditSettings = DEFAULT_INTERIOR_EDIT;
  editable = false;
  private readonly game: GameInstallInfo;
  private readonly ctx: ModContext;
  private readonly root = new THREE.Group();
  private readonly entries = new Map<string, Entry>();
  private readonly selectBox = new THREE.BoxHelper(new THREE.Object3D(), 0x4fb3ff);
  private readonly hoverBox = new THREE.BoxHelper(new THREE.Object3D(), 0xd0d0d0);
  private selectedKey: string | undefined;
  private hoveredKey: string | undefined;
  private dragStart: { pos: THREE.Vector3; quat: THREE.Quaternion } | undefined;
  private gizmoDown = false;
  private down: { x: number; y: number } | undefined;
  private pending = 0;
  private backdropSid: string | undefined;
  private disposed = false;
  private readonly ray = new THREE.Raycaster();
  /** Shell pieces of the building (empty — no model or not loaded yet). */
  private shell: ShellPiece[] = [];
  private shellPending = false;
  private readonly cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), NO_CUT);
  private floorView: InteriorFloorView = { floors: [], floor: undefined, floorOf: new Map(), stray: new Set() };
  /** Frame the camera once the shell and the objects are there. */
  private needFrame = true;
  private grid: THREE.GridHelper | undefined;
  private fill: THREE.Mesh | undefined;
  private readonly ring: THREE.Mesh;
  /** Shell loaded (its pieces with their lowest points): for the floor heights. */
  onShell: (pieces: FloorPiece[]) => void = () => undefined;
  /** The picture changed (framed, floor shown): for the e2e probes. */
  onViewChange: () => void = () => undefined;

  constructor(host: HTMLElement, game: GameInstallInfo, ctx: ModContext) {
    this.game = game;
    this.ctx = ctx;
    this.viewer = new ModelViewer(host);
    const v = this.viewer;
    v.autoGrid = false;
    v.renderer.localClippingEnabled = true;
    this.root.name = 'interior-objects';
    v.scene.add(this.root);
    for (const b of [this.selectBox, this.hoverBox]) {
      b.visible = false;
      b.material.depthTest = false;
      b.renderOrder = 10;
      v.scene.add(b);
    }
    this.gizmo = new TransformControls(v.camera, v.renderer.domElement);
    this.gizmo.setSpace('world');
    const helper = this.gizmo.getHelper();
    helper.name = 'gizmo';
    v.scene.add(helper);
    this.gizmo.addEventListener('change', () => { v.requestRender(); });
    this.gizmo.addEventListener('mouseDown', () => { this.gizmoDown = true; });
    this.gizmo.addEventListener('dragging-changed', (e) => {
      v.controls.enabled = !e.value;
      const o = this.selectedEntry();
      if (!o) return;
      if (e.value) this.dragStart = { pos: o.group.position.clone(), quat: o.group.quaternion.clone() };
      else this.commitDrag(o);
    });
    this.gizmo.addEventListener('objectChange', () => {
      const o = this.selectedEntry();
      if (o) this.box(this.selectBox, o);
    });
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(2.5, 4, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffc040, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }),
    );
    this.ring.name = 'place-ring';
    this.ring.renderOrder = 11;
    this.ring.visible = false;
    v.scene.add(this.ring);
    // The far plane follows the zoom: objects never vanish when the camera moves away.
    v.controls.addEventListener('change', () => {
      this.fitDepth();
      this.placeRing();
    });
    this.applyEdit();

    const el = v.renderer.domElement;
    el.tabIndex = 0;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('click', this.onClick);
    el.addEventListener('keydown', this.onKey);
  }

  /** Building shell — background. */
  async setBuilding(sid: string | undefined): Promise<void> {
    if (sid === this.backdropSid) return;
    this.backdropSid = sid;
    this.needFrame = true;
    const old = this.viewer.scene.getObjectByName('__model');
    this.shell = [];
    if (!sid) {
      this.shellPending = false;
      this.viewer.setModel(undefined);
      if (old) disposeModel(old);
      this.layoutFloor();
      return;
    }
    const model = modelOfRecord(this.ctx, sid, { shell: true });
    this.shellPending = model.pieces.length > 0;
    const built = model.pieces.length > 0 ? await buildModel(this.game, model).catch(() => undefined) : undefined;
    if (this.disposed || sid !== this.backdropSid) {
      if (built) disposeModel(built.group);
      return;
    }
    this.shellPending = false;
    const group = built?.group ?? new THREE.Group();
    group.name = '__model';
    const bySource = new Map(model.pieces.map((p) => [p.source, p]));
    group.updateMatrixWorld(true);
    for (const holder of group.children) {
      const p = bySource.get(holder.name);
      const materials: THREE.MeshStandardMaterial[] = [];
      holder.traverse((o) => {
        if (o instanceof THREE.Mesh) materials.push(...([o.material].flat() as THREE.MeshStandardMaterial[]));
      });
      for (const m of materials) m.clippingPlanes = [this.cutPlane];
      const box = new THREE.Box3().setFromObject(holder);
      this.shell.push({
        holder,
        floor: p?.floor ?? 0,
        interior: p?.interior === true,
        roof: p?.roof === true,
        door: p?.door === true,
        minY: box.isEmpty() ? 0 : box.min.y,
        materials,
      });
    }
    const prev = this.viewer.scene.getObjectByName('__model');
    this.viewer.setModel(group);
    if (prev) disposeModel(prev);
    this.applyFloorView();
    this.onShell(this.shell.map((p) => ({ floor: p.floor, interior: p.interior, minY: p.minY })));
    this.tryFrame();
  }

  /** What floor to show; objects and shell follow. */
  setFloorView(f: InteriorFloorView): void {
    const changed = f.floor !== this.floorView.floor;
    const firstFloors = this.floorView.floors.length === 0 && f.floors.length > 0;
    this.floorView = f;
    this.applyFloorView();
    if (changed && this.selectedKey !== undefined && !this.isShown(this.selectedKey)) this.select(undefined);
    if (changed || firstFloors) this.needFrame = true;
    this.tryFrame();
    this.onViewChange();
  }

  /** Frame the building again once objects come (a new layout). */
  resetFrame(): void {
    this.needFrame = true;
    this.tryFrame();
  }

  private isShown(key: string): boolean {
    const f = this.floorView.floor;
    return f === undefined || (this.floorView.floorOf.get(key) ?? 0) <= f;
  }

  /** Level of the floor looked at (the lowest one for the whole building). */
  private level(): number {
    const fv = this.floorView;
    const f = fv.floor === undefined ? fv.floors[0] : (fv.floors.find((x) => x.floor === fv.floor) ?? fv.floors[0]);
    return f?.level ?? 0;
  }

  /**
   * The building has its own interior parts. Without them (Metal Warehouse: `interior blank`) the
   * rooms are the exterior parts themselves, and see-through outer walls would take the floors away.
   */
  private hasInterior(): boolean {
    return this.shell.some((p) => p.interior);
  }

  private cutHeight(): number | undefined {
    const fv = this.floorView;
    // Whole building without interior parts: cut over the top floor, the roof stays as glass.
    const floor = fv.floor ?? (this.hasInterior() ? undefined : fv.floors.at(-1)?.floor);
    if (floor === undefined) return undefined;
    return floorCut(fv.floors, floor) ?? this.level() + 40;
  }

  private applyFloorView(): void {
    const fv = this.floorView;
    const floor = fv.floor;
    const all = floor === undefined;
    const ownInterior = this.hasInterior();
    const cut = this.cutHeight();
    this.cutPlane.constant = cut ?? NO_CUT;
    for (const p of this.shell) {
      p.holder.visible = all || (!p.roof && p.floor <= floor);
      // Whole building: outer parts (or only roofs, see hasInterior) are glass so the rooms show;
      // a floor: everything solid and cut above the floor.
      const glass = all && !p.interior && !p.door && (ownInterior || p.roof);
      for (const m of p.materials) {
        m.transparent = glass;
        m.opacity = glass ? 0.4 : 1;
        m.depthWrite = !glass;
        m.clippingPlanes = glass ? [] : [this.cutPlane];
        m.needsUpdate = true;
      }
    }
    for (const e of this.entries.values()) e.group.visible = this.isShown(e.item.key);
    if (this.hoveredKey !== undefined && !this.isShown(this.hoveredKey)) this.setHover(undefined);
    this.layoutFloor();
    this.refreshBoxes();
  }

  /** Box of the building: the shell, otherwise the objects (strays left out). */
  private buildingBox(): THREE.Box3 {
    const box = new THREE.Box3();
    const model = this.viewer.scene.getObjectByName('__model');
    if (model && this.shell.length > 0) box.setFromObject(model);
    const p = new THREE.Vector3();
    for (const e of this.entries.values()) if (!this.floorView.stray.has(e.item.key)) box.expandByPoint(p.set(...e.item.position));
    return box;
  }

  /** Grid on the floor looked at, solid ground under the lowest floor, the ring. */
  private layoutFloor(): void {
    const v = this.viewer;
    for (const o of [this.grid, this.fill]) {
      if (!o) continue;
      v.scene.remove(o);
      o.geometry.dispose();
      for (const m of [o.material].flat()) m.dispose();
    }
    this.grid = undefined;
    this.fill = undefined;
    const box = this.buildingBox();
    if (box.isEmpty()) {
      this.placeRing();
      return;
    }
    const level = this.level();
    let step = Math.max(this.edit.grid, 10);
    const lowest = this.floorView.floors[0];
    const ground = this.floorView.floor === undefined || lowest === undefined || this.floorView.floor === lowest.floor;
    // Upper floors: the grid only over the building and fainter, it lies over the walls below.
    const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 40) + (ground ? step * 4 : 0);
    while (span / step > 120) step *= 2;
    const cells = Math.ceil(span / step / 2) * 2;
    const cx = Math.round((box.min.x + box.max.x) / 2 / step) * step;
    const cz = Math.round((box.min.z + box.max.z) / 2 / step) * step;
    const grid = new THREE.GridHelper(cells * step, cells, 0x9aa3ad, 0x5d636b);
    grid.name = 'floor-grid';
    for (const m of [grid.material].flat()) {
      m.transparent = true;
      m.opacity = ground ? 0.45 : 0.22;
      m.depthWrite = false;
    }
    grid.position.set(cx, level + 0.3, cz);
    grid.renderOrder = 1;
    v.scene.add(grid);
    this.grid = grid;
    if (ground) {
      const fill = new THREE.Mesh(
        new THREE.PlaneGeometry(cells * step, cells * step).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x4d4943, roughness: 1, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
      );
      fill.name = 'floor-fill';
      fill.position.set(cx, (lowest?.level ?? level) - 0.6, cz);
      v.scene.add(fill);
      this.fill = fill;
    }
    this.placeRing();
    v.requestRender();
  }

  /** Where the screen centre meets the floor looked at (undefined — the camera looks above it). */
  private floorPoint(): THREE.Vector3 | undefined {
    this.ray.setFromCamera(new THREE.Vector2(0, 0), this.viewer.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.level());
    return this.ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? undefined;
  }

  private placeRing(): void {
    const p = this.editable ? this.floorPoint() : undefined;
    this.ring.visible = p !== undefined && !this.buildingBox().isEmpty();
    if (p) this.ring.position.set(p.x, p.y + 0.4, p.z);
    this.viewer.requestRender();
  }

  /** Near and far planes for the current distance. */
  private fitDepth(): void {
    const v = this.viewer;
    const d = v.camera.position.distanceTo(v.controls.target);
    const near = Math.max(d / 2000, 0.05);
    const far = Math.max(d * 200, 1e5);
    if (Math.abs(v.camera.near - near) / near < 0.25 && v.camera.far >= d * 50) return;
    v.camera.near = near;
    v.camera.far = far;
    v.camera.updateProjectionMatrix();
  }

  private tryFrame(): void {
    if (!this.needFrame || this.shellPending) return;
    if (this.entries.size === 0 && this.shell.length === 0) return;
    if (this.frameInterior()) this.needFrame = false;
  }

  /** Camera on the building from above at an angle, the floor looked at in the middle. */
  frameInterior(): boolean {
    const box = this.buildingBox();
    if (box.isEmpty()) return false;
    const cut = this.cutHeight();
    if (cut !== undefined) box.max.y = Math.min(box.max.y, cut);
    box.min.y = Math.max(box.min.y, this.level() - 20);
    if (box.max.y < box.min.y + 1) box.max.y = box.min.y + 1;
    const v = this.viewer;
    const c = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 20);
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(v.camera.fov / 2))) * 0.95;
    const dir = new THREE.Vector3(0.75, 1.25, 1).normalize();
    v.controls.target.copy(c);
    v.camera.position.copy(c).addScaledVector(dir, dist);
    v.controls.update();
    this.fitDepth();
    this.placeRing();
    v.requestRender();
    this.onViewChange();
    return true;
  }

  /** Layout objects: new ones are built, moved ones repositioned, missing ones removed. */
  sync(items: readonly InteriorItem[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(item.key);
      const e = this.entries.get(item.key);
      if (e && e.item.target === item.target) {
        e.item = item;
        if (!(this.gizmo.dragging && item.key === this.selectedKey)) this.placeGroup(e);
        continue;
      }
      if (e) this.drop(e);
      this.add(item);
    }
    for (const e of [...this.entries.values()]) if (!seen.has(e.item.key)) this.drop(e);
    if (this.selectedKey !== undefined && !this.entries.has(this.selectedKey)) this.select(undefined);
    else this.attachGizmo();
    if (this.hoveredKey !== undefined && !this.entries.has(this.hoveredKey)) this.setHover(undefined);
    for (const e of this.entries.values()) e.group.visible = this.isShown(e.item.key);
    this.layoutFloor();
    this.refreshBoxes();
    this.tryFrame();
  }

  /** How many object models are still loading. */
  get loading(): number {
    return this.pending;
  }

  get selected(): string | undefined {
    return this.selectedKey;
  }

  private add(item: InteriorItem): void {
    const group = new THREE.Group();
    group.userData['key'] = item.key;
    group.add(marker(item.kind));
    const e: Entry = { item, group };
    this.entries.set(item.key, e);
    this.placeGroup(e);
    this.root.add(group);
    const model = modelOfRecord(this.ctx, item.target);
    if (model.pieces.length === 0) return;
    this.pending++;
    buildModel(this.game, model)
      .then((built) => {
        if (this.disposed || this.entries.get(item.key) !== e || built.triangles === 0) {
          disposeModel(built.group);
          return;
        }
        for (const c of [...group.children]) {
          group.remove(c);
          disposeModel(c);
        }
        group.add(built.group);
        this.refreshBoxes();
      })
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
        if (this.pending === 0) this.onLoaded();
        this.viewer.requestRender();
      });
  }

  private drop(e: Entry): void {
    if (this.gizmo.object === e.group) this.gizmo.detach();
    this.root.remove(e.group);
    disposeModel(e.group);
    this.entries.delete(e.item.key);
  }

  private placeGroup(e: Entry): void {
    const [w, x, y, z] = e.item.rotation;
    e.group.position.set(...e.item.position);
    e.group.quaternion.set(x, y, z, w).normalize();
    e.group.updateMatrixWorld(true);
  }

  private selectedEntry(): Entry | undefined {
    return this.selectedKey === undefined ? undefined : this.entries.get(this.selectedKey);
  }

  select(key: string | undefined, notify = true): void {
    this.selectedKey = key !== undefined && this.entries.has(key) ? key : undefined;
    this.attachGizmo();
    this.refreshBoxes();
    if (notify) this.onSelect(this.selectedKey);
  }

  private setHover(key: string | undefined): void {
    if (key === this.hoveredKey) return;
    this.hoveredKey = key;
    this.viewer.renderer.domElement.style.cursor = key !== undefined ? 'pointer' : 'default';
    this.refreshBoxes();
  }

  private refreshBoxes(): void {
    const sel = this.selectedEntry();
    this.box(this.selectBox, sel);
    const hov = this.hoveredKey !== undefined && this.hoveredKey !== this.selectedKey ? this.entries.get(this.hoveredKey) : undefined;
    this.box(this.hoverBox, hov);
  }

  private box(helper: THREE.BoxHelper, e: Entry | undefined): void {
    helper.visible = e !== undefined;
    if (e) helper.setFromObject(e.group);
    this.viewer.requestRender();
  }

  setEdit(e: InteriorEditSettings): void {
    const regrid = e.grid !== this.edit.grid;
    this.edit = e;
    this.applyEdit();
    if (regrid) this.layoutFloor();
  }

  setEditable(on: boolean): void {
    this.editable = on;
    this.attachGizmo();
    this.placeRing();
  }

  private applyEdit(): void {
    const e = this.edit;
    const g = this.gizmo;
    g.setMode(e.mode === 'move' ? 'translate' : 'rotate');
    g.setTranslationSnap(e.grid > 0 ? e.grid : null);
    g.setRotationSnap(e.angle > 0 ? THREE.MathUtils.degToRad(e.angle) : null);
    // Rotation only around the vertical, as in the game.
    const rotate = e.mode === 'rotate';
    g.showX = !rotate;
    g.showZ = !rotate;
    g.showY = true;
    this.viewer.requestRender();
  }

  private attachGizmo(): void {
    const e = this.selectedEntry();
    if (e && this.editable) {
      if (this.gizmo.object !== e.group) this.gizmo.attach(e.group);
    } else if ((this.gizmo.object as THREE.Object3D | undefined) !== undefined) this.gizmo.detach();
    this.viewer.requestRender();
  }

  private commitDrag(e: Entry): void {
    const start = this.dragStart;
    this.dragStart = undefined;
    if (!start) return;
    const g = e.group;
    if (g.position.equals(start.pos) && g.quaternion.equals(start.quat)) return;
    const q = g.quaternion;
    const ok = this.onCommit(e.item.key, [g.position.x, g.position.y, g.position.z], [q.w, q.x, q.y, q.z]);
    if (!ok) {
      g.position.copy(start.pos);
      g.quaternion.copy(start.quat);
      g.updateMatrixWorld(true);
      this.refreshBoxes();
    }
  }

  private pick(e: { clientX: number; clientY: number }): string | undefined {
    const r = this.viewer.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(p, this.viewer.camera);
    for (const hit of this.ray.intersectObject(this.root, true)) {
      if (!shownInScene(hit.object)) continue;
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData['key'] === undefined) o = o.parent;
      const key: unknown = o?.userData['key'];
      if (typeof key === 'string') return key;
    }
    return undefined;
  }

  /** Where a new object goes: the ring (screen centre on the floor looked at), otherwise the orbit point on that floor. */
  centrePoint(): [number, number, number] {
    const p = this.floorPoint() ?? this.viewer.controls.target.clone().setY(this.level());
    return [p.x, p.y, p.z];
  }

  /** Camera to an object (from the previous direction). */
  focus(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    const box = new THREE.Box3().setFromObject(e.group);
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length(), 20);
    const v = this.viewer;
    const dir = v.camera.position.clone().sub(v.controls.target).normalize();
    v.controls.target.copy(c);
    v.camera.position.copy(c).addScaledVector(dir, r * 2.5);
    v.controls.update();
    v.requestRender();
  }

  /** Gizmo centre in canvas pixels ('' — no gizmo): for e2e. */
  gizmoProbe(): string {
    const e = this.selectedEntry();
    if (!e || (this.gizmo.object as THREE.Object3D | undefined) === undefined) return '';
    const v = e.group.position.clone().project(this.viewer.camera);
    const el = this.viewer.renderer.domElement;
    return `${Math.round(((v.x + 1) / 2) * el.clientWidth)},${Math.round(((1 - v.y) / 2) * el.clientHeight)}`;
  }

  /**
   * A shown object a click in the canvas picks: `key@x,y` in canvas pixels ('' — none). For e2e:
   * the one nearest the canvas centre whose box centre the pick ray hits.
   */
  objectProbe(): string {
    const el = this.viewer.renderer.domElement;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return '';
    let best: { d: number; text: string } | undefined;
    for (const e of this.entries.values()) {
      if (!this.isShown(e.item.key) || this.floorView.stray.has(e.item.key)) continue;
      const c = new THREE.Box3().setFromObject(e.group).getCenter(new THREE.Vector3()).project(this.viewer.camera);
      if (Math.abs(c.x) > 0.85 || Math.abs(c.y) > 0.85 || c.z > 1) continue;
      const x = ((c.x + 1) / 2) * r.width;
      const y = ((1 - c.y) / 2) * r.height;
      if (this.pick({ clientX: r.left + x, clientY: r.top + y }) !== e.item.key) continue;
      const d = Math.hypot(c.x, c.y);
      if (!best || d < best.d) best = { d, text: `${e.item.key}@${Math.round(x)},${Math.round(y)}` };
    }
    return best?.text ?? '';
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY };
    this.viewer.renderer.domElement.focus();
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.buttons !== 0) return;
    this.setHover(this.pick(e));
  };

  private readonly onLeave = (): void => {
    this.setHover(undefined);
  };

  private readonly onClick = (e: MouseEvent): void => {
    if (this.gizmoDown) {
      this.gizmoDown = false;
      return;
    }
    const d = this.down;
    if (e.button !== 0 || (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4)) return;
    this.select(this.pick(e));
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const letter = letterOf(e);
    if (letter === 'f') {
      if (this.selectedKey !== undefined) this.focus(this.selectedKey);
      else this.frameInterior();
    } else if ((letter === 'g' || letter === 'r') && this.editable) {
      this.setEdit({ ...this.edit, mode: letter === 'g' ? 'move' : 'rotate' });
      this.onEditChange(this.edit);
    } else if (e.key === 'Delete' && this.selectedKey !== undefined && this.editable && !this.gizmo.dragging) {
      this.onRemove(this.selectedKey);
    } else if (e.key === 'Escape') this.select(undefined);
    else return;
    e.preventDefault();
  };

  dispose(): void {
    this.disposed = true;
    const el = this.viewer.renderer.domElement;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerleave', this.onLeave);
    el.removeEventListener('click', this.onClick);
    el.removeEventListener('keydown', this.onKey);
    this.gizmo.detach();
    this.gizmo.dispose();
    for (const e of this.entries.values()) disposeModel(e.group);
    this.entries.clear();
    for (const o of [this.grid, this.fill, this.ring]) {
      if (!o) continue;
      o.geometry.dispose();
      for (const m of [o.material].flat()) m.dispose();
    }
    const model = this.viewer.scene.getObjectByName('__model');
    if (model) disposeModel(model);
    this.viewer.dispose();
  }
}

/** Box in place of an object without a model (item point, model not found). */
function marker(kind: InteriorKind): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(MARKER_SIZE, MARKER_SIZE, MARKER_SIZE).translate(0, MARKER_SIZE / 2, 0),
    new THREE.MeshStandardMaterial({ color: MARKER[kind], roughness: 0.7, transparent: true, opacity: 0.85 }),
  );
  m.name = 'marker';
  return m;
}

/** The object and all its parents are visible (the raycaster does not check it). */
function shownInScene(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
