/**
 * История правок: понятные названия шагов (ru/en) и переход к любому шагу одним действием.
 */
import { describe, expect, it } from 'vitest';
import {
  addLine,
  applyOps,
  deleteGraphItems,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  linkLine,
  ModContext,
  setLineTexts,
  unlinkLine,
  type DataFile,
  type GameRecord,
  type Reference,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);
const T = (n: string): number => itemTypeId(n)!;
const ref = (target: string): Reference => ({ target, v0: 0, v1: 0, v2: 0 });

function rec(type: string, sid: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(T(type), sid, b(sid));
  fill(r);
  return r;
}

function base(): DataFile {
  return {
    fileType: FileType.Data,
    lastId: 0,
    tail: new Uint8Array(),
    records: [
      rec('DIALOGUE', 'D', (r) => r.refs.set('lines', [ref('L')])),
      rec('DIALOGUE_LINE', 'L', (r) => {
        r.ints.set('speaker', 0);
        r.strings.set('text0', b('Beep won the fight, and now everyone is happy'));
        r.refs.set('lines', [ref('P')]);
      }),
      rec('DIALOGUE_LINE', 'P', (r) => {
        r.ints.set('speaker', 1);
        r.strings.set('text0', b('Bye'));
      }),
      rec('WEAPON', 'K', (r) => {
        r.name = b('Katana');
        r.ints.set('damage', 10);
      }),
    ],
  };
}

const ctxOf = (): ModContext => new ModContext({ layers: [{ name: 'gamedata.base', file: base() }], modName: 'Test.mod' });
const last = (ctx: ModContext) => describeChangeset(ctx, ctx.history().undo.at(-1)!);

describe('названия шагов истории', () => {
  it('реплики, связи, текст — по-человечески на двух языках', () => {
    const ctx = ctxOf();
    const a = addLine(ctx, 'L', { speaker: 1, text: 'Who are you?' });
    expect(last(ctx)).toMatchObject({ ru: 'Добавлен ответ игрока „Who are you?“', en: 'Added player answer „Who are you?“', ai: false });
    addLine(ctx, a, { speaker: 0, text: '' });
    expect(last(ctx).ru).toBe('Добавлена реплика NPC');
    setLineTexts(ctx, 'L', ['Beep won the fight, and now everyone is happy!']);
    expect(last(ctx).ru).toBe('Изменён текст реплики „Beep won the fight, and now eve…“');
    expect(last(ctx).en).toBe('Changed line text „Beep won the fight, and now eve…“');
    unlinkLine(ctx, 'L', 'P');
    expect(last(ctx)).toMatchObject({ ru: 'Удалена связь', en: 'Removed link' });
    linkLine(ctx, 'L', 'P');
    expect(last(ctx).ru).toBe('Добавлена связь');
    deleteGraphItems(ctx, { lines: ['P'] });
    expect(last(ctx).ru).toMatch(/^Удален/);
  });

  it('поля записи, ИИ, откат, своя метка', () => {
    const ctx = ctxOf();
    ctx.editRecord('K', (d) => d.ints.set('damage', 20));
    expect(last(ctx)).toMatchObject({ ru: 'Изменено «damage» у «Katana» → 20', en: 'Changed «damage» on «Katana» → 20' });
    ctx.renameRecord('K', 'Long katana');
    expect(last(ctx).ru).toBe('Переименовано в «Long katana»');
    applyOps(ctx, [{ op: 'set', id: 'K', field: 'damage', value: 30 }], 'ИИ: урон катаны');
    expect(last(ctx)).toMatchObject({ ru: 'ИИ: урон катаны', en: 'AI: урон катаны', ai: true });
    const ai = ctx.history().undo.at(-1)!;
    ctx.rollbackChangeset(ai.id);
    expect(last(ctx)).toMatchObject({ ru: 'Откат: ИИ: урон катаны', ai: true, rollback: true });
    ctx.transaction('Skeleton Cannibal Friend', () => { ctx.editRecord('K', (d) => d.ints.set('damage', 1)); });
    expect(last(ctx).ru).toBe('Skeleton Cannibal Friend');
  });
});

describe('переход к шагу истории', () => {
  it('3 правки → к первой: две отменены, повтор до последней возвращает', () => {
    const ctx = ctxOf();
    for (const v of [1, 2, 3]) ctx.editRecord('K', (d) => d.ints.set('damage', v));
    const [s1, , s3] = ctx.history().undo;
    expect(ctx.goToStep(s1!.id)).toEqual({ undone: 2, redone: 0 });
    expect(ctx.get('K')!.ints.get('damage')).toBe(1);
    expect(ctx.history().redo.map((c) => c.id)).toEqual([s1!.id + 1, s3!.id]);
    expect(ctx.redoTo(s3!.id)).toHaveLength(2);
    expect(ctx.get('K')!.ints.get('damage')).toBe(3);
    expect(ctx.undoTo(s1!.id)).toHaveLength(3);
    expect(ctx.get('K')!.ints.get('damage')).toBe(10);
    expect(ctx.goToStep(s3!.id)).toEqual({ undone: 0, redone: 3 });
    expect(ctx.goToStep(0)).toEqual({ undone: 3, redone: 0 });
    expect(() => ctx.undoTo(999)).toThrow();
    expect(ctx.canUndo).toBe(false);
  });
});
