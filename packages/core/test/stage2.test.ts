/**
 * Stage 2, core: enum names (built-in from C#, `enum shared` with numbers by name), dialogue
 * conditions and effects as text, enum input by name, record search by name, diff filter,
 * the "dialogue without lines" and "dangling reference" checks, permanent ids by name.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  buildCategoryTree,
  defaultValue,
  fieldRows,
  matchesCategory,
  refGroups,
  describeDialogAction,
  diffDataFiles,
  emptyRecord,
  encodeText,
  EditError,
  fieldEnum,
  FileType,
  filterDiffs,
  formatDiffSummary,
  formatEnumValue,
  getEnum,
  isVanillaLayer,
  itemTypeId,
  lookupRecord,
  ModContext,
  parseDiffStatuses,
  parseEnumValue,
  parseGameSchema,
  parseStableIds,
  removalMarker,
  StableIds,
  validateMod,
  type CategoryNode,
  type DataFile,
  type FieldRow,
  type GameRecord,
  type Layer,
  type Reference,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);
const CHAR = itemTypeId('CHARACTER')!;
const DIALOGUE = itemTypeId('DIALOGUE')!;
const LINE = itemTypeId('DIALOGUE_LINE')!;
const ACTION = itemTypeId('DIALOG_ACTION')!;
const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): Reference => ({ target, v0, v1, v2 });

function rec(type: number, sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(type, sid, b(name));
  fill(r);
  return r;
}

function file(records: GameRecord[]): DataFile {
  return {
    fileType: FileType.Mod,
    header: { version: 1, author: b(''), description: b(''), dependencies: b(''), references: b('') },
    lastId: 0,
    records,
    tail: new Uint8Array(),
  };
}

/** Vanilla: a character with dialogue D1 and an empty dialogue D0; condition "target: relation < 20". */
function vanilla(): Layer[] {
  const base = file([
    rec(CHAR, 'C', 'Guard', (r) => r.refs.set('dialogue', [ref('D1'), ref('D0')])),
    rec(DIALOGUE, 'D1', 'Guard talk', (r) => {
      r.ints.set('repetition limit', 5);
      r.refs.set('lines', [ref('L1')]);
    }),
    rec(DIALOGUE, 'D0', 'Empty talk'),
    rec(LINE, 'L1', 'Hello', (r) => r.refs.set('conditions', [ref('A1', 20)])),
    rec(ACTION, 'A1', 'cond', (r) => {
      r.ints.set('condition name', 1);
      r.ints.set('who', 1);
      r.ints.set('compare by', 1);
    }),
    rec(ACTION, 'A2', 'tag', (r) => {
      r.ints.set('condition name', 26);
      r.ints.set('tag', 1);
      r.ints.set('who', 0);
    }),
    rec(ACTION, 'E1', 'effect', (r) => r.ints.set('action name', 1)),
    rec(CHAR, 'S1', 'Same name'),
    rec(CHAR, 'S2', 'Same name'),
  ]);
  return [{ name: 'gamedata.base', file: base }];
}

const schema = parseGameSchema({
  fcsDef: ['[DIALOGUE]', 'general:', 'repetition limit: DialogRepetitionEnum.DR_NO_LIMIT', 'lines: DIALOGUE_LINE (0,0,0)', ''].join('\n'),
  // The order in the file does not match C#: numbers are taken by name.
  fcsEnums: ['enum shared DialogRepetitionEnum', '{', '  DR_ONCE_ONLY, // один раз', '  DR_NO_LIMIT', '  DR_MADE_UP', '}', ''].join('\n'),
});

const ctxOf = (layers: Layer[] = vanilla(), mod?: DataFile): ModContext =>
  new ModContext({ layers, modName: 'test.mod', schema, ...(mod ? { mod } : {}) });

describe('enums', () => {
  it('enum shared is numbered by names from C#, missing names are appended', () => {
    const e = schema.enums.get('DialogRepetitionEnum')!;
    const byName = Object.fromEntries(e.values.map((v) => [v.name, v.value]));
    expect(byName['DR_ONCE_ONLY']).toBe(5);
    expect(byName['DR_NO_LIMIT']).toBe(0);
    expect(byName['DR_LONG_1WEEK']).toBe(4);
    expect(e.values[0]!.name).toBe('DR_ONCE_ONLY');
    expect(schema.warnings.some((w) => w.message.includes('DR_MADE_UP'))).toBe(true);
  });

  it('built-in enums and the DIALOG_ACTION type without fcs.def', () => {
    expect(getEnum(undefined, 'TalkerEnum')?.values[1]?.name).toBe('T_TARGET');
    expect(schema.types.get('DIALOG_ACTION')?.builtin).toBe(true);
    expect(fieldEnum(schema, 'DIALOG_ACTION', 'who')?.name).toBe('TalkerEnum');
    expect(fieldEnum(schema, 'DIALOGUE', 'repetition limit')?.name).toBe('DialogRepetitionEnum');
  });

  it('name, name without prefix, label and number; showing a value', () => {
    const e = getEnum(schema, 'DialogRepetitionEnum')!;
    expect(parseEnumValue(e, 'DR_ONCE_ONLY')).toBe(5);
    expect(parseEnumValue(e, 'once_only')).toBe(5);
    expect(parseEnumValue(e, 'один раз')).toBe(5);
    expect(parseEnumValue(e, '3')).toBe(3);
    expect(parseEnumValue(e, 'nope')).toBeUndefined();
    expect(formatEnumValue(e, 5)).toBe('DR_ONCE_ONLY “once only” (5)');
    expect(formatEnumValue(e, 5, 'ru')).toBe('DR_ONCE_ONLY «один раз» (5)');
    expect(formatEnumValue(e, 5, 'zh')).toBe('DR_ONCE_ONLY “仅一次” (5)');
    expect(formatEnumValue(e, 99)).toBe('99 (not in DialogRepetitionEnum)');
    expect(formatEnumValue(e, 99, 'ru')).toBe('99 (нет в DialogRepetitionEnum)');
  });

  it('dialogue conditions and effects as text; tag by condition', () => {
    const ctx = ctxOf();
    expect(describeDialogAction(ctx, ref('A1', 20), 'conditions')).toBe('target: DC_RELATIONS < 20');
    expect(describeDialogAction(ctx, ref('A1', 20), 'conditions', 'ru')).toBe('собеседник: DC_RELATIONS < 20');
    expect(fieldEnum(schema, 'DIALOG_ACTION', 'tag', ctx.get('A2'))?.name).toBe('PersonalityTags');
    expect(describeDialogAction(ctx, ref('A2', 1), 'conditions')).toBe('me: DC_PERSONALITY_TAG PT_HONORABLE = 1');
    expect(describeDialogAction(ctx, ref('A2', 1), 'conditions', 'zh')).toBe('我: DC_PERSONALITY_TAG PT_HONORABLE = 1');
    expect(describeDialogAction(ctx, ref('E1'), 'effects')).toMatch(/^DA_/);
  });

  it('set accepts an enum value name; an unknown name — error', () => {
    const ctx = ctxOf();
    applyOps(ctx, [{ op: 'set', id: 'D1', field: 'repetition limit', value: 'DR_NO_LIMIT' }]);
    expect(ctx.get('D1')!.ints.get('repetition limit')).toBe(0);
    applyOps(ctx, [{ op: 'set', id: 'A1', field: 'who', value: 'T_ME' }]);
    expect(ctx.get('A1')!.ints.get('who')).toBe(0);
    expect(() => applyOps(ctx, [{ op: 'set', id: 'D1', field: 'repetition limit', value: 'never' }])).toThrow(EditError);
  });
});

describe('record by name', () => {
  it('id, exact name, substring; several — a list', () => {
    const ctx = ctxOf();
    expect(lookupRecord(ctx, 'D1').stringId).toBe('D1');
    expect(lookupRecord(ctx, 'guard talk').stringId).toBe('D1');
    expect(lookupRecord(ctx, 'Same name').candidates.map((h) => h.stringId)).toEqual(['S1', 'S2']);
    // "Guard" is an exact character name; without it a substring would give two.
    expect(lookupRecord(ctx, 'Guard').stringId).toBe('C');
    expect(lookupRecord(ctx, 'talk', { preferTypes: ['DIALOGUE'] }).candidates).toHaveLength(2);
    expect(lookupRecord(ctx, 'нет такого')).toEqual({ candidates: [] });
  });
});

describe('diff: filter and summary', () => {
  it('statuses, aliases, summary', () => {
    const a = file([rec(CHAR, 'X', 'x'), rec(CHAR, 'Y', 'y')]);
    const bFile = file([rec(CHAR, 'X', 'x2'), rec(CHAR, 'Z', 'z')]);
    const diffs = diffDataFiles(a, bFile);
    expect(formatDiffSummary(diffs)).toBe('total 3: new 1, changed 1, deleted 1');
    expect(formatDiffSummary(diffs, 'ru')).toBe('всего 3: новых 1, изменённых 1, удалённых 1');
    expect(parseDiffStatuses('new,deleted')).toEqual(['added', 'removed']);
    expect(filterDiffs(diffs, ['changed']).map((d) => d.stringId)).toEqual(['X']);
    expect(() => parseDiffStatuses('weird')).toThrow();
  });
});

describe('stage 2 checks', () => {
  it('dialogue without lines: own new one and a vanilla one the mod refers to', () => {
    const ctx = ctxOf();
    const sid = ctx.createRecord(DIALOGUE, 'Mine');
    ctx.addReference('S1', 'dialogue', 'D0');
    const issues = validateMod(ctx).filter((i) => i.code === 'empty-dialogue');
    expect(issues.map((i) => `${i.stringId}:${i.target ?? ''}`).sort()).toEqual([`${sid}:`, 'S1:D0'].sort());
  });

  it('dangling reference: a dependency deletes a dialogue vanilla refers to', () => {
    const dep = file([removalMarker(rec(DIALOGUE, 'D1', 'Guard talk'))]);
    const layers: Layer[] = [...vanilla(), { name: 'Other.mod', file: dep }];
    const ctx = ctxOf(layers);
    const issues = validateMod(ctx).filter((i) => i.code === 'dangling-ref');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ stringId: 'C', key: 'dialogue', target: 'D1', severity: 'warning' });
    expect(issues[0]!.message).toContain('Other.mod');
    // A deletion in vanilla itself is no reason for a warning.
    expect(isVanillaLayer('REBIRTH.MOD')).toBe(true);
  });
});

describe('permanent ids', () => {
  it('a number by name is given once; orphans; table check', () => {
    const ids = new StableIds('My.mod', { next: 102, ids: { old: 100, keep: 101 } });
    expect(ids.id('keep')).toBe('101-My.mod');
    expect(ids.id('new')).toBe('102-My.mod');
    expect(ids.id('new')).toBe('102-My.mod');
    expect(ids.added).toEqual(['new']);
    expect(ids.orphans()).toEqual(['old']);
    expect(ids.data.next).toBe(103);
    expect(parseStableIds('{"next":5,"ids":{"a":1}}')).toEqual({ next: 5, ids: { a: 1 } });
    expect(() => parseStableIds('{"next":1,"ids":{"a":1}}')).toThrow(/not less than next/);
    expect(() => parseStableIds('[]')).toThrow();
  });
});

describe('editor: categories, fields, references', () => {
  const ITEM = itemTypeId('ITEM')!;
  const s = parseGameSchema({
    fcsDef: [
      '[ITEM]',
      'item:',
      'kind: Kind.TOOL "Что это"',
      'mode: Kind.TOOL',
      'heavy: False',
      'extra: 1',
      'text0: "" looped',
      'condition "extra" if "mode" is Kind.FOOD',
      'condition "heavy" if "mode" not Kind.TOOL',
      'parts: ITEM (1, 2)',
      '',
    ].join('\n'),
    fcsEnums: ['enum Kind', '{', '  TOOL,', '  FOOD', '}', ''].join('\n'),
    fcsLayout: ['[FCS_LAYOUT]', 'Items:  ITEM "kind!=FOOD"', '\tFood:  ITEM "kind==FOOD"', '\tHeavy:  ITEM "heavy=true"', 'Everything:  NULL_ITEM', ''].join('\n'),
  });
  const base = file([
    rec(ITEM, 'T', 'Tool', (r) => {
      r.refs.set('parts', [ref('F', 1, 2), ref('H', 1, 2)]);
      r.strings.set('text2', b('x'));
    }),
    rec(ITEM, 'F', 'Food', (r) => r.ints.set('kind', 1)),
    rec(ITEM, 'H', 'Rock', (r) => r.bools.set('heavy', true)),
    rec(CHAR, 'C', 'Guy'),
  ]);
  const make = (): ModContext => new ModContext({ layers: [{ name: 'gamedata.base', file: base }], modName: 't.mod', schema: s });

  it('tree: filters by enum (with default) and bool, other types, all', () => {
    const ctx = make();
    const tree = buildCategoryTree(s, ['ITEM', 'CHARACTER']);
    expect(tree.map((n) => n.label)).toEqual(['Items', 'Everything', 'Other types']);
    const count = (n: CategoryNode): string[] => [...ctx.records()].filter((r) => matchesCategory(s, r, n)).map((r) => r.stringId);
    expect(count(tree[0]!)).toEqual(['T', 'H']);
    expect(count(tree[0]!.children[0]!)).toEqual(['F']);
    expect(count(tree[0]!.children[1]!)).toEqual(['H']);
    expect(count(tree[1]!)).toHaveLength(4);
    expect(count(tree[2]!)).toEqual([]);
    expect(tree[2]!.children.map((n) => n.type)).toEqual(['CHARACTER']);
  });

  it('fields: state, enum, conditions, repeated fields', () => {
    const ctx = make();
    ctx.setField('T', 'ints', 'mode', 1);
    ctx.setField('T', 'ints', 'extra', 5);
    const rows = fieldRows(ctx, 'T');
    const by = (k: string): FieldRow => rows.find((r) => r.key === k)!;
    expect(rows.map((r) => r.key)).toEqual(['kind', 'mode', 'heavy', 'extra', 'text0', 'text2']);
    expect(by('kind')).toMatchObject({ state: 'default', hidden: false, category: 'item' });
    expect(by('kind').enum?.name).toBe('Kind');
    expect(by('mode')).toMatchObject({ state: 'added', value: 1 });
    expect(by('extra').hidden).toBe(false);
    expect(by('heavy').hidden).toBe(false);
    expect(by('text2')).toMatchObject({ state: 'base', dict: 'strings' });
    expect(defaultValue(s, by('kind').def!)).toBe(0);
    ctx.undo();
    ctx.undo();
    const again = fieldRows(ctx, 'T');
    expect(again.find((r) => r.key === 'extra')!.hidden).toBe(true);
    expect(again.find((r) => r.key === 'heavy')!.hidden).toBe(true);
  });

  it('references: value labels, added, changed, removed', () => {
    const ctx = make();
    ctx.removeReference('T', 'parts', 'H');
    ctx.addReference('T', 'parts', 'C');
    ctx.setReferences('T', 'parts', [ref('F', 9, 2), ref('C', 1, 2)]);
    const g = refGroups(ctx, 'T').find((x) => x.category === 'parts')!;
    expect(g.targetType).toBe('ITEM');
    expect(g.valueLabels).toEqual(['v0', 'v1']);
    expect(g.rows.map((r) => `${r.ref.target}:${r.state}`)).toEqual(['F:changed', 'C:added', 'H:removed']);
    expect(g.rows[0]!.lower).toMatchObject({ v0: 1 });
    expect(g.rows[1]).toMatchObject({ targetName: 'Guy', targetType: 'CHARACTER', targetStatus: 'base' });
  });
});
