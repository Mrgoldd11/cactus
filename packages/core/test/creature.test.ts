/**
 * «Own creature» core: clips the game asks for (animations, strafe, attacks by attack type), ragdoll
 * bone names from a `.phs`, the check, animal traders, and creating race + animal + sale + start as
 * one undo step.
 */
import { describe, expect, it } from 'vitest';
import {
  animalRagdolls,
  animalStarts,
  animalTraders,
  bestRagdoll,
  checkCreature,
  createCreature,
  creatureClipNeeds,
  creatureProblems,
  creatureScale,
  creatureSamples,
  creatureVerdict,
  decodeText,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  hasModel,
  itemTypeId,
  ModContext,
  modelOfRecord,
  newCreatureNameProblem,
  phsBoneNames,
  startsWith,
  tradersSelling,
  type DataFile,
  type GameRecord,
  type OgreSkeleton,
} from '../src/index.ts';

const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });

function rec(type: string, sid: string, name: string, refs: Record<string, [string, number, number, number][]> = {}): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, encodeText(name));
  for (const [cat, list] of Object.entries(refs)) r.refs.set(cat, list.map(([target, v0, v1, v2]) => ({ target, v0, v1, v2 })));
  return r;
}

function skel(bones: string[], clips: string[]): OgreSkeleton {
  return {
    version: '[Serializer_v1.10]',
    blendMode: 0,
    bones: bones.map((name, i) => ({ handle: i, name, parent: i === 0 ? -1 : 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] })),
    animations: clips.map((name) => ({ name, length: 1, tracks: [] })),
    links: [],
  };
}

function make(): ModContext {
  const anim = (sid: string, clip: string): GameRecord => {
    const r = rec('ANIMAL_ANIMATION', sid, sid);
    r.strings.set('anim name', encodeText(clip));
    return r;
  };
  const race = rec('RACE', 'goat-r', 'Goat', { hairs: [['fur', 0, 0, 0]], 'hair colors': [['fur-c', 0, 0, 0]] });
  for (const g of ['male', 'female']) {
    race.files.set(`${g} mesh`, encodeText('.\\data\\animal\\meshes\\goat.mesh'));
    race.files.set(`${g} ragdoll`, encodeText('.\\data\\animal\\ragdoll\\goat.phs'));
    race.files.set(`body texture ${g}`, encodeText('.\\data\\animal\\textures\\goat.dds'));
  }
  race.floats.set('hull size X', 8);
  race.floats.set('hull size Y', 12);
  race.floats.set('pathfind footprint radius', 4);
  const bullRace = rec('RACE', 'bull-r', 'Bull');
  bullRace.files.set('male mesh', encodeText('.\\data\\animal\\meshes\\bull.mesh'));
  bullRace.files.set('male ragdoll', encodeText('.\\data\\animal\\ragdoll\\bull.phs'));
  const goat = rec('ANIMAL_CHARACTER', 'goat', 'Goat', {
    race: [['goat-r', 100, 0, 0]],
    animations: [
      ['a-idle', 0, 100, 0],
      ['a-walk', 0, 0, 0],
      ['a-strafe', 0, 0, 0],
    ],
    'strafe anim': [['a-strafe', 100, 0, 0]],
    'death items': [['meat', 7, 0, 0]],
  });
  goat.ints.set('attack type', 15);
  const bull = rec('ANIMAL_CHARACTER', 'bull', 'Bull', { race: [['bull-r', 100, 0, 0]] });
  const tech = rec('COMBAT_TECHNIQUE', 't-butt', 'duck attack');
  tech.ints.set('animal', 15);
  tech.strings.set('anim name', encodeText('attack1'));
  const off = rec('COMBAT_TECHNIQUE', 't-off', 'off');
  off.ints.set('animal', 15);
  off.bools.set('disabled', true);
  off.strings.set('anim name', encodeText('attack9'));
  const shop = rec('SQUAD_TEMPLATE', 'shop', 'farm shop', { animals: [['bull', 1, 2, 40]] });
  shop.bools.set('is trader', true);
  const herd = rec('SQUAD_TEMPLATE', 'herd', 'wild goats', { animals: [['goat', 2, 5, 0]] });
  const town = rec('TOWN', 'town', 'Stoat', { residents: [['shop', 1, 0, 0]] });
  const startSquad = rec('SQUAD_TEMPLATE', 'st-sq', 'start- guy with dog', { animals: [['bull', 1, 1, 0]], leader: [['homeless', 1, 0, 0]] });
  const start = rec('NEW_GAME_STARTOFF', 'start', 'Guy with a dog', { squad: [['st-sq', 0, 0, 0]] });
  const vanilla = [
    race,
    bullRace,
    goat,
    bull,
    anim('a-idle', 'idle1'),
    anim('a-walk', 'walk'),
    anim('a-strafe', 'strafeleft'),
    tech,
    off,
    shop,
    herd,
    town,
    startSquad,
    start,
    rec('CHARACTER', 'homeless', 'start- Homeless'),
  ];
  return new ModContext({ layers: [{ name: 'gamedata.base', file: file(vanilla) }], mod: file([]), modName: 'Custom Animal Test.mod' });
}

/** A `.phs`-like blob: binary noise around length-prefixed names, as the real files have. */
function phs(names: string[]): Uint8Array {
  const parts: number[] = [0x33, 0x33, 0xb3, 0x3f, 1, 0, 0, 0];
  for (const n of names) {
    parts.push(n.length, 0, 0, 0, ...new TextEncoder().encode(n), 0x09, 0xee, 0x8e, 0xbb, 0, 0, 0x80, 0x3f);
  }
  return new Uint8Array(parts);
}

describe('creature clips and ragdoll', () => {
  it('needs: animations, strafe, attacks of the attack type (not disabled ones)', () => {
    const needs = creatureClipNeeds(make(), 'goat');
    expect(needs.map((n) => [n.clip, n.kind, n.sources])).toEqual([
      ['idle1', 'move', ['a-idle']],
      ['walk', 'move', ['a-walk']],
      ['strafeleft', 'move', ['a-strafe']],
      ['attack1', 'attack', ['t-butt']],
    ]);
  });

  it('phs names: bone strings kept, mesh path and actor dropped, no duplicates', () => {
    const bytes = phs(['Bip01', 'Bip01 Pelvis', 'Actor', 'Bip01', 'data\\animal\\meshes\\bull.mesh', 'Bip01 L Foot']);
    expect(phsBoneNames(bytes)).toEqual(['Bip01', 'Bip01 Pelvis', 'Bip01 L Foot']);
  });

  it('check: missing clips and ragdoll bones are errors, sample-only clips a warning', () => {
    const ctx = make();
    const needs = creatureClipNeeds(ctx, 'goat');
    const good = skel(['Bip01', 'Bip01 Pelvis'], ['idle1', 'walk', 'strafeleft', 'attack1', 'sleep']);
    const ok = checkCreature(needs, good, { sampleClips: ['idle1', 'sleep'], ragdollBones: ['Bip01', 'Bip01 Pelvis'] });
    expect(creatureVerdict(creatureProblems(ok))).toBe('ok');
    const bad = skel(['Bip01'], ['idle1', 'walk']);
    const check = checkCreature(needs, bad, { sampleClips: ['gotosleep', 'idle1'], ragdollBones: ['Bip01', 'Bip01 Tail'] });
    expect(check.clips.filter((c) => !c.present).map((c) => c.clip)).toEqual(['strafeleft', 'attack1']);
    expect(check.ragdollMissing).toEqual(['Bip01 Tail']);
    expect(check.sampleOnly).toEqual(['gotosleep']);
    const problems = creatureProblems(check);
    expect(problems.map((p) => p.level)).toEqual(['error', 'error', 'warn']);
    expect(problems[0]!.text.ru).toContain('strafeleft, attack1');
    expect(creatureVerdict(problems)).toBe('error');
    const empty = creatureProblems(checkCreature(needs, skel(['Bip01'], [])));
    expect(empty).toHaveLength(1);
    expect(empty[0]!.text.en).toContain('no animations');
  });

  it('best ragdoll: fewest missing bones, then the sample ragdoll, then most bound', () => {
    const s = skel(['Bip01', 'Bip01 Pelvis', 'Bip01 Tail'], []);
    const best = bestRagdoll(
      s,
      new Map([
        ['goat.phs', ['Bip01', 'Bip01 Ponytail1']],
        ['dog.phs', ['Bip01']],
        ['bull.phs', ['Bip01', 'Bip01 Pelvis', 'Bip01 Tail']],
      ]),
    );
    expect(best).toEqual({ path: 'bull.phs', missing: [] });
    // The sample's own ragdoll wins a tie, never against fewer missing bones.
    const tie = new Map([
      ['bull.phs', ['Bip01', 'Bip01 Pelvis', 'Bip01 Tail']],
      ['goat.phs', ['Bip01', 'Bip01 Pelvis']],
    ]);
    expect(bestRagdoll(s, tie, 'GOAT.phs')?.path).toBe('goat.phs');
    expect(bestRagdoll(s, new Map([...tie, ['goat.phs', ['Bip01', 'Bip01 Ponytail1']]]), 'goat.phs')?.path).toBe('bull.phs');
    expect(animalRagdolls(make()).map((r) => r.path)).toEqual(['.\\data\\animal\\ragdoll\\bull.phs', '.\\data\\animal\\ragdoll\\goat.phs']);
  });
});

describe('traders, samples, starts', () => {
  it('animal traders are trader squads with animals; towns listed', () => {
    const ctx = make();
    expect(animalTraders(ctx)).toEqual([{ sid: 'shop', animals: [{ target: 'bull', v0: 1, v1: 2, v2: 40 }], towns: ['town'] }]);
    expect(tradersSelling(ctx, 'bull')).toEqual(['shop']);
    expect(creatureSamples(ctx).sort()).toEqual(['bull', 'goat']);
    expect(animalStarts(ctx)).toEqual(['start']);
  });

  it('name problems: empty, taken by an animal or a race', () => {
    const ctx = make();
    expect(newCreatureNameProblem(ctx, ' ')?.en).toContain('Enter');
    expect(newCreatureNameProblem(ctx, 'goat')?.en).toContain('taken');
    expect(newCreatureNameProblem(ctx, 'Donkey')).toBeUndefined();
  });

  it('scale: height ratio of the bounds, none for a flat mesh', () => {
    const b = (h: number): { bounds: { min: [number, number, number]; max: [number, number, number] } } => ({ bounds: { min: [0, -1, 0], max: [1, h - 1, 1] } });
    expect(creatureScale(b(15.2), b(11.6))).toBe(1.31);
    expect(creatureScale(b(0), b(11.6))).toBeUndefined();
  });
});

describe('create creature', () => {
  const MESH = '.\\mods\\Custom Animal Test\\donkey.mesh';

  it('race copy with own model, animal on it, sale and start — one undo step', () => {
    const ctx = make();
    const res = createCreature(ctx, {
      sample: 'goat',
      name: 'Donkey',
      mesh: MESH,
      texture: '.\\mods\\Custom Animal Test\\donkey.dds',
      ragdoll: '.\\data\\animal\\ragdoll\\bull.phs',
      scale: 1.5,
      traders: [{ sid: 'shop', min: 1, max: 2, age: 10 }],
      startFrom: 'start',
    });
    const race = ctx.get(res.race)!;
    expect(decodeText(race.name)).toBe('Donkey');
    expect(decodeText(race.files.get('male mesh')!)).toBe(MESH);
    expect(decodeText(race.files.get('female mesh')!)).toBe(MESH);
    expect(decodeText(race.files.get('male ragdoll')!)).toBe('.\\data\\animal\\ragdoll\\bull.phs');
    expect(decodeText(race.files.get('nm male')!)).toBe('');
    expect(race.refs.get('hairs')).toBeUndefined();
    expect(race.floats.get('hull size X')).toBe(12);
    expect(race.floats.get('pathfind footprint radius')).toBe(6);
    const animal = ctx.get(res.animal)!;
    expect(animal.refs.get('race')).toEqual([{ target: res.race, v0: 100, v1: 0, v2: 0 }]);
    expect(animal.refs.get('animations')?.map((r) => r.target)).toEqual(['a-idle', 'a-walk', 'a-strafe']);
    expect(animal.ints.get('attack type')).toBe(15);
    expect(ctx.get('shop')!.refs.get('animals')!.at(-1)).toEqual({ target: res.animal, v0: 1, v1: 2, v2: 10 });
    expect(tradersSelling(ctx, res.animal)).toEqual(['shop']);
    expect(startsWith(ctx, res.animal)).toEqual([res.start]);
    expect(ctx.get(res.squad!)!.refs.get('animals')).toEqual([{ target: res.animal, v0: 1, v1: 1, v2: 0 }]);
    expect(ctx.get(res.squad!)!.refs.get('leader')?.[0]?.target).toBe('homeless');
    // The vanilla start is untouched.
    expect(ctx.get('start')!.refs.get('squad')?.[0]?.target).toBe('st-sq');
    // The animal is drawn as its race's body.
    expect(hasModel(ctx, res.animal)).toBe(true);
    expect(modelOfRecord(ctx, res.animal).pieces[0]?.mesh).toBe('mods/Custom Animal Test/donkey.mesh');
    expect(ctx.history().undo).toHaveLength(1);
    expect(describeChangeset(ctx, ctx.history().undo[0]!).text.ru).toContain('Новое существо «Donkey» на основе «Goat»');
    ctx.undo();
    expect(ctx.get(res.animal)).toBeUndefined();
    expect(ctx.get('shop')!.refs.get('animals')).toHaveLength(1);
  });

  it('refuses a non-animal sample, a taken name and a non-mesh file', () => {
    const ctx = make();
    expect(() => createCreature(ctx, { sample: 'goat-r', name: 'X', mesh: MESH })).toThrow();
    expect(() => createCreature(ctx, { sample: 'goat', name: 'Bull', mesh: MESH })).toThrow();
    expect(() => createCreature(ctx, { sample: 'goat', name: 'X', mesh: 'x.dds' })).toThrow();
    expect(ctx.history().undo).toHaveLength(0);
  });
});
