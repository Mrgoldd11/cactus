/**
 * Массовые правки: выбор по условиям, предпросмотр «было → станет», применение одной
 * отменой, замена текста (regex), сохранение только разницы.
 */
import { describe, expect, it } from 'vitest';
import {
  applyBulk,
  bulkFieldValue,
  restrictBulk,
  matchesFilter,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  ModContext,
  parseFieldFilter,
  previewBulk,
  readDataFile,
  writeDataFile,
  type DataFile,
  type GameRecord,
} from '../src/index.ts';

const WEAPON = itemTypeId('WEAPON')!;
const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });

function weapon(sid: string, name: string, value: number, cut: number, desc = ''): GameRecord {
  const r = emptyRecord(WEAPON, sid, encodeText(name));
  r.ints.set('value', value);
  r.floats.set('cut damage multiplier', cut);
  r.strings.set('description', encodeText(desc));
  r.bools.set('is blunt', false);
  return r;
}

function make(): ModContext {
  return new ModContext({
    layers: [
      {
        name: 'gamedata.base',
        file: file([weapon('k', 'Katana', 100, 1, 'Sharp blade'), weapon('s', 'Sabre', 80, 0.9, 'A sharp sabre'), weapon('c', 'Club', 10, 0.1, 'Heavy')]),
      },
    ],
    modName: 'Bulk.mod',
  });
}

describe('массовые правки', () => {
  it('умножение по условию: предпросмотр ничего не меняет, применение — одна отмена', () => {
    const ctx = make();
    const p = previewBulk(ctx, { type: 'WEAPON', fields: [parseFieldFilter('cut damage multiplier>0.5')] }, { kind: 'mul', field: 'value', value: '1.5' });
    expect(p.matched).toBe(2);
    expect(p.changes.map((c) => [c.sid, c.before, c.after])).toEqual([
      ['k', '100', '150'],
      ['s', '80', '120'],
    ]);
    expect(ctx.status('k')).toBe('base');
    expect(applyBulk(ctx, p)).toBe(2);
    expect(ctx.get('k')!.ints.get('value')).toBe(150);
    expect(ctx.history().undo).toHaveLength(1);
    expect(describeChangeset(ctx, ctx.history().undo[0]!).en).toBe('Bulk edit WEAPON.value: × 1.5 (records: 2)');
    ctx.undo();
    expect(ctx.get('k')!.ints.get('value')).toBe(100);
    expect(ctx.get('s')!.ints.get('value')).toBe(80);
    ctx.redo();
    // Сохраняется только разница: две записи с одним полем.
    const saved = readDataFile(writeDataFile(ctx.buildModFile())).records;
    expect(saved.map((r) => r.stringId)).toEqual(['k', 's']);
    expect([...saved[0]!.ints]).toEqual([['value', 150]]);
    expect(saved[0]!.floats.size).toBe(0);
  });

  it('прибавить к дробному, задать bool, без изменений — не в списке', () => {
    const ctx = make();
    const add = previewBulk(ctx, { type: 'WEAPON', text: 'katana' }, { kind: 'add', field: 'cut damage multiplier', value: '0,25' });
    expect(add.changes).toEqual([{ sid: 'k', name: 'Katana', field: 'cut damage multiplier', before: '1', after: '1.25' }]);
    const set = previewBulk(ctx, { type: 'WEAPON' }, { kind: 'set', field: 'is blunt', value: 'true' });
    expect(set.changes).toHaveLength(3);
    const same = previewBulk(ctx, { type: 'WEAPON' }, { kind: 'set', field: 'value', value: '100' });
    expect(same.changes.map((c) => c.sid)).toEqual(['s', 'c']);
  });

  it('замена текста: подстрока без регистра, regex с группами, имя записи', () => {
    const ctx = make();
    const plain = previewBulk(ctx, { type: 'WEAPON' }, { kind: 'replace', field: 'description', find: 'SHARP', value: 'keen' });
    expect(plain.changes.map((c) => c.after)).toEqual(['keen blade', 'A keen sabre']);
    const re = previewBulk(ctx, { type: 'WEAPON' }, { kind: 'replace', field: 'description', find: '^(\\w+) (\\w+)', regex: true, value: '$2 $1' });
    expect(re.changes.map((c) => c.after)).toEqual(['blade Sharp', 'sharp A sabre']);
    const names = previewBulk(ctx, { type: 'WEAPON' }, { kind: 'replace', field: 'name', find: 'a$', regex: true, value: 'a+' });
    expect(names.changes.map((c) => c.after)).toEqual(['Katana+']);
    applyBulk(ctx, names);
    expect(ctx.name('k')).toBe('Katana+');
  });

  it('ошибки ввода и пропуски', () => {
    const ctx = make();
    expect(() => previewBulk(ctx, { type: 'WEAPON' }, { kind: 'mul', field: 'value', value: 'abc' })).toThrow(/число/);
    expect(() => previewBulk(ctx, { type: 'WEAPON' }, { kind: 'replace', field: 'description', find: '(', regex: true, value: '' })).toThrow(/регулярное/);
    expect(() => previewBulk(ctx, { type: 'NOPE' }, { kind: 'set', field: 'value', value: '1' })).toThrow(/тип/);
    const skip = previewBulk(ctx, { type: 'WEAPON' }, { kind: 'mul', field: 'description', value: '2' });
    expect(skip.changes).toHaveLength(0);
    expect(skip.skipped).toHaveLength(3);
    expect(skip.skipped[0]!.reason).toMatch(/не число/);
    const bad = previewBulk(ctx, { type: 'WEAPON' }, { kind: 'set', field: 'value', value: '1.5' });
    expect(bad.skipped).toHaveLength(3);
  });

  it('галочки: restrictBulk оставляет выбранные записи, подпись и операции согласованы', () => {
    const ctx = make();
    const p = previewBulk(ctx, { type: 'WEAPON' }, { kind: 'mul', field: 'value', value: '2' });
    const r = restrictBulk(p, (sid) => sid !== 'c');
    expect(r.changes.map((c) => c.sid)).toEqual(['k', 's']);
    expect(r.ops).toHaveLength(2);
    expect(r.label).toContain('(2 записей)');
    applyBulk(ctx, r);
    expect(ctx.get('c')!.ints.get('value')).toBe(10);
    expect(ctx.get('k')!.ints.get('value')).toBe(200);
  });

  it('значение поля записи для колонок', () => {
    const ctx = make();
    expect(bulkFieldValue(ctx, ctx.get('k')!, 'value')).toBe('100');
    expect(bulkFieldValue(ctx, ctx.get('k')!, 'name')).toBe('Katana');
    expect(bulkFieldValue(ctx, ctx.get('k')!, 'nope')).toBeUndefined();
  });

  it('фильтры как в FCS: содержит, не содержит, regex', () => {
    const ctx = make();
    const ids = (f: string): string[] => previewBulk(ctx, { type: 'WEAPON', fields: [parseFieldFilter(f)] }, { kind: 'set', field: 'value', value: '1' }).changes.map((c) => c.sid);
    expect(ids('description:sharp')).toEqual(['k', 's']);
    expect(ids('description!:sharp')).toEqual(['c']);
    expect(ids('description?^A .*sabre$')).toEqual(['s']);
    expect(() => parseFieldFilter('description?(')).toThrow(/регулярное/);
    expect(parseFieldFilter('value?')).toEqual({ key: 'value', op: 'exists' });
    expect(parseFieldFilter('value~5').op).toBe('~');
  });
});

describe('массовые правки ссылок и условия по ссылкам', () => {
  const VENDOR = itemTypeId('VENDOR_LIST')!;
  function vendor(sid: string, items: [string, number][]): GameRecord {
    const r = emptyRecord(VENDOR, sid, encodeText(sid));
    r.refs.set('items', items.map(([target, v0]) => ({ target, v0, v1: 0, v2: 0 })));
    return r;
  }
  function makeVendors(): ModContext {
    return new ModContext({
      layers: [{ name: 'gamedata.base', file: file([weapon('k', 'Katana', 100, 1), weapon('s', 'Sabre', 80, 0.9), vendor('v1', [['k', 5]]), vendor('v2', [['k', 1], ['s', 2]]), vendor('v3', [])]) }],
      modName: 'Refs.mod',
    });
  }

  it('условия по ссылкам: число в списке, значение v0, Ref', () => {
    const ctx = makeVendors();
    const has = (sid: string, f: string): boolean => matchesFilter(ctx, ctx.get(sid)!, parseFieldFilter(f));
    expect(has('v2', 'items>1')).toBe(true);
    expect(has('v1', 'items>1')).toBe(false);
    expect(has('v1', 'items.v0=5')).toBe(true);
    expect(has('v2', 'items.v0>=3')).toBe(false);
    expect(has('v2', 'items.v0>=1')).toBe(true);
    expect(has('k', 'Ref>=2')).toBe(true);
    expect(has('s', 'Ref>=2')).toBe(false);
    expect(has('v1', 'items=Katana')).toBe(true);
  });

  it('refAdd: добавляет ссылку тем, у кого её нет; одна отмена; повтор — без изменений', () => {
    const ctx = makeVendors();
    const p = previewBulk(ctx, { type: 'VENDOR_LIST' }, { kind: 'refAdd', field: 'items', value: 'Sabre', values: [7, 0, 0] });
    expect(p.matched).toBe(3);
    expect(p.changes.map((c) => c.sid)).toEqual(['v1', 'v2', 'v3']);
    expect(p.changes[0]!.before).toBe('');
    expect(p.changes[1]!.before).toContain('Sabre (2, 0, 0)');
    applyBulk(ctx, p);
    expect(ctx.get('v1')!.refs.get('items')!.map((r) => [r.target, r.v0])).toEqual([['k', 5], ['s', 7]]);
    expect(ctx.get('v2')!.refs.get('items')!.find((r) => r.target === 's')!.v0).toBe(7);
    expect(ctx.history().undo).toHaveLength(1);
    expect(previewBulk(ctx, { type: 'VENDOR_LIST' }, { kind: 'refAdd', field: 'items', value: 'Sabre', values: [7, 0, 0] }).changes).toHaveLength(0);
  });

  it('refAdd без значений не трогает существующую ссылку; refRemove убирает', () => {
    const ctx = makeVendors();
    const add = previewBulk(ctx, { type: 'VENDOR_LIST' }, { kind: 'refAdd', field: 'items', value: 'k' });
    expect(add.changes.map((c) => c.sid)).toEqual(['v3']);
    const rem = previewBulk(ctx, { type: 'VENDOR_LIST' }, { kind: 'refRemove', field: 'items', value: 'Katana' });
    expect(rem.changes.map((c) => c.sid)).toEqual(['v1', 'v2']);
    applyBulk(ctx, rem);
    expect(ctx.get('v1')!.refs.get('items')).toEqual([]);
    expect(ctx.get('v2')!.refs.get('items')!.map((r) => r.target)).toEqual(['s']);
  });

  it('ссылки: ошибки — нет цели, нет списка', () => {
    const ctx = makeVendors();
    expect(() => previewBulk(ctx, { type: 'VENDOR_LIST' }, { kind: 'refAdd', field: 'items', value: 'Nothing here' })).toThrow(/не найдена/);
    expect(() => previewBulk(ctx, { type: 'VENDOR_LIST' }, { kind: 'refAdd', field: 'items', value: '' })).toThrow(/на какую запись/);
    const p = previewBulk(ctx, { type: 'VENDOR_LIST' }, { kind: 'refAdd', field: 'nope', value: 'k' });
    expect(p.changes).toHaveLength(0);
    expect(p.skipped).toHaveLength(3);
  });
});
