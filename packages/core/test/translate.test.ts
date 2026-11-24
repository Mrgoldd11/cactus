/**
 * Translation helper: original texts, a translation mod on top of it, CSV/JSON there and back,
 * changed originals and extras in the translation. On synthetic layers, without the game.
 */
import { describe, expect, it } from 'vitest';
import {
  applyTranslationRows,
  decodeText,
  emptyRecord,
  encodeText,
  FileType,
  formatTranslationCsv,
  formatTranslationJson,
  formatTranslationPo,
  hasTranslatableText,
  itemTypeId,
  layerTexts,
  ModContext,
  parseCsv,
  parseTranslationFile,
  setTranslation,
  summarizeTranslation,
  translationExtras,
  translationRows,
  writeDataFile,
  readDataFile,
  type DataFile,
  type GameRecord,
  type Layer,
} from '../src/index.ts';

const ARMOUR = itemTypeId('ARMOUR')!;
const LINE = itemTypeId('DIALOGUE_LINE')!;
const SQUAD = itemTypeId('SQUAD_TEMPLATE')!;

function rec(type: number, sid: string, name: string, strings: Record<string, string> = {}, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(type, sid, encodeText(name));
  for (const [k, v] of Object.entries(strings)) r.strings.set(k, encodeText(v));
  fill(r);
  return r;
}

function file(records: GameRecord[], deps = ''): DataFile {
  return { fileType: FileType.Mod, header: { version: 1, author: encodeText(''), description: encodeText(''), dependencies: encodeText(deps), references: encodeText('') }, lastId: 0, records, tail: new Uint8Array() };
}

/** Vanilla: helmet V. Original: own helmet, a line, a squad; changes the description of V (name the same). */
function layers(original = 'Plate helm. Heavy.'): Layer[] {
  const vanilla = file([rec(ARMOUR, 'V', 'Hat', { description: 'Old hat', category: 'Armour' }, (r) => r.floats.set('weight', 1))]);
  const mod = file([
    rec(ARMOUR, '1-orig.mod', 'Plate helm', { description: original, 'sfx loop': 'metal' }, (r) => r.floats.set('weight', 5)),
    rec(LINE, '2-orig.mod', 'DIALOGUE_LINE2', { text0: 'Hello, drifter.', text1: '/INSULT/!' }),
    rec(SQUAD, '3-orig.mod', 'internal squad', { 'building name': 'Bandit camp' }),
    rec(ARMOUR, 'V', 'Hat', { description: 'Better hat', category: 'Armour' }),
  ]);
  return [
    { name: 'gamedata.base', file: vanilla },
    { name: 'Orig.mod', file: mod },
  ];
}

const tr = (l = layers()): ModContext => new ModContext({ layers: l, modName: 'Orig RUS.mod' });

describe('translation helper', () => {
  it('original texts: names of translatable types, text fields; service and unchanged ones — no', () => {
    const texts = layerTexts(layers(), 'orig.mod').map((e) => `${e.id} ${e.field}: ${e.original}`);
    expect(texts).toEqual([
      '1-orig.mod name: Plate helm',
      '1-orig.mod description: Plate helm. Heavy.',
      '2-orig.mod text0: Hello, drifter.',
      '3-orig.mod building name: Bandit camp',
      'V description: Better hat',
    ]);
    expect(hasTranslatableText('/INSULT/!')).toBe(false);
    expect(hasTranslatableText('Привет')).toBe(true);
  });

  it('the translation goes into the translation mod as texts only; equal to the original — translation removed', () => {
    const ctx = tr();
    setTranslation(ctx, '1-orig.mod', 'name', 'Латный шлем');
    setTranslation(ctx, '1-orig.mod', 'description', 'Латный шлем. Тяжёлый.');
    setTranslation(ctx, 'V', 'description', 'Better hat');
    let rows = translationRows(ctx, 'Orig.mod');
    expect(summarizeTranslation(rows)).toEqual({ total: 5, done: 2, same: 0, todo: 3 });
    expect(ctx.modRecords().map((r) => r.stringId)).toEqual(['1-orig.mod']);
    const d = ctx.delta('1-orig.mod')!;
    expect(decodeText(d.name)).toBe('Латный шлем');
    expect([...d.strings.keys()]).toEqual(['description']);
    expect(d.floats.size + d.refs.size).toBe(0);
    // Empty text — the translation is removed; the record leaves the mod.
    setTranslation(ctx, '1-orig.mod', 'name', '');
    setTranslation(ctx, '1-orig.mod', 'description', '');
    expect(ctx.modRecords()).toEqual([]);
    rows = translationRows(ctx, 'Orig.mod');
    expect(rows.every((r) => r.status === 'todo')).toBe(true);
    // The saved mod reads back with the same texts.
    setTranslation(ctx, '2-orig.mod', 'text0', 'Привет, бродяга.');
    const back = readDataFile(writeDataFile(ctx.buildModFile()));
    expect(decodeText(back.records[0]!.strings.get('text0')!)).toBe('Привет, бродяга.');
  });

  it('CSV and JSON: export → edit → import; quotes, line breaks, semicolon', () => {
    const ctx = tr();
    setTranslation(ctx, '2-orig.mod', 'text0', 'Привет, "бродяга".\nКуда идёшь?');
    const csv = formatTranslationCsv(translationRows(ctx, 'Orig.mod'));
    expect(csv.startsWith('﻿id,field,type,record,original,translation\r\n')).toBe(true);
    const parsed = parseTranslationFile(csv);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows[2]).toMatchObject({ id: '2-orig.mod', field: 'text0', original: 'Hello, drifter.', translation: 'Привет, "бродяга".\nКуда идёшь?' });
    // Translating into another translation mod from the same file gives the same texts.
    const other = tr();
    const rows = parsed.rows.map((r) => (r.field === 'name' ? { ...r, translation: 'Латный шлем' } : r));
    const rep = applyTranslationRows(other, 'Orig.mod', rows);
    expect(rep).toMatchObject({ applied: 2, unchanged: 0, empty: 3, stale: [], unknown: [] });
    expect(decodeText(other.delta('2-orig.mod')!.strings.get('text0')!)).toBe('Привет, "бродяга".\nКуда идёшь?');
    // The translation depends on the original — in the header.
    expect(other.info.dependencies).toEqual(['Orig.mod']);
    // One edit — one undo.
    other.undo();
    expect(other.modRecords()).toEqual([]);
    expect(other.info.dependencies).toEqual([]);
    // JSON — the same.
    const json = parseTranslationFile(formatTranslationJson('Orig.mod', translationRows(ctx, 'Orig.mod')));
    expect(json.source).toBe('Orig.mod');
    expect(json.rows[2]!.translation).toBe('Привет, "бродяга".\nКуда идёшь?');
    // PO (Poedit, as in FCS) — the same; quotes and line breaks are escaped.
    const poText = formatTranslationPo('Orig.mod', translationRows(ctx, 'Orig.mod'));
    expect(poText).toContain('msgctxt "2-orig.mod|text0"');
    const po = parseTranslationFile(poText);
    expect(po.source).toBe('Orig.mod');
    expect(po.rows.map((r) => [r.id, r.field, r.original, r.translation])).toEqual(parsed.rows.map((r) => [r.id, r.field, r.original, r.translation]));
    // Excel with a Russian locale saves with ";".
    expect(parseCsv('id;field;translation\r\nV;description;"a;b"\r\n')).toEqual([['id', 'field', 'translation'], ['V', 'description', 'a;b']]);
    expect(() => parseTranslationFile('a,b\n1,2')).toThrow('id, field and translation');
  });

  it('original updated: a row with an outdated original is not applied; unknown ids — into the report', () => {
    const csv = formatTranslationCsv(translationRows(tr(), 'Orig.mod'));
    const rows = parseTranslationFile(csv).rows.map((r) => ({ ...r, translation: `RU ${r.original ?? ''}` }));
    rows.push({ id: 'nope', field: 'description', translation: 'x' });
    const updated = tr(layers('Plate helm. Very heavy.'));
    const rep = applyTranslationRows(updated, 'Orig.mod', rows);
    expect(rep.applied).toBe(4);
    expect(rep.stale).toEqual([{ id: '1-orig.mod', field: 'description', was: 'Plate helm. Heavy.', now: 'Plate helm. Very heavy.' }]);
    expect(rep.unknown).toEqual([{ id: 'nope', field: 'description' }]);
    expect(translationRows(updated, 'Orig.mod').find((r) => r.field === 'description' && r.id === '1-orig.mod')!.status).toBe('todo');
    const forced = applyTranslationRows(updated, 'Orig.mod', rows, { applyStale: true });
    expect(forced.applied).toBe(1);
  });

  it('translation mod check: texts not from the original and edits of non-texts', () => {
    const ctx = tr();
    setTranslation(ctx, '1-orig.mod', 'description', 'Шлем');
    ctx.setField('1-orig.mod', 'floats', 'weight', 2);
    ctx.setField('V', 'strings', 'category', encodeText('Броня'));
    ctx.setField('V', 'strings', 'sfx loop', encodeText('x'));
    const ex = translationExtras(ctx, ['Orig.mod']);
    expect(ex.orphans).toEqual([{ id: 'V', field: 'category', text: 'Броня' }]);
    expect(ex.nonText).toEqual([{ id: '1-orig.mod', what: 'weight' }, { id: 'V', what: 'sfx loop' }]);
  });
});
