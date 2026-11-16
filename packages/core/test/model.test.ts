/**
 * Модель редактирования: наложение слоёв, разница «итог минус нижние слои», статусы,
 * команды с отменой/повтором, сохранение, поиск, проверка, деревья диалогов.
 * Всё на маленьких синтетических слоях, без файлов игры.
 */
import { describe, expect, it } from 'vitest';
import {
  FileType,
  ModContext,
  applyLayer,
  applyOps,
  coerceValue,
  EditError,
  buildDialogueTree,
  buildGameSchema,
  changesetDiff,
  decodeText,
  diffDataFiles,
  diffRecord,
  diffRecordStates,
  emptyRecord,
  encodeText,
  formatChangeset,
  formatDialogueTree,
  formatFloat,
  formatRecord,
  itemTypeId,
  LayerDiffError,
  page,
  parseFcsDef,
  parseGameSchema,
  listTypes,
  formatTypeSchema,
  findTypeSchema,
  formatEnum,
  recordToJson,
  parseFieldFilter,
  readDataFile,
  recordsEqual,
  refLabel,
  removalMarker,
  removedRef,
  REMOVED_REF_VALUE,
  searchRecords,
  validateMod,
  writeDataFile,
  type DataFile,
  type GameRecord,
  type Layer,
  type Reference,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);
const CHAR = itemTypeId('CHARACTER')!;
const ITEM = itemTypeId('ITEM')!;
const DIALOGUE = itemTypeId('DIALOGUE')!;
const LINE = itemTypeId('DIALOGUE_LINE')!;
const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): Reference => ({ target, v0, v1, v2 });

function rec(type: number, sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(type, sid, b(name));
  fill(r);
  return r;
}

function file(records: GameRecord[], fileType: number = FileType.Mod, lastId = 0): DataFile {
  return {
    fileType,
    header: { version: 1, author: b(''), description: b(''), dependencies: b(''), references: b('') },
    lastId,
    records,
    tail: new Uint8Array(),
  };
}

/**
 * gamedata.base: бандит A с торговцами X, Y; предметы X, Y; запись D.
 * rebirth.mod: A переименован, money=20, ссылка на Y снята, добавлен Z; D удалена; новый Z.
 */
function layers(): Layer[] {
  const base = file([
    rec(CHAR, 'A', 'Bandit', (r) => {
      r.ints.set('money', 10);
      r.bools.set('unique', true);
      r.refs.set('vendors', [ref('X', 1), ref('Y', 2)]);
    }),
    rec(ITEM, 'X', 'Sword'),
    rec(ITEM, 'Y', 'Shield'),
    rec(ITEM, 'D', 'Junk'),
  ]);
  const rebirth = file([
    rec(CHAR, 'A', 'Bandit 2', (r) => {
      r.ints.set('money', 20);
      r.refs.set('vendors', [removedRef('Y'), ref('Z', 5)]);
    }),
    removalMarker(rec(ITEM, 'D', 'Junk')),
    rec(ITEM, 'Z', 'Hat'),
  ]);
  return [
    { name: 'gamedata.base', file: base },
    { name: 'rebirth.mod', file: rebirth },
  ];
}

function newCtx(mod?: DataFile, modName = 'test.mod'): ModContext {
  return new ModContext({ layers: layers(), modName, ...(mod ? { mod } : {}) });
}

const targets = (r: GameRecord | undefined, cat: string): string[] => (r?.refs.get(cat) ?? []).map((x) => x.target);

describe('наложение слоёв', () => {
  it('applyLayer: замена на месте, снятие, добавление в конец, удаление записи', () => {
    const [base, rebirth] = layers();
    const a = applyLayer(base!.file.records[0], rebirth!.file.records[0]!)!;
    expect(decodeText(a.name)).toBe('Bandit 2');
    expect(a.ints.get('money')).toBe(20);
    expect(a.bools.get('unique')).toBe(true);
    expect(a.refs.get('vendors')).toEqual([ref('X', 1), ref('Z', 5)]);
    expect(applyLayer(base!.file.records[3], rebirth!.file.records[1]!)).toBeUndefined();
    // Новая запись: маркеры снятия ссылок ничего не значат.
    const created = applyLayer(undefined, rec(ITEM, 'N', 'n', (r) => r.refs.set('c', [removedRef('X'), ref('Y')])))!;
    expect(created.refs.get('c')).toEqual([ref('Y')]);
  });

  it('diffRecord: только изменения; снятые ссылки — маркером; лишнего не пишет', () => {
    const lower = rec(CHAR, 'A', 'Bandit', (r) => {
      r.ints.set('money', 10).set('age', 3);
      r.refs.set('vendors', [ref('X', 1), ref('Y', 2)]);
    });
    expect(diffRecord(lower, lower)).toBeUndefined();
    const want = rec(CHAR, 'A', 'Bandit', (r) => {
      r.ints.set('money', 10).set('age', 4);
      r.floats.set('speed', 1.5);
      r.refs.set('vendors', [ref('W'), ref('X', 9)]);
    });
    const d = diffRecord(lower, want)!;
    expect([...d.ints]).toEqual([['age', 4]]);
    expect([...d.floats]).toEqual([['speed', 1.5]]);
    expect(d.refs.get('vendors')).toEqual([ref('X', 9), removedRef('Y'), ref('W')]);
    expect(applyLayer(lower, d)!.refs.get('vendors')).toEqual([ref('X', 9), ref('W')]);
    // Нельзя убрать скалярное поле нижних слоёв.
    const noAge = rec(CHAR, 'A', 'Bandit', (r) => r.ints.set('money', 10));
    expect(() => diffRecord(lower, noAge)).toThrow(LayerDiffError);
  });

  it('diffRecord сохраняет порядок прежней записи мода', () => {
    const lower = rec(CHAR, 'A', 'n', (r) => r.ints.set('a', 1).set('b', 1));
    const prev = rec(CHAR, 'A', 'n', (r) => r.ints.set('b', 2).set('a', 2));
    const want = rec(CHAR, 'A', 'n', (r) => r.ints.set('a', 3).set('b', 3));
    expect([...diffRecord(lower, want, prev)!.ints.keys()]).toEqual(['b', 'a']);
  });
});

describe('контекст: чтение', () => {
  it('итоговые записи, статусы, происхождение', () => {
    const ctx = newCtx();
    expect(decodeText(ctx.get('A')!.name)).toBe('Bandit 2');
    expect(targets(ctx.get('A'), 'vendors')).toEqual(['X', 'Z']);
    expect(ctx.get('D')).toBeUndefined();
    expect(ctx.status('A')).toBe('base');
    expect(ctx.status('D')).toBeUndefined();
    expect(ctx.status('nope')).toBeUndefined();
    expect(ctx.origin('A')).toEqual({ status: 'base', origin: 'gamedata.base', layers: ['gamedata.base', 'rebirth.mod'] });
    expect([...ctx.allStringIds()]).toEqual(['A', 'X', 'Y', 'D', 'Z']);
  });

  it('индекс ссылок в обе стороны, обновляется при правках', () => {
    const ctx = newCtx();
    expect(ctx.referencesFrom('A').map((e) => e.target)).toEqual(['X', 'Z']);
    expect(ctx.referencesTo('X').map((e) => e.source)).toEqual(['A']);
    expect(ctx.referencesTo('Y')).toEqual([]);
    ctx.addReference('A', 'vendors', 'Y');
    expect(ctx.referencesTo('Y').map((e) => `${e.source}:${e.category}`)).toEqual(['A:vendors']);
    ctx.undo();
    expect(ctx.referencesTo('Y')).toEqual([]);
  });
});

describe('контекст: команды и история', () => {
  it('setField пишет только изменённое поле; undo/redo', () => {
    const ctx = newCtx();
    ctx.setField('A', 'ints', 'money', 99);
    expect(ctx.status('A')).toBe('changed');
    const d = ctx.delta('A')!;
    expect([...d.ints]).toEqual([['money', 99]]);
    expect(d.bools.size + d.refs.size).toBe(0);
    expect(ctx.dirty).toBe(true);
    ctx.undo();
    expect(ctx.delta('A')).toBeUndefined();
    expect(ctx.get('A')!.ints.get('money')).toBe(20);
    expect(ctx.dirty).toBe(false);
    ctx.redo();
    expect(ctx.get('A')!.ints.get('money')).toBe(99);
    // Значение как в нижних слоях — запись уходит из мода.
    ctx.setField('A', 'ints', 'money', 20);
    expect(ctx.delta('A')).toBeUndefined();
  });

  it('createRecord выдаёт id из lastId, отмена возвращает lastId', () => {
    const ctx = newCtx();
    const sid = ctx.createRecord(ITEM, 'Новый');
    expect(sid).toBe('1-test.mod');
    expect(ctx.info.lastId).toBe(1);
    expect(ctx.status(sid)).toBe('new');
    expect(ctx.history().undo).toHaveLength(1);
    ctx.undo();
    expect(ctx.has(sid)).toBe(false);
    expect(ctx.info.lastId).toBe(0);
    expect(() => ctx.createRecord(ITEM, 'x', { stringId: 'A' })).toThrow(/already exists/);
  });

  it('duplicateRecord копирует итоговую запись', () => {
    const ctx = newCtx();
    const sid = ctx.duplicateRecord('A', { name: 'Клон' });
    const c = ctx.get(sid)!;
    expect(decodeText(c.name)).toBe('Клон');
    expect(c.ints.get('money')).toBe(20);
    expect(targets(c, 'vendors')).toEqual(['X', 'Z']);
  });

  it('удаление: маркер для записи нижних слоёв, восстановление, удаление ссылок', () => {
    const ctx = newCtx();
    ctx.deleteRecord('X', { removeReferences: true });
    expect(ctx.status('X')).toBe('deleted');
    expect(ctx.get('X')).toBeUndefined();
    expect(ctx.delta('X')!.bools.get('REMOVED')).toBe(true);
    expect(ctx.delta('A')!.refs.get('vendors')).toEqual([removedRef('X')]);
    expect(refLabel(ctx, 'X')).toBe('<удалена> Sword [X]');
    expect(ctx.history().undo).toHaveLength(1);
    ctx.undo();
    expect(ctx.delta('A')).toBeUndefined();
    ctx.redo();
    ctx.restoreRecord('X');
    expect(ctx.status('X')).toBe('base');
    // Новая запись удаляется из мода совсем.
    const n = ctx.createRecord(ITEM, 'n');
    ctx.deleteRecord(n);
    expect(ctx.delta(n)).toBeUndefined();
  });

  it('ссылки: добавить, поменять значения, снять ссылку нижних слоёв', () => {
    const ctx = newCtx();
    ctx.addReference('A', 'vendors', 'Y', [3, 0, 0]);
    ctx.addReference('A', 'vendors', 'X', [7]);
    ctx.removeReference('A', 'vendors', 'Z');
    expect(ctx.get('A')!.refs.get('vendors')).toEqual([ref('X', 7), ref('Y', 3)]);
    expect(ctx.delta('A')!.refs.get('vendors')).toEqual([ref('X', 7), removedRef('Z'), ref('Y', 3)]);
    expect(ctx.delta('A')!.refs.get('vendors')![1]!.v0).toBe(REMOVED_REF_VALUE);
  });

  it('транзакция: одна отмена, откат при исключении', () => {
    const ctx = newCtx();
    ctx.transaction('две правки', () => {
      ctx.setField('A', 'ints', 'money', 1);
      ctx.renameRecord('A', 'Вожак');
    });
    expect(ctx.history().undo.map((c) => c.label)).toEqual(['две правки']);
    expect(() =>
      ctx.transaction('сломанная', () => {
        ctx.setField('X', 'ints', 'value', 5);
        throw new Error('стоп');
      }),
    ).toThrow('стоп');
    expect(ctx.delta('X')).toBeUndefined();
    expect(ctx.history().undo).toHaveLength(1);
    ctx.undo();
    expect(ctx.delta('A')).toBeUndefined();
    expect(ctx.canRedo).toBe(true);
    ctx.setField('Y', 'ints', 'value', 1);
    expect(ctx.canRedo).toBe(false);
  });

  it('подписка получает изменённые id', () => {
    const ctx = newCtx();
    const seen: string[][] = [];
    const off = ctx.subscribe((e) => seen.push(e.stringIds));
    ctx.setField('A', 'ints', 'money', 1);
    ctx.undo();
    off();
    ctx.redo();
    expect(seen).toEqual([['A'], ['A']]);
  });

  it('changeStringIds меняет id местами и переписывает ссылки', () => {
    const ctx = newCtx();
    const p = ctx.createRecord(ITEM, 'P');
    const q = ctx.createRecord(ITEM, 'Q');
    ctx.addReference(p, 'next', q);
    ctx.addReference('A', 'vendors', p);
    ctx.changeStringIds(new Map([[p, q], [q, p]]));
    expect(ctx.modRecords().map((r) => `${r.stringId}=${decodeText(r.name)}`)).toEqual([`${q}=P`, `${p}=Q`, 'A=Bandit 2']);
    expect(targets(ctx.get(q), 'next')).toEqual([p]);
    expect(targets(ctx.get('A'), 'vendors')).toEqual(['X', 'Z', q]);
    expect(() => { ctx.changeStringIds(new Map([['A', 'B']])); }).toThrow(/Only new records/);
    ctx.undo();
    expect(targets(ctx.get(p), 'next')).toEqual([q]);
  });

  it('diff правки читается', () => {
    const ctx = newCtx();
    ctx.setField('A', 'ints', 'money', 5);
    const cs = ctx.history().undo[0]!;
    expect(changesetDiff(ctx, cs)).toHaveLength(1);
    const text = formatChangeset(ctx, cs).join('\n');
    expect(text).toContain('money');
    expect(text).toContain('20');
    expect(text).toContain('5');
  });
});

describe('сохранение', () => {
  it('пишет только изменения; файл читается обратно в тот же итог', () => {
    const ctx = newCtx();
    const n = ctx.createRecord(ITEM, 'Новый');
    ctx.setField(n, 'floats', 'weight', 2.5);
    ctx.setField('A', 'ints', 'money', 7);
    ctx.deleteRecord('Y');
    const out = ctx.buildModFile();
    expect(out.records.map((r) => r.stringId)).toEqual([n, 'A', 'Y']);
    expect(out.records.map((r) => r.changeFlags >>> 0)).toEqual([0x80000002, 0x80000001, 0x80000001]);
    expect(out.lastId).toBe(1);
    const back = newCtx(readDataFile(writeDataFile(out)));
    for (const sid of [n, 'A', 'X']) expect(recordsEqual(back.get(sid)!, ctx.get(sid)!), sid).toBe(true);
    expect(back.status('Y')).toBe('deleted');
  });

  it('нетронутый мод пишется байт в байт; правка одной записи не трогает другие', () => {
    const first = newCtx();
    first.createRecord(ITEM, 'один');
    first.setField('A', 'ints', 'money', 1);
    const bytes = writeDataFile(first.buildModFile());
    const ctx = newCtx(readDataFile(bytes));
    expect(ctx.dirty).toBe(false);
    expect(writeDataFile(ctx.buildModFile())).toEqual(bytes);
    ctx.setField('A', 'ints', 'money', 2);
    const diff = diffDataFiles(readDataFile(bytes), ctx.buildModFile());
    expect(diff.map((d) => d.stringId)).toEqual(['A']);
  });

  it('формат 17: номер сохранения в флагах, markSaved', () => {
    const ctx = newCtx();
    ctx.setModInfo({ fileType: FileType.MergeMod });
    const n = ctx.createRecord(ITEM, 'x');
    ctx.setField('A', 'ints', 'money', 3);
    const saved = ctx.markSaved();
    expect(saved.header!.merge!.saveCount).toBe(1);
    expect(saved.records.map((r) => r.changeFlags)).toEqual([(1 << 4) | 0, (1 << 4) | 1]);
    expect(ctx.dirty).toBe(false);
    ctx.setField(n, 'ints', 'v', 1);
    const next = ctx.buildModFile();
    expect(next.header!.merge!.saveCount).toBe(2);
    // Изменилась только новая запись — у второй прежние флаги.
    expect(next.records.map((r) => r.changeFlags)).toEqual([(2 << 4) | 0, (1 << 4) | 1]);
    const back = readDataFile(writeDataFile(next));
    expect(back.fileType).toBe(FileType.MergeMod);
  });
});

describe('поиск', () => {
  it('по имени, типу, полям, статусу', () => {
    const ctx = newCtx();
    ctx.setField('X', 'ints', 'value', 100);
    const ids = (q: Parameters<typeof searchRecords>[1]): string[] => searchRecords(ctx, q).map((h) => h.stringId);
    expect(ids({ text: 'band' })).toEqual(['A']);
    expect(ids({ type: 'ITEM' })).toEqual(['X', 'Y', 'Z']);
    expect(ids({ fields: [parseFieldFilter('value>=50')] })).toEqual(['X']);
    expect(ids({ fields: [parseFieldFilter('vendors~hat')] })).toEqual(['A']);
    expect(ids({ fields: [parseFieldFilter('unique?')] })).toEqual(['A']);
    expect(ids({ status: ['changed'] })).toEqual(['X']);
    expect(ids({ modOnly: true })).toEqual(['X']);
    expect(ids({ anywhere: 'z' })).toEqual(['A', 'Z']);
    expect(ids({ text: 'shield', exact: true })).toEqual(['Y']);
    expect(() => parseFieldFilter('просто текст')).toThrow();
  });
});

describe('проверка', () => {
  const schema = buildGameSchema(
    parseFcsDef(['[CHARACTER]', 'general:', 'money: 0', 'unique: False', 'vendors: ITEM (1,0,0)', ''].join('\n')),
  );

  it('битые ссылки, удалённые цели, поля вне схемы, не тот вид и тип цели', () => {
    const ctx = new ModContext({ layers: layers(), modName: 'test.mod', schema });
    ctx.addReference('A', 'vendors', 'nowhere');
    ctx.deleteRecord('X');
    ctx.setField('A', 'ints', 'strange', 1);
    ctx.setField('A', 'floats', 'unique', 1);
    ctx.addReference('A', 'vendors', 'A');
    const codes = validateMod(ctx, { inferFromLayers: false })
      .map((i) => `${i.code}:${i.stringId}:${i.key ?? ''}`)
      .sort();
    expect(codes).toEqual(['broken-ref:A:vendors', 'deleted-ref:A:vendors', 'unknown-field:A:strange', 'wrong-kind:A:unique', 'wrong-target-type:A:vendors']);
    expect(ctx.refDefaults('A', 'vendors')).toEqual([1, 0, 0]);
  });

  it('чистый мод — без замечаний', () => {
    const ctx = new ModContext({ layers: layers(), modName: 'test.mod', schema });
    ctx.setField('A', 'ints', 'money', 5);
    expect(validateMod(ctx)).toEqual([]);
  });
});

describe('деревья диалогов и представление', () => {
  it('дерево с циклом: повтор не разворачивается', () => {
    const ctx = newCtx();
    const dlg = ctx.createRecord(DIALOGUE, 'talk');
    const l1 = ctx.createRecord(LINE, 'DIALOGUE_LINE');
    const l2 = ctx.createRecord(LINE, 'DIALOGUE_LINE');
    ctx.setField(l1, 'strings', 'text0', b('Привет'));
    ctx.setField(l1, 'ints', 'speaker', 0);
    ctx.addReference(dlg, 'lines', l1);
    ctx.addReference(l1, 'lines', l2);
    ctx.addReference(l2, 'lines', l1);
    ctx.addReference(l2, 'effects', 'X', [1]);
    const tree = buildDialogueTree(ctx, dlg);
    expect(tree.children[0]!.texts).toEqual(['Привет']);
    expect(tree.children[0]!.speaker).toBe(0);
    expect(tree.children[0]!.children[0]!.children[0]!.repeated).toBe(true);
    expect(tree.children[0]!.children[0]!.effects[0]!.name).toBe('Sword');
    const text = formatDialogueTree(ctx, tree).join('\n');
    expect(text).toContain('"Привет"');
    expect(text).toContain('↻');
    expect(buildDialogueTree(ctx, dlg, { maxDepth: 1 }).children[0]!.truncated).toBe(true);
  });

  it('запись текстом: ссылки с именами', () => {
    const ctx = newCtx();
    const text = formatRecord(ctx, ctx.get('A')!).join('\n');
    expect(text).toContain('Sword [X]');
    expect(text).toContain('money');
  });

  it('разница состояний, float, страницы', () => {
    const a = rec(CHAR, 'A', 'n', (r) => r.refs.set('c', [ref('X'), ref('Y')]));
    const c = rec(CHAR, 'A', 'n', (r) => r.refs.set('c', [ref('Y'), ref('X')]));
    expect(diffRecordStates(a, c)!.fields.map((f) => f.kind)).toEqual(['refOrder']);
    expect(diffRecordStates(a, a)).toBeUndefined();
    expect(formatFloat(Math.fround(0.1))).toBe('0.1');
    const p = page([1, 2, 3, 4, 5], 2, 2);
    expect(p.items).toEqual([3, 4]);
    expect(p.total).toBe(5);
  });
});

describe('правки данными (applyOps)', () => {
  it('псевдонимы, виды полей, одна отмена на весь список', () => {
    const ctx = newCtx();
    const r = applyOps(ctx, [
      { op: 'create', type: 'ITEM', name: 'Кирка', as: '$pick' },
      { op: 'set', id: '$pick', field: 'weight', value: 2.5 },
      { op: 'set', id: '$pick', field: 'stackable', value: true },
      { op: 'set', id: '$pick', field: 'description', value: 'текст' },
      { op: 'set', id: 'A', field: 'money', value: '15' },
      { op: 'addRef', id: 'A', category: 'vendors', target: '$pick', values: [4] },
      { op: 'info', author: 'я' },
    ]);
    const pick = r.aliases['$pick']!;
    expect(r.created).toEqual([pick]);
    const rec = ctx.get(pick)!;
    expect(rec.floats.get('weight')).toBe(2.5);
    expect(rec.bools.get('stackable')).toBe(true);
    expect(decodeText(rec.strings.get('description')!)).toBe('текст');
    expect(ctx.get('A')!.ints.get('money')).toBe(15);
    expect(ctx.get('A')!.refs.get('vendors')!.at(-1)).toEqual(ref(pick, 4));
    expect(ctx.info.author).toBe('я');
    expect(ctx.history().undo).toHaveLength(1);
    ctx.undo();
    expect(ctx.dirty).toBe(false);
  });

  it('ошибка в середине откатывает всё', () => {
    const ctx = newCtx();
    expect(() =>
      applyOps(ctx, [
        { op: 'set', id: 'A', field: 'money', value: 1 },
        { op: 'set', id: 'A', field: 'money', value: 'много' },
      ]),
    ).toThrow(/Operation 2/);
    expect(ctx.dirty).toBe(false);
    expect(() => applyOps(ctx, [{ op: 'rename', id: '$nope', name: 'x' }])).toThrow(EditError);
    expect(() => coerceValue('ints', 1.5)).toThrow(EditError);
    expect(coerceValue('bools', 'false')).toBe(false);
  });
});

describe('схема текстом и запись в JSON', () => {
  it('типы, поля с описаниями, перечисления', () => {
    const schema = parseGameSchema({
      fcsDef: ['[CHARACTER]', 'general:', 'money: 0 "Деньги\\nв кошельке"', 'mood: Mood.CALM', 'vendors: ITEM (1,0,0)', ''].join('\n'),
      fcsEnums: ['enum Mood', '{', '  CALM, // спокоен', '  ANGRY', '}', ''].join('\n'),
    });
    expect(listTypes(schema).map((t) => t.name)).toEqual(['CHARACTER', 'DIALOG_ACTION']);
    const text = formatTypeSchema(findTypeSchema(schema, 'character')!).join('\n');
    expect(text).toContain('general:');
    expect(text).toContain('money: int = 0 — Деньги в кошельке');
    expect(text).toContain('vendors: ref → ITEM (1, 0, 0)');
    expect(text).toMatch(/mood: enum Mood/);
    const en = formatEnum(schema, 'Mood')!.join('\n');
    expect(en).toContain('CALM = 0');
    expect(en).toContain('ANGRY = 1');
    expect(formatEnum(schema, 'Nope')).toBeUndefined();
  });

  it('recordToJson: поля по видам, ссылки с именами, статус', () => {
    const ctx = newCtx();
    ctx.setField('A', 'ints', 'money', 7);
    const j = recordToJson(ctx, ctx.get('A')!);
    expect(j).toMatchObject({ stringId: 'A', type: 'CHARACTER', name: 'Bandit 2', status: 'changed' });
    expect(j.fields).toEqual({ bool: { unique: true }, int: { money: 7 } });
    expect(j.refs['vendors']).toEqual([
      { target: 'X', name: 'Sword', values: [1, 0, 0] },
      { target: 'Z', name: 'Hat', values: [5, 0, 0] },
    ]);
    expect(j.layers).toEqual(['gamedata.base', 'rebirth.mod', 'test.mod']);
  });
});
