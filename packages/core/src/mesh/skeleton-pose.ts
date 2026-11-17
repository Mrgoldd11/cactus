/**
 * Poses of an Ogre skeleton: sampling a clip at a time, bone world matrices and CPU skinning.
 * Follows Ogre's rules: a keyframe is relative to the bind pose (position added, rotation and scale
 * multiplied on the right), keys are interpolated linearly, rotations by the shortest path, and a
 * bone without a track stays in its bind pose. The viewer draws these poses, the tests check them.
 *
 * Matrices are 4×4 column-major (as in three.js and WebGL).
 */

import type { MeshGeometry } from './ogre-mesh.ts';
import { SKIN_SLOTS } from './ogre-mesh.ts';
import type { OgreSkeleton, SkeletonAnimation, SkeletonTrack } from './ogre-skeleton.ts';

/** Local (parent-relative) transforms of every bone. */
export interface SkeletonPose {
  /** x, y, z per bone. */
  positions: Float32Array;
  /** x, y, z, w per bone. */
  rotations: Float32Array;
  /** x, y, z per bone. */
  scales: Float32Array;
}

/** Bind pose: the transforms stored in the bones. */
export function bindPose(skel: OgreSkeleton): SkeletonPose {
  const n = skel.bones.length;
  const pose: SkeletonPose = { positions: new Float32Array(n * 3), rotations: new Float32Array(n * 4), scales: new Float32Array(n * 3) };
  skel.bones.forEach((b, i) => {
    pose.positions.set(b.position, i * 3);
    pose.rotations.set(b.rotation, i * 4);
    pose.scales.set(b.scale, i * 3);
  });
  return pose;
}

/** Pose of `anim` at `time` seconds (clamped to the clip). Without a clip — the bind pose. */
export function samplePose(skel: OgreSkeleton, anim: SkeletonAnimation | undefined, time: number, out?: SkeletonPose): SkeletonPose {
  const pose = out ?? bindPose(skel);
  if (out) {
    const bind = bindPose(skel);
    pose.positions.set(bind.positions);
    pose.rotations.set(bind.rotations);
    pose.scales.set(bind.scales);
  }
  if (!anim) return pose;
  const t = Math.min(Math.max(time, 0), anim.length);
  const dq = [0, 0, 0, 1];
  const dp = [0, 0, 0];
  const ds = [1, 1, 1];
  for (const track of anim.tracks) {
    sampleTrack(track, t, dp, dq, ds);
    const b = track.bone;
    const bone = skel.bones[b]!;
    pose.positions[b * 3] = bone.position[0] + dp[0]!;
    pose.positions[b * 3 + 1] = bone.position[1] + dp[1]!;
    pose.positions[b * 3 + 2] = bone.position[2] + dp[2]!;
    const q = quatMul(bone.rotation, dq);
    pose.rotations.set(q, b * 4);
    pose.scales[b * 3] = bone.scale[0] * ds[0]!;
    pose.scales[b * 3 + 1] = bone.scale[1] * ds[1]!;
    pose.scales[b * 3 + 2] = bone.scale[2] * ds[2]!;
  }
  return pose;
}

/** Interpolated key of a track at `t` into `p` (translation), `q` (rotation), `s` (scale). */
function sampleTrack(track: SkeletonTrack, t: number, p: number[], q: number[], s: number[]): void {
  const { times } = track;
  const n = times.length;
  // Last key at or before t (binary search).
  let lo = 0;
  let hi = n - 1;
  if (t <= times[0]!) hi = 0;
  else if (t >= times[n - 1]!) lo = hi = n - 1;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) lo = mid;
      else hi = mid;
    }
  }
  const a = hi === 0 ? 0 : lo;
  const b = hi;
  const span = times[b]! - times[a]!;
  const f = span > 0 ? (t - times[a]!) / span : 0;
  for (let c = 0; c < 3; c++) p[c] = lerp(track.translations[a * 3 + c]!, track.translations[b * 3 + c]!, f);
  for (let c = 0; c < 3; c++) s[c] = track.scales ? lerp(track.scales[a * 3 + c]!, track.scales[b * 3 + c]!, f) : 1;
  slerp(track.rotations, a * 4, b * 4, f, q);
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Shortest-path spherical interpolation of two quaternions stored in `arr`. */
function slerp(arr: Float32Array, ia: number, ib: number, f: number, out: number[]): void {
  const ax = arr[ia]!, ay = arr[ia + 1]!, az = arr[ia + 2]!, aw = arr[ia + 3]!;
  let bx = arr[ib]!, by = arr[ib + 1]!, bz = arr[ib + 2]!, bw = arr[ib + 3]!;
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let ka: number;
  let kb: number;
  if (cos > 0.9995) {
    ka = 1 - f;
    kb = f;
  } else {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    ka = Math.sin((1 - f) * angle) / sin;
    kb = Math.sin(f * angle) / sin;
  }
  const x = ax * ka + bx * kb, y = ay * ka + by * kb, z = az * ka + bz * kb, w = aw * ka + bw * kb;
  const len = Math.hypot(x, y, z, w) || 1;
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  out[3] = w / len;
}

/** a × b for quaternions x, y, z, w. */
function quatMul(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number, number] {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, aw = a[3]!;
  const bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** Translation · rotation · scale as a column-major 4×4 matrix written at `out[o]`. */
function compose(out: Float32Array, o: number, p: ArrayLike<number>, po: number, q: ArrayLike<number>, qo: number, s: ArrayLike<number>, so: number): void {
  const x = q[qo]!, y = q[qo + 1]!, z = q[qo + 2]!, w = q[qo + 3]!;
  const sx = s[so]!, sy = s[so + 1]!, sz = s[so + 2]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[o] = (1 - (yy + zz)) * sx;
  out[o + 1] = (xy + wz) * sx;
  out[o + 2] = (xz - wy) * sx;
  out[o + 3] = 0;
  out[o + 4] = (xy - wz) * sy;
  out[o + 5] = (1 - (xx + zz)) * sy;
  out[o + 6] = (yz + wx) * sy;
  out[o + 7] = 0;
  out[o + 8] = (xz + wy) * sz;
  out[o + 9] = (yz - wx) * sz;
  out[o + 10] = (1 - (xx + yy)) * sz;
  out[o + 11] = 0;
  out[o + 12] = p[po]!;
  out[o + 13] = p[po + 1]!;
  out[o + 14] = p[po + 2]!;
  out[o + 15] = 1;
}

/** out[o] = a[ao] × b[bo] (4×4 column-major); `out` may not alias the inputs at the same offset. */
function mul(out: Float32Array, o: number, a: Float32Array, ao: number, b: Float32Array, bo: number): void {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[ao + k * 4 + r]! * b[bo + c * 4 + k]!;
      out[o + c * 4 + r] = v;
    }
}

/** World (model-space) matrix of every bone for a pose: 16 floats per bone. */
export function worldMatrices(skel: OgreSkeleton, pose: SkeletonPose): Float32Array {
  const n = skel.bones.length;
  const local = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) compose(local, i * 16, pose.positions, i * 3, pose.rotations, i * 4, pose.scales, i * 3);
  const world = new Float32Array(n * 16);
  const done = new Uint8Array(n);
  const visit = (i: number): void => {
    if (done[i]) return;
    const p = skel.bones[i]!.parent;
    if (p < 0) world.set(local.subarray(i * 16, i * 16 + 16), i * 16);
    else {
      visit(p);
      mul(world, i * 16, world, p * 16, local, i * 16);
    }
    done[i] = 1;
  };
  for (let i = 0; i < n; i++) visit(i);
  return world;
}

/** Inverse of an affine 4×4 matrix at `m[o]` into `out[oo]`. */
function invertAffine(out: Float32Array, oo: number, m: Float32Array, o: number): void {
  const a = m[o]!, b = m[o + 1]!, c = m[o + 2]!, d = m[o + 4]!, e = m[o + 5]!, f = m[o + 6]!, g = m[o + 8]!, h = m[o + 9]!, i = m[o + 10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = det !== 0 ? 1 / det : 0;
  const r00 = A * k, r01 = -(b * i - c * h) * k, r02 = (b * f - c * e) * k;
  const r10 = B * k, r11 = (a * i - c * g) * k, r12 = -(a * f - c * d) * k;
  const r20 = C * k, r21 = -(a * h - b * g) * k, r22 = (a * e - b * d) * k;
  // r_ij is the inverse of the transposed 3×3 block, so the inverse itself is inv(M)[row][col] = r_col_row.
  const tx = m[o + 12]!, ty = m[o + 13]!, tz = m[o + 14]!;
  out[oo] = r00;
  out[oo + 1] = r01;
  out[oo + 2] = r02;
  out[oo + 3] = 0;
  out[oo + 4] = r10;
  out[oo + 5] = r11;
  out[oo + 6] = r12;
  out[oo + 7] = 0;
  out[oo + 8] = r20;
  out[oo + 9] = r21;
  out[oo + 10] = r22;
  out[oo + 11] = 0;
  out[oo + 12] = -(r00 * tx + r10 * ty + r20 * tz);
  out[oo + 13] = -(r01 * tx + r11 * ty + r21 * tz);
  out[oo + 14] = -(r02 * tx + r12 * ty + r22 * tz);
  out[oo + 15] = 1;
}

/** Inverse bind matrices: model space → bone space in the bind pose. */
export function inverseBindMatrices(skel: OgreSkeleton): Float32Array {
  const world = worldMatrices(skel, bindPose(skel));
  const out = new Float32Array(world.length);
  for (let i = 0; i < skel.bones.length; i++) invertAffine(out, i * 16, world, i * 16);
  return out;
}

/** Bone handle → index in `skel.bones`. */
export function boneIndexByHandle(skel: OgreSkeleton): Map<number, number> {
  return new Map(skel.bones.map((b, i) => [b.handle, i]));
}

/**
 * Bone handles used by a mesh's weights that the skeleton lacks. Such a mesh does not fit the
 * skeleton: its vertices would stick to the wrong bones or to the model root.
 */
export function missingSkinBones(geo: MeshGeometry, skel: OgreSkeleton): number[] {
  if (!geo.skin) return [];
  const index = boneIndexByHandle(skel);
  const missing = new Set<number>();
  const { bones, weights } = geo.skin;
  for (let i = 0; i < bones.length; i++) if (weights[i]! > 0 && !index.has(bones[i]!)) missing.add(bones[i]!);
  return [...missing].sort((a, b) => a - b);
}

/**
 * Vertex positions of a skinned geometry in a pose (linear blend skinning, as Ogre and three.js do).
 * Vertices without weights, or with bones the skeleton lacks, keep their position.
 */
export function skinPositions(geo: MeshGeometry, skel: OgreSkeleton, world: Float32Array, inverseBind: Float32Array): Float32Array {
  const out = Float32Array.from(geo.positions);
  const skin = geo.skin;
  if (!skin) return out;
  const index = boneIndexByHandle(skel);
  const n = skel.bones.length;
  const skinMat = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) mul(skinMat, i * 16, world, i * 16, inverseBind, i * 16);
  for (let v = 0; v < geo.vertexCount; v++) {
    const x = geo.positions[v * 3]!, y = geo.positions[v * 3 + 1]!, z = geo.positions[v * 3 + 2]!;
    let ox = 0, oy = 0, oz = 0, sum = 0;
    for (let s = 0; s < SKIN_SLOTS; s++) {
      const w = skin.weights[v * SKIN_SLOTS + s]!;
      if (w <= 0) continue;
      const bi = index.get(skin.bones[v * SKIN_SLOTS + s]!);
      if (bi === undefined) continue;
      const m = bi * 16;
      ox += w * (skinMat[m]! * x + skinMat[m + 4]! * y + skinMat[m + 8]! * z + skinMat[m + 12]!);
      oy += w * (skinMat[m + 1]! * x + skinMat[m + 5]! * y + skinMat[m + 9]! * z + skinMat[m + 13]!);
      oz += w * (skinMat[m + 2]! * x + skinMat[m + 6]! * y + skinMat[m + 10]! * z + skinMat[m + 14]!);
      sum += w;
    }
    if (sum <= 0) continue;
    out[v * 3] = ox / sum;
    out[v * 3 + 1] = oy / sum;
    out[v * 3 + 2] = oz / sum;
  }
  return out;
}

/**
 * A clip of skeleton `from` made playable on skeleton `to`: tracks are matched by bone name (as the
 * game shares clips between skeletons of one rig); tracks of bones `to` lacks are dropped and listed.
 * Keys stay relative, so they apply on top of `to`'s own bind pose.
 */
export function retargetAnimation(anim: SkeletonAnimation, from: OgreSkeleton, to: OgreSkeleton): { anim: SkeletonAnimation; missing: string[] } {
  if (from === to) return { anim, missing: [] };
  const byName = new Map(to.bones.map((b, i) => [b.name.toLowerCase(), i]));
  const tracks: SkeletonTrack[] = [];
  const missing: string[] = [];
  for (const t of anim.tracks) {
    const name = from.bones[t.bone]!.name;
    const target = byName.get(name.toLowerCase());
    if (target === undefined) missing.push(name);
    else tracks.push({ ...t, bone: target });
  }
  const out: SkeletonAnimation = { ...anim, tracks };
  return { anim: out, missing };
}

/**
 * Skin weights laid out for a GPU skeleton made of `skel.bones` plus one extra still bone at index
 * `skel.bones.length` (identity transform). Handles become bone indices; slots whose bone the skeleton
 * lacks are dropped and the rest renormalized; a vertex left without weights goes to the still bone,
 * so it keeps its position — the same result as `skinPositions`.
 */
export function skinSlots(geo: MeshGeometry, skel: OgreSkeleton): { index: Uint16Array; weight: Float32Array; still: number } {
  const n = geo.vertexCount;
  const index = new Uint16Array(n * SKIN_SLOTS);
  const weight = new Float32Array(n * SKIN_SLOTS);
  const stillBone = skel.bones.length;
  let still = 0;
  const skin = geo.skin;
  const byHandle = boneIndexByHandle(skel);
  for (let v = 0; v < n; v++) {
    const base = v * SKIN_SLOTS;
    let sum = 0;
    let used = 0;
    if (skin)
      for (let s = 0; s < SKIN_SLOTS; s++) {
        const w = skin.weights[base + s]!;
        const bi = w > 0 ? byHandle.get(skin.bones[base + s]!) : undefined;
        if (bi === undefined) continue;
        index[base + used] = bi;
        weight[base + used] = w;
        sum += w;
        used++;
      }
    if (sum <= 0) {
      index[base] = stillBone;
      weight[base] = 1;
      for (let s = 1; s < SKIN_SLOTS; s++) weight[base + s] = 0;
      still++;
      continue;
    }
    for (let s = 0; s < used; s++) weight[base + s] = weight[base + s]! / sum;
  }
  return { index, weight, still };
}

/** A clip as the viewer offers it: already on the target skeleton. */
export interface ClipEntry {
  anim: SkeletonAnimation;
  /** Skeleton file the clip came from. */
  source: string;
  /** Bones the clip animates that the target skeleton lacks (their tracks are dropped). */
  missing: string[];
}

/**
 * Clips playable on skeleton `own` (from file `ownPath`): its own clips, then those of each extra
 * skeleton in order — a later clip with the same name replaces an earlier one, as the game adds
 * RACE animation files on top of the skeleton's clips. Extra clips are retargeted by bone name.
 */
export function clipLibrary(own: OgreSkeleton, ownPath: string, extra: { skeleton: OgreSkeleton; path: string }[] = []): Map<string, ClipEntry> {
  const out = new Map<string, ClipEntry>();
  for (const a of own.animations) out.set(a.name, { anim: a, source: ownPath, missing: [] });
  for (const e of extra)
    for (const a of e.skeleton.animations) {
      const r = retargetAnimation(a, e.skeleton, own);
      out.set(a.name, { anim: r.anim, source: e.path, missing: r.missing });
    }
  return out;
}
