/**
 * «+ New» in a category on the installed game's files: a new book (empty or from Book Of Grace)
 * stays in Books and leaves Items; a new building in the Buildings root stays there.
 * Without the game the tests are skipped.
 */
import { describe, expect, it } from 'vitest';
import { buildCategoryTree, createRecordIn, matchesCategory, type CategoryNode } from '../src/index.ts';
import { hasGame, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const BOOK_OF_GRACE = '50383-Dialogue.mod';

describe.skipIf(!game)('новая запись в категории: игра', () => {
  const { ctx } = loadModContext({ paths, po: false });
  const tree = buildCategoryTree(ctx.schema, []);
  const items = tree.find((n) => n.label === 'Items')!;
  const books = items.children.find((n) => n.label === 'Books')!;
  const buildings = tree.find((n) => n.label === 'Buildings')!;
  const inNode = (sid: string, n: CategoryNode): boolean => matchesCategory(ctx.schema, ctx.get(sid)!, n);

  it('Books: an empty record and a copy of Book Of Grace are books', () => {
    expect(inNode(BOOK_OF_GRACE, books)).toBe(true);
    const empty = createRecordIn(ctx, { type: ctx.typeId('ITEM')!, name: 'Test book', filters: books.filters });
    expect(inNode(empty, books)).toBe(true);
    expect(inNode(empty, items)).toBe(false);
    const copy = createRecordIn(ctx, { type: ctx.typeId('ITEM')!, name: 'Test book 2', sample: BOOK_OF_GRACE, filters: books.filters });
    expect(inNode(copy, books)).toBe(true);
    expect(ctx.get(copy)!.ints.get('value')).toBe(ctx.get(BOOK_OF_GRACE)!.ints.get('value'));
    ctx.undo();
    ctx.undo();
  });

  it('Buildings root (only != filters): an empty building stays in the root', () => {
    const sid = createRecordIn(ctx, { type: ctx.typeId('BUILDING')!, name: 'Test hut', filters: buildings.filters });
    expect(inNode(sid, buildings)).toBe(true);
    ctx.undo();
  });
});
