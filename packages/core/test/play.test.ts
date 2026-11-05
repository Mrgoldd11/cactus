/**
 * Этап 3, проигрыватель разговора: выбор диалога и реплик по правилу игры, ответы игрока,
 * «как будто», выбор среди равных.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  ModContext,
  PLAY_NPC,
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

const line = (sid: string, speaker: number, text: string, o: { kids?: string[]; cond?: boolean } = {}): GameRecord =>
  rec('DIALOGUE_LINE', sid, (r) => {
    r.ints.set('speaker', speaker);
    if (text) r.strings.set('text0', b(text));
    if (o.kids) r.refs.set('lines', o.kids.map((k) => ref(k)));
    if (o.cond) r.refs.set('conditions', [ref('COND', 1)]);
  });

/**
 * Персонаж C, пакет PK на событие 1: DA (без условий) и DB (с условием → +1 очко).
 * DA → E (пустой узел) → LA «hi» → A1 (ответ) → LN «ok»; A2 (ответ с условием); `mixed` — ещё LM (NPC).
 * С `tie` — ещё DT без условий: с DA поровну.
 */
function ctxOf(o: { tie?: boolean; mixed?: boolean } = {}): ModContext {
  const records = [
    rec('DIALOG_ACTION', 'COND', (r) => r.ints.set('condition name', 1)),
    rec('DIALOGUE', 'DA', (r) => r.refs.set('lines', [ref('E')])),
    line('E', 0, '', { kids: ['LA'] }),
    line('LA', 0, 'hi', { kids: ['A1', 'A2', ...(o.mixed ? ['LM'] : [])] }),
    line('A1', 2, 'Tell me more', { kids: ['LN'] }),
    line('A2', 2, 'Secret', { cond: true }),
    line('LN', 0, 'ok'),
    line('LM', 0, 'go away'),
    rec('DIALOGUE', 'DB', (r) => {
      r.refs.set('lines', [ref('LB')]);
      r.refs.set('conditions', [ref('COND', 1)]);
    }),
    line('LB', 0, 'b'),
    rec('DIALOGUE', 'DT', (r) => r.refs.set('lines', [ref('LT')])),
    line('LT', 0, 't'),
    rec('DIALOGUE_PACKAGE', 'PK', (r) => r.refs.set('dialogs', [ref('DA', 1), ref('DB', 1), ...(o.tie ? [ref('DT', 1)] : [])])),
    rec('CHARACTER', 'C', (r) => r.refs.set('dialogue package', [ref('PK')])),
  ];
  const file: DataFile = { fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() };
  return new ModContext({ layers: [{ name: 'gamedata.base', file }], modName: 'Test.mod' });
}

/** Расклад «только записи без условий». */
const N = { mode: 'none' } as const;

describe('проигрыватель разговора', () => {
  it('по умолчанию условия считаются выполненными: диалог с условием (+1) выбран, ответ с условием показан', () => {
    const s = playConversation(ctxOf(), 'C').steps[0]!;
    expect(s.options.map((o) => [o.sid, o.why])).toEqual([
      ['DB', 'chosen'],
      ['DA', 'outscored'],
    ]);
    const a = playConversation(ctxOf(), 'C', { assume: new Map([['DB', false]]) }).steps[0]!;
    expect(a.said).toBe('LA');
    expect(a.answers.every((x) => x.shown)).toBe(true);
  });

  it('начало: диалог с условием не проходит, выбран диалог без условий, пустой узел пройден', () => {
    const p = playConversation(ctxOf(), 'C', N);
    const s = p.steps[0]!;
    expect(s.options.map((o) => [o.sid, o.why, o.passes])).toEqual([
      ['DB', 'fails', false],
      ['DA', 'chosen', true],
    ]);
    expect(s.options.find((o) => o.sid === 'DA')!.sources![0]!.via).toBe('character-package');
    expect(s.path.map((l) => l.node)).toEqual(['DA', 'E']);
    expect(s.said).toBe('LA');
    expect(s.answers.map((a) => [a.sid, a.shown])).toEqual([
      ['A1', true],
      ['A2', false],
    ]);
    expect(p.waiting).toBe(true);
  });

  it('ответ игрока ведёт дальше; скрытый ответ не принимается; «как будто» его показывает', () => {
    const ctx = ctxOf();
    const p = playConversation(ctx, 'C', { ...N, answers: ['A1'] });
    expect(p.steps).toHaveLength(2);
    expect(p.steps[0]!.answered).toBe('A1');
    expect(p.steps[1]!.said).toBe('LN');
    expect(p.steps[1]!.end).toBe('nothing-next');
    expect(p.waiting).toBe(false);

    expect(playConversation(ctx, 'C', { ...N, answers: ['A2'] }).steps[0]!.answered).toBeUndefined();
    const q = playConversation(ctx, 'C', { ...N, answers: ['A2'], assume: new Map([['A2', true]]) });
    expect(q.steps[0]!.answered).toBe('A2');
    expect(q.steps[1]!.end).toBe('nothing-next');
  });

  it('«как будто условия выполнены»: диалог с условием получает +1 и перебивает', () => {
    const p = playConversation(ctxOf(), 'C', { ...N, assume: new Map([['DB', true]]) });
    const s = p.steps[0]!;
    expect(s.options.map((o) => [o.sid, o.why])).toEqual([
      ['DB', 'chosen'],
      ['DA', 'outscored'],
    ]);
    expect(s.said).toBe('LB');
    // Диалог подходит, но его реплика — нет: игра его пропускает, причина — «внутри ничего не подходит».
    const inner = playConversation(ctxOf(), 'C', { ...N, assume: new Map([['DB', true], ['LB', false]]) }).steps[0]!;
    expect(inner.options.map((o) => [o.sid, o.why])).toEqual([
      ['DB', 'empty'],
      ['DA', 'chosen'],
    ]);
    // И наоборот: «как будто не выполнены» для записи без условий.
    const none = playConversation(ctxOf(), 'C', { ...N, assume: new Map([['DA', false]]) });
    expect(none.steps[0]!.end).toBe('nothing-fits');
  });

  it('равные очки: случайно поровну, по умолчанию первый в порядке игры, можно взять другой', () => {
    const ctx = ctxOf({ tie: true });
    const s = playConversation(ctx, 'C', N).steps[0]!;
    expect(s.options.filter((o) => o.odds > 0).map((o) => [o.sid, o.why, o.odds])).toEqual([
      ['DA', 'chosen-random', 0.5],
      ['DT', 'random', 0.5],
    ]);
    const t = playConversation(ctx, 'C', { ...N, prefer: new Map([['', 'DT']]) }).steps[0]!;
    expect(t.said).toBe('LT');
    expect(t.end).toBe('nothing-next');
  });

  it('смешанная ветка: ответы и ход «NPC продолжает сам»', () => {
    const ctx = ctxOf({ mixed: true });
    const p = playConversation(ctx, 'C', N);
    expect(p.steps[0]!.npcToo).toBe(true);
    const q = playConversation(ctx, 'C', { ...N, answers: [PLAY_NPC] });
    expect(q.steps[1]!.said).toBe('LM');
  });
});
