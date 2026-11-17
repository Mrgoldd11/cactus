/**
 * «+ New» in a category: the category filters are put on the new record (it stays in the
 * category), a sample is copied (fields and references, new name and id), one undo step with a
 * clear history title; the sample offered by default.
 */
import { describe, expect, it } from 'vitest';
import {
  applyLayoutFilters,
  buildCategoryTree,
  createRaceFrom,
  createRecordIn,
  defaultSample,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  matchesCategory,
  ModContext,
  parseGameSchema,
  parseLayoutFilter,
  parsePo,
  type CategoryNode,
  type DataFile,
  type GameRecord,
} from '../src/index.ts';

const ITEM = itemTypeId('ITEM')!;
const RACE = itemTypeId('RACE')!;
const BUILDING = itemTypeId('BUILDING')!;

const schema = parseGameSchema({
  fcsDef: [
    '[ITEM]',
    'item:',
    'kind: Kind.TOOL "What it is"',
    'heavy: False',
    'value: 1',
    'icon: "" (*.dds) "Icon"',
    'weight: 1.5',
    'material: ""',
    'parts: ITEM (1, 2)',
    '[BUILDING]',
    'building:',
    'category: Cat.DOORS',
    'is node: False',
    '[RACE]',
    'race:',
    'speed: 1.0',
    '',
  ].join('\n'),
  fcsEnums: ['enum Kind', '{', '  TOOL,', '  FOOD,', '  BOOK', '}', 'enum Cat', '{', '  DOORS,', '  WALLS,', '  OTHER', '}', ''].join('\n'),
  fcsLayout: [
    '[FCS_LAYOUT]',
    'Items:  ITEM "kind!=BOOK"',
    '\tBooks:  ITEM "kind=BOOK"',
    '\tHeavy:  ITEM "heavy=true;material==stone"',
    'Buildings:  BUILDING "category!=DOORS;is node=false"',
    '\tNodes:  BUILDING "is node=true"',
    'Races:  RACE',
    'Everything:  NULL_ITEM',
    '',
  ].join('\n'),
});

function rec(type: number, sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(type, sid, encodeText(name));
  fill(r);
  return r;
}

const base = (): DataFile => ({
  fileType: FileType.Data,
  lastId: 0,
  tail: new Uint8Array(),
  records: [
    rec(ITEM, 'tmpl', '_LETTER TEMPLATE', (r) => r.ints.set('kind', 2)),
    rec(ITEM, 'grace', 'Book Of Grace', (r) => {
      r.ints.set('kind', 2);
      r.ints.set('value', 400);
      r.files.set('icon', encodeText('gui/icons/book.dds'));
      r.refs.set('parts', [{ target: 'tool', v0: 3, v1: 0, v2: 0 }]);
    }),
    rec(ITEM, 'tool', 'Hammer'),
    rec(BUILDING, 'door', 'Door', (r) => r.ints.set('category', 0)),
    rec(RACE, 'gl', 'Greenlander'),
  ],
});

const po = parsePo(['#: grace', 'msgid "Book Of Grace"', 'msgstr "Книга благодати"', '', '#: gl', 'msgid "Greenlander"', 'msgstr "Зеленоземец"', ''].join('\n'));

const make = (withPo = false): ModContext =>
  new ModContext({ layers: [{ name: 'gamedata.base', file: base() }], modName: 'T.mod', schema, ...(withPo ? { po } : {}) });

const tree = buildCategoryTree(schema, ['ITEM', 'BUILDING', 'RACE']);
const node = (path: string): CategoryNode => {
  const find = (list: CategoryNode[]): CategoryNode | undefined => {
    for (const n of list) {
      if (n.id === path) return n;
      const c = find(n.children);
      if (c) return c;
    }
    return undefined;
  };
  return find(tree)!;
};

describe('category filters on a new record', () => {
  it('== sets enum, bool and string values; != drops a violating value back to the default', () => {
    const r = emptyRecord(ITEM, 'x', encodeText('X'));
    expect(applyLayoutFilters(schema, r, parseLayoutFilter('kind=BOOK'))).toEqual([]);
    expect(r.ints.get('kind')).toBe(2);
    expect(applyLayoutFilters(schema, r, parseLayoutFilter('heavy=true;material==stone'))).toEqual([]);
    expect(r.bools.get('heavy')).toBe(true);
    expect(new TextDecoder().decode(r.strings.get('material'))).toBe('stone');
    // `!=` met by the default is left alone; a violating value goes.
    expect(applyLayoutFilters(schema, r, parseLayoutFilter('kind!=BOOK'))).toEqual([]);
    expect(r.ints.has('kind')).toBe(false);
  });

  it('a filter that cannot be met is reported, not guessed', () => {
    const b = emptyRecord(BUILDING, 'b', encodeText('B'));
    // The default category is DOORS: dropping the field does not help with `!=`.
    expect(applyLayoutFilters(schema, b, parseLayoutFilter('category!=DOORS')).map((f) => f.field)).toEqual(['category']);
    const i = emptyRecord(ITEM, 'i', encodeText('I'));
    expect(applyLayoutFilters(schema, i, parseLayoutFilter('kind=NO_SUCH_VALUE')).map((f) => f.value)).toEqual(['NO_SUCH_VALUE']);
  });
});

describe('createRecordIn', () => {
  it('empty record in Books is a book: stays in the category, one undo', () => {
    const ctx = make();
    const books = node('Items/Books');
    const sid = createRecordIn(ctx, { type: ITEM, name: ' My book ', filters: books.filters });
    const r = ctx.get(sid)!;
    expect(ctx.name(sid)).toBe('My book');
    expect(r.ints.get('kind')).toBe(2);
    expect(matchesCategory(schema, r, books)).toBe(true);
    expect(matchesCategory(schema, r, node('Items'))).toBe(false);
    expect(ctx.history().undo).toHaveLength(1);
    expect(describeChangeset(ctx, ctx.history().undo[0]!).text.en).toBe('Created record “My book”');
    ctx.undo();
    expect(ctx.get(sid)).toBeUndefined();
  });

  it('copy of a sample: fields and references, new name and id, category filters on top, one undo', () => {
    const ctx = make(true);
    const sid = createRecordIn(ctx, { type: ITEM, name: 'My book', sample: 'grace', filters: node('Items/Books').filters });
    expect(sid).not.toBe('grace');
    const r = ctx.get(sid)!;
    expect(ctx.name(sid)).toBe('My book');
    expect(r.ints.get('value')).toBe(400);
    expect(new TextDecoder().decode(r.files.get('icon'))).toBe('gui/icons/book.dds');
    expect(r.refs.get('parts')).toEqual([{ target: 'tool', v0: 3, v1: 0, v2: 0 }]);
    expect(ctx.status(sid)).toBe('new');
    expect(ctx.status('grace')).toBe('base');
    expect(ctx.history().undo).toHaveLength(1);
    const step = describeChangeset(ctx, ctx.history().undo[0]!);
    expect(step.text.ru).toBe('Новая запись «My book» по образцу «Книга благодати»');
    expect(step.text.en).toBe('New record “My book” based on “Book Of Grace”');

    // A sample from elsewhere still lands in the category: the filters are applied over the copy.
    const nodeSid = createRecordIn(ctx, { type: ITEM, name: 'Heavy hammer', sample: 'tool', filters: node('Items/Heavy').filters });
    expect(matchesCategory(schema, ctx.get(nodeSid)!, node('Items/Heavy'))).toBe(true);
    expect(ctx.history().undo).toHaveLength(2);
    ctx.undo();
    ctx.undo();
    expect(ctx.get(sid)).toBeUndefined();
  });

  it('refuses a missing name, a sample of another type or a missing sample, leaving no history', () => {
    const ctx = make();
    expect(() => createRecordIn(ctx, { type: ITEM, name: '  ' })).toThrow(/Enter a name/);
    expect(() => createRecordIn(ctx, { type: ITEM, name: 'X', sample: 'door' })).toThrow(/not ITEM/);
    expect(() => createRecordIn(ctx, { type: ITEM, name: 'X', sample: 'nope' })).toThrow(/not found/);
    expect(ctx.history().undo).toHaveLength(0);
  });

  it('default sample: the selected record of the category, else the first one that is not a template', () => {
    const ctx = make();
    const books = ['tmpl', 'grace'];
    expect(defaultSample(ctx, books, 'grace')).toBe('grace');
    expect(defaultSample(ctx, books, 'tool')).toBe('grace');
    expect(defaultSample(ctx, books)).toBe('grace');
    expect(defaultSample(ctx, ['tmpl'])).toBe('tmpl');
    ctx.deleteRecord('grace');
    expect(defaultSample(ctx, books, 'grace')).toBe('tmpl');
    expect(defaultSample(ctx, [])).toBeUndefined();
  });
});

describe('new race history title', () => {
  it('names the sample in the data language', () => {
    const ctx = make(true);
    createRaceFrom(ctx, 'gl', 'Mossfolk');
    const step = describeChangeset(ctx, ctx.history().undo[0]!);
    expect(step.text.ru).toBe('Новая раса «Mossfolk» на основе «Зеленоземец»');
    expect(step.text.en).toBe('New race «Mossfolk» based on «Greenlander»');
  });
});
