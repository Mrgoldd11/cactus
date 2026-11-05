/**
 * Этап 2, ядро: имена enum (встроенные из C#, `enum shared` с номерами по имени), условия и
 * действия диалога текстом, ввод enum по имени, поиск записи по имени, фильтр diff,
 * проверки «диалог без реплик» и «висячая ссылка», постоянные id по имени.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOps,
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
  type DataFile,
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

/** Ваниль: персонаж с диалогом D1 и пустым диалогом D0; условие «собеседник: отношения < 20». */
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
  // Порядок в файле не совпадает с C#: номера берутся по имени.
  fcsEnums: ['enum shared DialogRepetitionEnum', '{', '  DR_ONCE_ONLY, // один раз', '  DR_NO_LIMIT', '  DR_MADE_UP', '}', ''].join('\n'),
});

const ctxOf = (layers: Layer[] = vanilla(), mod?: DataFile): ModContext =>
  new ModContext({ layers, modName: 'test.mod', schema, ...(mod ? { mod } : {}) });

describe('перечисления', () => {
  it('enum shared нумеруется по именам из C#, недостающие имена дописываются', () => {
    const e = schema.enums.get('DialogRepetitionEnum')!;
    const byName = Object.fromEntries(e.values.map((v) => [v.name, v.value]));
    expect(byName['DR_ONCE_ONLY']).toBe(5);
    expect(byName['DR_NO_LIMIT']).toBe(0);
    expect(byName['DR_LONG_1WEEK']).toBe(4);
    expect(e.values[0]!.name).toBe('DR_ONCE_ONLY');
    expect(schema.warnings.some((w) => w.message.includes('DR_MADE_UP'))).toBe(true);
  });

  it('встроенные enum и тип DIALOG_ACTION без fcs.def', () => {
    expect(getEnum(undefined, 'TalkerEnum')?.values[1]?.name).toBe('T_TARGET');
    expect(schema.types.get('DIALOG_ACTION')?.builtin).toBe(true);
    expect(fieldEnum(schema, 'DIALOG_ACTION', 'who')?.name).toBe('TalkerEnum');
    expect(fieldEnum(schema, 'DIALOGUE', 'repetition limit')?.name).toBe('DialogRepetitionEnum');
  });

  it('имя, имя без префикса, подпись и число; показ значения', () => {
    const e = getEnum(schema, 'DialogRepetitionEnum')!;
    expect(parseEnumValue(e, 'DR_ONCE_ONLY')).toBe(5);
    expect(parseEnumValue(e, 'once_only')).toBe(5);
    expect(parseEnumValue(e, 'один раз')).toBe(5);
    expect(parseEnumValue(e, '3')).toBe(3);
    expect(parseEnumValue(e, 'nope')).toBeUndefined();
    expect(formatEnumValue(e, 5)).toBe('DR_ONCE_ONLY «один раз» (5)');
    expect(formatEnumValue(e, 99)).toBe('99 (нет в DialogRepetitionEnum)');
  });

  it('условия и действия диалога текстом; tag по условию', () => {
    const ctx = ctxOf();
    expect(describeDialogAction(ctx, ref('A1', 20), 'conditions')).toBe('собеседник: DC_RELATIONS < 20');
    expect(fieldEnum(schema, 'DIALOG_ACTION', 'tag', ctx.get('A2'))?.name).toBe('PersonalityTags');
    expect(describeDialogAction(ctx, ref('A2', 1), 'conditions')).toBe('я: DC_PERSONALITY_TAG PT_HONORABLE = 1');
    expect(describeDialogAction(ctx, ref('E1'), 'effects')).toMatch(/^DA_/);
  });

  it('set принимает имя значения enum; неизвестное имя — ошибка', () => {
    const ctx = ctxOf();
    applyOps(ctx, [{ op: 'set', id: 'D1', field: 'repetition limit', value: 'DR_NO_LIMIT' }]);
    expect(ctx.get('D1')!.ints.get('repetition limit')).toBe(0);
    applyOps(ctx, [{ op: 'set', id: 'A1', field: 'who', value: 'T_ME' }]);
    expect(ctx.get('A1')!.ints.get('who')).toBe(0);
    expect(() => applyOps(ctx, [{ op: 'set', id: 'D1', field: 'repetition limit', value: 'never' }])).toThrow(EditError);
  });
});

describe('запись по имени', () => {
  it('id, точное имя, подстрока; несколько — список', () => {
    const ctx = ctxOf();
    expect(lookupRecord(ctx, 'D1').stringId).toBe('D1');
    expect(lookupRecord(ctx, 'guard talk').stringId).toBe('D1');
    expect(lookupRecord(ctx, 'Same name').candidates.map((h) => h.stringId)).toEqual(['S1', 'S2']);
    // «Guard» — точное имя персонажа; без него подстрока дала бы два.
    expect(lookupRecord(ctx, 'Guard').stringId).toBe('C');
    expect(lookupRecord(ctx, 'talk', { preferTypes: ['DIALOGUE'] }).candidates).toHaveLength(2);
    expect(lookupRecord(ctx, 'нет такого')).toEqual({ candidates: [] });
  });
});

describe('diff: фильтр и итог', () => {
  it('статусы, псевдонимы, итог', () => {
    const a = file([rec(CHAR, 'X', 'x'), rec(CHAR, 'Y', 'y')]);
    const bFile = file([rec(CHAR, 'X', 'x2'), rec(CHAR, 'Z', 'z')]);
    const diffs = diffDataFiles(a, bFile);
    expect(formatDiffSummary(diffs)).toBe('всего 3: новых 1, изменённых 1, удалённых 1');
    expect(parseDiffStatuses('new,deleted')).toEqual(['added', 'removed']);
    expect(filterDiffs(diffs, ['changed']).map((d) => d.stringId)).toEqual(['X']);
    expect(() => parseDiffStatuses('weird')).toThrow();
  });
});

describe('проверки этапа 2', () => {
  it('диалог без реплик: свой новый и ванильный, на который мод ссылается', () => {
    const ctx = ctxOf();
    const sid = ctx.createRecord(DIALOGUE, 'Mine');
    ctx.addReference('S1', 'dialogue', 'D0');
    const issues = validateMod(ctx).filter((i) => i.code === 'empty-dialogue');
    expect(issues.map((i) => `${i.stringId}:${i.target ?? ''}`).sort()).toEqual([`${sid}:`, 'S1:D0'].sort());
  });

  it('висячая ссылка: зависимость удаляет диалог, на который ссылается ваниль', () => {
    const dep = file([removalMarker(rec(DIALOGUE, 'D1', 'Guard talk'))]);
    const layers: Layer[] = [...vanilla(), { name: 'Other.mod', file: dep }];
    const ctx = ctxOf(layers);
    const issues = validateMod(ctx).filter((i) => i.code === 'dangling-ref');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ stringId: 'C', key: 'dialogue', target: 'D1', severity: 'warning' });
    expect(issues[0]!.message).toContain('Other.mod');
    // Удаление в самой ванили — не повод для предупреждения.
    expect(isVanillaLayer('REBIRTH.MOD')).toBe(true);
  });
});

describe('постоянные id', () => {
  it('номер по имени выдаётся один раз; сироты; проверка таблицы', () => {
    const ids = new StableIds('My.mod', { next: 102, ids: { old: 100, keep: 101 } });
    expect(ids.id('keep')).toBe('101-My.mod');
    expect(ids.id('new')).toBe('102-My.mod');
    expect(ids.id('new')).toBe('102-My.mod');
    expect(ids.added).toEqual(['new']);
    expect(ids.orphans()).toEqual(['old']);
    expect(ids.data.next).toBe(103);
    expect(parseStableIds('{"next":5,"ids":{"a":1}}')).toEqual({ next: 5, ids: { a: 1 } });
    expect(() => parseStableIds('{"next":1,"ids":{"a":1}}')).toThrow(/не меньше next/);
    expect(() => parseStableIds('[]')).toThrow();
  });
});
