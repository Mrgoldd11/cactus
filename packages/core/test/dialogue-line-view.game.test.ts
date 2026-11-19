/**
 * Node views of the «line = node» dialogue graph (G2) on the installed game: «Healed (Recruit)».
 */
import { describe, expect, it } from 'vitest';
import { buildDialogueGraph, dialogueChecks, dialogueLineViews } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();

describe.skipIf(!hasGame(paths))('dialogue line views: vanilla', () => {
  it('Healed (Recruit): kinds, checking order, phrases, badges', () => {
    const { ctx } = loadModContext({ paths, schema: true });
    const g = buildDialogueGraph(ctx, '8950-Dialogue.mod', { lang: 'ru' });
    const v = dialogueLineViews(ctx, g, 'ru');
    // One dialogue: the head and 23 lines (8940 «Healed (Recruit)» that hands over to it has 7 more).
    expect(g.nodes).toHaveLength(24);
    expect(buildDialogueGraph(ctx, '8940-D-Dialogue.mod').nodes).toHaveLength(7);
    const head = v.get('8950-Dialogue.mod')!;
    expect(head.kind).toBe('head');
    expect(head.badges.map((b) => b.code)).toEqual(['locked=true', 'chance temporary=30', 'repetition limit=DR_MEDIUM_6']);
    expect(head.badges.map((b) => b.label)).toEqual(['заперт', 'шанс 30%', 'не чаще: 6 ч']);
    expect(head.conditions.map((c) => c.code)).toEqual(['DC_IS_IMPRISONED = 0', 'DC_IS_IMPRISONED = 0', 'DC_IS_RECRUITABLE = 1']);
    // Three conditions score more than one: «I owe you» is tried first, the honourable line second.
    expect(v.get('8956-Dialogue.mod')).toMatchObject({ kind: 'npc', order: 1 });
    expect(v.get('8951-Dialogue.mod')).toMatchObject({ kind: 'npc', order: 2 });
    expect(v.get('8951-Dialogue.mod')!.tie).toBeUndefined();
    expect(v.get('8951-Dialogue.mod')!.effects.map((e) => e.code)).toEqual(['DA_LOCK_THIS_DIALOG']);
    expect(v.get('8952-Dialogue.mod')).toMatchObject({ kind: 'player', speakerCode: 'T_TARGET' });
    expect(v.get('8952-Dialogue.mod')!.order).toBeUndefined();
    // A single NPC answer has no number; default properties give no badges.
    expect(v.get('8954-Dialogue.mod')!.order).toBeUndefined();
    expect(v.get('8954-Dialogue.mod')!.badges).toEqual([]);
    // Answers without a continuation end the conversation.
    const ends = dialogueChecks(ctx, g).filter((c) => c.kind === 'end').map((c) => c.node);
    expect(ends.sort()).toEqual(['8959-Dialogue.mod', '8988-Dialogue.mod', '8989-Dialogue.mod']);
    // Equal sort keys are ties: the list position decides.
    const g40 = buildDialogueGraph(ctx, '8940-D-Dialogue.mod', { lang: 'ru' });
    const v40 = dialogueLineViews(ctx, g40, 'ru');
    expect(['8941-D-Dialogue.mod', '8943-D-Dialogue.mod', '8945-D-Dialogue.mod'].map((s) => [v40.get(s)!.order, v40.get(s)!.tie])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
    expect(v40.get('8940-D-Dialogue.mod')!.badges.map((b) => b.label)).toEqual(['шанс 10%', 'есть у 1%', 'не чаще: неделя']);
  });
});
