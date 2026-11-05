/**
 * Таблицы сравнения: столбцы из данных, кто поменял значение (мод / другие моды), диапазон.
 */
import { describe, expect, it } from 'vitest';
import { compareTable, emptyRecord, encodeText, FileType, itemTypeId, ModContext, type DataFile, type GameRecord } from '../src/index.ts';

const WEAPON = itemTypeId('WEAPON')!;
const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });
function weapon(sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(WEAPON, sid, encodeText(name));
  fill(r);
  return r;
}

describe('таблица сравнения', () => {
  it('значения, отметки «мод» и «другие моды», выбросы, добавленные записи', () => {
    const base = file([
      weapon('k', 'Katana', (r) => {
        r.floats.set('cut damage multiplier', 1);
        r.ints.set('value', 100);
        r.bools.set('is blunt', false);
      }),
      weapon('s', 'Sabre', (r) => {
        r.floats.set('cut damage multiplier', 1.2);
        r.ints.set('value', 300);
        r.bools.set('is blunt', false);
      }),
    ]);
    const other = file([weapon('k', 'Katana', (r) => r.floats.set('cut damage multiplier', 1.5)), weapon('x', 'Mod Blade', (r) => r.ints.set('value', 50))]);
    const ctx = new ModContext({ layers: [{ name: 'gamedata.base', file: base }, { name: 'Other.mod', file: other }], modName: 'My.mod' });
    ctx.setField('s', 'ints', 'value', 999);
    const own = ctx.createRecord(WEAPON, 'Mine');

    const t = compareTable(ctx, 'WEAPON');
    expect(t.rows.map((r) => r.sid)).toEqual(['k', 's', 'x', own]);
    expect(t.columns.map((c) => c.key)).toEqual(['is blunt', 'value', 'cut damage multiplier']);
    expect(t.defaultColumns).toEqual(['value', 'cut damage multiplier']);
    const cell = (sid: string, key: string) => t.rows.find((r) => r.sid === sid)!.cells.get(key)!;
    expect(cell('k', 'cut damage multiplier')).toEqual({ value: 1.5, text: '1.5', mark: 'mods', layers: ['Other.mod'] });
    expect(cell('s', 'value')).toEqual({ value: 999, text: '999', mark: 'mine' });
    expect(cell('s', 'cut damage multiplier')).toEqual({ value: 1.2, text: '1.2' });
    expect(t.rows.find((r) => r.sid === 'x')!.addedBy).toBe('Other.mod');
    expect(t.rows.find((r) => r.sid === own)!.addedBy).toBe('My.mod');
    expect(t.range('value')).toEqual({ min: 50, max: 999 });
    expect(t.range('is blunt')).toBeUndefined();
    expect(t.columns.find((c) => c.key === 'value')!.varies).toBe(true);
  });
});
