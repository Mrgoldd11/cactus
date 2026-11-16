/**
 * Record model (`modelOfRecord` from the core) → three.js group: each part has its own model,
 * texture and offset. The alpha channel of Kenshi textures is gloss, not transparency, so the
 * material is opaque.
 */
import * as THREE from 'three';
import type { RecordModel } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../shared/api.ts';
import { loadMesh, loadTexture, meshGeometries } from './assets.ts';

export interface BuiltModel {
  group: THREE.Group;
  triangles: number;
  /** Files missing from the game folder or unreadable. */
  missing: string[];
}

const GREY = 0xb8b2a6;

export async function buildModel(game: GameInstallInfo, model: RecordModel): Promise<BuiltModel> {
  const group = new THREE.Group();
  group.name = model.sid;
  const missing: string[] = [];
  let triangles = 0;
  const parts = await Promise.all(
    model.pieces.map(async (piece) => {
      const [mesh, tex] = await Promise.all([
        loadMesh(game, piece.mesh).catch(() => null),
        piece.texture ? loadTexture(game, piece.texture) : Promise.resolve(null),
      ]);
      return { piece, mesh, tex };
    }),
  );
  for (const { piece, mesh, tex } of parts) {
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
    for (const geo of meshGeometries(mesh)) {
      const colors = !map && geo.hasAttribute('color');
      const mat = new THREE.MeshStandardMaterial({
        color: map || colors ? 0xffffff : GREY,
        map,
        vertexColors: colors,
        roughness: 0.85,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.userData['source'] = piece.source;
      holder.add(m);
      triangles += (geo.index?.count ?? 0) / 3;
    }
    group.add(holder);
  }
  return { group, triangles, missing };
}

/** Free the group geometry and materials (textures are shared — in the cache, not touched). */
export function disposeModel(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      (o.geometry as THREE.BufferGeometry).dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats as THREE.Material[]) m.dispose();
    }
  });
}
