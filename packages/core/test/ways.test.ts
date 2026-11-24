/**
 * Ways into the game from the schema (which types take a type in, through which field, in plain
 * words or the generic «type · field»), the short «in game» line, the lists a sample is in and
 * adding a record to them as one undo step with a clear title; the sample of a new record.
 */
import { describe, expect, it } from 'vitest';
import {
  addToLists,
  countedUses,
  createRecordIn,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  ModContext,
  parseGameSchema,
  parsePo,
  sameListsAs,
  sampleOf,
  uiText,
  waysIntoGame,
  wayText,
  whereBrief,
  whereInGame,
  type DataFile,
  type GameRecord,
} from '../src/index.ts';

const id = (t: string): number => itemTypeId(t)!;

const schema = parseGameSchema({
  fcsDef: [
    '[ITEM]',
    'item:',
    'value: 1',
    '[CHARACTER]',
    'character:',
    'race: RACE',
    'inventory: ITEM (1)',
    '[RACE]',
    'race:',
    'speed: 1.0',
    '[VENDOR_LIST]',
    'vendor:',
    'items: ITEM (100, 0, 0)',
    '[SQUAD_TEMPLATE]',
    'squad:',
    'vendors: VENDOR_LIST',
    'special items: ITEM (1)',
    'leader: CHARACTER',
    '[FACTION]',
    'faction:',
    'squads: SQUAD_TEMPLATE',
    '[ITEM_PLACEMENT_GROUP]',
    'group:',
    'items: ITEM (1)',
    '',
  ].join('\n'),
  fcsEnums: '',
  fcsLayout: '[FCS_LAYOUT]\nItems:  ITEM\n',
});

function rec(type: string, sid: string, name: string, refs: Record<string, [string, number][]> = {}): GameRecord {
  const r = emptyRecord(id(type), sid, encodeText(name));
  for (const [cat, list] of Object.entries(refs)) r.refs.set(cat, list.map(([target, v0]) => ({ target, v0, v1: 0, v2: 0 })));
  return r;
}

const base = (): DataFile => ({
  fileType: FileType.Data,
  lastId: 0,
  tail: new Uint8Array(),
  records: [
    rec('ITEM', 'grace', 'Book Of Grace'),
    rec('ITEM', 'other', 'Other Book'),
    rec('RACE', 'gl', 'Greenlander'),
    rec('CHARACTER', 'priest', 'Priest', { race: [['gl', 0]] }),
    rec('CHARACTER', 'moll', 'Moll', { race: [['gl', 0]] }),
    rec('VENDOR_LIST', 'holy', 'holy church', { items: [['grace', 70]] }),
    rec('VENDOR_LIST', 'lore', 'Lore Notes', { items: [['grace', 30], ['other', 5]] }),
    rec('SQUAD_TEMPLATE', 'hp', 'Holy Priest church', { vendors: [['holy', 0]], leader: [['priest', 0]] }),
    rec('SQUAD_TEMPLATE', 'refuge', 'flotsam refuge', { vendors: [['lore', 0]] }),
    rec('SQUAD_TEMPLATE', 'hq', 'flotsam hq', { 'special items': [['grace', 1]], leader: [['moll', 0]] }),
  ],
});

const po = parsePo(['#: grace', 'msgid "Book Of Grace"', 'msgstr "Книга благодати"', '', '#: priest', 'msgid "Priest"', 'msgstr "Жрец"', '', '#: moll', 'msgid "Moll"', 'msgstr "Молл"', ''].join('\n'));

const make = (): ModContext => new ModContext({ layers: [{ name: 'gamedata.base', file: base() }], modName: 'T.mod', schema, po });

describe('waysIntoGame', () => {
  it('an item: every schema field that takes it upward, common ways first and in plain words', () => {
    const ways = waysIntoGame(schema, 'ITEM');
    expect(ways.map((w) => `${w.sourceType}.${w.field}`)).toEqual(['VENDOR_LIST.items', 'ITEM_PLACEMENT_GROUP.items', 'CHARACTER.inventory', 'SQUAD_TEMPLATE.special items']);
    expect(ways.every((w) => w.plain && w.action !== undefined)).toBe(true);
    const sold = ways[0]!;
    expect(sold.role).toBe('sold');
    expect(uiText(sold.title, 'ru')).toBe('Продаётся у торговца');
    expect(uiText(sold.action!, 'en')).toBe('Add to a vendor list…');
    expect(wayText(sold.same, 'holy church', 'ru')).toBe('Добавить в тот же список «holy church»');
    expect(uiText(ways[3]!.title, 'zh')).toBe('小队开局即持有');
  });

  it('a type without plain words gets «type · field»; a race is counted, not added to', () => {
    const squad = waysIntoGame(schema, 'SQUAD_TEMPLATE');
    expect(squad).toHaveLength(1);
    expect(squad[0]!.plain).toBe(false);
    expect(uiText(squad[0]!.title, 'ru')).toBe('Фракция · squads');
    expect(uiText(squad[0]!.title, 'en')).toBe('Faction · squads');
    expect(squad[0]!.action).toBeDefined();
    const race = waysIntoGame(schema, 'RACE');
    expect(race.map((w) => `${w.sourceType}.${w.field}`)).toEqual(['CHARACTER.race']);
    expect(race[0]!.counted).toBe(true);
    expect(race[0]!.action).toBeUndefined();
    expect(countedUses(make(), 'gl', race).map((c) => c.count)).toEqual([2]);
    // Nothing takes a vendor list's owner type in this schema.
    expect(waysIntoGame(schema, 'FACTION')).toEqual([]);
    expect(waysIntoGame(undefined, 'ITEM')).toEqual([]);
  });
});

describe('whereBrief', () => {
  it('who sells it (which list) and who has it, in the UI language', () => {
    const ctx = make();
    const facts = whereInGame(ctx, 'grace').facts;
    expect(whereBrief(facts, 'ru').parts).toEqual(['продаёт отряд «flotsam refuge» (Lore Notes)', 'продаёт Жрец (holy church)', 'у Молл']);
    expect(whereBrief(facts, 'en', 1)).toEqual({ parts: ['sold by squad “flotsam refuge” (Lore Notes)'], more: 2 });
    expect(whereBrief([], 'ru')).toEqual({ parts: [], more: 0 });
  });
});

describe('the same lists as the sample', () => {
  it('a book made from Book of Grace: nowhere, then in all three lists of the sample in one undo step', () => {
    const ctx = make();
    const sid = createRecordIn(ctx, { type: id('ITEM'), name: 'My book', sample: 'grace' });
    expect(sampleOf(ctx, sid)).toBe('grace');
    expect(whereInGame(ctx, sid).facts).toEqual([]);
    const slots = sameListsAs(ctx, sid, 'grace');
    expect(slots).toEqual([
      { source: 'holy', category: 'items', values: [70, 0, 0] },
      { source: 'lore', category: 'items', values: [30, 0, 0] },
      { source: 'hq', category: 'special items', values: [1, 0, 0] },
    ]);
    const steps = ctx.history().undo.length;
    expect(addToLists(ctx, sid, slots, 'grace')).toBe(3);
    expect(ctx.history().undo).toHaveLength(steps + 1);
    // The values of the sample are copied.
    expect(ctx.get('holy')!.refs.get('items')!.find((r) => r.target === sid)!.v0).toBe(70);
    expect(whereBrief(whereInGame(ctx, sid).facts, 'ru').parts).toEqual(whereBrief(whereInGame(ctx, 'grace').facts, 'ru').parts);
    expect(sameListsAs(ctx, sid, 'grace')).toEqual([]);
    const title = describeChangeset(ctx, ctx.history().undo.at(-1)!);
    expect(title.text.ru).toBe('В игру: «My book» → туда же, где «Книга благодати» (мест: 3)');
    expect(title.text.en).toBe('Into the game: “My book” → same places as “Book Of Grace” (places: 3)');
    ctx.undo();
    expect(whereInGame(ctx, sid).facts).toEqual([]);
    expect(ctx.get('holy')!.refs.get('items')!.some((r) => r.target === sid)).toBe(false);
  });

  it('one list: a clear title; already there — nothing changes; a field that does not take the type — an error', () => {
    const ctx = make();
    expect(addToLists(ctx, 'other', [{ source: 'holy', category: 'items' }])).toBe(1);
    // Schema default values for a list picked by hand.
    expect(ctx.get('holy')!.refs.get('items')!.find((r) => r.target === 'other')!.v0).toBe(100);
    expect(describeChangeset(ctx, ctx.history().undo.at(-1)!).text.ru).toBe('В игру: «Other Book» → в «holy church» (items)');
    expect(addToLists(ctx, 'other', [{ source: 'lore', category: 'items' }])).toBe(0);
    // Ids with spaces (a mod named «My Mod») read back as well.
    const mine = createRecordIn(ctx, { type: id('ITEM'), name: 'Mine', stringId: '1-My Mod.mod' });
    addToLists(ctx, mine, [{ source: 'holy', category: 'items' }]);
    expect(describeChangeset(ctx, ctx.history().undo.at(-1)!).text.en).toBe('Into the game: “Mine” → to “holy church” (items)');
    expect(() => addToLists(ctx, 'other', [{ source: 'hp', category: 'vendors' }])).toThrow(/does not take ITEM/);
    expect(() => addToLists(ctx, 'other', [{ source: 'nope', category: 'items' }])).toThrow(/No record nope/);
  });

  it('a copy knows its sample; an undone or empty creation does not', () => {
    const ctx = make();
    const copy = ctx.duplicateRecord('grace', { name: 'Copy' });
    expect(sampleOf(ctx, copy)).toBe('grace');
    const empty = createRecordIn(ctx, { type: id('ITEM'), name: 'Empty' });
    expect(sampleOf(ctx, empty)).toBeUndefined();
    expect(sampleOf(ctx, 'grace')).toBeUndefined();
    ctx.undo();
    ctx.undo();
    expect(sampleOf(ctx, copy)).toBeUndefined();
  });
});
