/**
 * Loading model files from the game folder: `.mesh` → three.js geometry, `.dds` → texture.
 * Parsing is in the core (`parseOgreMesh`, `decodeDds`); here only the cache and conversion to three.js objects.
 */
import * as THREE from 'three';
import { decodeDds, parseOgreMesh, triangleIndices, type OgreMesh } from '@kenshi-editor/core';
import type { GameInstallInfo } from '../../../shared/api.ts';

/** Largest texture side in the window: more is not visible on a small model, and decoding takes longer. */
const TEXTURE_MAX = 1024;

const meshes = new Map<string, Promise<OgreMesh | null>>();
const textures = new Map<string, Promise<THREE.Texture | null>>();

function key(game: GameInstallInfo, path: string): string {
  return `${game.kenshi}|${path.toLowerCase()}`;
}

/** Model from the game folder; null — no file. Parse error — exception. */
export function loadMesh(game: GameInstallInfo, path: string): Promise<OgreMesh | null> {
  const k = key(game, path);
  let p = meshes.get(k);
  if (!p) {
    p = window.kedit.readGameAsset(game, path).then((bytes) => (bytes ? parseOgreMesh(bytes) : null));
    p.catch(() => meshes.delete(k));
    meshes.set(k, p);
  }
  return p;
}

/** Texture from the game folder; null — no file or the format cannot be read. */
export function loadTexture(game: GameInstallInfo, path: string): Promise<THREE.Texture | null> {
  const k = key(game, path);
  let p = textures.get(k);
  if (!p) {
    p = window.kedit.readGameAsset(game, path).then((bytes) => {
      if (!bytes) return null;
      try {
        const img = decodeDds(bytes, { maxSize: TEXTURE_MAX });
        const tex = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
        // DDS stores rows top to bottom, and Ogre UVs count v from the top — no flip needed.
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        return tex;
      } catch {
        return null;
      }
    });
    textures.set(k, p);
  }
  return p;
}

/** Submesh geometries (one per submesh, the record sets the material). */
export function meshGeometries(mesh: OgreMesh): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const sub of mesh.submeshes) {
    const idx = triangleIndices(sub);
    if (idx.length === 0) continue;
    const g = sub.geometry;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    if (g.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
    if (g.colors) geo.setAttribute('color', new THREE.BufferAttribute(g.colors, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    if (g.normals) geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
    else geo.computeVertexNormals();
    geo.computeBoundingBox();
    out.push(geo);
  }
  return out;
}
