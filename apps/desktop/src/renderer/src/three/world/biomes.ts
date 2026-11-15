/**
 * Текстуры земли вблизи: записи BIOMES (какие текстуры у местности) и карта биомов
 * `data/newland/land/biomemap.png` (1024², цвет пикселя = поле `index` биома; столбец — x,
 * строка — z, как у карт цвета — проверено сравнением с `ground colour` биомов).
 *
 * Земля рисуется так: цвет — из карты цвета (вид сверху), а вблизи он умножается на рисунок
 * текстуры биома, делённый на её средний цвет. Так сохраняется цвет местности, а появляется
 * мелкий рисунок: песок, камни, трещины. На склонах — текстура склона, на обрывах — обрыва.
 * Вдали (`fade distance` биома) рисунок плавно исчезает.
 *
 * Не проверено: единица `tiling` — считаем «повторов на зону» (4608 единиц).
 *
 * Растительность биома: `foliage` → FOLIAGE_LAYER → `meshes` (v0 — плотность) → FOLIAGE_MESH
 * с правилами (размер, склон, высота, кучки). Мест в файлах нет — игра раскладывает сама.
 */
import * as THREE from 'three';
import { decodeText, gamePath, type ModContext } from '@kenshi-editor/core';

export const BIOME_MAP_PATH = 'data/newland/land/biomemap.png';
/** Повторы текстуры считаются на столько единиц мира (зона). */
const TILING_UNIT = 4608;

export interface Biome {
  index: number;
  name: string;
  base?: string;
  slope?: string;
  cliff?: string;
  /** Повторов на единицу мира по x и по второй оси. */
  tileBase: [number, number];
  tileSlope: [number, number];
  tileCliff: [number, number];
  /** Склон (градусы): от, до, размытие. */
  slopeRange: [number, number, number];
  /** Обрыв: от, размытие. */
  cliffFrom: [number, number];
  fade: number;
  /** Растительность и камни (FOLIAGE_MESH с правилами). */
  foliage: FoliageRule[];
}

/** Правило раскладки одной модели растительности (поля FOLIAGE_MESH). */
export interface FoliageRule {
  target: string;
  /** Плотность из ссылки слоя (v0). Единица не выяснена. */
  density: number;
  clustered: boolean;
  cluster: [number, number];
  radius: [number, number];
  scale: [number, number];
  offset: [number, number];
  /** Склон в «процентах» (100 × тангенс угла — предположение). */
  slope: [number, number];
  altitude: [number, number];
  avoidTowns: boolean;
  upright: boolean;
  slopeAlign: boolean;
}

function foliageRules(ctx: ModContext, layers: readonly { target: string }[]): FoliageRule[] {
  const out: FoliageRule[] = [];
  for (const l of layers) {
    const layer = ctx.get(l.target);
    for (const ref of layer?.refs.get('meshes') ?? []) {
      const r = ctx.get(ref.target);
      if (!r || ref.v0 <= 0) continue;
      // Ore rocks carry a building (`building type`); their real places are in the zone files.
      if ((r.refs.get('building type') ?? []).length > 0) continue;
      const f = (k: string, d: number): number => r.floats.get(k) ?? d;
      const i = (k: string, d: number): number => r.ints.get(k) ?? d;
      const b = (k: string): boolean => r.bools.get(k) === true;
      const pair = (a: number, c: number): [number, number] => [Math.min(a, c), Math.max(a, c)];
      out.push({
        target: ref.target,
        density: ref.v0,
        clustered: b('clustered'),
        cluster: pair(i('cluster num min', 1), i('cluster num max', 1)),
        radius: pair(f('cluster radius min', 100), f('cluster radius max', 400)),
        scale: pair(f('min height', 1), f('max height', 1)),
        offset: pair(f('vertical offset min', 0), f('vertical offset max', 0)),
        slope: pair(f('min slope', 0), f('max slope', 200)),
        altitude: pair(f('min altitude', -1e6), f('max altitude', 1e6)),
        avoidTowns: b('avoid towns'),
        upright: b('keep upright'),
        slopeAlign: b('slope align'),
      });
    }
  }
  return out;
}

/** Биомы по `index` (последний слой побеждает, как в игре). */
export function readBiomes(ctx: ModContext): Map<number, Biome> {
  const out = new Map<number, Biome>();
  for (const r of ctx.records()) {
    if (ctx.typeName(r.type) !== 'BIOMES') continue;
    const index = r.ints.get('index');
    if (index === undefined) continue;
    const f = (k: string, d: number): number => r.floats.get(k) ?? d;
    const file = (k: string): string | undefined => {
      const v = r.files.get(k);
      return v ? gamePath(decodeText(v)) : undefined;
    };
    const tile = (x: string, y: string, d: number): [number, number] => [f(x, d) / TILING_UNIT, f(y, d) / TILING_UNIT];
    out.set(index, {
      index,
      name: r.stringId,
      base: file('texture base'),
      slope: file('texture slope'),
      cliff: file('texture vertical'),
      tileBase: tile('tiling X 0', 'tiling Y 0', 50),
      tileSlope: tile('tiling X 1', 'tiling Y 1', 70),
      tileCliff: [f('tiling X 2', 40) / TILING_UNIT, f('tiling Y 2', 10) / TILING_UNIT],
      slopeRange: [f('slope min 1', 0), f('slope max 1', 90), Math.max(0.5, f('slope fade 1', 5))],
      cliffFrom: [f('slope min 2', 0), Math.max(0.5, f('slope fade 2', 5))],
      fade: Math.max(1500, f('fade distance', 4000)),
      foliage: foliageRules(ctx, r.refs.get('foliage') ?? []),
    });
  }
  return out;
}

export interface DetailTexture {
  tex: THREE.Texture;
  /** Средний цвет (линейный) — на него делим, чтобы не менять цвет местности. */
  avg: THREE.Vector3;
}

/** Средний линейный цвет картинки RGBA (sRGB) — по каждому 7-му пикселю. */
export function averageColour(rgba: Uint8Array): THREE.Vector3 {
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lin[i] = c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let k = 0; k < rgba.length; k += 4 * 7) {
    r += lin[rgba[k]!]!;
    g += lin[rgba[k + 1]!]!;
    b += lin[rgba[k + 2]!]!;
    n++;
  }
  const v = new THREE.Vector3(r / n, g / n, b / n);
  return v.max(new THREE.Vector3(0.02, 0.02, 0.02));
}

const VERTEX_HEAD = /* glsl */ `
varying vec3 vDetailPos;
varying vec3 vDetailNormal;
`;

const FRAGMENT_HEAD = /* glsl */ `
varying vec3 vDetailPos;
varying vec3 vDetailNormal;
uniform sampler2D tBase;
uniform sampler2D tSlope;
uniform sampler2D tCliff;
uniform vec3 avgBase;
uniform vec3 avgSlope;
uniform vec3 avgCliff;
uniform vec2 tileBase;
uniform vec2 tileSlope;
uniform vec2 tileCliff;
uniform vec3 slopeRange;
uniform vec2 cliffFrom;
uniform float fadeDist;
`;

const FRAGMENT_BODY = /* glsl */ `
#include <map_fragment>
{
  float fadeK = 1.0 - smoothstep(fadeDist * 0.5, fadeDist, length(vViewPosition));
  if (fadeK > 0.0) {
    vec3 n = normalize(vDetailNormal);
    float deg = degrees(acos(clamp(n.y, 0.0, 1.0)));
    vec3 d = texture2D(tBase, vDetailPos.xz * tileBase).rgb / avgBase;
    float ws = smoothstep(slopeRange.x - slopeRange.z, slopeRange.x + slopeRange.z, deg)
      * (1.0 - smoothstep(slopeRange.y - slopeRange.z, slopeRange.y + slopeRange.z, deg));
    if (ws > 0.0) d = mix(d, texture2D(tSlope, vDetailPos.xz * tileSlope).rgb / avgSlope, ws);
    float wc = smoothstep(cliffFrom.x - cliffFrom.y, cliffFrom.x + cliffFrom.y, deg);
    if (wc > 0.0) {
      vec2 cuv = abs(n.x) > abs(n.z) ? vDetailPos.zy : vDetailPos.xy;
      d = mix(d, texture2D(tCliff, cuv * tileCliff).rgb / avgCliff, wc);
    }
    diffuseColor.rgb *= mix(vec3(1.0), clamp(d, 0.25, 2.5), fadeK);
  }
}
`;

/** Материал земли с цветом сверху и рисунком биома вблизи. */
export function detailMaterial(colour: THREE.Texture, biome: Biome, base: DetailTexture, slope: DetailTexture, cliff: DetailTexture): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ map: colour });
  const uniforms = {
    tBase: { value: base.tex },
    tSlope: { value: slope.tex },
    tCliff: { value: cliff.tex },
    avgBase: { value: base.avg },
    avgSlope: { value: slope.avg },
    avgCliff: { value: cliff.avg },
    tileBase: { value: new THREE.Vector2(...biome.tileBase) },
    tileSlope: { value: new THREE.Vector2(...biome.tileSlope) },
    tileCliff: { value: new THREE.Vector2(...biome.tileCliff) },
    slopeRange: { value: new THREE.Vector3(...biome.slopeRange) },
    cliffFrom: { value: new THREE.Vector2(...biome.cliffFrom) },
    fadeDist: { value: biome.fade },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvDetailPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvDetailNormal = normal;',
    );
    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader.replace('#include <map_fragment>', FRAGMENT_BODY);
  };
  mat.customProgramCacheKey = () => 'kedit-terrain-detail';
  return mat;
}
