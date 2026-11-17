/**
 * Parser of binary Ogre skeletons (`.skeleton`): bones, their hierarchy and animation clips. In Kenshi
 * the clips live inside the skeletons (`male_skeleton.skeleton` holds every human animation), and an
 * ANIMATION record's `anim name` must match a clip name here. Two serializer versions occur in the
 * game: `[Serializer_v1.10]` and `[Serializer_v1.80]` (adds the blend mode block and the base
 * animation info).
 *
 * Layout: a header string, then chunks "id (uint16) + length (uint32) + data". Ogre's own bone chunk
 * length leaves out the bone name, so lengths are only used where Ogre itself uses them: to tell
 * whether a bone or a keyframe carries a scale.
 *
 * Keyframes are stored as Ogre stores them: relative to the bone's bind pose (position is added,
 * rotation and scale are multiplied on the right). `poseOf` turns them into absolute local transforms.
 *
 * The module has no disk access and no three.js: bytes in, arrays out.
 */

import type { Vec3 } from '../format/types.ts';
import { MeshFormatError } from './ogre-mesh.ts';

const HEADER = 0x1000;
const BLENDMODE = 0x1010;
const BONE = 0x2000;
const BONE_PARENT = 0x3000;
const ANIMATION = 0x4000;
const ANIMATION_BASEINFO = 0x4010;
const ANIMATION_TRACK = 0x4100;
const ANIMATION_TRACK_KEYFRAME = 0x4110;
const ANIMATION_LINK = 0x5000;

/** Chunk header size (id + length). */
const OVERHEAD = 6;
/** Bone chunk length as Ogre computes it without the scale: overhead + handle + position + rotation (no name). */
const BONE_NO_SCALE = OVERHEAD + 2 + 12 + 16;
/** Keyframe chunk length without the scale: overhead + time + rotation + translation. */
const KEY_NO_SCALE = OVERHEAD + 4 + 16 + 12;

/** Quaternion x, y, z, w (the order in a `.skeleton`). */
export type QuatXyzw = [number, number, number, number];

export interface SkeletonBone {
  /** Ogre bone handle: what `.mesh` bone assignments refer to. */
  handle: number;
  name: string;
  /** Index of the parent in `OgreSkeleton.bones`; -1 for a root. */
  parent: number;
  /** Bind pose relative to the parent. */
  position: Vec3;
  rotation: QuatXyzw;
  scale: Vec3;
}

export interface SkeletonTrack {
  /** Index in `OgreSkeleton.bones`. */
  bone: number;
  /** Key times in seconds, ascending. */
  times: Float32Array;
  /** Per key x, y, z, w; relative to the bind rotation. */
  rotations: Float32Array;
  /** Per key x, y, z; added to the bind position. */
  translations: Float32Array;
  /** Per key x, y, z; multiplies the bind scale. Absent when no key carries a scale. */
  scales?: Float32Array;
}

export interface SkeletonAnimation {
  name: string;
  /** Clip length in seconds. */
  length: number;
  tracks: SkeletonTrack[];
  /** Additive base (v1.80): the clip is a difference against this clip at this time. */
  base?: { name: string; time: number };
}

export interface OgreSkeleton {
  /** Version string from the header: `[Serializer_v1.80]`. */
  version: string;
  /** Ogre `SkeletonAnimationBlendMode`: 0 — average, 1 — cumulative. */
  blendMode: number;
  /** Bones ordered by handle. */
  bones: SkeletonBone[];
  animations: SkeletonAnimation[];
  /** Other skeletons whose clips this one borrows (`SKELETON_ANIMATION_LINK`). */
  links: { name: string; scale: number }[];
}

class Reader {
  private readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get left(): number {
    return this.bytes.length - this.pos;
  }

  need(n: number): void {
    if (n > this.left) throw new MeshFormatError({ en: `file ends early (${n} bytes needed at ${this.pos}, ${this.left} left)`, ru: `файл обрывается (нужно ${n} байт на ${this.pos}, осталось ${this.left})`, zh: `文件提前结束（在 ${this.pos} 处需要 ${n} 字节，只剩 ${this.left}）` });
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  floats(out: Float32Array | number[], at: number, n: number): void {
    this.need(n * 4);
    for (let i = 0; i < n; i++) out[at + i] = this.view.getFloat32(this.pos + i * 4, true);
    this.pos += n * 4;
  }

  vec3(): Vec3 {
    return [this.f32(), this.f32(), this.f32()];
  }

  quat(): QuatXyzw {
    return [this.f32(), this.f32(), this.f32(), this.f32()];
  }

  /** String up to `\n` (this is how Ogre writes strings). */
  line(): string {
    const end = this.bytes.indexOf(10, this.pos);
    if (end < 0) throw new MeshFormatError({ en: `unterminated string at ${this.pos}`, ru: `строка без конца на ${this.pos}`, zh: `${this.pos} 处的字符串没有结尾` });
    let s = '';
    for (let i = this.pos; i < end; i++) s += String.fromCharCode(this.bytes[i]!);
    this.pos = end + 1;
    return s;
  }

  peekChunk(): number | undefined {
    return this.left >= OVERHEAD ? this.view.getUint16(this.pos, true) : undefined;
  }

  chunk(): { id: number; length: number } {
    const id = this.u16();
    const length = this.u32();
    return { id, length };
  }
}

const TOP_CHUNKS = new Set([BLENDMODE, BONE, BONE_PARENT, ANIMATION, ANIMATION_LINK]);

/**
 * Does a bone chunk carry a scale? Ogre writes the length without the name (`BONE_NO_SCALE`, +12 with a
 * scale); some exporters write the true length (name included). If both readings fit, the block that
 * follows decides.
 */
function boneHasScale(r: Reader, length: number, nameBytes: number): boolean {
  const ogreScaled = length === BONE_NO_SCALE + 12;
  const trueScaled = length === BONE_NO_SCALE + nameBytes + 12;
  const ogrePlain = length === BONE_NO_SCALE;
  const truePlain = length === BONE_NO_SCALE + nameBytes;
  if ((ogreScaled || trueScaled) && !(ogrePlain || truePlain)) return true;
  if ((ogrePlain || truePlain) && !(ogreScaled || trueScaled)) return false;
  if (!(ogreScaled || trueScaled)) return length > BONE_NO_SCALE + nameBytes; // unknown writer: Ogre's own rule
  // Ambiguous (a name of exactly 11 characters): a scale is present if a block starts right after it.
  const at = r.pos + 28 + 12;
  const next = at + 2 <= r.bytes.length ? r.bytes[at]! | (r.bytes[at + 1]! << 8) : undefined;
  return next === undefined || TOP_CHUNKS.has(next);
}

/** Parse a `.skeleton`. Throws `MeshFormatError` if the file is not an Ogre skeleton or is corrupt. */
export function parseOgreSkeleton(bytes: Uint8Array): OgreSkeleton {
  const r = new Reader(bytes);
  const head = r.u16();
  if (head !== HEADER) throw new MeshFormatError({ en: 'this is not an Ogre skeleton (.skeleton)', ru: 'это не скелет Ogre (.skeleton)', zh: '这不是 Ogre 骨骼（.skeleton）' });
  const version = r.line();
  if (!version.startsWith('[Serializer_v')) throw new MeshFormatError({ en: `unknown version “${version}”`, ru: `неизвестная версия «${version}»`, zh: `未知版本“${version}”` });
  const skel: OgreSkeleton = { version, blendMode: 0, bones: [], animations: [], links: [] };
  const byHandle = new Map<number, SkeletonBone>();
  const parents: [number, number][] = [];
  const rawAnims: { name: string; length: number; base?: { name: string; time: number }; tracks: { handle: number; keys: RawKeys }[] }[] = [];

  for (;;) {
    const id = r.peekChunk();
    if (id === undefined) break;
    const c = r.chunk();
    if (c.id === BLENDMODE) {
      skel.blendMode = r.u16();
    } else if (c.id === BONE) {
      const start = r.pos;
      const name = r.line();
      const nameBytes = r.pos - start;
      const handle = r.u16();
      const scaled = boneHasScale(r, c.length, nameBytes);
      const position = r.vec3();
      const rotation = r.quat();
      const scale: Vec3 = scaled ? r.vec3() : [1, 1, 1];
      if (byHandle.has(handle)) throw new MeshFormatError({ en: `bone handle ${handle} occurs twice`, ru: `номер кости ${handle} встречается дважды`, zh: `骨骼句柄 ${handle} 出现了两次` });
      const bone: SkeletonBone = { handle, name, parent: -1, position, rotation, scale };
      byHandle.set(handle, bone);
    } else if (c.id === BONE_PARENT) {
      parents.push([r.u16(), r.u16()]);
    } else if (c.id === ANIMATION) {
      const name = r.line();
      const length = r.f32();
      const anim: (typeof rawAnims)[number] = { name, length, tracks: [] };
      if (r.peekChunk() === ANIMATION_BASEINFO) {
        r.chunk();
        anim.base = { name: r.line(), time: r.f32() };
      }
      while (r.peekChunk() === ANIMATION_TRACK) {
        r.chunk();
        const handle = r.u16();
        const keys = new RawKeys();
        while (r.peekChunk() === ANIMATION_TRACK_KEYFRAME) {
          const k = r.chunk();
          keys.add(r, k.length > KEY_NO_SCALE);
        }
        anim.tracks.push({ handle, keys });
      }
      rawAnims.push(anim);
    } else if (c.id === ANIMATION_LINK) {
      skel.links.push({ name: r.line(), scale: r.f32() });
    } else {
      throw new MeshFormatError({ en: `unknown skeleton block 0x${c.id.toString(16)} at ${r.pos - OVERHEAD}`, ru: `неизвестный блок скелета 0x${c.id.toString(16)} на ${r.pos - OVERHEAD}`, zh: `位置 ${r.pos - OVERHEAD} 处有未知的骨骼数据块 0x${c.id.toString(16)}` });
    }
  }

  skel.bones = [...byHandle.values()].sort((a, b) => a.handle - b.handle);
  const index = new Map(skel.bones.map((b, i) => [b.handle, i]));
  for (const [child, parent] of parents) {
    const ci = index.get(child);
    const pi = index.get(parent);
    if (ci === undefined || pi === undefined) throw new MeshFormatError({ en: `bone parent link ${child} → ${parent} names a missing bone`, ru: `связь костей ${child} → ${parent} ссылается на несуществующую кость`, zh: `骨骼父子关系 ${child} → ${parent} 指向不存在的骨骼` });
    skel.bones[ci]!.parent = pi;
  }
  // A cycle would hang every pose computation.
  for (let i = 0; i < skel.bones.length; i++) {
    let p = skel.bones[i]!.parent;
    for (let steps = 0; p >= 0; steps++) {
      if (steps > skel.bones.length) throw new MeshFormatError({ en: `bone “${skel.bones[i]!.name}” is its own ancestor`, ru: `кость «${skel.bones[i]!.name}» оказалась своим же предком`, zh: `骨骼“${skel.bones[i]!.name}”是它自己的祖先` });
      p = skel.bones[p]!.parent;
    }
  }
  for (const a of rawAnims) {
    const tracks: SkeletonTrack[] = [];
    for (const t of a.tracks) {
      const bone = index.get(t.handle);
      if (bone === undefined || t.keys.count === 0) continue;
      tracks.push(t.keys.finish(bone));
    }
    const anim: SkeletonAnimation = { name: a.name, length: a.length, tracks };
    if (a.base) anim.base = a.base;
    skel.animations.push(anim);
  }
  return skel;
}

/** Growing keyframe arrays of one track. */
class RawKeys {
  count = 0;
  private times: number[] = [];
  private rot: number[] = [];
  private pos: number[] = [];
  private scl: number[] = [];
  private anyScale = false;

  add(r: Reader, scaled: boolean): void {
    this.times.push(r.f32());
    r.floats(this.rot, this.rot.length, 4);
    r.floats(this.pos, this.pos.length, 3);
    if (scaled) {
      r.floats(this.scl, this.scl.length, 3);
      this.anyScale = true;
    } else this.scl.push(1, 1, 1);
    this.count++;
  }

  finish(bone: number): SkeletonTrack {
    const t: SkeletonTrack = {
      bone,
      times: Float32Array.from(this.times),
      rotations: Float32Array.from(this.rot),
      translations: Float32Array.from(this.pos),
    };
    if (this.anyScale) t.scales = Float32Array.from(this.scl);
    return t;
  }
}

/** Skeleton file name that a mesh links to, resolved against the mesh's folder (`data/a/b.mesh` + `b.skeleton` → `data/a/b.skeleton`). */
export function skeletonPathFor(meshPath: string, skeletonName: string): string {
  const name = skeletonName.replace(/\\/g, '/');
  if (name.includes('/')) return name.replace(/^(\.\/)+/, '');
  const slash = meshPath.replace(/\\/g, '/').lastIndexOf('/');
  return slash < 0 ? name : `${meshPath.replace(/\\/g, '/').slice(0, slash + 1)}${name}`;
}
