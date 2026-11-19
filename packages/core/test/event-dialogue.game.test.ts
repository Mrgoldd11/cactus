/**
 * «Dialogue on event» (G6) on the installed game: a Shek line on acid rain for the player characters.
 */
import { describe, expect, it } from 'vitest';
import { chooseRanking, createEventDialogue, eventDialogueScore, packageDialogs, packageHolders } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const PCD = '5369-gamedata.base';
const SHEK = '5276-chareditor.mod';

describe.skipIf(!hasGame(paths))('event dialogue: vanilla', () => {
  it('acid rain (62) in «player character default»: the race line goes first', () => {
    const { ctx } = loadModContext({ paths, schema: true });
    // The package's own «acid rain» (key 0) and the inherited «Acid rain tough reaction» of
    // «Player TOUGH Merc»: 2 conditions + a root line with 4 conditions = key 6.
    const spec = {
      event: 62,
      who: { kind: 'package' as const, pkg: PCD },
      race: SHEK,
      name: 'acid rain (Shek)',
      lines: [{ speaker: 0, texts: ['Acid! Even Shek hide does not hold it.'] }],
    };
    const s = eventDialogueScore(ctx, spec);
    expect(s.rivals.map((r) => [r.dialog, r.pkg, r.key])).toEqual([
      ['55661-Dialogue.mod', '19504-Dialogue.mod', 6],
      ['55630-rebirth.mod', PCD, 0],
    ]);
    expect(s).toMatchObject({ best: 6, base: 0, conditional: true, autoBonus: 7, key: 7, outcome: 'first', outcomeWithout: 'shadowed' });
    expect(packageHolders(ctx, PCD)).toHaveLength(6);
    const r = createEventDialogue(ctx, spec);
    expect(ctx.get(r.dialog)!.ints.get('score bonus')).toBe(7);
    const onEvent = packageDialogs(ctx, PCD).filter((d) => d.event === 62).map((d) => d.dialog);
    expect(chooseRanking(ctx, onEvent).map((x) => [x.sid, x.key])).toEqual([
      [r.dialog, 7],
      ['55661-Dialogue.mod', 6],
      ['55630-rebirth.mod', 0],
    ]);
  });
});
