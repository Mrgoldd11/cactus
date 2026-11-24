/**
 * Stage 3, dialogue graph: nodes once each, loops, Russian text from `.translation`,
 * checks (no record, dialogue without lines, a line the game will not pick).
 */
import { describe, expect, it } from 'vitest';
import {
  buildDialogueGraph,
  emptyRecord,
  encodeText,
  FileType,
  indexTranslation,
  itemTypeId,
  ModContext,
  shadowedLines,
  translatedText,
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

function line(sid: string, speaker: number, text: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  return rec('DIALOGUE_LINE', sid, (r) => {
    r.ints.set('speaker', speaker);
    r.strings.set('text0', b(text));
    fill(r);
  });
}

function file(records: GameRecord[]): DataFile {
  return { fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() };
}

/**
 * D: greeting G1 (no conditions, +5) and G2 (+0, will be outscored), G3 (with a condition, +10);
 * G1 → player choice P1 "Trade?" (effect) and P2 "Bye"; P1 → answer A1 → P1 again (loop).
 */
function data(): DataFile {
  return file([
    rec('DIALOG_ACTION', 'COND', (r) => r.ints.set('condition name', 1)),
    rec('DIALOG_ACTION', 'ACT', (r) => r.ints.set('action name', 1)),
    rec('DIALOGUE', 'D', (r) => r.refs.set('lines', [ref('G1'), ref('G2'), ref('G3')])),
    line('G1', 0, 'Hello', (r) => {
      r.ints.set('score bonus', 5);
      r.refs.set('lines', [ref('P1'), ref('P2')]);
    }),
    line('G2', 0, 'Hi there'),
    line('G3', 0, 'Friend!', (r) => {
      r.refs.set('conditions', [ref('COND', 50)]);
      r.ints.set('score bonus', 10);
    }),
    line('P1', 1, 'Trade?', (r) => {
      r.refs.set('effects', [ref('ACT')]);
      r.refs.set('lines', [ref('A1')]);
    }),
    line('P2', 1, 'Bye'),
    line('A1', 0, 'Sure', (r) => r.refs.set('lines', [ref('P1'), ref('GONE')])),
    rec('DIALOGUE', 'EMPTY'),
    rec('DIALOGUE_PACKAGE', 'PKG', (r) => r.refs.set('dialogs', [ref('D', 1), ref('EMPTY', 3)])),
  ]);
}

function translation(): DataFile {
  return file([
    rec('DIALOGUE_LINE', 'G1', (r) => {
      r.strings.set('_original_text0', b('Hello'));
      r.strings.set('text0', b('Привет'));
    }),
    rec('DIALOGUE_LINE', 'P2', (r) => {
      r.strings.set('_original_text0', b('Old text'));
      r.strings.set('text0', b('Пока'));
    }),
  ]);
}

const ctx = (): ModContext => new ModContext({ layers: [{ name: 'gamedata.base', file: data() }], modName: 'x.mod' });

describe('dialogue graph', () => {
  it('nodes once each, a loop is a back edge, player choice, texts in Russian', () => {
    const tr = indexTranslation(translation());
    const g = buildDialogueGraph(ctx(), 'D', { translation: tr });
    expect(g.nodes.map((n) => n.id)).toEqual(['D', 'G1', 'P1', 'A1', 'GONE', 'P2', 'G2', 'G3']);
    const back = g.edges.filter((e) => e.back);
    expect(back.map((e) => `${e.source}>${e.target}`)).toEqual(['A1>P1']);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get('P1')!.choice).toBe(true);
    expect(byId.get('G1')!.choice).toBe(false);
    expect(byId.get('G1')!.texts).toEqual([{ en: 'Hello', localized: 'Привет' }]);
    // The translation was made from a different English text — does not fit.
    expect(byId.get('P2')!.texts).toEqual([{ en: 'Bye' }]);
    expect(byId.get('P1')!.effects).toEqual(['DA_TRADE']);
    expect(byId.get('G3')!.conditions[0]).toContain('= 50');
    expect(byId.get('A1')!.depth).toBe(3);
  });

  it('checks: no record, a line that will not be picked', () => {
    const g = buildDialogueGraph(ctx(), 'D');
    expect(g.issues.map((i) => `${i.kind}:${i.node}${i.by ? `<${i.by}` : ''}`).sort()).toEqual(['missing:GONE', 'shadowed:G2<G1']);
    // G3 with a condition and a higher score: wins when the condition holds.
    expect(shadowedLines(ctx(), 'D')).toEqual([{ line: 'G2', by: 'G1' }]);
    // Player lines are choice options, they are not compared.
    expect(shadowedLines(ctx(), 'G1')).toEqual([]);
  });

  it('package: event on an edge and in a node, dialogue without lines', () => {
    const g = buildDialogueGraph(ctx(), 'PKG');
    const empty = g.nodes.find((n) => n.id === 'EMPTY')!;
    expect(empty.event).toBe(3);
    expect(empty.noLines).toBe(true);
    expect(g.issues.some((i) => i.kind === 'no-lines' && i.node === 'EMPTY')).toBe(true);
    expect(g.edges.filter((e) => e.source === 'PKG').every((e) => e.category === 'dialogs')).toBe(true);
  });

  it('translatedText: without the source text the translation is taken as is', () => {
    const idx = indexTranslation(file([rec('DIALOGUE_LINE', 'X', (r) => r.strings.set('text1', b('Да')))]));
    expect(translatedText(idx, 'X', 'text1', 'Yes')).toBe('Да');
    expect(translatedText(idx, 'X', 'text0', 'Yes')).toBeUndefined();
  });
});
