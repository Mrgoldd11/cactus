/**
 * Ways into the game and «like the sample» on the installed game's files. Without the game the
 * tests are skipped. Reference: Book of Grace — sold by the Priest (vendor list «holy church»)
 * and by squad «flotsam refuge», Moll has it (special items of squad «flotsam hq»).
 */
import { describe, expect, it } from 'vitest';
import { addToLists, createRecordIn, sameListsAs, sampleOf, waysIntoGame, whereBrief, whereInGame } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const GRACE = '50383-Dialogue.mod';

describe.skipIf(!game)('ways into the game: vanilla', () => {
  const { ctx } = loadModContext({ paths });

  it('an item is sold, lies in the world, is carried; a race is counted', () => {
    const item = waysIntoGame(ctx.schema, 'ITEM').map((w) => `${w.sourceType}.${w.field}`);
    expect(item.slice(0, 2)).toEqual(['VENDOR_LIST.items', 'ITEM_PLACEMENT_GROUP.items']);
    expect(item).toContain('SQUAD_TEMPLATE.special items');
    expect(waysIntoGame(ctx.schema, 'RACE').every((w) => w.counted)).toBe(true);
    expect(waysIntoGame(ctx.schema, 'SQUAD_TEMPLATE').length).toBeGreaterThan(10);
  });

  it('a book made from Book of Grace gets into the same three lists in one undo step', () => {
    const brief = whereBrief(whereInGame(ctx, GRACE).facts, 'ru').parts;
    expect(brief).toContain('продаёт Жрец (holy church)');
    expect(brief).toContain('у Молл');
    const sid = createRecordIn(ctx, { type: ctx.get(GRACE)!.type, name: 'Test book', sample: GRACE });
    expect(sampleOf(ctx, sid)).toBe(GRACE);
    expect(whereInGame(ctx, sid).facts).toEqual([]);
    const slots = sameListsAs(ctx, sid, GRACE);
    expect(slots.map((s) => s.category).sort()).toEqual(['items', 'items', 'special items']);
    const steps = ctx.history().undo.length;
    addToLists(ctx, sid, slots, GRACE);
    expect(ctx.history().undo).toHaveLength(steps + 1);
    expect(whereBrief(whereInGame(ctx, sid).facts, 'ru').parts).toEqual(brief);
    ctx.undo();
    expect(whereInGame(ctx, sid).facts).toEqual([]);
  });
});
