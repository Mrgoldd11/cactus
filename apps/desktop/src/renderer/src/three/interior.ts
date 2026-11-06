/**
 * Окно «Внутри»: модель интерьера здания (фон, мышью не выбирается) и объекты раскладки —
 * мебель, сундуки, верстаки, точки предметов. Камера — как в «Модели» (вращать, сдвигать,
 * колесо); клик — выбрать объект, гизмо — сдвиг (G) / поворот вокруг вертикали (R) с шагом
 * сетки и угла, Del — удалить, F — к выбранному, Esc — снять выбор. Координаты объектов — от
 * начала модели здания, как в файле игры.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { modelOfRecord, type InteriorKind, type ModContext } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../shared/api.ts';
import { letterOf } from '../keys.ts';
import { buildModel, disposeModel } from './build.ts';
import { ModelViewer } from './viewer.ts';

export interface InteriorEditSettings {
  mode: 'move' | 'rotate';
  /** Шаг сетки (0 — без привязки). */
  grid: number;
  /** Шаг угла в градусах (0 — без привязки). */
  angle: number;
}

export const DEFAULT_INTERIOR_EDIT: InteriorEditSettings = { mode: 'move', grid: 0, angle: 15 };

/** Объект раскладки для окна. */
export interface InteriorItem {
  key: string;
  target: string;
  kind: InteriorKind;
  position: [number, number, number];
  /** w, x, y, z — как в файле. */
  rotation: [number, number, number, number];
}

interface Entry {
  item: InteriorItem;
  group: THREE.Group;
}

/** Цвет коробки объекта без модели: точка предметов — жёлтая, прочее — серо-синее. */
const MARKER: Record<InteriorKind, number> = { furniture: 0x8fa3b8, items: 0xe0b040, other: 0x9a8fb8 };
const MARKER_SIZE = 6;

export class InteriorView {
  readonly viewer: ModelViewer;
  readonly gizmo: TransformControls;
  onSelect: (key: string | undefined) => void = () => undefined;
  /** Конец перетаскивания: записать сдвиг. false — не вышло, объект вернётся на место. */
  onCommit: (key: string, position: [number, number, number], rotation: [number, number, number, number]) => boolean = () => false;
  onRemove: (key: string) => void = () => undefined;
  onEditChange: (e: InteriorEditSettings) => void = () => undefined;
  /** Модели объектов дочитаны (для e2e и строки состояния). */
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

  constructor(host: HTMLElement, game: GameInstallInfo, ctx: ModContext) {
    this.game = game;
    this.ctx = ctx;
    this.viewer = new ModelViewer(host);
    const v = this.viewer;
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
    this.applyEdit();

    const el = v.renderer.domElement;
    el.tabIndex = 0;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('click', this.onClick);
    el.addEventListener('keydown', this.onKey);
  }

  /** Модель интерьера здания — фон. */
  async setBuilding(sid: string | undefined): Promise<void> {
    if (sid === this.backdropSid) return;
    this.backdropSid = sid;
    const old = this.viewer.scene.getObjectByName('__model');
    if (!sid) {
      this.viewer.setModel(undefined);
      if (old) disposeModel(old);
      return;
    }
    const model = modelOfRecord(this.ctx, sid, { interior: true });
    const built = model.pieces.length > 0 ? await buildModel(this.game, model).catch(() => undefined) : undefined;
    if (this.disposed || sid !== this.backdropSid) {
      if (built) disposeModel(built.group);
      return;
    }
    const group = built?.group ?? new THREE.Group();
    group.name = '__model';
    // Фон полупрозрачный: мебель за стенами видно и её можно выбрать.
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) for (const m of [o.material].flat() as THREE.MeshStandardMaterial[]) {
        m.transparent = true;
        m.opacity = 0.55;
        m.depthWrite = false;
      }
    });
    const prev = this.viewer.scene.getObjectByName('__model');
    this.viewer.setModel(group);
    if (prev) disposeModel(prev);
    if (group.children.length === 0) this.frameObjects();
  }

  /** Объекты раскладки: новые строятся, сдвинутые переставляются, пропавшие убираются. */
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
    this.refreshBoxes();
  }

  /** Сколько моделей объектов ещё читается. */
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
    // Поворот — только вокруг вертикали, как в игре.
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
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData['key'] === undefined) o = o.parent;
      const key: unknown = o?.userData['key'];
      if (typeof key === 'string') return key;
    }
    return undefined;
  }

  /** Точка под серединой экрана (модель или объект), иначе — точка, вокруг которой камера. */
  centrePoint(): [number, number, number] {
    this.ray.setFromCamera(new THREE.Vector2(0, 0), this.viewer.camera);
    const targets: THREE.Object3D[] = [this.root];
    const model = this.viewer.scene.getObjectByName('__model');
    if (model) targets.push(model);
    const hit = this.ray.intersectObjects(targets, true)[0];
    const p = hit ? hit.point : this.viewer.controls.target;
    return [p.x, p.y, p.z];
  }

  /** Камера к объекту (с прежнего направления). */
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

  /** Камера на все объекты (когда модели здания нет). */
  private frameObjects(): void {
    const box = new THREE.Box3().setFromObject(this.root);
    if (box.isEmpty()) return;
    const v = this.viewer;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length(), 50);
    v.controls.target.copy(c);
    v.camera.position.copy(c).add(new THREE.Vector3(r, r * 0.8, r));
    v.controls.update();
    v.requestRender();
  }

  /** Центр гизмо в пикселях холста ('' — гизмо нет): для e2e. */
  gizmoProbe(): string {
    const e = this.selectedEntry();
    if (!e || (this.gizmo.object as THREE.Object3D | undefined) === undefined) return '';
    const v = e.group.position.clone().project(this.viewer.camera);
    const el = this.viewer.renderer.domElement;
    return `${Math.round(((v.x + 1) / 2) * el.clientWidth)},${Math.round(((1 - v.y) / 2) * el.clientHeight)}`;
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
      else this.viewer.frame();
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
    const model = this.viewer.scene.getObjectByName('__model');
    if (model) disposeModel(model);
    this.viewer.dispose();
  }
}

/** Коробка на месте объекта без модели (точка предметов, модель не нашлась). */
function marker(kind: InteriorKind): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(MARKER_SIZE, MARKER_SIZE, MARKER_SIZE).translate(0, MARKER_SIZE / 2, 0),
    new THREE.MeshStandardMaterial({ color: MARKER[kind], roughness: 0.7, transparent: true, opacity: 0.85 }),
  );
  m.name = 'marker';
  return m;
}
