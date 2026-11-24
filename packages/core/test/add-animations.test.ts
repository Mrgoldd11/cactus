/**
 * «Add animations» wizard core: how an exported skeleton fits a race skeleton (by bone name, parents must
 * match), clip rows with exact and near-miss records, the sample suggestion, and applying everything as one
 * undo step into the mod.
 */
import { describe, expect, it } from 'vitest';
import {
  addAnimationsLabel,
  animationFilesFor,
  animNameOf,
  applyAddAnimations,
  clipRows,
  decodeText,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  fitVerdict,
  itemTypeId,
  ModContext,
  modFileRecordPath,
  modFolderName,
  raceAnimalCharacters,
  skeletonFit,
  skeletonFitText,
  suggestAnimSample,
  type DataFile,
  type GameRecord,
  type OgreSkeleton,
} from '../src/index.ts';

/** Skeleton from `[name, parent name]` pairs and clips that animate the listed bones. */
function skel(bones: [string, string | null][], clips: Record<string, string[]> = {}): OgreSkeleton {
  const index = new Map(bones.map(([n], i) => [n, i]));
  return {
    version: '[Serializer_v1.10]',
    blendMode: 0,
    bones: bones.map(([name, parent], i) => ({
      handle: i,
      name,
      parent: parent === null ? -1 : index.get(parent)!,
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    })),
    animations: Object.entries(clips).map(([name, moved]) => ({
      name,
      length: 1.5,
      tracks: moved.map((b) => ({ bone: index.get(b)!, times: new Float32Array([0]), rotations: new Float32Array([0, 0, 0, 1]), translations: new Float32Array(3) })),
    })),
    links: [],
  };
}

const RACE_BONES: [string, string | null][] = [
  ['Bip01', null],
  ['Bip01 Pelvis', 'Bip01'],
  ['Bip01 Spine', 'Bip01 Pelvis'],
  ['Bip01 Head', 'Bip01 Spine'],
  ['Bip01 L Hand', 'Bip01 Spine'],
];

describe('skeleton fit', () => {
  const race = skel(RACE_BONES);

  it('same bones and parents: ok, absent bones are fine', () => {
    const file = skel(RACE_BONES.slice(0, 4), { wave: ['Bip01 Head'] });
    const fit = skeletonFit(file, race);
    expect(fit).toMatchObject({ common: 4, fileBones: 4, raceBones: 5, extra: [], hierarchy: [], absent: ['Bip01 L Hand'] });
    expect(fitVerdict(fit)).toBe('ok');
    expect(skeletonFitText(fit)).toEqual([]);
  });

  it('extra bones: harmless unless a clip moves them', () => {
    const still = skel([...RACE_BONES, ['Tail', 'Bip01 Pelvis']], { wave: ['Bip01 Head'] });
    expect(fitVerdict(skeletonFit(still, race))).toBe('ok');
    const moving = skel([...RACE_BONES, ['Tail', 'Bip01 Pelvis']], { wag: ['Tail'] });
    const fit = skeletonFit(moving, race);
    expect(fit.animatedExtra).toEqual(['Tail']);
    expect(fitVerdict(fit)).toBe('warn');
    expect(skeletonFitText(fit)[0]!.ru).toContain('Tail');
  });

  it('a bone on another parent: error (Ogre refuses to merge)', () => {
    const file = skel([
      ['Bip01', null],
      ['Bip01 Pelvis', 'Bip01'],
      ['Bip01 Spine', 'Bip01 Pelvis'],
      ['Bip01 Head', 'Bip01 Pelvis'],
    ]);
    const fit = skeletonFit(file, race);
    expect(fit.hierarchy).toEqual([{ bone: 'Bip01 Head', fileParent: 'Bip01 Pelvis', raceParent: 'Bip01 Spine' }]);
    expect(fitVerdict(fit)).toBe('error');
    expect(skeletonFitText(fit)[0]!.en).toMatch(/crash/);
  });

  it('no common bone: error', () => {
    const fit = skeletonFit(skel([['root', null], ['leg', 'root']]), race);
    expect(fit.common).toBe(0);
    expect(fitVerdict(fit)).toBe('error');
  });
});

const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });

function rec(type: string, sid: string, name: string, refs: Record<string, string[]> = {}, strings: Record<string, string> = {}): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, encodeText(name));
  for (const [cat, list] of Object.entries(refs)) r.refs.set(cat, list.map((target) => ({ target, v0: 0, v1: 0, v2: 0 })));
  for (const [k, v] of Object.entries(strings)) r.strings.set(k, encodeText(v));
  return r;
}

function make(): ModContext {
  const idle = rec('ANIMATION', 'a-idle', 'Idle stand', {}, { 'anim name': 'idle_stand' });
  idle.floats.set('speed', 1.25);
  const vanilla = [
    rec('RACE', 'gl', 'Greenlander'),
    rec('RACE', 'sc', 'Scorchlander'),
    rec('RACE', 'goat-r', 'Goat'),
    rec('ANIMAL_CHARACTER', 'goat', 'Goat', { race: ['goat-r'] }),
    idle,
    rec('ANIMATION', 'a-sit', 'Sit', {}, { 'anim name': 'sit_ground' }),
    rec('ANIMATION', 'a-dance', 'Dance (typo)', {}, { 'anim name': 'Dance Happy' }),
    rec('ANIMAL_ANIMATION', 'aa-walk', 'Goat walk', {}, { 'anim name': 'walk' }),
  ];
  return new ModContext({ layers: [{ name: 'gamedata.base', file: file(vanilla) }], mod: file([]), modName: 'Anims.mod' });
}

describe('clip rows and suggestions', () => {
  it('exact records, near misses, clips the race already has', () => {
    const ctx = make();
    const f = skel(RACE_BONES, { idle_stand: ['Bip01'], dance_happy: ['Bip01 Head'], my_wave: [] });
    const rows = clipRows(ctx, f, new Set(['idle_stand']), 'ANIMATION');
    expect(rows.map((r) => [r.clip, r.records, r.nearMisses.map((m) => m.sid), r.replaces, r.tracks])).toEqual([
      ['idle_stand', ['a-idle'], [], true, 1],
      ['dance_happy', [], ['a-dance'], false, 1],
      ['my_wave', [], [], false, 0],
    ]);
    // «Dance Happy» is a real clip of this race: not a typo, nothing to fix.
    const real = clipRows(ctx, f, new Set(['Dance Happy']), 'ANIMATION');
    expect(real.find((r) => r.clip === 'dance_happy')!.nearMisses).toEqual([]);
  });

  it('sample by shared words; nothing alike — none', () => {
    const ctx = make();
    expect(suggestAnimSample(ctx, 'idle_relax', 'ANIMATION')).toBe('a-idle');
    expect(suggestAnimSample(ctx, 'sit_chair', 'ANIMATION')).toBe('a-sit');
    expect(suggestAnimSample(ctx, 'zzz', 'ANIMATION')).toBeUndefined();
    expect(suggestAnimSample(ctx, 'goat_walk_fast', 'ANIMAL_ANIMATION')).toBe('aa-walk');
  });

  it('animal races are found through their animal characters', () => {
    const ctx = make();
    expect(raceAnimalCharacters(ctx, 'goat-r')).toEqual(['goat']);
    expect(raceAnimalCharacters(ctx, 'gl')).toEqual([]);
  });

  it('mod paths', () => {
    expect(modFileRecordPath('My Mod', 'animations', 'a.skeleton')).toBe('.\\mods\\My Mod\\animations\\a.skeleton');
    expect(modFolderName('C:/x/My Mod.mod')).toBe('My Mod');
  });
});

describe('apply', () => {
  const PATH = '.\\mods\\Anims\\animations\\wave.skeleton';

  it('one undo step: animation file, races linked, clip records, near-miss fix', () => {
    const ctx = make();
    const r = applyAddAnimations(ctx, {
      type: 'ANIMATION',
      races: ['gl', 'sc'],
      male: PATH,
      female: PATH,
      fileName: 'wave',
      clips: [
        { clip: 'my_wave', name: 'My wave' },
        { clip: 'idle_relax', sample: 'a-idle' },
      ],
      fixes: [{ sid: 'a-dance', clip: 'dance_happy' }],
    });
    const af = ctx.get(r.animationFile)!;
    expect(ctx.typeName(af.type)).toBe('ANIMATION_FILE');
    expect(decodeText(af.files.get('male animation')!)).toBe(PATH);
    expect(decodeText(af.files.get('female animation')!)).toBe(PATH);
    expect(af.bools.get('preprocess')).toBe(true);
    for (const race of ['gl', 'sc']) expect(ctx.get(race)!.refs.get('animation files')!.map((x) => x.target)).toEqual([r.animationFile]);
    expect(r.racesLinked).toEqual(['gl', 'sc']);
    const [wave, relax] = r.records.map((s) => ctx.get(s)!);
    expect(decodeText(wave!.name)).toBe('My wave');
    expect(animNameOf(ctx, wave!.stringId)).toBe('my_wave');
    // The sample's settings are copied, only the clip name changes.
    expect(relax!.floats.get('speed')).toBe(1.25);
    expect(animNameOf(ctx, relax!.stringId)).toBe('idle_relax');
    expect(animNameOf(ctx, 'a-dance')).toBe('dance_happy');
    // One step in the history, with a translated title.
    const steps = ctx.history().undo;
    expect(steps.length).toBe(1);
    expect(steps[0]!.label).toBe(addAnimationsLabel('wave', 2, 2));
    expect(describeChangeset(ctx, steps[0]!).text.en).toBe('Animations «wave»: clips 2, races 2');
    ctx.undo();
    expect(ctx.get(r.animationFile)).toBeUndefined();
    expect(ctx.get('gl')!.refs.get('animation files') ?? []).toEqual([]);
    expect(animNameOf(ctx, 'a-dance')).toBe('Dance Happy');
  });

  it('the same file again: the record is reused, races already linked are skipped', () => {
    const ctx = make();
    const first = applyAddAnimations(ctx, { type: 'ANIMATION', races: ['gl'], male: PATH, fileName: 'wave', clips: [{ clip: 'my_wave' }], fixes: [] });
    expect(animationFilesFor(ctx, PATH)).toEqual([first.animationFile]);
    expect(animationFilesFor(ctx, './mods/anims/animations/WAVE.skeleton')).toEqual([first.animationFile]);
    const again = applyAddAnimations(ctx, { type: 'ANIMATION', races: ['gl', 'sc'], male: PATH, fileName: 'wave', reuseFile: first.animationFile, clips: [], fixes: [] });
    expect(again.animationFile).toBe(first.animationFile);
    expect(again.racesLinked).toEqual(['sc']);
    expect(ctx.get('gl')!.refs.get('animation files')!.length).toBe(1);
  });

  it('animals: clip records are animal animations added to the characters', () => {
    const ctx = make();
    const r = applyAddAnimations(ctx, {
      type: 'ANIMAL_ANIMATION',
      races: ['goat-r'],
      male: PATH,
      fileName: 'goat extra',
      clips: [{ clip: 'goat_jump', sample: 'aa-walk' }],
      fixes: [],
      animalCharacters: ['goat'],
    });
    const sid = r.records[0]!;
    expect(ctx.typeName(ctx.get(sid)!.type)).toBe('ANIMAL_ANIMATION');
    expect(ctx.get('goat')!.refs.get('animations')!.map((x) => x.target)).toEqual([sid]);
  });

  it('refuses without a file or with a non-race', () => {
    const ctx = make();
    expect(() => applyAddAnimations(ctx, { type: 'ANIMATION', races: ['gl'], fileName: 'x', clips: [], fixes: [] })).toThrow();
    expect(() => applyAddAnimations(ctx, { type: 'ANIMATION', races: ['a-idle'], male: PATH, fileName: 'x', clips: [], fixes: [] })).toThrow();
    expect(ctx.history().undo.length).toBe(0);
  });
});
