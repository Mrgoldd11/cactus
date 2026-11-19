/**
 * «Dialogue on event» (`dialog/event-dialogue.ts`): a new dialogue with lines goes into a package
 * under the event, in one history step; a holder without a package gets one; «everyone of a race»
 * adds `my race`; an existing dialogue can be attached.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseRanking,
  createEventDialogue,
  eventDialogueScore,
  packageDialogs,
  decodeText,
  describeChangeset,
  dialogueWhen,
  emptyRecord,
  encodeText,
  eventDialogueBaseName,
  eventDialogueProblem,
  eventDialogueTarget,
  FileType,
  freeRecordName,
  itemTypeId,
  ModContext,
  type DataFile,
  type GameRecord,
  type Reference,
} from '../src/index.ts';

const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): Reference => ({ target, v0, v1, v2 });
function rec(type: string, sid: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, encodeText(sid));
  fill(r);
  return r;
}

function ctxOf(): ModContext {
  const file: DataFile = {
    fileType: FileType.Data,
    lastId: 0,
    tail: new Uint8Array(),
    records: [
      rec('DIALOGUE', 'OLD'),
      rec('DIALOGUE_PACKAGE', 'SHARED'),
      rec('DIALOGUE_PACKAGE', 'PCD', (r) => {
        r.name = encodeText('player character default');
      }),
      rec('CHARACTER', 'BEEP'),
      rec('CHARACTER', 'A', (r) => r.refs.set('dialogue package', [ref('SHARED')])),
      rec('CHARACTER', 'B', (r) => r.refs.set('dialogue package', [ref('SHARED')])),
      rec('SQUAD_TEMPLATE', 'SQ'),
      rec('RACE', 'SHEK'),
    ],
  };
  return new ModContext({ layers: [{ name: 'gamedata.base', file }], modName: 'Test.mod' });
}

const lines = [{ speaker: 0, texts: ['Bloody acid rain!', 'Ow, it burns!'] }, { speaker: 0, texts: ['Find cover.'] }];

describe('createEventDialogue', () => {
  it('a character without a package gets one; the new dialogue plays on the event, one undo step', () => {
    const ctx = ctxOf();
    const steps = ctx.history().undo.length;
    const r = createEventDialogue(ctx, { event: 62, who: { kind: 'holder', sid: 'BEEP', field: 'dialogue package' }, name: 'BEEP acid rain', lines });
    expect(r.createdPkg).toBe(true);
    expect(ctx.get('BEEP')!.refs.get('dialogue package')!.map((x) => x.target)).toEqual([r.pkg]);
    expect(decodeText(ctx.get(r.pkg)!.name)).toBe('BEEP dialogues');
    expect(ctx.get(r.pkg)!.refs.get('dialogs')).toEqual([ref(r.dialog, 62)]);
    // Lines one after another, texts as variants.
    expect(r.lines).toHaveLength(2);
    expect(ctx.get(r.dialog)!.refs.get('lines')!.map((x) => x.target)).toEqual([r.lines[0]]);
    expect(ctx.get(r.lines[0]!)!.refs.get('lines')!.map((x) => x.target)).toEqual([r.lines[1]]);
    expect(decodeText(ctx.get(r.lines[0]!)!.strings.get('text1')!)).toBe('Ow, it burns!');
    expect(ctx.get(r.dialog)!.bools.get('monologue')).toBe(true);
    // «Plays when» now shows the event and the character.
    const when = dialogueWhen(ctx, r.dialog);
    expect(when).toEqual([{ events: [62], pkg: r.pkg, holders: [{ sid: 'BEEP', type: 'CHARACTER', field: 'dialogue package' }] }]);
    // One step: one undo removes everything.
    expect(ctx.history().undo.length).toBe(steps + 1);
    const cs = ctx.history().undo.at(-1)!;
    expect(describeChangeset(ctx, cs).text.ru).toMatch(/^Диалог на событие «BEEP acid rain» → пакет «BEEP dialogues»: Кислотный дождь · EV_ACID_RAIN \(62\)$/);
    ctx.undo();
    expect(ctx.get(r.dialog)).toBeUndefined();
    expect(ctx.get(r.pkg)).toBeUndefined();
    expect(ctx.get('BEEP')!.refs.get('dialogue package')).toBeUndefined();
  });

  it('a shared package: appended to it, or a new own package with `own`', () => {
    const ctx = ctxOf();
    expect(eventDialogueTarget(ctx, { kind: 'holder', sid: 'A', field: 'dialogue package' })).toEqual({ pkg: 'SHARED', sharedBy: 2, existing: ['SHARED'] });
    const shared = createEventDialogue(ctx, { event: 62, who: { kind: 'holder', sid: 'A', field: 'dialogue package' }, name: 'x', lines });
    expect(shared.pkg).toBe('SHARED');
    expect(shared.createdPkg).toBe(false);
    const own = createEventDialogue(ctx, { event: 62, who: { kind: 'holder', sid: 'A', field: 'dialogue package', own: true }, name: 'x', lines });
    expect(own.createdPkg).toBe(true);
    expect(ctx.get('A')!.refs.get('dialogue package')!.map((x) => x.target)).toEqual(['SHARED', own.pkg]);
    // Names stay unique.
    expect(decodeText(ctx.get(own.dialog)!.name)).toBe('x 2');
  });

  it('a squad field and «everyone of a race» (a shared package plus `my race`)', () => {
    const ctx = ctxOf();
    const sq = createEventDialogue(ctx, { event: 3, who: { kind: 'holder', sid: 'SQ', field: 'dialog squad' }, name: 'sq', lines });
    expect(ctx.get('SQ')!.refs.get('dialog squad')!.map((x) => x.target)).toEqual([sq.pkg]);
    const race = createEventDialogue(ctx, { event: 62, who: { kind: 'package', pkg: 'PCD' }, race: 'SHEK', name: 'shek rain', lines });
    expect(race.pkg).toBe('PCD');
    expect(ctx.get(race.dialog)!.refs.get('my race')).toEqual([ref('SHEK')]);
  });

  it('attaches an existing dialogue; the same event twice is one reference', () => {
    const ctx = ctxOf();
    const r = createEventDialogue(ctx, { event: 62, who: { kind: 'package', pkg: 'PCD' }, dialog: 'OLD' });
    expect(r).toMatchObject({ dialog: 'OLD', pkg: 'PCD', lines: [], createdPkg: false });
    // An attached dialogue keeps its own bonus.
    expect(r.score).toMatchObject({ autoBonus: 0, bonus: 0, outcome: 'alone' });
    createEventDialogue(ctx, { event: 62, who: { kind: 'package', pkg: 'PCD' }, dialog: 'OLD' });
    createEventDialogue(ctx, { event: 61, who: { kind: 'package', pkg: 'PCD' }, dialog: 'OLD' });
    expect(ctx.get('PCD')!.refs.get('dialogs')).toEqual([ref('OLD', 62, 61)]);
    expect(describeChangeset(ctx, ctx.history().undo.at(-1)!).text.en).toMatch(/^Dialogue “OLD” into package “player character default”: .+ · EV_ACID_FEET \(61\)$/);
  });

  it('explains what is missing', () => {
    const ctx = ctxOf();
    const who = { kind: 'holder' as const, sid: 'BEEP', field: 'dialogue package' };
    expect(eventDialogueProblem(ctx, { event: 0, who, name: 'n', lines })?.en).toBe('Choose an event');
    expect(eventDialogueProblem(ctx, { event: 62, who: { ...who, field: 'dialog squad' }, name: 'n', lines })?.ru).toMatch(/нет поля пакета/);
    expect(eventDialogueProblem(ctx, { event: 62, who, name: ' ', lines })?.en).toBe('Give the dialogue a name');
    expect(eventDialogueProblem(ctx, { event: 62, who, name: 'n', lines: [{ speaker: 0, texts: [' '] }] })?.en).toBe('Line 1 has no text');
    expect(eventDialogueProblem(ctx, { event: 62, who, name: 'n', lines })).toBeUndefined();
    expect(() => createEventDialogue(ctx, { event: 62, who: { kind: 'package', pkg: 'BEEP' }, name: 'n', lines })).toThrow();
  });

  it('default names', () => {
    expect(eventDialogueBaseName('Beep', 'EV_ACID_RAIN', 62)).toBe('Beep acid rain');
    expect(eventDialogueBaseName('Beep', undefined, 300)).toBe('Beep event 300');
    const ctx = ctxOf();
    expect(freeRecordName(ctx, 'DIALOGUE', 'OLD')).toBe('OLD 2');
    expect(freeRecordName(ctx, 'DIALOGUE', 'new')).toBe('new');
  });

  it('score bonus: a conditional dialogue goes first, one without conditions shares the draw', () => {
    const ctx = ctxOf();
    // A rival on the event: OLD (no conditions, key 0).
    createEventDialogue(ctx, { event: 62, who: { kind: 'package', pkg: 'PCD' }, dialog: 'OLD' });
    const race = { event: 62, who: { kind: 'package' as const, pkg: 'PCD' }, race: 'SHEK', name: 'shek rain', lines };
    // «my race» gives no score: without the bonus it would be 0 and 0 — a tie, a random pick.
    expect(eventDialogueScore(ctx, race)).toMatchObject({ rivals: [{ dialog: 'OLD', key: 0 }], best: 0, base: 0, conditional: true, autoBonus: 1, bonus: 1, key: 1, outcome: 'first', outcomeWithout: 'tie' });
    const r = createEventDialogue(ctx, race);
    expect(ctx.get(r.dialog)!.ints.get('score bonus')).toBe(1);
    const onEvent = packageDialogs(ctx, 'PCD').filter((d) => d.event === 62).map((d) => d.dialog);
    expect(chooseRanking(ctx, onEvent)[0]).toEqual({ sid: r.dialog, key: 1 });
    // Without conditions: enough to tie with the best rival (here the race dialogue with key 1).
    const plain = eventDialogueScore(ctx, { ...race, race: undefined, name: 'plain' });
    expect(plain).toMatchObject({ best: 1, bestDialog: r.dialog, conditional: false, autoBonus: 1, outcome: 'tie', outcomeWithout: 'shadowed' });
    // The bonus can be set by hand.
    expect(eventDialogueScore(ctx, { ...race, scoreBonus: 0 })).toMatchObject({ autoBonus: 2, bonus: 0, outcome: 'shadowed' });
  });

  it('score bonus: scored conditions count, locked rivals and an empty event do not', () => {
    const ctx = ctxOf();
    const who = { kind: 'package' as const, pkg: 'PCD' };
    expect(eventDialogueScore(ctx, { event: 62, who, name: 'n', lines })).toMatchObject({ rivals: [], autoBonus: 0, outcome: 'alone' });
    // A rival with two DC_ conditions (key 2), a locked one with a big bonus.
    const strong = createEventDialogue(ctx, { event: 62, who, name: 'strong', lines, when: [{ cond: 14, who: 0, v: 0 }, { cond: 58, who: 0, v: 0 }] });
    expect(strong.score.outcome).toBe('alone');
    expect(ctx.get(strong.dialog)!.refs.get('conditions')).toHaveLength(2);
    const locked = createEventDialogue(ctx, { event: 62, who, name: 'locked', lines, scoreBonus: 50 });
    ctx.editRecord(locked.dialog, (d) => d.bools.set('locked', true));
    const s = eventDialogueScore(ctx, { event: 62, who, race: 'SHEK', name: 'n', lines, when: [{ cond: 14, who: 0, v: 0 }] });
    expect(s.rivals.map((x) => [x.key, x.locked])).toEqual([[52, true], [2, false]]);
    // One DC_ condition gives 1: 2 more are needed to go before «strong».
    expect(s).toMatchObject({ best: 2, bestDialog: strong.dialog, base: 1, autoBonus: 2, key: 3, outcome: 'first' });
    // The target speaking the first line gives +1 to the key.
    expect(eventDialogueScore(ctx, { event: 62, who, name: 'n', lines: [{ speaker: 1, texts: ['Hi'] }] }).base).toBe(1);
    // A holder without a package yet: no rivals in it.
    expect(eventDialogueScore(ctx, { event: 62, who: { kind: 'holder', sid: 'BEEP', field: 'dialogue package' }, name: 'n', lines }).outcome).toBe('alone');
  });
});
