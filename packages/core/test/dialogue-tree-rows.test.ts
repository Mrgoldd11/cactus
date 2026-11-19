/**
 * Rows of the «Tree (as in FCS)» view (UI review G5, `model/dialogue-tree-rows.ts`): order, depth, link
 * rows for loops and shared lines, folding; on a synthetic graph and on «Healed (Recruit)» of the game.
 */
import { describe, expect, it } from 'vitest';
import { buildDialogueGraph, dialogueDeepFolds, dialogueTreeAncestors, dialogueTreeRows, type DialogueGraph, type DialogueGraphNode } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const node = (id: string, type = 'DIALOGUE_LINE'): DialogueGraphNode => ({ id, type, name: id, texts: [], choice: false, conditions: [], effects: [], filters: [], depth: 0, issues: [] });

/** D → [A, B]; A → [A1, S]; B → [S, D (loop)]; S shared by A and B; A1 → A (loop). */
function graph(): DialogueGraph {
  const e = (source: string, target: string, order: number, back = false) => ({ id: `${source}>${target}`, source, target, category: 'lines' as const, order, back });
  return {
    root: 'D',
    nodes: ['D', 'A', 'B', 'A1', 'S'].map((id) => node(id, id === 'D' ? 'DIALOGUE' : 'DIALOGUE_LINE')),
    // Edges listed out of order: rows follow `order`.
    edges: [e('D', 'B', 1), e('D', 'A', 0), e('A', 'S', 1), e('A', 'A1', 0), e('A1', 'A', 0, true), e('B', 'S', 0, true), e('B', 'D', 1, true)],
    issues: [],
  };
}

describe('dialogue tree rows', () => {
  it('reads the graph top to bottom, each node once, other links as link rows', () => {
    const rows = dialogueTreeRows(graph());
    expect(rows.map((r) => [r.id, r.depth, r.link ?? '', r.kids])).toEqual([
      ['D', 0, '', 2],
      ['A', 1, '', 2],
      ['A1', 2, '', 1],
      ['A', 3, 'loop', 0],
      ['S', 2, '', 0],
      ['B', 1, '', 2],
      ['S', 2, 'shared', 0],
      ['D', 2, 'loop', 0],
    ]);
    expect(rows[1]).toMatchObject({ parent: 'D', edge: 'D>A' });
  });

  it('folding hides the rows below, a hidden line is not shown again elsewhere', () => {
    const rows = dialogueTreeRows(graph(), new Set(['A']));
    expect(rows.map((r) => `${r.id}${r.link ? `:${r.link}` : ''}`)).toEqual(['D', 'A', 'B', 'S:shared', 'D:loop']);
    expect(rows[1]).toMatchObject({ folded: true, kids: 2 });
    // A leaf cannot be folded.
    expect(dialogueTreeRows(graph(), new Set(['S'])).find((r) => r.id === 'S')!.folded).toBe(false);
  });

  it('ancestors and deep folds', () => {
    expect(dialogueTreeAncestors(graph(), 'A1')).toEqual(['A', 'D']);
    expect(dialogueTreeAncestors(graph(), 'D')).toEqual([]);
    expect([...dialogueDeepFolds(graph(), 1)]).toEqual(['A']);
    expect(dialogueDeepFolds(graph(), 3).size).toBe(0);
  });
});

const paths = resolveGamePaths();

describe.skipIf(!hasGame(paths))('dialogue tree rows: vanilla', () => {
  it('Healed (Recruit): 24 rows, the honourable line under the dialogue, its answers under it', () => {
    const { ctx } = loadModContext({ paths, schema: true });
    const g = buildDialogueGraph(ctx, '8950-Dialogue.mod', { lang: 'ru' });
    const rows = dialogueTreeRows(g);
    const whole = rows.filter((r) => r.link === undefined);
    expect(whole).toHaveLength(g.nodes.length);
    expect(new Set(whole.map((r) => r.id)).size).toBe(g.nodes.length);
    expect(rows[0]).toMatchObject({ id: '8950-Dialogue.mod', depth: 0 });
    const honourable = rows.find((r) => r.id === '8951-Dialogue.mod')!;
    expect(honourable).toMatchObject({ depth: 1, parent: '8950-Dialogue.mod' });
    expect(rows.find((r) => r.id === '8952-Dialogue.mod')).toMatchObject({ depth: 2, parent: '8951-Dialogue.mod' });
    // The default folding of the graph closes some rows of the tree too.
    const folds = dialogueDeepFolds(g);
    expect(folds.size).toBeGreaterThan(0);
    expect(dialogueTreeRows(g, folds).length).toBeLessThan(rows.length);
  });
});
