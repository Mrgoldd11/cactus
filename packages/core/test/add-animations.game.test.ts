/**
 * «Add animations» bone check on real files: animation packs from the Workshop fit the vanilla human
 * skeleton, an animal skeleton does not. Without the game (or the Workshop items) the tests are skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitVerdict, parseOgreSkeleton, skeletonFit, type OgreSkeleton } from '../src/index.ts';
import { hasGame, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const MALE = 'data/character/meshes/male_skeleton/male_skeleton.skeleton';
const FEMALE = 'data/character/meshes/female_skeleton/female_skeleton.skeleton';

const load = (path: string): OgreSkeleton => parseOgreSkeleton(readFileSync(path));
const inGame = (rel: string): string => join(paths.kenshi, rel);
const inWorkshop = (rel: string): string => join(paths.workshop, rel);

/** Workshop animation packs that people play with: their bones must not clash with the race skeleton. */
const PACKS: [string, string][] = [
  ['2810262017/character/meshes/male_skeleton/3.skeleton', MALE],
  ['2692142481/character/male Animations set 1 v7.skeleton', MALE],
  ['2810262017/character/meshes/female_skeleton/female_waki_patched.skeleton', FEMALE],
  ['2692142481/character/female animations set 1 v10.skeleton', FEMALE],
];

describe.skipIf(!game)('add animations on game files', () => {
  for (const [pack, race] of PACKS) {
    it.skipIf(!existsSync(inWorkshop(pack)) || !existsSync(inGame(race)))(`${pack} fits ${race}`, () => {
      const file = load(inWorkshop(pack));
      const fit = skeletonFit(file, load(inGame(race)));
      expect(fit.hierarchy).toEqual([]);
      expect(fit.common).toBeGreaterThan(10);
      expect(fitVerdict(fit)).not.toBe('error');
      expect(file.animations.length).toBeGreaterThan(0);
    });
  }

  it('the male skeleton fits itself', () => {
    const male = load(inGame(MALE));
    const fit = skeletonFit(male, male);
    expect(fitVerdict(fit)).toBe('ok');
    expect(fit.common).toBe(male.bones.length);
  });

  it.skipIf(!existsSync(inGame('data/animal/meshes/goat.skeleton')))('a goat skeleton does not fit a human', () => {
    const fit = skeletonFit(load(inGame('data/animal/meshes/goat.skeleton')), load(inGame(MALE)));
    expect(fitVerdict(fit)).toBe('error');
  });
});
