/**
 * Здания и прочие объекты мира (`0-buildinglist` в зонах).
 *  - Сетка по зонам (64×64): кадр перебирает только зоны в пределах дальности.
 *  - Вдали — коробки-маркеры (одна InstancedMesh на всё), вблизи — настоящие модели:
 *    модель записи (`modelOfRecord`) грузится один раз, её части рисуются InstancedMesh-ами
 *    на все экземпляры этой записи.
 *  - Отсев по пирамиде видимости и лимиты: число моделей рядом, число загруженных моделей
 *    (лишние выгружаются), число маркеров.
 *  - Выбор: луч против коробок объектов (без треугольников — быстро и на тысячах объектов).
 *  - Растительность (`foliage.ts`) рисуется теми же моделями-экземплярами, но не выбирается.
 * Разбор `.mesh` и `.dds` — в фоновом потоке (`WorkerPool`).
 */
import * as THREE from 'three';
import { decodeText, modelOfRecord, zoneOfPath, WORLD_HALF, ZONE_COUNT, ZONE_SIZE, type BuildingPlacement, type Instance, type ModContext, type Placement, type WorldChange, type WorldEdits, type WorldIndex } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../../shared/api.ts';
import type { SubmeshArrays, WorkerPool } from './protocol.ts';
import { averageColour } from './biomes.ts';

export interface ObjectsQuality {
  /** Дальность маркеров. */
  markerDist: number;
  /** Дальность настоящих моделей. */
  modelDist: number;
  /** Сколько экземпляров рисовать моделями (ближайшие). */
  maxModels: number;
  /** Сколько разных моделей держать в памяти. */
  maxProtos: number;
  /** Сколько маркеров рисовать. */
  maxMarkers: number;
}

export interface WorldObject {
  index: number;
  p: Placement;
  /** Состояние здания, если есть. */
  b?: BuildingPlacement;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  /** Убран правкой мода: не рисуется и не выбирается. */
  gone?: boolean;
  /** Нет состояния здания: высота в мире = земля + y экземпляра, ждём рельеф. */
  needsGround?: boolean;
}

function objectKey(file: string, holder: string, key: string): string {
  return `${file.toLowerCase()}|${holder}|${key}`;
}

interface Part {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  offset: THREE.Matrix4;
  mesh?: THREE.InstancedMesh;
}

interface Proto {
  state: 'loading' | 'ready' | 'none';
  parts: Part[];
  box: THREE.Box3;
  radius: number;
  used: number;
  meshPaths: string[];
  texPaths: string[];
}

const DEFAULT_BOX = new THREE.Box3(new THREE.Vector3(-40, 0, -40), new THREE.Vector3(40, 80, 40));
const COLOR_BUILDING = new THREE.Color(0xd9b26f);
const COLOR_OTHER = new THREE.Color(0x8f9aa6);
const GREY = 0xb8b2a6;
/** Камни без своей текстуры (в игре на них ложится текстура земли). */
const STONE = 0x8a7c6c;
/** Рисунок скалы на камнях без своей текстуры: самая частая «отвесная» текстура биомов. */
const ROCK_DETAIL = 'data/newland/land/textures/CinderRidge-Rockloop_DIF.dds';
/** Повторов рисунка скалы на единицу мира (как у отвесных склонов земли, чуть мельче). */
const ROCK_TILE = 1 / 90;
/** Растительность меньше этой доли расстояния до камеры не рисуется. */
const FOLIAGE_MIN_SIZE = 0.015;

function dataTexture(rgba: Uint8Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function zoneKey(x: number, y: number): number {
  return y * ZONE_COUNT + x;
}

export class WorldObjects {
  readonly group = new THREE.Group();
  readonly list: WorldObject[] = [];
  private readonly grid = new Map<number, number[]>();
  private readonly byKey = new Map<string, WorldObject>();
  /** Высота земли (у объектов без состояния здания y экземпляра — над землёй). */
  groundAt: (x: number, z: number) => number | undefined = () => undefined;
  /** Карта цвета всей земли (X/Z мира → 0..1): ею красятся камни с типом материала TERRAIN. */
  groundMap: THREE.Texture | null = null;
  private readonly protos = new Map<string, Proto>();
  private readonly meshCache = new Map<string, Promise<SubmeshArrays[] | null>>();
  private readonly texCache = new Map<string, Promise<THREE.Texture | null>>();
  private markers: THREE.InstancedMesh;
  private markerIds: number[] = [];
  /** Объекты, нарисованные в последнем обновлении (для выбора). */
  private visible: number[] = [];
  private readonly protoInstances = new Map<string, number[]>();
  /** Растительность: модель → матрицы (задаёт `setFoliage`). */
  private foliage = new Map<string, THREE.Matrix4[]>();
  drawnFoliage = 0;
  private loading = 0;
  private tick = 0;
  quality: ObjectsQuality;
  drawnModels = 0;
  drawnMarkers = 0;
  /** Записей, у которых модели нет или она не прочиталась (рисуются коробкой). */
  failed = 0;
  onChange: () => void = () => undefined;
  private readonly game: GameInstallInfo;
  private readonly pool: WorkerPool;
  private readonly ctx: ModContext;

  constructor(game: GameInstallInfo, pool: WorkerPool, ctx: ModContext, world: WorldIndex, quality: ObjectsQuality) {
    this.game = game;
    this.pool = pool;
    this.ctx = ctx;
    this.quality = quality;
    this.group.name = 'objects';
    const byKey = new Map<string, BuildingPlacement>();
    for (const b of world.buildings()) byKey.set(`${b.file}|${b.holder}|${b.key}`, b);
    for (const p of world.placements()) {
      if (!p.zone || !p.holder.endsWith('buildinglist')) continue;
      this.add(p, byKey.get(`${p.file}|${p.holder}|${p.key}`));
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.markers = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, quality.maxMarkers));
    this.markers.count = 0;
    this.markers.frustumCulled = false;
    this.markers.name = 'markers';
    this.group.add(this.markers);
  }

  /** Добавить объект (из мира или новый — правкой мода). */
  private add(p: Placement, b: BuildingPlacement | undefined): WorldObject {
    const index = this.list.length;
    const [w, x, y, z] = p.rotation;
    // y экземпляра — над землёй; высота в мире — `world Y pos` состояния здания,
    // без него — земля + y (узнаём, когда рельеф загрузится).
    const o: WorldObject = { index, p, pos: new THREE.Vector3(p.position[0], b?.worldY ?? p.position[1], p.position[2]), quat: new THREE.Quaternion(x, y, z, w).normalize() };
    if (b) o.b = b;
    else this.lift(o);
    this.list.push(o);
    this.byKey.set(objectKey(p.file, p.holder, p.key), o);
    const zx = Math.floor(p.position[0] / ZONE_SIZE) + ZONE_COUNT / 2;
    const zy = Math.floor(p.position[2] / ZONE_SIZE) + ZONE_COUNT / 2;
    const k = zoneKey(zx, zy);
    const cell = this.grid.get(k);
    if (cell) cell.push(index);
    else this.grid.set(k, [index]);
    return o;
  }

  /**
   * Подтянуть правки мира мода (свои, отмена, повтор, правки ИИ): что сдвинуто, повёрнуто,
   * добавлено, убрано. Возвращает затронутые объекты.
   */
  sync(edits: WorldEdits, changes: readonly WorldChange[]): WorldObject[] {
    const touched = new Set<WorldObject>();
    const states = new Map<string, Set<string>>();
    for (const { path, sid } of changes) {
      const zone = zoneOfPath(path);
      if (!zone) continue;
      const rec = edits.record(path, sid);
      if (!sid.endsWith('buildinglist') || (rec && this.ctx.typeName(rec.type) !== 'INSTANCE_COLLECTION')) {
        const set = states.get(path.toLowerCase()) ?? new Set<string>();
        set.add(sid);
        states.set(path.toLowerCase(), set);
        continue;
      }
      const keys = new Set<string>();
      for (const [key, inst] of rec?.instances ?? []) {
        keys.add(key);
        const o = this.byKey.get(objectKey(path, sid, key));
        if (inst.target === '') {
          if (o && !o.gone) {
            o.gone = true;
            touched.add(o);
          }
          continue;
        }
        if (o && !o.gone && sameInstance(o.p, inst)) continue;
        touched.add(this.apply(edits, path, sid, key, inst, o, zone));
      }
      // Объекты, которых в записи больше нет (отменили «поставить», удалили свой).
      const prefix = objectKey(path, sid, '');
      for (const [k, o] of this.byKey)
        if (k.startsWith(prefix) && !keys.has(o.p.key) && !o.gone) {
          o.gone = true;
          touched.add(o);
        }
    }
    // Высота зданий — из их состояний (`world Y pos`).
    for (const [path, sids] of states)
      for (const o of this.list) {
        if (o.gone || !o.b || o.p.file.toLowerCase() !== path || !o.p.states.some((st) => sids.has(st))) continue;
        const wy = worldYOf(edits, o.p.file, o.p.states);
        if (wy !== undefined && wy !== o.pos.y) {
          o.b = { ...o.b, worldY: wy };
          o.pos.y = wy;
          touched.add(o);
        }
      }
    return [...touched];
  }

  private apply(edits: WorldEdits, path: string, holder: string, key: string, inst: Instance, o: WorldObject | undefined, zone: { x: number; y: number }): WorldObject {
    const states = inst.states.map((st) => decodeText(st)).filter((st) => st !== '');
    const p: Placement = { key, target: inst.target, position: [...inst.position], rotation: [...inst.rotation], states, holder, holderType: 'INSTANCE_COLLECTION', file: o?.p.file ?? path, layer: edits.modLayer, zone };
    const wy = worldYOf(edits, path, states);
    if (!o) return this.add(p, wy !== undefined ? { ...p, worldY: wy } : undefined);
    o.p = p;
    o.gone = false;
    if (wy !== undefined) o.b = { ...(o.b ?? {}), ...p, worldY: wy };
    else delete o.b;
    const [w, x, y, z] = p.rotation;
    o.quat.set(x, y, z, w).normalize();
    o.pos.set(p.position[0], o.b?.worldY ?? p.position[1], p.position[2]);
    if (!o.b) this.lift(o);
    else delete o.needsGround;
    return o;
  }

  /** Объект без состояния здания — на высоту земли + y экземпляра (если рельеф уже есть). */
  private lift(o: WorldObject): void {
    const g = this.groundAt(o.p.position[0], o.p.position[2]);
    if (g === undefined) o.needsGround = true;
    else {
      o.pos.y = g + o.p.position[1];
      delete o.needsGround;
    }
  }

  /** Растительность вокруг камеры (рисуется при следующем `update`). */
  setFoliage(m: Map<string, THREE.Matrix4[]>): void {
    this.foliage = m;
  }

  boxOf(o: WorldObject): THREE.Box3 {
    const proto = this.protos.get(o.p.target);
    return proto && proto.state === 'ready' ? proto.box : DEFAULT_BOX;
  }

  /** Матрица объекта в мире. */
  matrixOf(o: WorldObject, out = new THREE.Matrix4()): THREE.Matrix4 {
    return out.compose(o.pos, o.quat, new THREE.Vector3(1, 1, 1));
  }

  private proto(target: string): Proto {
    let p = this.protos.get(target);
    if (p) return p;
    p = { state: 'loading', parts: [], box: DEFAULT_BOX.clone(), radius: 60, used: this.tick, meshPaths: [], texPaths: [] };
    this.protos.set(target, p);
    const proto = p;
    this.loading++;
    void this.loadProto(target, proto)
      .catch((e: unknown) => {
        proto.state = 'none';
        console.warn('world: model', target, e);
      })
      .finally(() => {
        if (proto.state === 'none') this.failed++;
        this.loading--;
        this.onChange();
      });
    return p;
  }

  private mesh(path: string): Promise<SubmeshArrays[] | null> {
    const k = path.toLowerCase();
    let m = this.meshCache.get(k);
    if (!m) {
      m = window.kedit.readGameAsset(this.game, path).then(async (bytes) => (bytes ? (await this.pool.run<'mesh'>({ type: 'mesh', bytes }, [bytes.buffer])).submeshes : null));
      m.catch(() => this.meshCache.delete(k));
      this.meshCache.set(k, m);
    }
    return m;
  }

  private texture(path: string): Promise<THREE.Texture | null> {
    const k = path.toLowerCase();
    let t = this.texCache.get(k);
    if (!t) {
      t = (async () => {
        let bytes = await window.kedit.readGameAsset(this.game, path);
        // `…_HI.dds` бывает без файла (текстуры высокого качества не у всех) — тогда обычная.
        if (!bytes && /_HI\.dds$/i.test(path)) bytes = await window.kedit.readGameAsset(this.game, path.replace(/_HI(\.dds)$/i, '$1'));
        if (!bytes) return null;
        const r = await this.pool.run<'dds'>({ type: 'dds', bytes, maxSize: 512 }, [bytes.buffer]);
        return dataTexture(r.rgba, r.width, r.height);
      })();
      t.catch(() => this.texCache.delete(k));
      this.texCache.set(k, t);
    }
    return t;
  }

  /** Диффузная текстура с альфой из `mask` (маска вырезов листвы — альфа карты нормалей). */
  private maskedTexture(diffuse: string, mask: string): Promise<THREE.Texture | null> {
    const k = `${diffuse}|${mask}`.toLowerCase();
    let t = this.texCache.get(k);
    if (!t) {
      t = Promise.all([this.texture(diffuse), this.texture(mask).catch(() => null)]).then(([d, m]) => {
        if (!d || !m) return d;
        const di = d.image as { data: Uint8Array; width: number; height: number };
        const mi = m.image as { data: Uint8Array; width: number; height: number };
        const rgba = new Uint8Array(di.data);
        for (let y = 0; y < di.height; y++) {
          const my = Math.min(mi.height - 1, Math.floor((y * mi.height) / di.height));
          for (let x = 0; x < di.width; x++) {
            const mx = Math.min(mi.width - 1, Math.floor((x * mi.width) / di.width));
            rgba[(y * di.width + x) * 4 + 3] = mi.data[(my * mi.width + mx) * 4 + 3]!;
          }
        }
        return dataTexture(rgba, di.width, di.height);
      });
      t.catch(() => this.texCache.delete(k));
      this.texCache.set(k, t);
    }
    return t;
  }

  /** Материал камней с типом TERRAIN: цвет земли под ними (карта цвета рельефа по X/Z мира). */
  /**
   * Камни с типом материала TERRAIN без своей текстуры: цвет — карта земли по X/Z мира,
   * рисунок — скальная текстура в трёх проекциях (по нормали), поделённая на её средний цвет,
   * чтобы не менять цвет земли.
   */
  private terrainMaterial(rock: THREE.Texture | null): THREE.Material {
    const map = this.groundMap;
    const mat = new THREE.MeshLambertMaterial({ color: map ? 0xffffff : STONE, map, side: THREE.DoubleSide });
    if (!map) return mat;
    const data = rock ? (rock.image as { data?: Uint8Array }).data : undefined;
    const avg = data ? averageColour(data) : null;
    const detail = rock !== null && avg !== null;
    mat.customProgramCacheKey = () => (detail ? 'kedit-terrain-mapped-rock' : 'kedit-terrain-mapped');
    mat.onBeforeCompile = (shader) => {
      const head = detail ? 'varying vec3 kRockP;\nvarying vec3 kRockN;\n' : '';
      shader.vertexShader = head + shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        [
          '#include <worldpos_vertex>',
          '#ifdef USE_INSTANCING',
          'mat4 kModel = modelMatrix * instanceMatrix;',
          '#else',
          'mat4 kModel = modelMatrix;',
          '#endif',
          'vec4 kWorld = kModel * vec4( transformed, 1.0 );',
          `vMapUv = ( kWorld.xz + ${WORLD_HALF.toFixed(1)} ) / ${(2 * WORLD_HALF).toFixed(1)};`,
          detail ? 'kRockP = kWorld.xyz;\nkRockN = mat3( kModel ) * objectNormal;' : '',
        ].join('\n'),
      );
      if (!detail) return;
      shader.uniforms.tRock = { value: rock };
      shader.uniforms.rockAvg = { value: avg };
      shader.fragmentShader = head + 'uniform sampler2D tRock;\nuniform vec3 rockAvg;\n' +shader.fragmentShader.replace(
        '#include <map_fragment>',
        [
          '#include <map_fragment>',
          '{',
          '  vec3 kw = pow( abs( normalize( kRockN ) ), vec3( 4.0 ) );',
          '  kw /= kw.x + kw.y + kw.z + 1e-5;',
          `  vec3 kp = kRockP * ${ROCK_TILE.toFixed(6)};`,
          '  vec3 kd = texture2D( tRock, kp.zy ).rgb * kw.x + texture2D( tRock, kp.xz ).rgb * kw.y + texture2D( tRock, kp.xy ).rgb * kw.z;',
          '  diffuseColor.rgb *= clamp( kd / rockAvg, 0.25, 2.5 );',
          '}',
        ].join('\n'),
      );
    };
    return mat;
  }

  private async loadProto(target: string, proto: Proto): Promise<void> {
    const model = modelOfRecord(this.ctx, target, { interior: false });
    if (model.pieces.length === 0) {
      proto.state = 'none';
      return;
    }
    const box = new THREE.Box3();
    for (const piece of model.pieces) {
      const tex = !piece.texture ? Promise.resolve(null) : piece.alphaMap ? this.maskedTexture(piece.texture, piece.alphaMap) : this.texture(piece.texture);
      const [subs, loaded] = await Promise.all([this.mesh(piece.mesh).catch(() => null), tex.catch(() => null)]);
      if (!subs) continue;
      const rock = piece.terrain ? await this.texture(ROCK_DETAIL).catch(() => null) : null;
      if (rock) proto.texPaths.push(ROCK_DETAIL.toLowerCase());
      proto.meshPaths.push(piece.mesh.toLowerCase());
      if (piece.texture) proto.texPaths.push(piece.texture.toLowerCase());
      if (piece.texture && piece.alphaMap) proto.texPaths.push(piece.alphaMap.toLowerCase(), `${piece.texture}|${piece.alphaMap}`.toLowerCase());
      let map = loaded;
      const alphaTest = piece.alphaTest !== undefined && map ? Math.max(0.05, piece.alphaTest / 255) : 0;
      if (map && piece.tile) {
        map = map.clone();
        map.repeat.set(piece.tile[0], piece.tile[1]);
        map.needsUpdate = true;
      }
      const offset = new THREE.Matrix4();
      if (piece.offset) offset.makeTranslation(piece.offset[0], piece.offset[1], piece.offset[2]);
      for (const s of subs) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
        if (s.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(s.uvs, 2));
        if (s.colors) geo.setAttribute('color', new THREE.BufferAttribute(s.colors, 4));
        geo.setIndex(new THREE.BufferAttribute(s.index, 1));
        if (s.normals) geo.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
        else geo.computeVertexNormals();
        geo.computeBoundingBox();
        box.union(geo.boundingBox!.clone().applyMatrix4(offset));
        if (piece.terrain) {
          proto.parts.push({ geo, mat: this.terrainMaterial(rock), offset });
          continue;
        }
        const colors = !map && s.colors !== undefined;
        const mat = new THREE.MeshLambertMaterial({ color: map || colors ? 0xffffff : model.type === 'FOLIAGE_MESH' ? STONE : GREY, map, vertexColors: colors, side: THREE.DoubleSide, alphaTest });
        proto.parts.push({ geo, mat, offset });
      }
    }
    if (proto.parts.length === 0) {
      proto.state = 'none';
      return;
    }
    proto.box = box;
    proto.radius = box.getBoundingSphere(new THREE.Sphere()).radius + box.getCenter(new THREE.Vector3()).length();
    proto.state = 'ready';
  }

  get busy(): number {
    return this.loading;
  }

  get protoCount(): number {
    return [...this.protos.values()].filter((p) => p.state === 'ready').length;
  }

  /** Пересобрать, что рисуется: дёшево, вызывать при движении камеры (не чаще ~6 раз в секунду). */
  update(camera: THREE.Camera): void {
    this.tick++;
    const q = this.quality;
    const cam = camera.position;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const sphere = new THREE.Sphere();
    const z0x = Math.max(0, Math.floor((cam.x - q.markerDist) / ZONE_SIZE) + ZONE_COUNT / 2);
    const z1x = Math.min(ZONE_COUNT - 1, Math.floor((cam.x + q.markerDist) / ZONE_SIZE) + ZONE_COUNT / 2);
    const z0y = Math.max(0, Math.floor((cam.z - q.markerDist) / ZONE_SIZE) + ZONE_COUNT / 2);
    const z1y = Math.min(ZONE_COUNT - 1, Math.floor((cam.z + q.markerDist) / ZONE_SIZE) + ZONE_COUNT / 2);
    const near: { i: number; d: number }[] = [];
    for (let zy = z0y; zy <= z1y; zy++)
      for (let zx = z0x; zx <= z1x; zx++)
        for (const i of this.grid.get(zoneKey(zx, zy)) ?? []) {
          const o = this.list[i]!;
          if (o.gone) continue;
          if (o.needsGround) this.lift(o);
          const d = o.pos.distanceTo(cam);
          if (d > q.markerDist) continue;
          const proto = this.protos.get(o.p.target);
          sphere.set(o.pos, proto?.state === 'ready' ? proto.radius : 120);
          if (!frustum.intersectsSphere(sphere)) continue;
          near.push({ i, d });
        }
    near.sort((a, b) => a.d - b.d);

    // Ближайшие — моделями (если модель есть и загружена), остальные — маркерами.
    const perProto = new Map<string, number[]>();
    const markers: number[] = [];
    let models = 0;
    const want: string[] = [];
    for (const { i, d } of near) {
      const o = this.list[i]!;
      if (d < q.modelDist && models < q.maxModels) {
        const proto = this.protos.get(o.p.target) ?? (want.length < 8 && this.loading < 8 ? (want.push(o.p.target), this.proto(o.p.target)) : undefined);
        if (proto) proto.used = this.tick;
        if (proto?.state === 'ready') {
          const l = perProto.get(o.p.target);
          if (l) l.push(i);
          else perProto.set(o.p.target, [i]);
          models++;
          continue;
        }
      }
      if (markers.length < q.maxMarkers) markers.push(i);
    }

    // Растительность: модели грузятся тем же порядком, экземпляры — отсев по пирамиде.
    const foliage = new Map<string, THREE.Matrix4[]>();
    let drawnFoliage = 0;
    const at = new THREE.Vector3();
    for (const [target, list] of this.foliage) {
      const proto = this.protos.get(target) ?? (want.length < 8 && this.loading < 8 ? (want.push(target), this.proto(target)) : undefined);
      if (!proto) continue;
      proto.used = this.tick;
      if (proto.state !== 'ready') continue;
      const shown: THREE.Matrix4[] = [];
      for (const mat of list) {
        at.setFromMatrixPosition(mat);
        sphere.set(at, proto.radius * mat.getMaxScaleOnAxis());
        // Мелкое вдали не рисуем: на экране оно меньше пары точек, а треугольников много.
        if (sphere.radius < at.distanceTo(cam) * FOLIAGE_MIN_SIZE) continue;
        if (frustum.intersectsSphere(sphere)) shown.push(mat);
      }
      if (shown.length) foliage.set(target, shown);
      drawnFoliage += shown.length;
    }
    this.drawnFoliage = drawnFoliage;

    // Маркеры.
    if (this.markers.instanceMatrix.count < markers.length) this.resizeMarkers(markers.length);
    const m = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    markers.forEach((i, k) => {
      const o = this.list[i]!;
      const box = this.boxOf(o);
      box.getSize(size);
      box.getCenter(centre);
      local.compose(centre, new THREE.Quaternion(), size.max(new THREE.Vector3(10, 10, 10)));
      this.markers.setMatrixAt(k, this.matrixOf(o, m).multiply(local));
      this.markers.setColorAt(k, o.b ? COLOR_BUILDING : COLOR_OTHER);
    });
    this.markers.count = markers.length;
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
    this.markerIds = markers;

    // Модели.
    for (const [target, proto] of this.protos) {
      const ids = perProto.get(target) ?? [];
      const extra = foliage.get(target) ?? [];
      const total = ids.length + extra.length;
      for (const part of proto.parts) {
        if (total === 0) {
          if (part.mesh) part.mesh.visible = false;
          continue;
        }
        if (!part.mesh || part.mesh.instanceMatrix.count < total) {
          if (part.mesh) {
            this.group.remove(part.mesh);
            part.mesh.dispose();
          }
          const cap = 2 ** Math.ceil(Math.log2(Math.max(4, total)));
          part.mesh = new THREE.InstancedMesh(part.geo, part.mat, cap);
          part.mesh.frustumCulled = false;
          this.group.add(part.mesh);
        }
        ids.forEach((i, k) => part.mesh!.setMatrixAt(k, this.matrixOf(this.list[i]!, m).multiply(part.offset)));
        extra.forEach((f, k) => part.mesh!.setMatrixAt(ids.length + k, m.multiplyMatrices(f, part.offset)));
        part.mesh.count = total;
        part.mesh.visible = true;
        part.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.protoInstances.clear();
    for (const [k, v] of perProto) this.protoInstances.set(k, v);
    this.visible = [...markers, ...[...perProto.values()].flat()];
    this.drawnModels = models;
    this.drawnMarkers = markers.length;
    this.trimProtos();
  }

  private resizeMarkers(n: number): void {
    const cap = 2 ** Math.ceil(Math.log2(n));
    const old = this.markers;
    const next = new THREE.InstancedMesh(old.geometry, old.material, cap);
    next.frustumCulled = false;
    next.name = 'markers';
    this.group.remove(old);
    old.dispose();
    this.group.add(next);
    this.markers = next;
  }

  /** Выгрузить давно не нужные модели сверх лимита (и их файлы из кэша). */
  private trimProtos(): void {
    const ready = [...this.protos.entries()].filter(([, p]) => p.state !== 'loading');
    if (ready.length <= this.quality.maxProtos) return;
    ready.sort((a, b) => a[1].used - b[1].used);
    for (const [target, p] of ready.slice(0, ready.length - this.quality.maxProtos)) {
      if (p.used === this.tick) continue;
      for (const part of p.parts) {
        if (part.mesh) {
          this.group.remove(part.mesh);
          part.mesh.dispose();
        }
        part.geo.dispose();
        part.mat.dispose();
      }
      this.protos.delete(target);
    }
    const meshes = new Set<string>();
    const texs = new Set<string>();
    for (const p of this.protos.values()) {
      for (const m of p.meshPaths) meshes.add(m);
      for (const t of p.texPaths) texs.add(t);
    }
    for (const k of [...this.meshCache.keys()]) if (!meshes.has(k)) this.meshCache.delete(k);
    for (const [k, t] of [...this.texCache]) {
      if (texs.has(k)) continue;
      this.texCache.delete(k);
      void t.then((tex) => tex?.dispose());
    }
  }

  /** Объект под лучом (ближайший по коробке) среди нарисованных. */
  pick(ray: THREE.Ray): WorldObject | undefined {
    let best: WorldObject | undefined;
    let bestD = Infinity;
    const sphere = new THREE.Sphere();
    const inv = new THREE.Matrix4();
    const local = new THREE.Ray();
    const hit = new THREE.Vector3();
    for (const i of this.visible) {
      const o = this.list[i]!;
      const box = this.boxOf(o);
      const proto = this.protos.get(o.p.target);
      sphere.set(o.pos, proto?.state === 'ready' ? proto.radius : 120);
      if (!ray.intersectsSphere(sphere)) continue;
      this.matrixOf(o, inv).invert();
      local.copy(ray).applyMatrix4(inv);
      if (!local.intersectBox(box, hit)) continue;
      const d = hit.length() === 0 ? 0 : local.origin.distanceTo(hit);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  /** Объект по ключу экземпляра (файл + владелец + ключ). */
  find(file: string, holder: string, key: string): WorldObject | undefined {
    const o = this.byKey.get(objectKey(file, holder, key));
    return o && !o.gone ? o : undefined;
  }

  get markerCount(): number {
    return this.markerIds.length;
  }

  dispose(): void {
    for (const p of this.protos.values())
      for (const part of p.parts) {
        part.mesh?.dispose();
        part.geo.dispose();
        part.mat.dispose();
      }
    this.protos.clear();
    for (const t of this.texCache.values()) void t.then((tex) => tex?.dispose());
    this.texCache.clear();
    this.meshCache.clear();
    this.markers.geometry.dispose();
    (this.markers.material as THREE.Material).dispose();
    this.markers.dispose();
  }
}

function sameInstance(p: Placement, inst: Instance): boolean {
  return p.target === inst.target && p.position.every((v, i) => v === inst.position[i]) && p.rotation.every((v, i) => v === inst.rotation[i]);
}

function worldYOf(edits: WorldEdits, path: string, states: readonly string[]): number | undefined {
  for (const st of states) {
    const wy = edits.record(path, st)?.floats.get('world Y pos');
    if (wy !== undefined) return wy;
  }
  return undefined;
}
