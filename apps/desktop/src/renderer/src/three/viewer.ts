/**
 * 3D preview view: the camera orbits the model (left button — rotate, middle or right
 * — pan, wheel — closer/farther), light «from the viewer», a grid on the floor. Renders only when
 * something changed, or every frame while an animation plays (`setTicker`).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type ViewSide = 'front' | 'right' | 'top';

export class ModelViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1e6);
  readonly controls: OrbitControls;
  private readonly host: HTMLElement;
  private grid: THREE.GridHelper | undefined;
  private model: THREE.Object3D | undefined;
  private readonly resize: ResizeObserver;
  private frameRequested = false;
  private wire = false;
  private readonly ray = new THREE.Raycaster();
  private ticker: ((dt: number) => void) | undefined;
  private tickFrame = 0;
  private lastTick = 0;
  private bones: THREE.SkeletonHelper | undefined;
  private showBones = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x2a2c30, 1);
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene.add(new THREE.HemisphereLight(0xfff4e6, 0x3a3630, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.4, 0.8, 1);
    this.camera.add(key);
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => { this.requestRender(); });

    this.resize = new ResizeObserver(() => { this.fit(); });
    this.resize.observe(host);
    this.fit();
  }

  private fit(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Called every frame with the seconds since the previous one, then the frame is drawn; undefined
   * stops the loop (rendering goes back to on-demand).
   */
  setTicker(fn: ((dt: number) => void) | undefined): void {
    this.ticker = fn;
    cancelAnimationFrame(this.tickFrame);
    if (!fn) return;
    this.lastTick = performance.now();
    const step = (now: number): void => {
      if (this.ticker !== fn) return;
      const dt = Math.max(0, Math.min((now - this.lastTick) / 1000, 0.25));
      this.lastTick = now;
      fn(dt);
      this.render();
      this.tickFrame = requestAnimationFrame(step);
    };
    this.tickFrame = requestAnimationFrame(step);
  }

  /** Bones of the model's skeletons drawn over it (seen through the surface). */
  setBonesVisible(on: boolean): void {
    this.showBones = on;
    this.placeBones();
    this.requestRender();
  }

  private placeBones(): void {
    if (this.bones) {
      this.scene.remove(this.bones);
      this.bones.dispose();
      this.bones = undefined;
    }
    if (!this.showBones || !this.model?.getObjectByProperty('isBone', true)) return;
    this.bones = new THREE.SkeletonHelper(this.model);
    this.scene.add(this.bones);
  }

  /** Show a model (the previous one is removed, the caller frees it). */
  setModel(obj: THREE.Object3D | undefined): void {
    if (this.model) this.scene.remove(this.model);
    this.model = obj;
    if (obj) {
      this.scene.add(obj);
      this.applyWire();
    }
    this.placeBones();
    this.placeGrid();
    this.frame('home');
  }

  private bounds(): THREE.Box3 {
    const box = new THREE.Box3();
    if (this.model) box.setFromObject(this.model);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    return box;
  }

  /** Grid under the model: step — a round number for its size. */
  private placeGrid(): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const box = this.bounds();
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 0.1) * 1.5;
    const step = Math.pow(10, Math.floor(Math.log10(span / 10)));
    const cells = Math.ceil(span / step / 2) * 2;
    this.grid = new THREE.GridHelper(cells * step, cells, 0x6a6f78, 0x43474e);
    const c = box.getCenter(new THREE.Vector3());
    this.grid.position.set(Math.round(c.x / step) * step, box.min.y, Math.round(c.z / step) * step);
    this.scene.add(this.grid);
  }

  /**
   * Camera on the whole model. Without a side — from the previous direction (F key); `home` — three-quarter
   * view; otherwise front, right or top.
   */
  frame(side?: ViewSide | 'home'): void {
    const box = this.bounds();
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    let dir = this.camera.position.clone().sub(this.controls.target);
    if (side === 'front') dir = new THREE.Vector3(0, 0, 1);
    else if (side === 'right') dir = new THREE.Vector3(1, 0, 0);
    else if (side === 'top') dir = new THREE.Vector3(0, 1, 0.0001);
    else if (side === 'home' || dir.lengthSq() < 1e-9) dir = new THREE.Vector3(1, 0.7, 1.4);
    dir.normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 0.001);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  get wireframe(): boolean {
    return this.wire;
  }

  setWireframe(on: boolean): void {
    this.wire = on;
    this.applyWire();
    this.requestRender();
  }

  private applyWire(): void {
    this.model?.traverse((o) => {
      if (o instanceof THREE.Mesh) for (const m of [o.material].flat() as THREE.MeshStandardMaterial[]) m.wireframe = this.wire;
    });
  }

  /** Model part under a screen point: `userData.source` of the hit submesh (the part record). */
  pick(clientX: number, clientY: number): string | undefined {
    if (!this.model) return undefined;
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(p, this.camera);
    for (const hit of this.ray.intersectObject(this.model, true)) {
      const src: unknown = hit.object.userData['source'];
      if (typeof src === 'string' && hit.object.visible) return src;
    }
    return undefined;
  }

  /** Highlight: selected part — blue glow, under the mouse — faint light. */
  highlight(selected: string | undefined, hover: string | undefined): void {
    this.model?.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const src: unknown = o.userData['source'];
      for (const m of [o.material].flat() as THREE.MeshStandardMaterial[]) {
        if (src === selected) {
          m.emissive.setHex(0x2f7fd0);
          m.emissiveIntensity = 0.55;
        } else if (src === hover) {
          m.emissive.setHex(0x808080);
          m.emissiveIntensity = 0.3;
        } else m.emissive.setHex(0x000000);
      }
    });
    this.requestRender();
  }

  /** Icon: `size`×`size` square, transparent background, no grid; PNG bytes. */
  renderIcon(size: number): Uint8Array {
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevAspect = this.camera.aspect;
    const prevColor = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    const prevRatio = this.renderer.getPixelRatio();
    if (this.grid) this.grid.visible = false;
    if (this.bones) this.bones.visible = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.renderer.setClearColor(0x000000, 0);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    this.render();
    const url = this.renderer.domElement.toDataURL('image/png');
    if (this.grid) this.grid.visible = true;
    if (this.bones) this.bones.visible = true;
    this.renderer.setPixelRatio(prevRatio);
    this.renderer.setClearColor(prevColor, prevAlpha);
    this.renderer.setSize(prevSize.x, prevSize.y, true);
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.render();
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  dispose(): void {
    this.setTicker(undefined);
    if (this.bones) this.bones.dispose();
    this.resize.disconnect();
    this.controls.dispose();
    this.model = undefined;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
