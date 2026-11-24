/**
 * Transitions between dialogues (UI review G3): entries, exits, inner transitions and the unlockers
 * of a locked dialogue (`model/dialogue-transitions.ts`), on synthetic data and on the installed game.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDialogueGraph,
  dialogueTransitions,
  dialogueUnlockers,
  dialogueUnlocks,
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  ModContext,
  type DataFile,
  type GameRecord,
  type Reference,
} from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const b = (s: string): Uint8Array => encodeText(s);
const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): Reference => ({ target, v0, v1, v2 });
function rec(type: string, sid: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, b(sid));
  fill(r);
  return r;
}

function ctxOf(): ModContext {
  const file: DataFile = {
    fileType: FileType.Data,
    lastId: 0,
    tail: new Uint8Array(),
    records: [
      // A: thanks → «I owe you» interrupts and unlocks B; another line unlocks B and keeps A.
      rec('DIALOGUE_LINE', 'A2', (r) => {
        r.refs.set('interrupt', [ref('B')]);
        r.refs.set('unlocks', [ref('B')]);
      }),
      rec('DIALOGUE_LINE', 'A1', (r) => r.refs.set('lines', [ref('A2')])),
      rec('DIALOGUE_LINE', 'A3', (r) => r.refs.set('unlock but keep me', [ref('B')])),
      rec('DIALOGUE', 'A', (r) => r.refs.set('lines', [ref('A1'), ref('A3')])),
      // B: locked; its line locks B itself and calls the crowd into C.
      rec('DIALOGUE_LINE', 'B1', (r) => {
        r.refs.set('locks', [ref('B')]);
        r.refs.set('crowd trigger', [ref('C', 40)]);
      }),
      rec('DIALOGUE', 'B', (r) => {
        r.bools.set('locked', true);
        r.refs.set('lines', [ref('B1')]);
      }),
      rec('DIALOGUE', 'C'),
      // A stray line (in no dialogue) that interrupts into B.
      rec('DIALOGUE_LINE', 'STRAY', (r) => r.refs.set('interrupt', [ref('B')])),
    ],
  };
  return new ModContext({ layers: [{ name: 'gamedata.base', file }], modName: 'Test.mod' });
}

describe('dialogue transitions', () => {
  it('entries are grouped by the source dialogue, with the kinds of each line', () => {
    const ctx = ctxOf();
    const t = dialogueTransitions(ctx, buildDialogueGraph(ctx, 'B'));
    expect(t.entries.map((p) => p.dialogue)).toEqual(['A', 'STRAY']);
    const a = t.entries[0]!;
    expect(a.lines).toEqual([
      { line: 'A2', kinds: ['interrupt', 'unlocks'] },
      { line: 'A3', kinds: ['unlock but keep me'] },
    ]);
    expect(a.kinds).toEqual(['interrupt', 'unlocks', 'unlock but keep me']);
    expect(t.entries[1]!.lines).toEqual([{ line: 'STRAY', kinds: ['interrupt'] }]);
  });

  it('exits go to other dialogues, a reference into the own graph is an inner transition', () => {
    const ctx = ctxOf();
    const t = dialogueTransitions(ctx, buildDialogueGraph(ctx, 'B'));
    expect(t.exits).toEqual([{ dialogue: 'C', lines: [{ line: 'B1', kinds: ['crowd trigger'], crowd: 40 }], kinds: ['crowd trigger'] }]);
    expect(t.inner).toEqual([{ line: 'B1', target: 'B', kinds: ['locks'] }]);
    const ta = dialogueTransitions(ctx, buildDialogueGraph(ctx, 'A'));
    expect(ta.entries).toEqual([]);
    expect(ta.exits.map((p) => [p.dialogue, p.lines.map((l) => l.line), p.kinds])).toEqual([['B', ['A2', 'A3'], ['interrupt', 'unlocks', 'unlock but keep me']]]);
  });

  it('who unlocks a dialogue and what a dialogue unlocks', () => {
    const ctx = ctxOf();
    // STRAY only interrupts: it does not unlock.
    expect(dialogueUnlockers(ctx, 'B')).toEqual(['A']);
    expect(dialogueUnlockers(ctx, 'A')).toEqual([]);
    expect(dialogueUnlocks(ctx, 'A')).toEqual(['B']);
    expect(dialogueUnlocks(ctx, 'B')).toEqual([]);
  });
});

const paths = resolveGamePaths();

describe.skipIf(!hasGame(paths))('dialogue transitions: vanilla', () => {
  it('Healed (Recruit) 8950 is entered from 8940 «Healed (Recruit)»', () => {
    const { ctx } = loadModContext({ paths, schema: true });
    const t = dialogueTransitions(ctx, buildDialogueGraph(ctx, '8950-Dialogue.mod'));
    const p = t.entries.find((e) => e.dialogue === '8940-D-Dialogue.mod')!;
    // Three thank-you lines interrupt; «I owe you one» unlocks, the other two unlock and keep 8940.
    expect(p.lines.map((l) => [l.line, l.kinds]).sort()).toEqual([
      ['8942-D-Dialogue.mod', ['interrupt', 'unlocks']],
      ['8944-D-Dialogue.mod', ['interrupt', 'unlock but keep me']],
      ['8945-Dialogue.mod', ['interrupt', 'unlock but keep me']],
    ]);
    expect(dialogueUnlockers(ctx, '8950-Dialogue.mod')).toContain('8940-D-Dialogue.mod');
    const t40 = dialogueTransitions(ctx, buildDialogueGraph(ctx, '8940-D-Dialogue.mod'));
    expect(t40.exits.map((e) => e.dialogue)).toEqual(['8950-Dialogue.mod']);
    expect(dialogueUnlocks(ctx, '8940-D-Dialogue.mod')).toEqual(['8950-Dialogue.mod']);
  });
});
