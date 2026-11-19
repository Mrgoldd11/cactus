/**
 * G7 «▶ Play» strip: where a dialogue is heard, the package start list, the ranked candidates with
 * the tie, and the draft «like this one».
 */
import { describe, expect, it } from 'vitest';
import {
  dialoguePlaySpots,
  emptyRecord,
  encodeText,
  eventDialogueLike,
  FileType,
  itemTypeId,
  ModContext,
  packagePlayStart,
  playCandidates,
  playConversation,
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

const line = (sid: string, speaker: number, text: string, kids: string[] = []): GameRecord =>
  rec('DIALOGUE_LINE', sid, (r) => {
    r.ints.set('speaker', speaker);
    if (text) r.strings.set('text0', b(text));
    if (kids.length) r.refs.set('lines', kids.map((k) => ref(k)));
  });

/**
 * Package PK: on event 62 DA (no conditions, key 0), DB (a DC_ condition → key 1) and DT (equal to DB
 * when `tie`); PK inherits BASE with DI on event 62 too. DA also on event 5. Character C holds PK and
 * has DX as its own `dialogue`.
 */
function ctxOf(o: { tie?: boolean } = {}): ModContext {
  const records = [
    rec('DIALOG_ACTION', 'COND', (r) => {
      r.ints.set('condition name', 7);
      r.ints.set('who', 1);
      r.ints.set('compare by', 2);
    }),
    rec('RACE', 'SHEK'),
    rec('FACTION', 'HOLY'),
    rec('DIALOGUE', 'DA', (r) => r.refs.set('lines', [ref('LA')])),
    line('LA', 0, 'rain', ['LA2']),
    line('LA2', 1, 'yes'),
    rec('DIALOGUE', 'DB', (r) => {
      r.refs.set('lines', [ref('LB')]);
      r.refs.set('conditions', [ref('COND', 3)]);
      r.refs.set('my race', [ref('SHEK')]);
      r.refs.set('my faction', [ref('HOLY')]);
      r.ints.set('repetition limit', 4);
      r.bools.set('monologue', true);
    }),
    line('LB', 0, 'acid'),
    rec('DIALOGUE', 'DT', (r) => {
      r.refs.set('lines', [ref('LT')]);
      r.ints.set('score bonus', 3);
    }),
    line('LT', 0, 't'),
    rec('DIALOGUE', 'DI', (r) => r.refs.set('lines', [ref('LI')])),
    line('LI', 0, 'inherited'),
    rec('DIALOGUE', 'DX', (r) => r.refs.set('lines', [ref('LX')])),
    line('LX', 0, 'own'),
    rec('DIALOGUE_PACKAGE', 'BASE', (r) => r.refs.set('dialogs', [ref('DI', 62)])),
    rec('DIALOGUE_PACKAGE', 'PK', (r) => {
      r.refs.set('dialogs', [ref('DA', 62), ref('DB', 62), ref('DA', 5), ...(o.tie ? [ref('DT', 62)] : [])]);
      r.refs.set('inheritsFrom', [ref('BASE')]);
    }),
    rec('CHARACTER', 'C', (r) => {
      r.refs.set('dialogue package', [ref('PK')]);
      r.refs.set('dialogue', [ref('DX')]);
    }),
  ];
  const file: DataFile = { fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() };
  return new ModContext({ layers: [{ name: 'gamedata.base', file }], modName: 'Test.mod' });
}

describe('play strip (G7)', () => {
  it('spots: a dialogue per package event, a line through its dialogue, a package per event, a direct holder', () => {
    const ctx = ctxOf();
    expect(dialoguePlaySpots(ctx, 'DA')).toEqual([
      { event: 62, pkg: 'PK', dialog: 'DA' },
      { event: 5, pkg: 'PK', dialog: 'DA' },
    ]);
    expect(dialoguePlaySpots(ctx, 'LA2')).toEqual(dialoguePlaySpots(ctx, 'DA'));
    expect(dialoguePlaySpots(ctx, 'PK').map((s) => s.event)).toEqual([62, 5]);
    expect(dialoguePlaySpots(ctx, 'DX')).toEqual([{ event: 1, character: 'C', dialog: 'DX' }]);
    expect(dialoguePlaySpots(ctx, 'C')).toEqual([]);
  });

  it('package start list: own and inherited dialogues of the event; the play goes from it', () => {
    const ctx = ctxOf();
    const start = packagePlayStart(ctx, 'PK', 62);
    expect([...start.keys()]).toEqual(['DA', 'DB', 'DI']);
    expect(start.get('DI')![0]).toEqual({ via: 'character-package', holder: 'BASE', dialog: 'DI' });
    const p = playConversation(ctx, 'PK', { event: 62, start });
    expect(p.character).toBe('PK');
    expect(p.steps[0]!.said).toBe('LB');
    expect(p.steps[0]!.options.find((o) => o.sid === 'DI')!.sources![0]!.holder).toBe('BASE');
  });

  it('candidates by key; the tie lists everyone with a chance', () => {
    const ctx = ctxOf();
    const c = playCandidates(ctx, playConversation(ctx, 'PK', { event: 62, start: packagePlayStart(ctx, 'PK', 62) }).steps[0]!.options);
    // DB: a condition (+1) and `my faction` (+2) = 3.
    expect(c.rows.map((r) => [r.sid, r.key, r.place])).toEqual([
      ['DB', 3, 1],
      ['DA', 0, 2],
      ['DI', 0, 3],
    ]);
    expect(c.chosen).toBe('DB');
    expect(c.tie).toEqual([]);
    const tied = ctxOf({ tie: true });
    const t = playCandidates(tied, playConversation(tied, 'PK', { event: 62, start: packagePlayStart(tied, 'PK', 62) }).steps[0]!.options);
    expect(t.rows.slice(0, 2).map((r) => [r.sid, r.key])).toEqual([
      ['DB', 3],
      ['DT', 3],
    ]);
    expect([...t.tie].sort()).toEqual(['DB', 'DT']);
  });

  it('like this one: race, conditions, line chain, limit and monologue', () => {
    const ctx = ctxOf();
    expect(eventDialogueLike(ctx, 'DB')).toEqual({
      race: 'SHEK',
      when: [{ cond: 7, who: 1, v: 3, cmp: 2 }, { ref: 'my faction', targets: ['HOLY'] }],
      lines: [{ speaker: 0, texts: ['acid'] }],
      rep: 4,
      monologue: true,
    });
    expect(eventDialogueLike(ctx, 'DA')!.lines).toEqual([
      { speaker: 0, texts: ['rain'] },
      { speaker: 1, texts: ['yes'] },
    ]);
    expect(eventDialogueLike(ctx, 'LA')).toBeUndefined();
  });
});
