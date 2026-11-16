/**
 * Stage 3, conversation simulator, the "mod outscores a vanilla dialogue with an effect" check and
 * the dialogue builder.
 */
import { describe, expect, it } from 'vitest';
import {
  DialogBuilder,
  emptyRecord,
  encodeText,
  FileType,
  formatTalk,
  itemTypeId,
  ModContext,
  simulateTalk,
  SPEAKER,
  StableIds,
  talkSources,
  squadIndex,
  validateMod,
  decodeText,
  type DataFile,
  type GameRecord,
  type Reference,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);
const T = (n: string): number => itemTypeId(n)!;
const ref = (target: string, v0 = 0): Reference => ({ target, v0, v1: 0, v2: 0 });

function rec(type: string, sid: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(T(type), sid, b(sid));
  fill(r);
  return r;
}

const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });

/** A dialogue with one root NPC line; `cond` is a condition on the dialogue itself. */
function dlg(sid: string, o: { score?: number; cond?: boolean; act?: string; locked?: boolean; empty?: boolean } = {}): GameRecord[] {
  const line = rec('DIALOGUE_LINE', `${sid}.L`, (r) => {
    r.ints.set('speaker', 0);
    r.strings.set('text0', b(`${sid} says hi`));
    if (o.act) r.refs.set('effects', [ref(o.act)]);
    r.refs.set('lines', [ref(`${sid}.P`)]);
  });
  const choice = rec('DIALOGUE_LINE', `${sid}.P`, (r) => {
    r.ints.set('speaker', 1);
    r.strings.set('text0', b('Bye'));
  });
  const d = rec('DIALOGUE', sid, (r) => {
    if (o.score !== undefined) r.ints.set('score bonus', o.score);
    if (o.cond) r.refs.set('conditions', [ref('COND', 1)]);
    if (o.locked) r.bools.set('locked', true);
    if (!o.empty) r.refs.set('lines', [ref(line.stringId)]);
  });
  return [d, line, choice];
}

/**
 * Character C (no own faction, leader of squad SQ):
 * - `dialogue` → DC (condition, 10 points);
 * - own package PK: event 1 → DV (no conditions, 0, arrest), event 3 → D3; inherits PK2 (event 1 → DS, −5);
 * - squad SQ: `dialog leader` PL (DLOCK, locked), `dialog squad` PS (DEMPTY, no lines);
 * - squad faction F: `dialog default` PF (DTIE without conditions, 0; and DV once more).
 */
function base(): DataFile {
  return file([
    rec('DIALOG_ACTION', 'COND', (r) => r.ints.set('condition name', 1)),
    rec('DIALOG_ACTION', 'ARREST', (r) => r.ints.set('action name', 29)),
    ...dlg('DC', { score: 10, cond: true }),
    ...dlg('DV', { act: 'ARREST' }),
    ...dlg('D3'),
    ...dlg('DS', { score: -5 }),
    ...dlg('DLOCK', { locked: true }),
    ...dlg('DEMPTY', { empty: true }),
    ...dlg('DTIE'),
    rec('DIALOGUE_PACKAGE', 'PK', (r) => {
      r.refs.set('dialogs', [ref('DV', 1), ref('D3', 3)]);
      r.refs.set('inheritsFrom', [ref('PK2')]);
    }),
    rec('DIALOGUE_PACKAGE', 'PK2', (r) => r.refs.set('dialogs', [ref('DS', 1)])),
    rec('DIALOGUE_PACKAGE', 'PL', (r) => r.refs.set('dialogs', [ref('DLOCK', 1)])),
    rec('DIALOGUE_PACKAGE', 'PS', (r) => r.refs.set('dialogs', [ref('DEMPTY', 1)])),
    rec('DIALOGUE_PACKAGE', 'PF', (r) => r.refs.set('dialogs', [ref('DTIE', 1), ref('DV', 1)])),
    rec('FACTION', 'F', (r) => r.refs.set('dialog default', [ref('PF')])),
    rec('SQUAD_TEMPLATE', 'SQ', (r) => {
      r.refs.set('leader', [ref('C')]);
      r.refs.set('faction', [ref('F')]);
      r.refs.set('dialog leader', [ref('PL')]);
      r.refs.set('dialog squad', [ref('PS')]);
    }),
    rec('CHARACTER', 'C', (r) => {
      r.refs.set('dialogue', [ref('DC')]);
      r.refs.set('dialogue package', [ref('PK')]);
    }),
    rec('CHARACTER', 'OTHER'),
    rec('RACE', 'RACE'),
  ]);
}

const ctxOf = (): ModContext => new ModContext({ layers: [{ name: 'gamedata.base', file: base() }], modName: 'Test.mod' });

describe('conversation simulator', () => {
  it('sources: character, own package (with inheritsFrom), squad leader, squad, squad faction', () => {
    const ctx = ctxOf();
    const src = talkSources(ctx, ctx.get('C')!, 1, squadIndex(ctx));
    expect(src.map((s) => [s.via, s.holder, s.dialog])).toEqual([
      ['character', 'C', 'DC'],
      ['character-package', 'PK', 'DV'],
      ['character-package', 'PK2', 'DS'],
      ['squad-leader', 'PL', 'DLOCK'],
      ['squad', 'PS', 'DEMPTY'],
      ['faction', 'PF', 'DTIE'],
      ['faction', 'PF', 'DV'],
    ]);
    // Event 3: only from packages, the character's `dialogue` is only for the click.
    expect(talkSources(ctx, ctx.get('C')!, 3).map((s) => s.dialog)).toEqual(['D3']);
  });

  it('verdicts: random among equals, conditions, outscored, locked, empty', () => {
    const ctx = ctxOf();
    const sim = simulateTalk(ctx, 'C');
    // Game order: by score (DC gets +1 for the condition), locked and empty ones — at the end.
    expect(sim.candidates.map((x) => [x.dialog, x.verdict, x.score])).toEqual([
      ['DC', 'if-conditions', 11],
      ['DV', 'random', 0],
      ['DTIE', 'random', 0],
      ['DS', 'shadowed', -5],
      ['DLOCK', 'locked', 2],
      ['DEMPTY', 'empty', 0],
    ]);
    // DV and DTIE without conditions and with equal scores: the game picks randomly, with equal odds.
    expect(sim.winner).toBeUndefined();
    expect(sim.pool).toEqual(['DV', 'DTIE']);
    expect(sim.candidates.find((x) => x.dialog === 'DV')!.odds).toBeCloseTo(0.5);
    expect(sim.candidates.find((x) => x.dialog === 'DV')!.with).toEqual(['DTIE']);
    expect(sim.candidates.find((x) => x.dialog === 'DC')!.scoreParts).toEqual([
      { key: 'bonus', value: 10 },
      { key: 'conditions', value: 1 },
    ]);
    const dv = sim.candidates.find((x) => x.dialog === 'DV')!;
    expect(dv.sources.map((s) => s.via)).toEqual(['character-package', 'faction']);
    expect(dv.actions).toEqual(['arrest']);
    expect(dv.origin).toBe('gamedata.base');
    expect(sim.candidates.find((x) => x.dialog === 'DS')!.by).toBe('DV');
    expect(sim.candidates.find((x) => x.dialog === 'DC')!.conditions.length).toBe(1);
    // Start of the conversation: the NPC line and the player choice under it.
    expect(sim.opening.map((l) => [l.id, l.texts[0]?.en, l.choices.map((c) => c.texts[0]?.en)])).toEqual([['DV.L', 'DV says hi', ['Bye']]]);
    const text = formatTalk(sim, 'ru').join('\n');
    expect(sim.openingOf).toBe('DV');
    expect(text).toContain('· DV (DV) — выпадет случайно: без условий выпадет случайно, шанс 50%; вместе с «DTIE»');
    expect(text).toContain('итог: без условий игра выберет случайно один из 2');
    expect(text).toContain('как выбирает игра');
    expect(text).toContain('действия: арест');
    expect(text).toContain('«DV says hi»');
  });

  it('game rule: a condition gives points, one already in the draw does not drop out, race +2, limit −999', () => {
    const ctx = ctxOf();
    const bld = new DialogBuilder(ctx);
    // Line A (0 points, but with a player option: key 1) comes earlier in the list than B (1 point, key 1):
    // A enters the draw first and does not drop out, although B has more points.
    const a = bld.line('A', SPEAKER.ME, ['A'], { children: [bld.line('A.p', SPEAKER.TARGET, ['ok'])] });
    const bl = bld.line('B', SPEAKER.ME, ['B'], { score: 1 });
    const w = bld.dialogue('W', [a, bl], [], { score: 4 });
    // Target race: +2 at load and another +2 in the game — 4, as W has with line A.
    const r = bld.dialogue('R', [bld.line('R.l', SPEAKER.ME, ['R'])], [{ targetRace: ['RACE'] }]);
    const low = bld.dialogue('LOW', [bld.line('LOW.l', SPEAKER.ME, ['low'])], [], { score: -1000 });
    for (const d of [w, r, low]) bld.attachToCharacter('OTHER', d);
    const sim = simulateTalk(ctx, 'OTHER');
    const v = Object.fromEntries(sim.candidates.map((x) => [x.dialog, [x.verdict, x.odds]]));
    expect(v[w]).toEqual(['wins', 1]);
    // W starts with A (total 4) or B (total 5) with equal odds; R (4) is in the draw only with A: 1/2 × 1/2.
    expect(v[r]).toEqual(['tie', 0.25]);
    // The game never takes scores below −999, even if there is only one dialogue.
    expect(v[low]).toEqual(['shadowed', undefined]);
    expect(sim.opening.map((l) => [l.id, l.odds])).toEqual([
      [a, 0.5],
      [bl, 0.5],
    ]);
  });

  it('no dialogues and not a character', () => {
    const ctx = ctxOf();
    expect(formatTalk(simulateTalk(ctx, 'OTHER'), 'ru').join('\n')).toContain('диалогов на это событие нет');
    expect(() => simulateTalk(ctx, 'PK')).toThrow(/is not a character/);
  });
});

describe('check: the mod outscores a vanilla dialogue with an effect', () => {
  it('a mod dialogue in a package with a score ≥ the vanilla one with arrest — warning; a fallback (−100) — no', () => {
    const ctx = ctxOf();
    const bld = new DialogBuilder(ctx);
    const l = bld.line('мой привет', SPEAKER.ME, ['Yo']);
    const loud = bld.dialogue('громкий', [l], [], { score: 0 });
    const quiet = bld.dialogue('запасной', [bld.line('тихий привет', SPEAKER.ME, ['hm'])], [], { score: -100 });
    bld.attachToPackages(['C'], loud, 1);
    bld.attachToPackages(['C'], quiet, 1);
    const w = validateMod(ctx).filter((i) => i.code === 'overrides-action');
    expect(w.map((i) => [i.stringId, i.target])).toEqual([['PK', loud]]);
    expect(w[0]!.texts?.ru).toContain('арест');
    expect(w[0]!.message).toContain('arrest');
  });

  it('the character click (CHARACTER.dialogue) is compared with all event 1 dialogues', () => {
    const ctx = ctxOf();
    const bld = new DialogBuilder(ctx);
    const d = bld.dialogue('мой клик', [bld.line('клик', SPEAKER.ME, ['Hey'])], [], { score: 5 });
    bld.attachToCharacter('C', d);
    const w = validateMod(ctx).filter((i) => i.code === 'overrides-action');
    expect(w.map((i) => [i.stringId, i.key, i.target])).toEqual([['C', 'dialogue', d]]);
  });
});

describe('dialogue builder', () => {
  it('lines, conditions, effect, dialogue, permanent ids; binding to a character and packages', () => {
    const ctx = ctxOf();
    const ids = new StableIds('Test.mod');
    const bld = new DialogBuilder(ctx, ids);
    const bye = bld.line('пока', SPEAKER.TARGET, ['Bye'], { action: 1 });
    const hi = bld.line('привет', SPEAKER.ME, ['Hi', 'Hello'], { children: [bye], score: 20, chance: 50, when: [{ cond: 7, who: 1, v: 0 }, { isChar: ['C'] }] });
    const d = bld.dialogue('разговор', [hi], [{ myFaction: ['F'] }], { score: -100, rep: 4, tag: 'test' });
    expect([bye, hi, d]).toEqual(['101-Test.mod', '103-Test.mod', '104-Test.mod']);
    expect(Object.keys(ids.data.ids)).toEqual(['пока !', 'пока', 'привет ?1', 'привет', 'разговор']);

    const h = ctx.get(hi)!;
    expect([decodeText(h.strings.get('text0')!), decodeText(h.strings.get('text1')!)]).toEqual(['Hi', 'Hello']);
    expect(h.ints.get('score bonus')).toBe(20);
    expect(h.floats.get('chance temporary')).toBe(50);
    expect(h.refs.get('is character')?.map((r) => r.target)).toEqual(['C']);
    const cond = ctx.get(h.refs.get('conditions')![0]!.target)!;
    expect([cond.ints.get('condition name'), cond.ints.get('who'), h.refs.get('conditions')![0]!.v0]).toEqual([7, 1, 0]);
    expect(ctx.get(ctx.get(bye)!.refs.get('effects')![0]!.target)!.ints.get('action name')).toBe(1);
    expect(ctx.get(d)!.refs.get('my faction')?.map((r) => r.target)).toEqual(['F']);
    expect(() => bld.line('пока', 0, [])).toThrow(/Повтор имени/);

    bld.attachToCharacter('C', d);
    bld.attachToCharacter('C', d);
    expect(ctx.get('C')!.refs.get('dialogue')!.map((r) => r.target)).toEqual(['DC', d]);
    // The character's own package — only the first; a character without packages — in noPackage.
    expect(bld.attachToPackages(['C', 'OTHER'], d, 3)).toEqual(['PK']);
    expect([...bld.noPackage]).toEqual(['OTHER']);
    expect(ctx.get('PK')!.refs.get('dialogs')!.map((r) => [r.target, r.v0])).toContainEqual([d, 3]);
    expect(simulateTalk(ctx, 'C', 3).candidates.map((x) => x.dialog)).toEqual(['D3', d]);
  });
});
