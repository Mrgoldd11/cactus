/**
 * Animated model parts: a three.js skeleton made from an Ogre skeleton, and clip playback. The pose
 * is computed by the core (`samplePose`, the same code the tests check) and copied into the bones
 * each frame; three.js only skins on the GPU. No `AnimationMixer`: Ogre keys are relative to the
 * bind pose, and the core already applies that rule.
 */
import * as THREE from 'three';
import { clipLibrary, inverseBindMatrices, samplePose, type ClipEntry, type OgreSkeleton, type SkeletonPose } from '@kenshi-editor/core';

export interface Rig {
  /** Skeleton file (game-relative). */
  path: string;
  skeleton: OgreSkeleton;
  /** Bones in core order, then the still bone (identity, for vertices without usable weights). */
  bones: THREE.Bone[];
  three: THREE.Skeleton;
  /** Playable clips by name: the skeleton's own and those of the record's animation files. */
  clips: Map<string, ClipEntry>;
  /** Reused pose buffer. */
  pose: SkeletonPose;
}

export function createRig(path: string, skeleton: OgreSkeleton, extra: { skeleton: OgreSkeleton; path: string }[] = []): Rig {
  const bones = skeleton.bones.map((b) => {
    const o = new THREE.Bone();
    o.name = b.name;
    return o;
  });
  skeleton.bones.forEach((b, i) => {
    if (b.parent >= 0) bones[b.parent]!.add(bones[i]!);
  });
  const still = new THREE.Bone();
  still.name = '__still';
  bones.push(still);
  const inv = inverseBindMatrices(skeleton);
  const inverses = skeleton.bones.map((_, i) => new THREE.Matrix4().fromArray(inv, i * 16));
  inverses.push(new THREE.Matrix4());
  const rig: Rig = {
    path,
    skeleton,
    bones,
    three: new THREE.Skeleton(bones, inverses),
    clips: clipLibrary(skeleton, path, extra),
    pose: samplePose(skeleton, undefined, 0),
  };
  applyPose(rig, undefined, 0);
  return rig;
}

/** Bones to add to the part's holder: the roots of the hierarchy and the still bone. */
export function rigRoots(rig: Rig): THREE.Bone[] {
  return rig.bones.filter((b, i) => i === rig.skeleton.bones.length || rig.skeleton.bones[i]!.parent < 0);
}

/** Put the rig in clip `clip` at `time` seconds; a clip this rig lacks (or none) — the bind pose. */
export function applyPose(rig: Rig, clip: string | undefined, time: number): void {
  const anim = clip === undefined ? undefined : rig.clips.get(clip)?.anim;
  const p = samplePose(rig.skeleton, anim, time, rig.pose);
  for (let i = 0; i < rig.skeleton.bones.length; i++) {
    const b = rig.bones[i]!;
    b.position.fromArray(p.positions, i * 3);
    b.quaternion.fromArray(p.rotations, i * 4);
    b.scale.fromArray(p.scales, i * 3);
  }
}

/** Clip names of all rigs with their longest length, sorted by name. */
export function clipList(rigs: readonly Rig[]): { name: string; length: number }[] {
  const out = new Map<string, number>();
  for (const r of rigs) for (const [name, c] of r.clips) out.set(name, Math.max(out.get(name) ?? 0, c.anim.length));
  return [...out].map(([name, length]) => ({ name, length })).sort((a, b) => a.name.localeCompare(b.name));
}
