/**
 * Этап 3, симулятор разговора, проверка «мод перебивает ванильный диалог с действием» и
 * конструктор диалогов.
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

/** Диалог с одной корневой репликой NPC; `cond` — условие на самом диалоге. */
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
 * Персонаж C (без своей фракции, лидер отряда SQ):
 * - `dialogue` → DC (условие, 10 очков);
 * - свой пакет PK: событие 1 → DV (без условий, 0, арест), событие 3 → D3; наследует PK2 (событие 1 → DS, −5);
 * - отряд SQ: `dialog leader` PL (DLOCK, заблокирован), `dialog squad` PS (DEMPTY, без реплик);
 * - фракция отряда F: `dialog default` PF (DTIE без условий, 0; и DV ещё раз).
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

describe('симулятор разговора', () => {
  it('источники: персонаж, свой пакет (с inheritsFrom), лидер отряда, отряд, фракция отряда', () => {
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
    // Событие 3: только из пакетов, `dialogue` персонажа — лишь для клика.
    expect(talkSources(ctx, ctx.get('C')!, 3).map((s) => s.dialog)).toEqual(['D3']);
  });

  it('вердикты: случайно из равных, условия, перебит, заблокирован, пустой', () => {
    const ctx = ctxOf();
    const sim = simulateTalk(ctx, 'C');
    // Порядок игры: по очкам (у DC +1 за условие), заблокированные и пустые — в конце.
    expect(sim.candidates.map((x) => [x.dialog, x.verdict, x.score])).toEqual([
      ['DC', 'if-conditions', 11],
      ['DV', 'random', 0],
      ['DTIE', 'random', 0],
      ['DS', 'shadowed', -5],
      ['DLOCK', 'locked', 2],
      ['DEMPTY', 'empty', 0],
    ]);
    // DV и DTIE без условий и с равными очками: игра выбирает случайно, поровну.
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
    // Начало разговора: реплика NPC и выбор игрока под ней.
    expect(sim.opening.map((l) => [l.id, l.texts[0]?.en, l.choices.map((c) => c.texts[0]?.en)])).toEqual([['DV.L', 'DV says hi', ['Bye']]]);
    const text = formatTalk(sim).join('\n');
    expect(sim.openingOf).toBe('DV');
    expect(text).toContain('· DV (DV) — выпадет случайно: без условий выпадет случайно, шанс 50%; вместе с «DTIE»');
    expect(text).toContain('итог: без условий игра выберет случайно один из 2');
    expect(text).toContain('как выбирает игра');
    expect(text).toContain('действия: арест');
    expect(text).toContain('«DV says hi»');
  });

  it('правило игры: условие даёт очки, уже попавший в розыгрыш не выбывает, раса +2, предел −999', () => {
    const ctx = ctxOf();
    const bld = new DialogBuilder(ctx);
    // Реплика A (0 очков, но с вариантом игрока: ключ 1) стоит в списке раньше B (1 очко, ключ 1):
    // A попадает в розыгрыш первой и не выбывает, хотя у B очков больше.
    const a = bld.line('A', SPEAKER.ME, ['A'], { children: [bld.line('A.p', SPEAKER.TARGET, ['ok'])] });
    const bl = bld.line('B', SPEAKER.ME, ['B'], { score: 1 });
    const w = bld.dialogue('W', [a, bl], [], { score: 4 });
    // Раса собеседника: +2 при загрузке и ещё +2 в игре — 4, как у W с репликой A.
    const r = bld.dialogue('R', [bld.line('R.l', SPEAKER.ME, ['R'])], [{ targetRace: ['RACE'] }]);
    const low = bld.dialogue('LOW', [bld.line('LOW.l', SPEAKER.ME, ['low'])], [], { score: -1000 });
    for (const d of [w, r, low]) bld.attachToCharacter('OTHER', d);
    const sim = simulateTalk(ctx, 'OTHER');
    const v = Object.fromEntries(sim.candidates.map((x) => [x.dialog, [x.verdict, x.odds]]));
    expect(v[w]).toEqual(['wins', 1]);
    // W начинает с A (итог 4) или B (итог 5) поровну; R (4) в розыгрыше только при A: 1/2 × 1/2.
    expect(v[r]).toEqual(['tie', 0.25]);
    // Очки ниже −999 игра не берёт никогда, даже если диалог один.
    expect(v[low]).toEqual(['shadowed', undefined]);
    expect(sim.opening.map((l) => [l.id, l.odds])).toEqual([
      [a, 0.5],
      [bl, 0.5],
    ]);
  });

  it('без диалогов и не персонаж', () => {
    const ctx = ctxOf();
    expect(formatTalk(simulateTalk(ctx, 'OTHER')).join('\n')).toContain('диалогов на это событие нет');
    expect(() => simulateTalk(ctx, 'PK')).toThrow(/не персонаж/);
  });
});

describe('проверка: мод перебивает ванильный диалог с действием', () => {
  it('диалог мода в пакете с очками ≥ ванильного с арестом — предупреждение; запасной (−100) — нет', () => {
    const ctx = ctxOf();
    const bld = new DialogBuilder(ctx);
    const l = bld.line('мой привет', SPEAKER.ME, ['Yo']);
    const loud = bld.dialogue('громкий', [l], [], { score: 0 });
    const quiet = bld.dialogue('запасной', [bld.line('тихий привет', SPEAKER.ME, ['hm'])], [], { score: -100 });
    bld.attachToPackages(['C'], loud, 1);
    bld.attachToPackages(['C'], quiet, 1);
    const w = validateMod(ctx).filter((i) => i.code === 'overrides-action');
    expect(w.map((i) => [i.stringId, i.target])).toEqual([['PK', loud]]);
    expect(w[0]!.message).toContain('арест');
  });

  it('клик персонажа (CHARACTER.dialogue) сравнивается со всеми диалогами события 1', () => {
    const ctx = ctxOf();
    const bld = new DialogBuilder(ctx);
    const d = bld.dialogue('мой клик', [bld.line('клик', SPEAKER.ME, ['Hey'])], [], { score: 5 });
    bld.attachToCharacter('C', d);
    const w = validateMod(ctx).filter((i) => i.code === 'overrides-action');
    expect(w.map((i) => [i.stringId, i.key, i.target])).toEqual([['C', 'dialogue', d]]);
  });
});

describe('конструктор диалогов', () => {
  it('реплики, условия, действие, диалог, постоянные id; привязка к персонажу и пакетам', () => {
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
    // Свой пакет персонажа — только первый; персонаж без пакетов — в noPackage.
    expect(bld.attachToPackages(['C', 'OTHER'], d, 3)).toEqual(['PK']);
    expect([...bld.noPackage]).toEqual(['OTHER']);
    expect(ctx.get('PK')!.refs.get('dialogs')!.map((r) => [r.target, r.v0])).toContainEqual([d, 3]);
    expect(simulateTalk(ctx, 'C', 3).candidates.map((x) => x.dialog)).toEqual(['D3', d]);
  });
});
