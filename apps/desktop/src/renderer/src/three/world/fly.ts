/**
 * Камера-полёт как в Unity / Blender:
 *  - правая или левая кнопка + движение мыши — осмотреться;
 *  - средняя кнопка — сдвиг; колесо — вперёд / назад;
 *  - WASD — полёт, Q / E — вниз / вверх, Shift — быстрее (на любой раскладке — по `letterOf`);
 *  - скорость растёт с высотой над землёй;
 *  - `flyTo` — плавный перелёт к точке (клавиша F в окне).
 * Левый клик без движения остаётся щелчком (выбор объекта) — его ловит окно.
 */
import * as THREE from 'three';
import { letterOf, isTypingIn } from '../../keys.ts';

const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

export class FlyControls {
  readonly camera: THREE.PerspectiveCamera;
  private readonly dom: HTMLElement;
  private yaw = 0;
  private pitch = -0.5;
  private readonly held = new Set<string>();
  private fast = false;
  private drag: { button: number; x: number; y: number; moved: boolean } | undefined;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; yaw0: number; yaw1: number; pitch0: number; pitch1: number; t: number; dur: number } | undefined;
  /** Высота земли под точкой (для скорости и чтобы не уйти под землю). */
  groundAt: (x: number, z: number) => number | undefined = () => undefined;
  onChange: () => void = () => undefined;
  /** Множитель скорости (настройка окна). */
  speed = 1;
  private readonly off: (() => void)[] = [];

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.dom = dom;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      el.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => { el.removeEventListener(type, fn as EventListener, opts); });
    };
    on(dom, 'contextmenu', (e) => { e.preventDefault(); });
    on(dom, 'pointerdown', (e) => {
      this.drag = { button: e.button, x: e.clientX, y: e.clientY, moved: false };
      this.flight = undefined;
      dom.focus();
    });
    on(window, 'pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) dom.setPointerCapture(e.pointerId);
      d.moved = true;
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.button === 1) this.pan(dx, dy);
      else {
        this.yaw -= dx * 0.004;
        this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * 0.004));
        this.apply();
      }
    });
    on(window, 'pointerup', () => {
      // `moved` читает окно в click — сбрасываем после него.
      setTimeout(() => (this.drag = undefined), 0);
    });
    on(
      dom,
      'wheel',
      (e) => {
        e.preventDefault();
        this.flight = undefined;
        // Шаг — доля высоты над землёй: к земле подлетаем плавно, не проскакивая её.
        const step = this.step() * 3 * (e.deltaY < 0 ? 1 : -1) * Math.min(3, Math.abs(e.deltaY) / 100);
        this.camera.position.addScaledVector(this.forward(), step);
        this.keepAboveGround();
        this.onChange();
      },
      { passive: false },
    );
    on(dom, 'keydown', (e) => {
      if (isTypingIn(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      this.fast = e.shiftKey;
      const k = letterOf(e);
      if (k && MOVE_KEYS.has(k)) {
        this.held.add(k);
        this.flight = undefined;
        e.preventDefault();
      }
    });
    on(window, 'keyup', (e) => {
      this.fast = e.shiftKey;
      const k = letterOf(e);
      if (k) this.held.delete(k);
    });
    on(window, 'blur', () => { this.held.clear(); });
    this.apply();
  }

  /** Был ли последний нажатый указатель перетаскиванием (тогда это не щелчок). */
  get dragged(): boolean {
    return this.drag?.moved ?? false;
  }

  get moving(): boolean {
    return this.held.size > 0 || this.flight !== undefined;
  }

  private forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  private apply(): void {
    const target = this.camera.position.clone().add(this.forward());
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.onChange();
  }

  /** Шаг движения: быстрее высоко над землёй. */
  private step(): number {
    const g = this.groundAt(this.camera.position.x, this.camera.position.z) ?? 0;
    const above = Math.max(5, this.camera.position.y - g);
    return Math.max(2, above * 0.05) * this.speed;
  }

  private pan(dx: number, dy: number): void {
    const s = this.step() * 0.15;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const up = new THREE.Vector3().crossVectors(right, this.forward()).normalize();
    this.camera.position.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
    this.keepAboveGround();
    this.onChange();
  }

  private keepAboveGround(): void {
    const g = this.groundAt(this.camera.position.x, this.camera.position.z);
    if (g !== undefined && this.camera.position.y < g + 15) this.camera.position.y = g + 15;
  }

  /** Поставить камеру: позиция и точка, куда смотреть. */
  set(position: THREE.Vector3, look: THREE.Vector3): void {
    this.camera.position.copy(position);
    const d = look.clone().sub(position).normalize();
    this.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    this.yaw = Math.atan2(-d.x, -d.z);
    this.flight = undefined;
    this.apply();
  }

  /** Плавно перелететь так, чтобы точка `look` была видна с расстояния `dist`. */
  flyTo(look: THREE.Vector3, dist: number): void {
    const dir = this.forward();
    if (dir.y > -0.35) dir.set(dir.x, -0.6, dir.z).normalize();
    const to = look.clone().addScaledVector(dir, -dist);
    const d = look.clone().sub(to).normalize();
    const pitch1 = Math.asin(d.y);
    let yaw1 = Math.atan2(-d.x, -d.z);
    while (yaw1 - this.yaw > Math.PI) yaw1 -= 2 * Math.PI;
    while (yaw1 - this.yaw < -Math.PI) yaw1 += 2 * Math.PI;
    const far = this.camera.position.distanceTo(to);
    this.flight = { from: this.camera.position.clone(), to, yaw0: this.yaw, yaw1, pitch0: this.pitch, pitch1, t: 0, dur: Math.min(1.6, 0.4 + far / 40000) };
    this.onChange();
  }

  /** Шаг кадра; true — камера сдвинулась. */
  update(dt: number): boolean {
    const f = this.flight;
    if (f) {
      f.t = Math.min(1, f.t + dt / f.dur);
      const k = f.t < 0.5 ? 2 * f.t * f.t : 1 - (-2 * f.t + 2) ** 2 / 2;
      this.camera.position.lerpVectors(f.from, f.to, k);
      // Дальний перелёт — с подъёмом, чтобы видеть, куда летим.
      this.camera.position.y += Math.sin(Math.PI * k) * Math.min(20000, f.from.distanceTo(f.to) * 0.25);
      this.yaw = f.yaw0 + (f.yaw1 - f.yaw0) * k;
      this.pitch = f.pitch0 + (f.pitch1 - f.pitch0) * k;
      if (f.t >= 1) this.flight = undefined;
      this.apply();
      return true;
    }
    if (this.held.size === 0) return false;
    const fwd = this.forward();
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const v = new THREE.Vector3();
    if (this.held.has('w')) v.add(fwd);
    if (this.held.has('s')) v.sub(fwd);
    if (this.held.has('d')) v.add(right);
    if (this.held.has('a')) v.sub(right);
    if (this.held.has('e')) v.y += 1;
    if (this.held.has('q')) v.y -= 1;
    if (v.lengthSq() === 0) return false;
    v.normalize().multiplyScalar(this.step() * 12 * dt * (this.fast ? 5 : 1));
    this.camera.position.add(v);
    this.keepAboveGround();
    this.apply();
    return true;
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}
