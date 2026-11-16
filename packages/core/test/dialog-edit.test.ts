/**
 * Этап 3, редактор диалогов: правки командами ядра (одна отмена на операцию), слои поверх ванили,
 * постоянные id, проверки на графе.
 */
import { describe, expect, it } from 'vitest';
import {
  addCondition,
  addEffect,
  addLine,
  buildDialogueGraph,
  canMoveLine,
  conditionOf,
  decodeText,
  deleteGraphItems,
  deleteLine,
  dialogueChecks,
  duplicateLine,
  duplicateLines,
  insertLineBetween,
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  lineParents,
  lineTexts,
  linkLine,
  linkProblem,
  ModContext,
  moveCopies,
  moveLine,
  readDataFile,
  removeAction,
  revertLine,
  revertLinks,
  removedLinks,
  linksChanged,
  dialogEnumUsage,
  setLineTexts,
  unlinkLine,
  updateCondition,
  writeDataFile,
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

/** D → L (NPC, условие C) → P1, P2 (ответы игрока); P1 → L (петля). */
function base(): DataFile {
  return file([
    rec('DIALOGUE', 'D', (r) => r.refs.set('lines', [ref('L')])),
    rec('DIALOGUE_LINE', 'L', (r) => {
      r.ints.set('speaker', 0);
      r.strings.set('text0', b('Hello'));
      r.strings.set('text1', b('Hi'));
      r.refs.set('conditions', [ref('C', 1)]);
      r.refs.set('lines', [ref('P1'), ref('P2')]);
    }),
    rec('DIALOGUE_LINE', 'P1', (r) => {
      r.ints.set('speaker', 1);
      r.strings.set('text0', b('Again'));
      r.refs.set('lines', [ref('L')]);
    }),
    rec('DIALOGUE_LINE', 'P2', (r) => {
      r.ints.set('speaker', 1);
      r.strings.set('text0', b('Bye'));
    }),
    rec('DIALOG_ACTION', 'C', (r) => {
      r.ints.set('condition name', 26);
      r.ints.set('who', 0);
      r.ints.set('compare by', 0);
      r.ints.set('tag', 2);
    }),
    rec('DIALOGUE', 'LOCKED', (r) => {
      r.bools.set('locked', true);
      r.refs.set('lines', [ref('P2')]);
    }),
  ]);
}

const ctxOf = (mod?: DataFile): ModContext => new ModContext({ layers: [{ name: 'gamedata.base', file: base() }], modName: 'Test.mod', ...(mod ? { mod } : {}) });
const targets = (ctx: ModContext, sid: string, cat = 'lines'): string[] => (ctx.get(sid)?.refs.get(cat) ?? []).map((r) => r.target);

describe('правка диалогов', () => {
  it('новая реплика: постоянный id мода, одна отмена, повтор', () => {
    const ctx = ctxOf();
    const sid = addLine(ctx, 'L', { speaker: 1, text: 'Who are you?' });
    expect(sid).toBe('1-Test.mod');
    expect(decodeText(ctx.get(sid)!.name)).toBe('DIALOGUE_LINE1');
    expect(ctx.get(sid)!.ints.get('speaker')).toBe(1);
    expect(lineTexts(ctx.get(sid)!)).toEqual(['Who are you?']);
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2', sid]);
    ctx.undo();
    expect(ctx.get(sid)).toBeUndefined();
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2']);
    ctx.redo();
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2', sid]);
    // Следующая запись — следующий номер, даже после отмены и повтора.
    expect(addLine(ctx, sid, { speaker: 0, text: 'A friend.' })).toBe('2-Test.mod');
  });

  it('связи: петля к существующей реплике, повтор и сам на себя — нельзя, разрыв', () => {
    const ctx = ctxOf();
    expect(linkProblem(ctx, 'P2', 'L')).toBeUndefined();
    linkLine(ctx, 'P2', 'L');
    expect(targets(ctx, 'P2')).toEqual(['L']);
    expect(linkProblem(ctx, 'P2', 'L')).toBe('эта связь уже есть');
    expect(linkProblem(ctx, 'P2', 'P2')).toMatch(/сама на себя/);
    expect(linkProblem(ctx, 'P2', 'C')).toMatch(/только на реплику/);
    expect(() => { linkLine(ctx, 'C', 'L'); }).toThrow();
    expect(lineParents(ctx, 'L').sort()).toEqual(['D', 'P1', 'P2']);
    unlinkLine(ctx, 'P1', 'L');
    expect(targets(ctx, 'P1')).toEqual([]);
    ctx.undo();
    expect(targets(ctx, 'P1')).toEqual(['L']);
  });

  it('порядок: добавленные двигаются свободно, ванильная — через копию; переживает сохранение', () => {
    const ctx = ctxOf();
    const a = addLine(ctx, 'L', { speaker: 1, text: 'A' });
    const c = addLine(ctx, 'L', { speaker: 1, text: 'C' });
    expect(canMoveLine(ctx, 'L', 'P2', 1)).toBe(true);
    expect(canMoveLine(ctx, 'L', c, 1)).toBe(false);
    expect(moveCopies(ctx, 'L', c, -1)).toEqual([]);
    moveLine(ctx, 'L', c, -1);
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2', c, a]);
    // Ванильный P1 вниз: P1 после P2 — его заменит копия, P2 остаётся как в игре.
    expect(moveCopies(ctx, 'L', 'P1', 1)).toEqual(['P1']);
    const rep = moveLine(ctx, 'L', 'P1', 1);
    const p1 = rep.get('P1')!;
    expect(p1).toBe('3-Test.mod');
    expect(targets(ctx, 'L')).toEqual(['P2', p1, c, a]);
    expect(lineTexts(ctx.get(p1)!)).toEqual(['Again']);
    expect(targets(ctx, p1)).toEqual(['L']);
    // Ванильная после добавленной тоже идёт копией.
    expect(moveCopies(ctx, 'L', 'P2', 1)).toEqual(['P2']);
    // После сохранения и загрузки порядок тот же.
    const saved = readDataFile(writeDataFile(ctx.buildModFile()));
    expect(targets(ctxOf(saved), 'L')).toEqual(['P2', p1, c, a]);
    // «Как в игре»: связи ветки возвращаются к ванильным; одна отмена.
    revertLinks(ctx, 'L');
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2']);
    ctx.undo();
    expect(targets(ctx, 'L')).toEqual(['P2', p1, c, a]);
    ctx.undo();
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2', c, a]);
    expect(ctx.get(p1)).toBeUndefined();
  });

  it('копия реплики: свои условия, общие продолжения, встаёт в ветку', () => {
    const ctx = ctxOf();
    const copy = duplicateLine(ctx, 'L', 'D');
    const cond = ctx.get(copy)!.refs.get('conditions')![0]!;
    expect(cond.target).not.toBe('C');
    expect(cond.v0).toBe(1);
    expect(conditionOf(ctx, cond)).toEqual({ cond: 26, who: 0, cmp: 0, value: 1, tag: 2 });
    expect(targets(ctx, copy)).toEqual(['P1', 'P2']);
    expect(targets(ctx, 'D')).toEqual(['L', copy]);
    ctx.undo();
    expect(ctx.get(copy)).toBeUndefined();
    expect(ctx.modRecords()).toHaveLength(0);
  });

  it('условия и действия: значение в ссылке, общая запись условия копируется при правке', () => {
    const ctx = ctxOf();
    const a = addCondition(ctx, 'P2', { cond: 7, who: 1, cmp: 1, value: 20 });
    expect(ctx.get('P2')!.refs.get('conditions')).toEqual([ref(a, 20)]);
    expect(ctx.get(a)!.ints.get('tag')).toBe(-1);
    updateCondition(ctx, 'P2', a, { value: 30, cmp: 2 });
    expect(conditionOf(ctx, ctx.get('P2')!.refs.get('conditions')![0]!)).toEqual({ cond: 7, who: 1, cmp: 2, value: 30 });
    // C используют двое — правка у P1 не трогает L.
    ctx.addReference('P1', 'conditions', 'C', [1, 0, 0]);
    const own = updateCondition(ctx, 'P1', 'C', { value: 0 });
    expect(own).not.toBe('C');
    expect(ctx.get('L')!.refs.get('conditions')).toEqual([ref('C', 1)]);
    expect(ctx.get('C')!.ints.get('condition name')).toBe(26);
    const e = addEffect(ctx, 'P2', { action: 1 });
    expect(ctx.get(e)!.ints.get('action name')).toBe(1);
    removeAction(ctx, 'P2', 'effects', e);
    expect(ctx.get(e)).toBeUndefined();
    expect(ctx.get('P2')!.refs.get('effects') ?? []).toEqual([]);
  });

  it('удаление: ссылки на реплику убираются вместе с её условиями; отмена всё возвращает', () => {
    const ctx = ctxOf();
    const n = addLine(ctx, 'P2', { speaker: 0, text: 'Bye then' });
    const a = addCondition(ctx, n, { cond: 7, who: 0, cmp: 0, value: 1 });
    deleteLine(ctx, n);
    expect(ctx.get(n)).toBeUndefined();
    expect(ctx.get(a)).toBeUndefined();
    expect(targets(ctx, 'P2')).toEqual([]);
    ctx.undo();
    expect(targets(ctx, 'P2')).toEqual([n]);
    expect(ctx.get(a)).toBeDefined();
    // Ванильная реплика помечается удалённой, ссылки на неё убраны, её условие C из игры остаётся.
    deleteLine(ctx, 'L');
    expect(ctx.status('L')).toBe('deleted');
    expect(targets(ctx, 'D')).toEqual([]);
    expect(ctx.get('C')).toBeDefined();
  });

  it('граф: вставить реплику между, удалить выделенное и копии — каждое одной отменой', () => {
    const ctx = ctxOf();
    // L → P2 (связь из игры) становится L → N → P2.
    const n = insertLineBetween(ctx, 'L', 'P2', { speaker: 0, text: 'Wait' });
    expect(targets(ctx, 'L')).toEqual(['P1', n]);
    expect(targets(ctx, n)).toEqual(['P2']);
    expect(removedLinks(ctx, 'L')).toEqual(['P2']);
    ctx.undo();
    expect(ctx.get(n)).toBeUndefined();
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2']);
    expect(() => insertLineBetween(ctx, 'P2', 'L', { speaker: 0 })).toThrow(/no such link/);

    // Две новые реплики и связь петли — одна отмена; связи удаляемых реплик не мешают.
    const a = addLine(ctx, 'P2', { speaker: 0, text: 'a' });
    const c = addLine(ctx, a, { speaker: 1, text: 'c' });
    deleteGraphItems(ctx, { lines: [a, c], links: [{ parent: 'P1', child: 'L' }, { parent: 'P2', child: a }] });
    expect(ctx.get(a)).toBeUndefined();
    expect(ctx.get(c)).toBeUndefined();
    expect(targets(ctx, 'P1')).toEqual([]);
    expect(targets(ctx, 'P2')).toEqual([]);
    ctx.undo();
    expect(targets(ctx, 'P2')).toEqual([a]);
    expect(targets(ctx, a)).toEqual([c]);
    expect(targets(ctx, 'P1')).toEqual(['L']);
    expect(() => { deleteGraphItems(ctx, { lines: ['D'] }); }).toThrow(/is not a line/);

    const [x, y] = duplicateLines(ctx, [{ sid: 'P1', parent: 'L' }, { sid: 'P2', parent: 'L' }]);
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2', x, y]);
    ctx.undo();
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2']);
    expect(ctx.get(x!)).toBeUndefined();
  });

  it('тексты: у ванильной реплики лишние становятся пустыми, у новой — убираются', () => {
    const ctx = ctxOf();
    setLineTexts(ctx, 'L', ['Hey']);
    expect(decodeText(ctx.get('L')!.strings.get('text1')!)).toBe('');
    expect(lineTexts(ctx.get('L')!)).toEqual(['Hey']);
    const n = addLine(ctx, 'L', { speaker: 1, text: 'x' });
    setLineTexts(ctx, n, ['a', 'b']);
    setLineTexts(ctx, n, ['a']);
    expect(ctx.get(n)!.strings.has('text1')).toBe(false);
  });

  it('проверки на графе: конец разговора, запертый диалог, без текста, ничейная реплика', () => {
    const ctx = ctxOf();
    const silent = addLine(ctx, 'P1', { speaker: 0, text: '' });
    const orphan = addLine(ctx, 'P1', { speaker: 0, text: 'lost' });
    unlinkLine(ctx, 'P1', orphan);
    const kinds = (root: string): string[] => dialogueChecks(ctx, buildDialogueGraph(ctx, root)).map((c) => `${c.kind}:${c.node}`);
    expect(kinds('D').sort()).toEqual([`end:P2`, `orphan:${orphan}`, `silent:${silent}`]);
    expect(kinds('LOCKED')).toContain('locked:LOCKED');
    linkLine(ctx, 'P2', silent);
    ctx.addReference(silent, 'unlocks', 'LOCKED');
    expect(kinds('LOCKED')).not.toContain('locked:LOCKED');
  });

  it('«как в игре»: правки реплики убираются, удалённая возвращается на своё место', () => {
    const ctx = ctxOf();
    setLineTexts(ctx, 'P1', ['Again!']);
    const own = addCondition(ctx, 'P1', { cond: 7, who: 0, cmp: 0, value: 1 });
    expect(ctx.status('P1')).toBe('changed');
    revertLine(ctx, 'P1');
    expect(ctx.status('P1')).toBe('base');
    expect(ctx.get(own)).toBeUndefined();
    deleteLine(ctx, 'P1');
    expect(targets(ctx, 'L')).toEqual(['P2']);
    expect(removedLinks(ctx, 'L')).toEqual(['P1']);
    expect(linksChanged(ctx, 'L')).toBe(true);
    revertLine(ctx, 'P1');
    expect(ctx.status('P1')).toBe('base');
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2']);
    expect(linksChanged(ctx, 'L')).toBe(false);
    // Связь из игры, убранная и снова проведённая, встаёт на своё место.
    unlinkLine(ctx, 'L', 'P1');
    linkLine(ctx, 'L', 'P1');
    expect(targets(ctx, 'L')).toEqual(['P1', 'P2']);
    expect(() => { revertLine(ctx, addLine(ctx, 'L', { speaker: 1, text: 'x' })); }).toThrow(/not in the game/);
  });

  it('какие условия и действия есть в данных', () => {
    const ctx = ctxOf();
    addEffect(ctx, 'P2', { action: 5 });
    const u = dialogEnumUsage(ctx);
    expect(u.conditions.get(26)).toBe(1);
    expect(u.actions.get(5)).toBe(1);
  });
});
