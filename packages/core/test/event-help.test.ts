/**
 * Package dialogue events in plain words (`schema/event-help.ts`), how they are shown and searched,
 * and «when is this dialogue spoken» (`dialog/when.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ENUMS,
  dialogueWhen,
  emptyRecord,
  encodeText,
  enumValue,
  enumValueMatches,
  EVENT_GROUPS,
  EVENT_HELP,
  FileType,
  formatEnumValue,
  itemTypeId,
  lineDialogues,
  ModContext,
  parseEnumValue,
  refValueEnum,
  type DataFile,
  type GameRecord,
  type Reference,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);
const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): Reference => ({ target, v0, v1, v2 });
function rec(type: string, sid: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, b(sid));
  fill(r);
  return r;
}

describe('event help', () => {
  const names = BUILTIN_ENUMS.EventTriggerEnum!;

  it('every EventTriggerEnum value has a name and an explanation in en, ru and zh, and nothing else is there', () => {
    expect(names.length).toBe(76);
    expect(Object.keys(EVENT_HELP).sort()).toEqual([...names].sort());
    for (const n of names) {
      const h = EVENT_HELP[n]!;
      for (const lang of ['en', 'ru', 'zh']) {
        expect(h.label[lang], `${n} label ${lang}`).toBeTruthy();
        expect(h.desc[lang], `${n} desc ${lang}`).toBeTruthy();
        if (h.target) expect(h.target[lang], `${n} target ${lang}`).toBeTruthy();
      }
      expect(EVENT_GROUPS).toContain(h.group);
      // A human name, not the code.
      expect(h.label.en).not.toMatch(/^EV_/);
    }
  });

  it('an event reads «name · EV_NAME (number)» in every language', () => {
    const def = refValueEnum(undefined, 'DIALOGUE_PACKAGE', 'dialogs', 0)!;
    expect(formatEnumValue(def, 62, 'ru')).toBe('Кислотный дождь · EV_ACID_RAIN (62)');
    expect(formatEnumValue(def, 62, 'en')).toBe('Acid rain · EV_ACID_RAIN (62)');
    expect(formatEnumValue(def, 62, 'zh')).toMatch(/ · EV_ACID_RAIN \(62\)$/);
    expect(formatEnumValue(def, 20, 'ru')).toMatch(/ · EV_HEALING_OTHER_FINISHED \(20\)$/);
    // Unknown numbers stay visible as numbers with a note.
    expect(formatEnumValue(def, 999, 'en')).toBe('999 (not in EventTriggerEnum)');
  });

  it('events are found by the translation, the EV name and the number', () => {
    const def = refValueEnum(undefined, 'DIALOGUE_PACKAGE', 'dialogs', 0)!;
    const rain = enumValue(def, 62)!;
    expect(enumValueMatches(def, rain, 'кислотный', 'ru')).toBe(true);
    expect(enumValueMatches(def, rain, 'дождь кисл', 'ru')).toBe(true);
    expect(enumValueMatches(def, rain, 'acid rain', 'ru')).toBe(true);
    expect(enumValueMatches(def, rain, 'EV_ACID_RAIN', 'ru')).toBe(true);
    expect(enumValueMatches(def, rain, '62', 'ru')).toBe(true);
    expect(enumValueMatches(def, rain, '6', 'ru')).toBe(false);
    expect(enumValueMatches(def, rain, 'лечить', 'ru')).toBe(false);
    expect(def.values.filter((v) => enumValueMatches(def, v, 'кислот', 'ru')).map((v) => v.value).sort()).toEqual([61, 62, 63]);
    expect(parseEnumValue(def, 'Кислотный дождь')).toBe(62);
    expect(parseEnumValue(def, 'acid rain')).toBe(62);
  });
});

describe('dialogueWhen', () => {
  function ctxOf(): ModContext {
    const file: DataFile = {
      fileType: FileType.Data,
      lastId: 0,
      tail: new Uint8Array(),
      records: [
        rec('DIALOGUE_LINE', 'L2'),
        rec('DIALOGUE_LINE', 'L1', (r) => r.refs.set('lines', [ref('L2')])),
        rec('DIALOGUE', 'HEAL', (r) => r.refs.set('lines', [ref('L1')])),
        rec('DIALOGUE', 'TALK'),
        rec('DIALOGUE', 'LOST'),
        rec('DIALOGUE_PACKAGE', 'PK', (r) => r.refs.set('dialogs', [ref('HEAL', 20), ref('LOST', 71, 70, 69)])),
        rec('DIALOGUE_PACKAGE', 'PK2', (r) => r.refs.set('inheritsFrom', [ref('PK')])),
        rec('DIALOGUE_PACKAGE', 'ORPHAN', (r) => r.refs.set('dialogs', [ref('HEAL', 62)])),
        rec('CHARACTER', 'BEEP', (r) => {
          r.refs.set('dialogue package player', [ref('PK')]);
          r.refs.set('dialogue', [ref('TALK')]);
        }),
        rec('SQUAD_TEMPLATE', 'SQ', (r) => r.refs.set('dialog squad', [ref('PK2')])),
      ],
    };
    return new ModContext({ layers: [{ name: 'gamedata.base', file }], modName: 'Test.mod' });
  }

  it('lists the events, the package and who has it, also through inheriting packages', () => {
    const ctx = ctxOf();
    const w = dialogueWhen(ctx, 'HEAL');
    const pk = w.find((s) => s.pkg === 'PK')!;
    expect(pk.events).toEqual([20]);
    expect(pk.holders).toEqual([
      { sid: 'BEEP', type: 'CHARACTER', field: 'dialogue package player' },
      { sid: 'SQ', type: 'SQUAD_TEMPLATE', field: 'dialog squad', through: 'PK2' },
    ]);
    const orphan = w.find((s) => s.pkg === 'ORPHAN')!;
    expect(orphan.events).toEqual([62]);
    expect(orphan.holders).toEqual([]);
    expect(dialogueWhen(ctx, 'LOST')[0]!.events).toEqual([71, 70, 69]);
  });

  it('CHARACTER.dialogue is the talk event', () => {
    expect(dialogueWhen(ctxOf(), 'TALK')).toEqual([{ events: [1], holders: [{ sid: 'BEEP', type: 'CHARACTER', field: 'dialogue' }] }]);
  });

  it('a line finds its dialogue through parent lines', () => {
    const ctx = ctxOf();
    expect(lineDialogues(ctx, 'L2')).toEqual(['HEAL']);
    expect(lineDialogues(ctx, 'L1')).toEqual(['HEAL']);
  });
});
