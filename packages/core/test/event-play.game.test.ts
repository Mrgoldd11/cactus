/**
 * G7 «▶ Play» strip on the installed game: acid rain (62) in «player character default».
 */
import { describe, expect, it } from 'vitest';
import { dialoguePlaySpots, eventDialogueLike, packagePlayStart, playCandidates, playConversation } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const PCD = '5369-gamedata.base';

describe.skipIf(!hasGame(paths))('play strip: vanilla', () => {
  it('acid rain: the spot, the candidates by key and the draft «like this one»', () => {
    const { ctx } = loadModContext({ paths, schema: true });
    expect(dialoguePlaySpots(ctx, '55630-rebirth.mod')).toContainEqual({ event: 62, pkg: PCD, dialog: '55630-rebirth.mod' });
    const start = packagePlayStart(ctx, PCD, 62);
    const play = playConversation(ctx, PCD, { event: 62, start });
    const c = playCandidates(ctx, play.steps[0]!.options);
    expect(c.rows.map((r) => [r.sid, r.key])).toEqual([
      ['55661-Dialogue.mod', 6],
      ['55630-rebirth.mod', 0],
    ]);
    expect(c.chosen).toBe('55661-Dialogue.mod');
    expect(c.tie).toEqual([]);
    expect(play.steps[0]!.said).toBeDefined();
    const like = eventDialogueLike(ctx, '55661-Dialogue.mod')!;
    expect(like.when).toHaveLength(2);
    expect(like.lines.length).toBeGreaterThan(0);
  });
});
