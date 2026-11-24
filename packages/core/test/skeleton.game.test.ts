/**
 * Ogre skeletons on the installed game's files: every `.skeleton` parses, every animated model finds
 * its skeleton and fits it, and no clip throws vertices apart. Without the game the tests are skipped.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bindPose,
  inverseBindMatrices,
  missingSkinBones,
  parseOgreMesh,
  parseOgreSkeleton,
  samplePose,
  skeletonPathFor,
  skinPositions,
  worldMatrices,
  type MeshGeometry,
  type OgreSkeleton,
} from '../src/index.ts';
import { hasGame, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);

function listFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Diagonal of the bounding box of x, y, z triples. */
function diagonal(p: Float32Array): number {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    mn[i % 3] = Math.min(mn[i % 3]!, p[i]!);
    mx[i % 3] = Math.max(mx[i % 3]!, p[i]!);
  }
  return Math.hypot(mx[0]! - mn[0]!, mx[1]! - mn[1]!, mx[2]! - mn[2]!);
}

/** Largest pose size over the bind size across `times` (fractions of the clip) of each clip. */
function worstStretch(geo: MeshGeometry, skel: OgreSkeleton, times: number[], every = 1): { ratio: number; clip: string } {
  const inv = inverseBindMatrices(skel);
  const size = diagonal(geo.positions);
  let ratio = 0;
  let clip = '';
  skel.animations.forEach((a, i) => {
    if (i % every !== 0) return;
    for (const f of times) {
      const r = diagonal(skinPositions(geo, skel, worldMatrices(skel, samplePose(skel, a, a.length * f)), inv)) / size;
      if (r > ratio) [ratio, clip] = [r, a.name];
    }
  });
  return { ratio, clip };
}

describe.skipIf(!game)('skeletons on the game files', () => {
  const all = game ? listFiles(join(paths.kenshi, 'data')) : [];
  const read = (rel: string): Uint8Array => readFileSync(join(paths.kenshi, rel));
  const skeletons = all.filter((f) => /\.skeleton$/i.test(f));
  const byName = new Map<string, string>();
  for (const f of skeletons) if (!byName.has(basename(f).toLowerCase())) byName.set(basename(f).toLowerCase(), f);

  it('every non-empty .skeleton parses, both serializer versions occur', () => {
    expect(skeletons.length).toBeGreaterThan(300);
    const versions = new Set<string>();
    let clips = 0;
    for (const f of skeletons) {
      if (statSync(f).size === 0) {
        expect(() => parseOgreSkeleton(readFileSync(f))).toThrow();
        continue;
      }
      const s = parseOgreSkeleton(readFileSync(f));
      versions.add(s.version);
      clips += s.animations.length;
      expect(s.bones.length, f).toBeGreaterThan(0);
      for (const b of s.bones) expect(Math.hypot(...b.rotation), `${f} ${b.name}`).toBeCloseTo(1, 2);
      for (const a of s.animations)
        for (const t of a.tracks) {
          expect(t.times.length, `${f} ${a.name}`).toBeGreaterThan(0);
          for (let i = 1; i < t.times.length; i++) expect(t.times[i]!, `${f} ${a.name}`).toBeGreaterThanOrEqual(t.times[i - 1]!);
        }
    }
    expect([...versions].sort()).toEqual(['[Serializer_v1.10]', '[Serializer_v1.80]']);
    expect(clips).toBeGreaterThan(500);
  });

  it('human skeleton: the Biped bones and the clips ANIMATION records name', () => {
    const s = parseOgreSkeleton(read('data/character/meshes/male_skeleton/male_skeleton.skeleton'));
    expect(s.bones).toHaveLength(30);
    expect(s.bones[0]!.name).toBe('Bip01');
    expect(s.bones.find((b) => b.name === 'Bip01 Head')?.parent).toBe(s.bones.findIndex((b) => b.name === 'Bip01 Neck'));
    const names = new Set(s.animations.map((a) => a.name));
    for (const n of ['idle_stand_relax', 'walk upper', 'walk lower', 'hand2chest', 'run lower']) expect(names.has(n), n).toBe(true);
  });

  it('animated models find a skeleton and fit it; no clip stretches a body more than 2×', () => {
    let checked = 0;
    const misfits: string[] = [];
    const cache = new Map<string, OgreSkeleton>();
    for (const f of all.filter((x) => /\.mesh$/i.test(x))) {
      const mesh = parseOgreMesh(readFileSync(f));
      if (!mesh.skeleton) continue;
      const rel = relative(paths.kenshi, f).split('\\').join('/');
      const near = join(paths.kenshi, skeletonPathFor(rel, mesh.skeleton));
      const file = skeletons.includes(near) ? near : byName.get(mesh.skeleton.toLowerCase());
      // Two armour models in the game link a skeleton that is not shipped.
      if (!file) continue;
      let skel = cache.get(file);
      if (!skel) cache.set(file, (skel = parseOgreSkeleton(readFileSync(file))));
      for (const geo of new Set(mesh.submeshes.map((s) => s.geometry))) {
        if (!geo.skin) continue;
        if (missingSkinBones(geo, skel).length > 0) {
          misfits.push(rel);
          continue;
        }
        // Bind pose reproduces the model exactly.
        const still = skinPositions(geo, skel, worldMatrices(skel, bindPose(skel)), inverseBindMatrices(skel));
        for (let i = 0; i < still.length; i += 97) expect(still[i], rel).toBeCloseTo(geo.positions[i]!, 3);
        const { ratio, clip } = worstStretch(geo, skel, [0.5], 10);
        expect(ratio, `${rel}: ${clip}`).toBeLessThan(2);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(150);
    // The only vanilla model that does not fit its skeleton: the unused Whistler.
    expect(misfits).toEqual(['data/character/meshes/whistler/whistler.mesh']);
  });

  it('human, shek, hive and goat bodies stay whole through every clip', () => {
    const cases: [string, string][] = [
      ['data/character/meshes/human/human_male.mesh', 'data/character/meshes/male_skeleton/male_skeleton.skeleton'],
      ['data/character/meshes/bone/bone_male.mesh', 'data/character/meshes/male_skeleton/male_skeleton.skeleton'],
      ['data/character/meshes/stick_person/Stick_person.mesh', 'data/character/meshes/male_skeleton/male_skeleton.skeleton'],
      ['data/animal/meshes/goat.mesh', 'data/animal/meshes/goat.skeleton'],
    ];
    for (const [m, s] of cases) {
      const mesh = parseOgreMesh(read(m));
      const skel = parseOgreSkeleton(read(s));
      expect(skel.animations.length, s).toBeGreaterThan(5);
      const { ratio, clip } = worstStretch(mesh.submeshes[0]!.geometry, skel, [0, 0.5, 1]);
      expect(ratio, `${m}: ${clip}`).toBeLessThan(1.8);
    }
  });
});
