/**
 * Record model (`modelOfRecord` from the core) → three.js group: each part has its own model,
 * texture and offset. The alpha channel of Kenshi textures is gloss, not transparency, so the
 * material is opaque.
 *
 * With `rig`, a part whose `.mesh` links a skeleton becomes a three.js skinned mesh with that skeleton
 * (see `rig.ts`), so the viewer can play its clips.
 */
import * as THREE from 'three';
import { missingSkinBones, skeletonPathFor, type OgreSkeleton, type RecordModel } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../shared/api.ts';
import { loadMesh, loadSkeleton, loadTexture, meshGeometries } from './assets.ts';
import { createRig, rigRoots, type Rig } from './rig.ts';

export interface BuiltModel {
  group: THREE.Group;
  triangles: number;
  /** Files missing from the game folder or unreadable. */
  missing: string[];
  /** Skeletons of the animated parts (only with the `rig` option). */
  rigs: Rig[];
  /** Skeleton problems worth telling the user. */
  rigNotes: RigNote[];
}

export type RigNote =
  /** The file is there but is not a readable skeleton. */
  | { kind: 'unreadable'; path: string }
  /** The model is weighted to bones the skeleton lacks: those vertices stay still. */
  | { kind: 'misfit'; path: string; bones: number }
  /** Clips of an animation file animate bones the model's skeleton lacks: those bones stay still. */
  | { kind: 'partial'; path: string; clips: number; bones: string[] };

/** Skeleton, or null with a note / missing entry. */
async function skeletonOf(game: GameInstallInfo, path: string, missing: string[], notes: RigNote[]): Promise<OgreSkeleton | null> {
  try {
    const s = await loadSkeleton(game, path);
    if (!s) missing.push(path);
    return s;
  } catch {
    notes.push({ kind: 'unreadable', path });
    return null;
  }
}

const GREY = 0xb8b2a6;

export async function buildModel(game: GameInstallInfo, model: RecordModel, options: { rig?: boolean } = {}): Promise<BuiltModel> {
  const group = new THREE.Group();
  group.name = model.sid;
  const missing: string[] = [];
  let triangles = 0;
  const rigs: Rig[] = [];
  const rigNotes: RigNote[] = [];
  const parts = await Promise.all(
    model.pieces.map(async (piece) => {
      const [mesh, tex] = await Promise.all([
        loadMesh(game, piece.mesh).catch(() => null),
        piece.texture ? loadTexture(game, piece.texture) : Promise.resolve(null),
      ]);
      let skeleton: OgreSkeleton | null = null;
      const extra: { skeleton: OgreSkeleton; path: string }[] = [];
      if (options.rig && mesh?.skeleton && mesh.submeshes.some((s) => s.geometry.skin)) {
        skeleton = await skeletonOf(game, skeletonPathFor(piece.mesh, mesh.skeleton), missing, rigNotes);
        if (skeleton)
          for (const a of piece.animationFiles ?? []) {
            const s = await skeletonOf(game, a.skeleton, missing, rigNotes);
            if (s) extra.push({ skeleton: s, path: a.skeleton });
          }
      }
      return { piece, mesh, tex, skeleton, extra };
    }),
  );
  for (const { piece, mesh, tex, skeleton, extra } of parts) {
    if (!mesh) {
      missing.push(piece.mesh);
      continue;
    }
    if (piece.texture && !tex) missing.push(piece.texture);
    let map: THREE.Texture | null = tex;
    if (map && piece.tile) {
      map = map.clone();
      map.repeat.set(piece.tile[0], piece.tile[1]);
      map.needsUpdate = true;
    }
    const holder = new THREE.Group();
    holder.name = piece.source;
    if (piece.offset) holder.position.set(piece.offset[0], piece.offset[1], piece.offset[2]);
    let rig: Rig | undefined;
    if (skeleton && mesh.skeleton) {
      rig = createRig(skeletonPathFor(piece.mesh, mesh.skeleton), skeleton, extra);
      rigs.push(rig);
      holder.add(...rigRoots(rig));
      const lacking = new Set<number>();
      for (const s of mesh.submeshes) for (const h of missingSkinBones(s.geometry, skeleton)) lacking.add(h);
      if (lacking.size > 0) rigNotes.push({ kind: 'misfit', path: rig.path, bones: lacking.size });
      for (const e of extra) {
        const off = [...rig.clips.values()].filter((c) => c.source === e.path && c.missing.length > 0);
        if (off.length > 0) rigNotes.push({ kind: 'partial', path: e.path, clips: off.length, bones: [...new Set(off.flatMap((c) => c.missing))] });
      }
    }
    for (const geo of meshGeometries(mesh, skeleton ?? undefined)) {
      const colors = !map && geo.hasAttribute('color');
      const mat = new THREE.MeshStandardMaterial({
        color: map || colors ? 0xffffff : GREY,
        map,
        vertexColors: colors,
        roughness: 0.85,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
      let m: THREE.Mesh;
      if (rig && geo.userData['skinned']) {
        const sm = new THREE.SkinnedMesh(geo, mat);
        // Vertices and inverse bind matrices are both in model space: no extra bind transform.
        sm.bind(rig.three, new THREE.Matrix4());
        // The bounds are of the bind pose; a clip may leave them.
        sm.frustumCulled = false;
        m = sm;
      } else m = new THREE.Mesh(geo, mat);
      m.userData['source'] = piece.source;
      holder.add(m);
      triangles += (geo.index?.count ?? 0) / 3;
    }
    group.add(holder);
  }
  return { group, triangles, missing, rigs, rigNotes };
}

/** Free the group geometry and materials (textures are shared — in the cache, not touched). */
export function disposeModel(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
    if (o instanceof THREE.Mesh) {
      (o.geometry as THREE.BufferGeometry).dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats as THREE.Material[]) m.dispose();
    }
  });
}
