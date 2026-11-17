/**
 * «Race compatibility» wizard: finding every place that references the sample race (vanilla,
 * dependencies, context mods, the mod itself), copying reference values, applying as one undo
 * only into the mod, and a rerun finding nothing new.
 */
import { describe, expect, it } from 'vitest';
import {
  applyBulk,
  createRaceFrom,
  newRaceNameProblem,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  findRace,
  formatRaceCompat,
  itemTypeId,
  ModContext,
  planRaceCompat,
  raceCompatPreview,
  raceCompatSituation,
  raceSkeletonWarning,
  readDataFile,
  writeDataFile,
  type DataFile,
  type GameRecord,
} from '../src/index.ts';

const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });

function rec(type: string, sid: string, name: string, refs: Record<string, [string, number?, number?, number?][]> = {}): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, encodeText(name));
  for (const [cat, list] of Object.entries(refs)) r.refs.set(cat, list.map(([target, v0 = 0, v1 = 0, v2 = 0]) => ({ target, v0, v1, v2 })));
  return r;
}

function make(): ModContext {
  const gl = rec('RACE', 'gl', 'Greenlander', { 'animation files': [['anim1']], hairs: [['hair1', 50]], 'part map male': [['pm1']], 'combat anatomy': [['anat1']] });
  gl.files.set('male mesh', encodeText('data/character/greenlander.mesh'));
  const vanilla = [
    gl,
    rec('RACE', 'sc', 'Scorchlander'),
    rec('ANIMATION_FILE', 'anim1', 'Overhaul anims'),
    rec('ATTACHMENT', 'hair1', 'Short hair'),
    rec('TEXTURE_DDS', 'pm1', 'Human part map'),
    rec('COMBAT_ANATOMY', 'anat1', 'Human anatomy'),
    rec('ARMOUR', 'cap', 'Cap', { races: [['gl'], ['sc']] }),
    rec('ARMOUR', 'shirt', 'Shirt', { 'races exclude': [['gl']] }),
    rec('ARMOUR', 'done', 'Done hat', { races: [['gl'], ['nr']] }),
    rec('WEAPON', 'w', 'Fragment Axe', { 'race damage': [['gl', 150]] }),
    rec('CONTAINER', 'bp', 'Backpack', { races: [['gl']] }),
    rec('DIALOGUE_LINE', 'dl', '', { 'my race': [['gl']], 'target race': [['sc'], ['gl']] }),
    rec('RACE_GROUP', 'human', 'Human', { races: [['gl'], ['sc']] }),
    rec('NEW_GAME_STARTOFF', 'st', 'Wanderer', { 'force race': [['gl']] }),
    rec('FACTION', 'f', 'Holy Nation', { races: [['gl', 60]] }),
    rec('CHARACTER', 'c', 'Guard', { race: [['gl']] }),
  ];
  vanilla.find((r) => r.stringId === 'dl')!.strings.set('text0', encodeText('Hello there, green one'));
  const nr = rec('RACE', 'nr', 'Lizardfolk');
  nr.files.set('male mesh', encodeText('data/character/lizard.mesh'));
  return new ModContext({
    layers: [
      { name: 'gamedata.base', file: file(vanilla) },
      { name: 'Races.mod', file: file([nr]) },
      { name: 'Context.mod', file: file([rec('ARMOUR', 'ctxhat', 'Context hat', { races: [['gl']] })]) },
    ],
    mod: file([rec('ARMOUR', 'mine', 'My helmet', { races: [['gl']] })]),
    modName: 'Compat.mod',
  });
}

describe('race compatibility', () => {
  it('finds every place of the sample race, grouped, with default choices', () => {
    const ctx = make();
    const plan = planRaceCompat(ctx, 'nr', 'gl', { contextMods: ['Context.mod'] });
    const byKey = new Map(plan.changes.map((c) => [c.key, c]));
    expect([...byKey.keys()].sort()).toEqual(
      [
        'bp|races',
        'cap|races',
        'ctxhat|races',
        'dl|my race',
        'dl|target race',
        'f|races',
        'human|races',
        'mine|races',
        'nr|animation files',
        'nr|combat anatomy',
        'nr|hairs',
        'nr|part map male',
        'shirt|races exclude',
        'st|force race',
        'w|race damage',
      ].sort(),
    );
    expect(byKey.get('cap|races')).toMatchObject({ group: 'armour', before: 'Greenlander, Scorchlander', after: 'Greenlander, Scorchlander, Lizardfolk', checked: true });
    expect(byKey.get('w|race damage')).toMatchObject({ group: 'weapons', after: 'Greenlander (150), Lizardfolk (150)' });
    expect(byKey.get('dl|my race')).toMatchObject({ group: 'dialogue', name: 'Hello there, green one', checked: true });
    expect(byKey.get('human|races')!.group).toBe('raceGroups');
    expect(byKey.get('st|force race')!.group).toBe('starts');
    expect(byKey.get('bp|races')!.group).toBe('items');
    expect(byKey.get('nr|animation files')).toMatchObject({ group: 'animations', before: '', after: 'Overhaul anims', checked: true });
    // Population, looks and part maps are opt-in.
    expect(byKey.get('f|races')).toMatchObject({ group: 'factions', checked: false, after: 'Greenlander (60), Lizardfolk (60)' });
    expect(byKey.get('nr|hairs')!.checked).toBe(false);
    expect(byKey.get('nr|part map male')!.checked).toBe(false);
    // Body setup is ticked when the new race has none of its own.
    expect(byKey.get('nr|combat anatomy')).toMatchObject({ group: 'body', checked: true, after: 'Human anatomy' });
    // A record from a context mod (not a dependency) is marked and unchecked.
    expect(byKey.get('ctxhat|races')).toMatchObject({ contextOnly: true, checked: false, origin: 'Context.mod' });
    // Records of the mod itself count too.
    expect(byKey.get('mine|races')).toMatchObject({ origin: 'Compat.mod', checked: true });
    // A character's single race is not a list: shown, not changed.
    expect(plan.info).toEqual([{ sid: 'c', name: 'Guard', type: 'CHARACTER', field: 'race' }]);
    expect(plan.already).toBe(1);
    const text = formatRaceCompat(plan, new Set(plan.changes.filter((c) => c.checked).map((c) => c.key)), 100).join('\n');
    expect(text).toContain('CHARACTER.race 1');
    expect(text).toContain('[from context mod Context.mod, not a dependency]');
  });

  it('applies the chosen changes as one undo, into the mod only, with the sample values', () => {
    const ctx = make();
    const plan = planRaceCompat(ctx, 'nr', 'gl');
    const keys = plan.changes.map((c) => c.key);
    const p = raceCompatPreview(plan, keys);
    expect(p.changes).toHaveLength(keys.length);
    expect(ctx.status('cap')).toBe('base');
    expect(applyBulk(ctx, p)).toBe(keys.length);
    expect(ctx.history().undo).toHaveLength(1);
    expect(describeChangeset(ctx, ctx.history().undo[0]!).text.en).toBe(`Race compatibility «Lizardfolk» like «Greenlander» (changes: ${keys.length})`);
    const ref = (sid: string, cat: string) => ctx.get(sid)!.refs.get(cat)!.find((r) => r.target === 'nr');
    expect(ref('w', 'race damage')!.v0).toBe(150);
    expect(ref('f', 'races')!.v0).toBe(60);
    expect(ref('shirt', 'races exclude')).toBeDefined();
    expect(ref('dl', 'target race')).toBeDefined();
    expect(ctx.get('nr')!.refs.get('animation files')!.map((r) => r.target)).toEqual(['anim1']);
    expect(ctx.get('nr')!.refs.get('hairs')![0]!.v0).toBe(50);
    expect(ctx.get('nr')!.refs.get('part map male')!.map((r) => r.target)).toEqual(['pm1']);
    // The lower layers are untouched; the mod holds only the diff.
    expect(ctx.layers[0]!.file.records.find((r) => r.stringId === 'cap')!.refs.get('races')!.map((r) => r.target)).toEqual(['gl', 'sc']);
    const saved = readDataFile(writeDataFile(ctx.buildModFile())).records;
    const cap = saved.find((r) => r.stringId === 'cap')!;
    expect(cap.refs.get('races')!.map((r) => r.target)).toEqual(['nr']);
    expect(saved.find((r) => r.stringId === 'c')).toBeUndefined();
    // A rerun finds nothing new.
    expect(planRaceCompat(ctx, 'nr', 'gl').changes).toEqual([]);
    ctx.undo();
    expect(ref('cap', 'races')).toBeUndefined();
    expect(ctx.get('nr')!.refs.get('animation files') ?? []).toEqual([]);
    expect(planRaceCompat(ctx, 'nr', 'gl').changes).toHaveLength(keys.length);
  });

  it('applies only the checked changes by default', () => {
    const ctx = make();
    const plan = planRaceCompat(ctx, 'nr', 'gl', { contextMods: ['Context.mod'] });
    const p = raceCompatPreview(plan);
    expect(p.changes.map((c) => `${c.sid}|${c.field}`)).not.toContain('f|races');
    expect(p.changes.map((c) => `${c.sid}|${c.field}`)).not.toContain('ctxhat|races');
    applyBulk(ctx, p);
    expect(ctx.get('f')!.refs.get('races')!.map((r) => r.target)).toEqual(['gl']);
    const again = planRaceCompat(ctx, 'nr', 'gl', { contextMods: ['Context.mod'] });
    expect(again.changes.every((c) => !c.checked)).toBe(true);
  });

  it('finds races by name and refuses wrong input', () => {
    const ctx = make();
    expect(findRace(ctx, 'Lizardfolk')).toBe('nr');
    expect(findRace(ctx, 'gl')).toBe('gl');
    expect(() => findRace(ctx, 'Cap')).toThrow(/not a race/);
    expect(() => findRace(ctx, 'nothing at all')).toThrow(/No race/);
    expect(() => planRaceCompat(ctx, 'gl', 'gl')).toThrow(/same race/);
    expect(() => planRaceCompat(ctx, 'cap', 'gl')).toThrow(/not a race/);
  });

  it('warns when the meshes use different skeletons', () => {
    const ctx = make();
    const plan = planRaceCompat(ctx, 'nr', 'gl');
    const skel: Record<string, string> = { 'data/character/greenlander.mesh': 'male.skeleton', 'data/character/lizard.mesh': 'lizard.skeleton' };
    expect(raceSkeletonWarning(ctx, plan, (p) => skel[p])?.en).toContain('lizard.skeleton');
    expect(raceSkeletonWarning(ctx, plan, () => 'male.skeleton')).toBeUndefined();
    expect(raceSkeletonWarning(ctx, plan, () => undefined)).toBeUndefined();
  });

  it('new race based on a sample: name checks, one undo step, then the wizard pair works', () => {
    const ctx = make();
    expect(newRaceNameProblem(ctx, 'gl', '  ')?.en).toMatch(/Enter a name/);
    expect(newRaceNameProblem(ctx, 'gl', ' greenlander ')?.en).toMatch(/same as the sample/);
    expect(newRaceNameProblem(ctx, 'gl', 'LIZARDFOLK')?.en).toMatch(/Another race.*nr/);
    expect(newRaceNameProblem(ctx, 'gl', 'Mossfolk')).toBeUndefined();
    expect(() => createRaceFrom(ctx, 'gl', 'Greenlander')).toThrow(/sample/);
    expect(() => createRaceFrom(ctx, 'cap', 'Mossfolk')).toThrow(/not a race/);
    expect(ctx.history().undo).toHaveLength(0);

    const sid = createRaceFrom(ctx, 'gl', '  Mossfolk ');
    const rec = ctx.get(sid)!;
    expect(ctx.typeName(rec.type)).toBe('RACE');
    expect(ctx.name(sid)).toBe('Mossfolk');
    expect(ctx.status(sid)).toBe('new');
    // A full copy: the sample's own references come along.
    expect(rec.refs.get('animation files')?.map((r) => r.target)).toEqual(['anim1']);
    expect(ctx.history().undo).toHaveLength(1);
    const step = describeChangeset(ctx, ctx.history().undo.at(-1)!);
    expect(step.text.ru).toBe('Новая раса «Mossfolk» на основе «Greenlander»');
    expect(step.text.en).toBe('New race «Mossfolk» based on «Greenlander»');

    // The wizard for the new pair: incoming places are offered, the copied own fields are already there.
    const plan = planRaceCompat(ctx, sid, 'gl');
    expect(plan.changes.some((c) => c.key === 'cap|races')).toBe(true);
    expect(plan.changes.some((c) => c.group === 'animations')).toBe(false);
    applyBulk(ctx, raceCompatPreview(plan));
    expect(ctx.history().undo).toHaveLength(2);
    ctx.undo();
    expect(ctx.get(sid)).toBeDefined();
    ctx.undo();
    expect(ctx.get(sid)).toBeUndefined();
    expect(ctx.history().undo).toHaveLength(0);
  });
  it('explains an empty plan: the sample unused (maybe a swapped pair) or everything done', () => {
    const ctx = make();
    // Lizardfolk is listed only next to Greenlander already → nothing to do.
    const done = planRaceCompat(ctx, 'gl', 'nr');
    expect(done.changes).toHaveLength(0);
    expect(raceCompatSituation(done)).toBe('done');
    expect(formatRaceCompat(done, new Set()).join('\n')).toMatch(/nothing to do/);

    // A fresh copy of Greenlander is used nowhere: as the sample it has nothing outside itself.
    const copy = createRaceFrom(ctx, 'gl', 'Mossfolk');
    const swapped = planRaceCompat(ctx, 'gl', copy);
    expect(raceCompatSituation(swapped)).toBe('unused');
    expect(swapped.raceUses).toBeGreaterThan(0);
    const text = formatRaceCompat(swapped, new Set(), 50, 'ru').join('\n');
    expect(text).toMatch(/нигде больше не используется/);
    expect(text).toMatch(/перепутаны/);

    // The same unused sample for another unused race: no swap hint.
    const other = createRaceFrom(ctx, 'gl', 'Ashfolk');
    const plain = planRaceCompat(ctx, other, copy);
    expect(raceCompatSituation(plain)).toBe('unused');
    expect(plain.raceUses).toBe(0);
    expect(formatRaceCompat(plain, new Set()).join('\n')).not.toMatch(/swapped/);

    // Places to add the new race to → no explanation needed.
    expect(raceCompatSituation(planRaceCompat(ctx, copy, 'gl'))).toBeUndefined();
  });
});
