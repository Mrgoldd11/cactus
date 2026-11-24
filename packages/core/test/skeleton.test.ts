/**
 * Ogre skeletons and bone weights without the game: files are built byte by byte here, the way
 * Ogre's serializers write them, and parsed back; poses and skinning are checked on them.
 */
import { describe, expect, it } from 'vitest';
import {
  bindPose,
  clipLibrary,
  emptyRecord,
  encodeText,
  FileType,
  inverseBindMatrices,
  itemTypeId,
  ModContext,
  modelOfRecord,
  missingSkinBones,
  parseOgreMesh,
  parseOgreSkeleton,
  samplePose,
  skeletonPathFor,
  skinPositions,
  skinSlots,
  worldMatrices,
  type GameRecord,
} from '../src/index.ts';

/** Little-endian byte writer with Ogre chunks. */
class W {
  private out: number[] = [];

  u16(v: number): this {
    this.out.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }

  u32(v: number): this {
    this.out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }

  f32(...vs: number[]): this {
    for (const v of vs) {
      const b = new Uint8Array(new Float32Array([v]).buffer);
      this.out.push(...b);
    }
    return this;
  }

  u8(v: number): this {
    this.out.push(v & 0xff);
    return this;
  }

  line(s: string): this {
    for (const ch of s) this.out.push(ch.charCodeAt(0));
    this.out.push(10);
    return this;
  }

  /** Chunk header with the given length (Ogre's lengths are not always the true size). */
  chunk(id: number, length: number): this {
    return this.u16(id).u32(length);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

const SQ = Math.SQRT1_2;

interface BoneSpec {
  name: string;
  handle: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale?: [number, number, number];
}

/** Bone chunk; `trueLength` — the length includes the name (some exporters), otherwise Ogre's rule. */
function bone(w: W, b: BoneSpec, trueLength = false): void {
  const len = 6 + 2 + 28 + (b.scale ? 12 : 0) + (trueLength ? b.name.length + 1 : 0);
  w.chunk(0x2000, len).line(b.name).u16(b.handle).f32(...b.pos, ...b.rot);
  if (b.scale) w.f32(...b.scale);
}

/**
 * Two-bone arm: root at the origin, child `tip` 10 up the root's Y. Clip `bend`, 2 s: the tip turns
 * 90° about Z at t=2 (relative to its bind pose) and the root moves 5 along X; the tip's last key
 * has a scale.
 */
function armSkeleton(opts: { v180?: boolean; trueLength?: boolean } = {}): Uint8Array {
  const w = new W();
  w.u16(0x1000).line(opts.v180 === false ? '[Serializer_v1.10]' : '[Serializer_v1.80]');
  if (opts.v180 !== false) w.chunk(0x1010, 8).u16(1);
  bone(w, { name: 'root', handle: 0, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [2, 2, 2] }, opts.trueLength);
  bone(w, { name: 'tip', handle: 1, pos: [0, 5, 0], rot: [0, 0, 0, 1] }, opts.trueLength);
  w.chunk(0x3000, 10).u16(1).u16(0);
  w.chunk(0x4000, 0).line('bend').f32(2);
  if (opts.v180 !== false) w.chunk(0x4010, 0).line('base').f32(0.5);
  w.chunk(0x4100, 8).u16(1);
  w.chunk(0x4110, 38).f32(0, 0, 0, 0, 1, 0, 0, 0);
  w.chunk(0x4110, 50).f32(2, 0, 0, SQ, SQ, 0, 0, 0, 1, 1, 1);
  w.chunk(0x4100, 8).u16(0);
  w.chunk(0x4110, 38).f32(0, 0, 0, 0, 1, 0, 0, 0);
  w.chunk(0x4110, 38).f32(2, 0, 0, 0, 1, 5, 0, 0);
  w.chunk(0x5000, 0).line('other.skeleton').f32(1);
  return w.bytes();
}

/** Mesh with one submesh of its own geometry: 3 vertices, weights given as [vertex, bone, weight]. */
function skinnedMesh(assign: [number, number, number][], shared = false): Uint8Array {
  const w = new W();
  w.u16(0x1000).line('[MeshSerializer_v1.8]');
  w.chunk(0x3000, 0).u8(1);
  const geometry = (): void => {
    w.chunk(0x5000, 0).u32(3);
    w.chunk(0x5100, 0);
    w.chunk(0x5110, 0).u16(0).u16(2).u16(1).u16(0).u16(0); // source 0, FLOAT3, POSITION
    w.chunk(0x5200, 0).u16(0).u16(12);
    w.chunk(0x5210, 0).f32(0, 0, 0, 0, 10, 0, 0, 20, 0);
  };
  if (shared) geometry();
  w.chunk(0x4000, 0).line('mat').u8(shared ? 1 : 0).u32(3).u8(0).u16(0).u16(1).u16(2);
  if (!shared) geometry();
  if (!shared) for (const [v, b, wt] of assign) w.chunk(0x4100, 16).u32(v).u16(b).f32(wt);
  w.chunk(0x6000, 0).line('arm.skeleton');
  if (shared) for (const [v, b, wt] of assign) w.chunk(0x7000, 16).u32(v).u16(b).f32(wt);
  return w.bytes();
}

describe('Ogre skeleton parser', () => {
  it('reads bones, hierarchy, clip, base info and links (v1.80)', () => {
    const s = parseOgreSkeleton(armSkeleton());
    expect(s.version).toBe('[Serializer_v1.80]');
    expect(s.blendMode).toBe(1);
    expect(s.bones.map((b) => [b.name, b.handle, b.parent])).toEqual([
      ['root', 0, -1],
      ['tip', 1, 0],
    ]);
    expect(s.bones[0]!.scale).toEqual([2, 2, 2]);
    expect(s.bones[1]!.scale).toEqual([1, 1, 1]);
    expect(s.bones[1]!.position).toEqual([0, 5, 0]);
    expect(s.animations).toHaveLength(1);
    const a = s.animations[0]!;
    expect([a.name, a.length, a.base]).toEqual(['bend', 2, { name: 'base', time: 0.5 }]);
    expect(a.tracks.map((t) => t.bone)).toEqual([1, 0]);
    expect([...a.tracks[0]!.times]).toEqual([0, 2]);
    expect(a.tracks[0]!.scales).toBeDefined();
    expect(a.tracks[1]!.scales).toBeUndefined();
    expect(s.links).toEqual([{ name: 'other.skeleton', scale: 1 }]);
  });

  it('old version without blend mode, and bone lengths that include the name', () => {
    for (const opts of [{ v180: false }, { trueLength: true }, { v180: false, trueLength: true }]) {
      const s = parseOgreSkeleton(armSkeleton(opts));
      expect(s.bones[0]!.scale, JSON.stringify(opts)).toEqual([2, 2, 2]);
      expect(s.bones[1]!.scale, JSON.stringify(opts)).toEqual([1, 1, 1]);
      expect(s.animations[0]!.tracks).toHaveLength(2);
    }
  });

  it('an 11-character bone name: both length rules give the same number, the next block decides', () => {
    for (const scaled of [false, true]) {
      const w = new W();
      w.u16(0x1000).line('[Serializer_v1.10]');
      // 'abcdefghijk' plus the line end is 12 bytes: true length without scale == Ogre's length with scale.
      w.chunk(0x2000, 6 + 2 + 28 + 12).line('abcdefghijk').u16(0).f32(1, 2, 3, 0, 0, 0, 1);
      if (scaled) w.f32(3, 3, 3);
      w.chunk(0x2000, 36).line('b').u16(1).f32(0, 0, 0, 0, 0, 0, 1);
      const s = parseOgreSkeleton(w.bytes());
      expect(s.bones[0]!.scale).toEqual(scaled ? [3, 3, 3] : [1, 1, 1]);
      expect(s.bones[1]!.name).toBe('b');
    }
  });

  it('rejects other files and broken hierarchies', () => {
    expect(() => parseOgreSkeleton(new Uint8Array())).toThrow();
    expect(() => parseOgreSkeleton(new W().u16(0x1000).line('[MeshSerializer_v1.8]').bytes())).toThrow(/version/);
    const cyc = new W().u16(0x1000).line('[Serializer_v1.10]');
    bone(cyc, { name: 'a', handle: 0, pos: [0, 0, 0], rot: [0, 0, 0, 1] });
    bone(cyc, { name: 'b', handle: 1, pos: [0, 0, 0], rot: [0, 0, 0, 1] });
    cyc.chunk(0x3000, 10).u16(0).u16(1).chunk(0x3000, 10).u16(1).u16(0);
    expect(() => parseOgreSkeleton(cyc.bytes())).toThrow(/ancestor/);
    const dangling = new W().u16(0x1000).line('[Serializer_v1.10]');
    bone(dangling, { name: 'a', handle: 0, pos: [0, 0, 0], rot: [0, 0, 0, 1] });
    dangling.chunk(0x3000, 10).u16(0).u16(7);
    expect(() => parseOgreSkeleton(dangling.bytes())).toThrow(/missing/);
  });

  it('skeleton path is resolved next to the mesh', () => {
    expect(skeletonPathFor('data/animal/meshes/goat.mesh', 'goat.skeleton')).toBe('data/animal/meshes/goat.skeleton');
    expect(skeletonPathFor('goat.mesh', 'goat.skeleton')).toBe('goat.skeleton');
    expect(skeletonPathFor('data\\a\\b.mesh', 'b.skeleton')).toBe('data/a/b.skeleton');
  });
});

describe('poses and skinning', () => {
  const s = parseOgreSkeleton(armSkeleton());
  const anim = s.animations[0]!;
  const inv = inverseBindMatrices(s);
  const tipWorld = (world: Float32Array): number[] => [world[16 + 12]!, world[16 + 13]!, world[16 + 14]!];

  it('bind pose: root scale 2 doubles the tip offset', () => {
    expect(tipWorld(worldMatrices(s, bindPose(s)))).toEqual([0, 10, 0]);
  });

  it('keys are relative to the bind pose and interpolated (slerp, lerp)', () => {
    const p1 = samplePose(s, anim, 1);
    // Tip rotated 45° about Z: x, y, z, w = 0, 0, sin 22.5°, cos 22.5°.
    expect(p1.rotations[4 + 2]).toBeCloseTo(Math.sin(Math.PI / 8), 5);
    expect(p1.rotations[4 + 3]).toBeCloseTo(Math.cos(Math.PI / 8), 5);
    // Root moved half way: bind 0 + 2.5.
    expect(p1.positions[0]).toBeCloseTo(2.5, 5);
    // Past the end — clamped to the last key.
    const p3 = samplePose(s, anim, 3);
    tipWorld(worldMatrices(s, p3)).forEach((v, i) => {
      expect(v).toBeCloseTo([5, 10, 0][i]!, 5);
    });
    expect(p3.scales[4]).toBeCloseTo(1, 5);
    // Reusing an output pose resets it to the bind pose first.
    const reused = samplePose(s, undefined, 0, samplePose(s, anim, 2));
    expect([...reused.positions]).toEqual([...bindPose(s).positions]);
  });

  it('vertices follow their bones, and the bind pose changes nothing', () => {
    const mesh = parseOgreMesh(skinnedMesh([[0, 0, 1], [1, 1, 0.5], [1, 0, 0.5], [2, 1, 3]]));
    expect(mesh.skeleton).toBe('arm.skeleton');
    const geo = mesh.submeshes[0]!.geometry;
    expect(geo.skin).toBeDefined();
    expect([...geo.skin!.weights.subarray(8, 12)]).toEqual([1, 0, 0, 0]);
    expect(missingSkinBones(geo, s)).toEqual([]);
    const still = skinPositions(geo, s, worldMatrices(s, bindPose(s)), inv);
    for (let i = 0; i < 9; i++) expect(still[i]).toBeCloseTo(geo.positions[i]!, 5);
    const bent = skinPositions(geo, s, worldMatrices(s, samplePose(s, anim, 2)), inv);
    // Vertex 0 is on the root: moved by 5 along X. Vertex 2 (0, 20) is on the tip at (5, 10) turned 90°:
    // its 10 units above the tip become 10 units along −X (the root scale 2 still applies).
    expect([...bent.subarray(0, 3)].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([5, 0, 0]);
    expect([...bent.subarray(6, 9)].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([-5, 10, 0]);
  });

  it('weights: shared geometry, more than four bones, a bone the skeleton lacks', () => {
    const shared = parseOgreMesh(skinnedMesh([[0, 0, 1], [1, 1, 1]], true));
    expect(shared.submeshes[0]!.geometry.skin?.unassigned).toBe(1);
    const many = parseOgreMesh(skinnedMesh([[0, 0, 0.1], [0, 1, 0.2], [0, 2, 0.3], [0, 3, 0.4], [0, 4, 0.5], [1, 9, 1]]));
    const skin = many.submeshes[0]!.geometry.skin!;
    expect(skin.dropped).toBe(1);
    // The weakest (bone 0, 0.1) is replaced by bone 4; weights are normalized.
    expect([...skin.bones.subarray(0, 4)].sort()).toEqual([1, 2, 3, 4]);
    expect(skin.weights.subarray(0, 4).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(missingSkinBones(many.submeshes[0]!.geometry, s)).toEqual([2, 3, 4, 9]);
    expect(() => parseOgreMesh(skinnedMesh([[5, 0, 1]]))).toThrow(/vertex 5/);
  });
});

describe('GPU weights and clip libraries', () => {
  const s = parseOgreSkeleton(armSkeleton());

  it('skin slots: handles become indices, a missing bone is dropped, an empty vertex goes to the still bone', () => {
    // Vertex 0: root + bone 9 (missing) → root only; vertex 1: tip; vertex 2: only bone 9 → still bone.
    const geo = parseOgreMesh(skinnedMesh([[0, 0, 0.5], [0, 9, 0.5], [1, 1, 1], [2, 9, 1]])).submeshes[0]!.geometry;
    const { index, weight, still } = skinSlots(geo, s);
    expect(still).toBe(1);
    expect([...index.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...weight.subarray(0, 4)]).toEqual([1, 0, 0, 0]);
    expect([...index.subarray(4, 5)]).toEqual([1]);
    expect(index[8]).toBe(s.bones.length);
    expect([...weight.subarray(8, 12)]).toEqual([1, 0, 0, 0]);
  });

  it('clip library: extra skeletons override by name and are retargeted by bone name', () => {
    // The same rig with the handles swapped: clips must land on the bones with the same names.
    const w = new W();
    w.u16(0x1000).line('[Serializer_v1.80]');
    bone(w, { name: 'TIP', handle: 0, pos: [0, 5, 0], rot: [0, 0, 0, 1] });
    bone(w, { name: 'root', handle: 1, pos: [0, 0, 0], rot: [0, 0, 0, 1] });
    bone(w, { name: 'tail', handle: 2, pos: [0, -1, 0], rot: [0, 0, 0, 1] });
    w.chunk(0x3000, 10).u16(0).u16(1);
    w.chunk(0x3000, 10).u16(2).u16(1);
    w.chunk(0x4000, 0).line('bend').f32(1);
    w.chunk(0x4100, 8).u16(0);
    w.chunk(0x4110, 38).f32(0, 0, 0, 0, 1, 0, 0, 0);
    w.chunk(0x4100, 8).u16(2);
    w.chunk(0x4110, 38).f32(0, 0, 0, 0, 1, 0, 0, 0);
    w.chunk(0x4000, 0).line('wave').f32(3);
    w.chunk(0x4100, 8).u16(1);
    w.chunk(0x4110, 38).f32(0, 0, 0, 0, 1, 0, 0, 0);
    const other = parseOgreSkeleton(w.bytes());
    const lib = clipLibrary(s, 'arm.skeleton', [{ skeleton: other, path: 'extra.skeleton' }]);
    expect([...lib.keys()]).toEqual(['bend', 'wave']);
    const bend = lib.get('bend')!;
    expect(bend.source).toBe('extra.skeleton');
    expect(bend.anim.length).toBe(1);
    // TIP (index 0 there) is `tip` (index 1 here); `tail` is not in the arm.
    expect(bend.anim.tracks.map((t) => t.bone)).toEqual([1]);
    expect(bend.missing).toEqual(['tail']);
    expect(lib.get('wave')!.anim.tracks.map((t) => t.bone)).toEqual([0]);
    // Without extras — the skeleton's own clips as they are.
    expect(clipLibrary(s, 'arm.skeleton').get('bend')!.anim).toBe(s.animations[0]);
  });
});

describe('RACE model', () => {
  const RACE = itemTypeId('RACE')!;
  const ANIM = itemTypeId('ANIMATION_FILE')!;
  const rec = (type: number, sid: string, fill: (r: GameRecord) => void): GameRecord => {
    const r = emptyRecord(type, sid, encodeText(sid));
    fill(r);
    return r;
  };
  const ctx = new ModContext({
    modName: 'race.mod',
    layers: [
      {
        name: 'gamedata.base',
        file: {
          fileType: FileType.Data,
          lastId: 0,
          tail: new Uint8Array(),
          records: [
            rec(RACE, 'R', (r) => {
              r.files.set('male mesh', encodeText('.\\data\\character\\meshes\\human\\human_male.mesh'));
              r.files.set('female mesh', encodeText('.\\data\\character\\meshes\\human\\human_female.mesh'));
              r.files.set('body texture male', encodeText('.\\data\\character\\textures\\body_m.dds'));
              r.files.set('nm female', encodeText('.\\data\\character\\textures\\body_f_n.dds'));
              r.refs.set('animation files', [{ target: 'A', v0: 0, v1: 0, v2: 0 }]);
            }),
            rec(RACE, 'M', (r) => r.files.set('male mesh', encodeText('.\\data\\character\\meshes\\bone\\bone_male.mesh'))),
            rec(ANIM, 'A', (r) => {
              r.files.set('male animation', encodeText('.\\data\\anim\\extra_m.skeleton'));
              r.files.set('female animation', encodeText(''));
            }),
          ],
        },
      },
    ],
  });

  it('picks the body of the gender asked, with its texture and animation files', () => {
    const male = modelOfRecord(ctx, 'R').pieces;
    expect(male).toHaveLength(1);
    expect(male[0]).toMatchObject({
      mesh: 'data/character/meshes/human/human_male.mesh',
      field: 'male mesh',
      texture: 'data/character/textures/body_m.dds',
      animationFiles: [{ skeleton: 'data/anim/extra_m.skeleton', source: 'A' }],
    });
    const female = modelOfRecord(ctx, 'R', { female: true }).pieces[0]!;
    expect(female.mesh).toBe('data/character/meshes/human/human_female.mesh');
    expect(female.normalMap).toBe('data/character/textures/body_f_n.dds');
    expect(female.texture).toBeUndefined();
    expect(female.animationFiles).toBeUndefined();
  });

  it('a race with one body shows it for both genders', () => {
    expect(modelOfRecord(ctx, 'M', { female: true }).pieces[0]!.field).toBe('male mesh');
  });
});
