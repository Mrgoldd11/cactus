/**
 * «Own creature» on the installed game's files: the goat's clip needs match the clips of goat.skeleton,
 * vanilla ragdolls name Biped bones, the farm shop is an animal trader, and the Quaternius donkey of
 * the «Custom Animal Test» mod (if it is in the mods folder) passes the check with bull.phs.
 * Without the game the tests are skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  animalRagdolls,
  animalTraders,
  bestRagdoll,
  checkCreature,
  creatureClipNeeds,
  creatureProblems,
  creatureVerdict,
  gamePath,
  parseOgreSkeleton,
  phsBoneNames,
} from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const GOAT = '3993-gamedata.base';
const FARM_SHOP = '53642-rebirth.mod';
const inGame = (rel: string): string => join(paths.kenshi, rel);
const DONKEY = inGame('mods/Custom Animal Test/donkey.skeleton');

describe.skipIf(!game)('own creature on game files', () => {
  const { ctx } = loadModContext({ paths, po: false });
  const goatSkel = parseOgreSkeleton(readFileSync(inGame('data/animal/meshes/goat.skeleton')));
  const goatClips = goatSkel.animations.map((a) => a.name);

  it('the goat: every clip its records ask for is in goat.skeleton', () => {
    const needs = creatureClipNeeds(ctx, GOAT);
    expect(needs.map((n) => n.clip)).toEqual(expect.arrayContaining(['idle1', 'walk', 'run', 'strafeleft', 'attack1']));
    const check = checkCreature(needs, goatSkel, { ragdollBones: phsBoneNames(readFileSync(inGame('data/animal/ragdoll/goat.phs'))) });
    expect(check.clips.filter((c) => !c.present)).toEqual([]);
    expect(check.ragdollMissing).toEqual([]);
  });

  it('vanilla ragdolls name Biped bones; the bull ragdoll has 27', () => {
    const bull = phsBoneNames(readFileSync(inGame('data/animal/ragdoll/bull.phs')));
    expect(bull).toHaveLength(27);
    expect(bull).toEqual(expect.arrayContaining(['Bip01', 'Bip01 Pelvis', 'Bip01 L Toe0', 'Bip01 Tail1']));
    const used = animalRagdolls(ctx).map((r) => r.path.toLowerCase());
    expect(used).toEqual(expect.arrayContaining(['.\\data\\animal\\ragdoll\\bull.phs', '.\\data\\animal\\ragdoll\\goat.phs']));
  });

  it('the farm shop is an animal trader in several towns', () => {
    const shop = animalTraders(ctx).find((t) => t.sid === FARM_SHOP);
    expect(shop?.animals.length).toBeGreaterThan(0);
    expect(shop?.towns.length).toBeGreaterThan(3);
  });

  it.skipIf(!existsSync(DONKEY))('the donkey of Custom Animal Test: all goat clips, bull.phs fits best', () => {
    const donkey = parseOgreSkeleton(readFileSync(DONKEY));
    const ragdolls = new Map<string, string[]>();
    for (const r of animalRagdolls(ctx)) {
      const p = inGame(gamePath(r.path)!);
      if (existsSync(p)) ragdolls.set(r.path, phsBoneNames(readFileSync(p)));
    }
    const best = bestRagdoll(donkey, ragdolls);
    expect(best?.path.toLowerCase()).toBe('.\\data\\animal\\ragdoll\\bull.phs');
    expect(best?.missing).toEqual([]);
    const check = checkCreature(creatureClipNeeds(ctx, GOAT), donkey, { sampleClips: goatClips, ragdollBones: ragdolls.get(best!.path)! });
    expect(creatureVerdict(creatureProblems(check))).toBe('ok');
  });
});
