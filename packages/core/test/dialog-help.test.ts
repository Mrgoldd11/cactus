/**
 * Dialogue conditions and effects in plain words (`schema/dialog-help.ts`): every value of the
 * dialogue enums and every reference category of a line has a name and an explanation in en/ru/zh,
 * search by translation, English and code, and the ready phrases «who → condition → comparison → value».
 */
import { describe, expect, it } from 'vitest';
import {
  addCondition,
  addEffect,
  BUILTIN_ENUMS,
  CONDITION_GROUPS,
  ACTION_GROUPS,
  CONDITION_HELP,
  ACTION_HELP,
  conditionPhrase,
  DIALOG_HELP_TABLES,
  DIALOGUE_CONDITION_CATEGORIES,
  dialogActionPhrase,
  dialogHelpMatches,
  dialogValueText,
  effectPhrase,
  emptyRecord,
  encodeText,
  enumValue,
  enumValueMatches,
  FileType,
  formatEnumValue,
  getEnum,
  itemTypeId,
  LINE_FIELD_HELP,
  LINE_REF_HELP,
  lineRefPhrase,
  ModContext,
  parseEnumValue,
  recordPhrases,
  type DataFile,
  type GameRecord,
  type Reference,
} from '../src/index.ts';

const LANGS = ['en', 'ru', 'zh'] as const;
const b = (s: string): Uint8Array => encodeText(s);
const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): Reference => ({ target, v0, v1, v2 });
function rec(type: string, sid: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, b(sid));
  fill(r);
  return r;
}
const num = (enumName: string, value: string): number => BUILTIN_ENUMS[enumName]!.indexOf(value);

describe('dialog help: completeness', () => {
  for (const [enumName, table] of Object.entries(DIALOG_HELP_TABLES)) {
    it(`${enumName}: every value has a name and an explanation in en, ru and zh, and nothing else is there`, () => {
      const names = BUILTIN_ENUMS[enumName]!;
      expect(names.length).toBeGreaterThan(0);
      expect(Object.keys(table).sort()).toEqual([...names].sort());
      for (const n of names) {
        const h = table[n]!;
        for (const lang of LANGS) {
          expect(h.label[lang], `${n} label ${lang}`).toBeTruthy();
          expect(h.desc[lang], `${n} desc ${lang}`).toBeTruthy();
        }
      }
    });
  }

  it('the enums the brief names are covered', () => {
    for (const e of ['DialogConditionEnum', 'DialogActionEnum', 'TalkerEnum', 'ComparisonEnum', 'DialogRepetitionEnum', 'CharacterTypeEnum', 'PersonalityTags'])
      expect(DIALOG_HELP_TABLES[e], e).toBeDefined();
    expect(Object.keys(CONDITION_HELP)).toHaveLength(81);
    expect(Object.keys(ACTION_HELP)).toHaveLength(60);
  });

  it('conditions and effects have a group and a phrase in every language', () => {
    for (const [n, h] of Object.entries(CONDITION_HELP)) {
      expect(CONDITION_GROUPS, n).toContain(h.group);
      for (const lang of LANGS) expect(h.phrase[lang], `${n} phrase ${lang}`).toBeTruthy();
    }
    for (const [n, h] of Object.entries(ACTION_HELP)) {
      expect(ACTION_GROUPS, n).toContain(h.group);
      for (const lang of LANGS) expect(h.phrase[lang], `${n} phrase ${lang}`).toBeTruthy();
    }
  });

  it('every condition reference of a line and the plain line fields have a name, explanation and phrase', () => {
    for (const c of DIALOGUE_CONDITION_CATEGORIES.filter((x) => x !== 'conditions')) expect(LINE_REF_HELP[c]?.kind, c).toBe('condition');
    for (const effect of ['change relations', 'crowd trigger', 'give item', 'locks', 'unlock but keep me', 'unlocks', 'AI contract', 'change AI', 'interrupt', 'trigger campaign', 'lock campaign', 'unlock campaign'])
      expect(LINE_REF_HELP[effect]?.kind, effect).toBe('effect');
    for (const [c, h] of [...Object.entries(LINE_REF_HELP), ...Object.entries(LINE_FIELD_HELP)]) {
      for (const lang of LANGS) {
        expect(h.label[lang], `${c} label ${lang}`).toBeTruthy();
        expect(h.desc[lang], `${c} desc ${lang}`).toBeTruthy();
        expect(h.phrase[lang], `${c} phrase ${lang}`).toBeTruthy();
      }
    }
  });

  it('values without a description are marked, not guessed', () => {
    expect(CONDITION_HELP.DC_TARGET_CHARACTER_EXISTS!.undescribed).toBe(true);
    expect(ACTION_HELP.DA_KNOCKOUT!.undescribed).toBe(true);
    expect(DIALOG_HELP_TABLES.PersonalityTags!.PT___!.undescribed).toBe(true);
    expect(CONDITION_HELP.DC_STARVING!.undescribed).toBeUndefined();
  });
});

describe('dialog help: display and search', () => {
  const cond = getEnum(undefined, 'DialogConditionEnum')!;
  const starving = enumValue(cond, num('DialogConditionEnum', 'DC_STARVING'))!;

  it('a value reads «translation · CODE»', () => {
    expect(dialogValueText('DialogConditionEnum', 'DC_STARVING', 'ru')).toBe('Голодает · DC_STARVING');
    expect(dialogValueText('DialogConditionEnum', 'DC_STARVING', 'en')).toBe('Starving · DC_STARVING');
    expect(dialogValueText('DialogConditionEnum', 'DC_IS_SLEEPING', 'ru')).toBe('DC_IS_SLEEPING');
    expect(formatEnumValue(cond, starving.value, 'ru')).toBe(`Голодает · DC_STARVING (${starving.value})`);
    expect(formatEnumValue(getEnum(undefined, 'DialogActionEnum')!, 1, 'ru')).toMatch(/^[^A-Z_]+ · DA_TRADE \(1\)$/);
  });

  it('«голод», «starv» and «DC_STARV» all find DC_STARVING', () => {
    for (const q of ['голод', 'starv', 'DC_STARV', 'Голодает', 'ГОЛОД']) {
      expect(dialogHelpMatches('DialogConditionEnum', 'DC_STARVING', q, 'ru'), q).toBe(true);
      expect(enumValueMatches(cond, starving, q, 'ru'), q).toBe(true);
    }
    // English and the code also work with another interface language, the translation only with its own.
    expect(dialogHelpMatches('DialogConditionEnum', 'DC_STARVING', 'starv', 'zh')).toBe(true);
    expect(dialogHelpMatches('DialogConditionEnum', 'DC_STARVING', 'голод', 'en')).toBe(false);
    expect(dialogHelpMatches('DialogConditionEnum', 'DC_RELATIONS', 'голод', 'ru')).toBe(false);
    const hits = cond.values.filter((v) => enumValueMatches(cond, v, 'голод', 'ru')).map((v) => v.name);
    expect(hits).toContain('DC_STARVING');
  });

  it('ё and е are the same in search', () => {
    const tags = getEnum(undefined, 'PersonalityTags')!;
    const any = tags.values.find((v) => /ё/.test(DIALOG_HELP_TABLES.PersonalityTags![v.name]!.label.ru ?? ''));
    if (any) expect(enumValueMatches(tags, any, DIALOG_HELP_TABLES.PersonalityTags![any.name]!.label.ru!.replace(/ё/g, 'е'), 'ru')).toBe(true);
    expect(dialogHelpMatches('DialogConditionEnum', 'DC_STARVING', 'голодает', 'ru')).toBe(true);
  });

  it('a translated name is accepted as input', () => {
    expect(parseEnumValue(cond, 'Голодает')).toBe(starving.value);
    expect(parseEnumValue(cond, 'starving')).toBe(starving.value);
  });
});

describe('dialog help: phrases', () => {
  const honest = { cond: 'DC_PERSONALITY_TAG', who: 0, cmp: 0, value: 1, tag: 'PT_HONORABLE' };

  it('a personality condition reads as a sentence in every language', () => {
    expect(conditionPhrase(honest, 'ru').text).toBe('Сказать, только если у меня есть черта «честный»');
    expect(conditionPhrase(honest, 'en').text).toMatch(/^Say only if I have the “.+” trait$/);
    expect(conditionPhrase(honest, 'zh').text).toMatch(/^仅当.+时才说$/);
    expect(conditionPhrase(honest, 'ru').code).toBe('DC_PERSONALITY_TAG PT_HONORABLE = 1');
    // `= 0` turns it into «not», a dialogue gets its own lead-in.
    expect(conditionPhrase({ ...honest, value: 0 }, 'ru').short).toBe('у меня нет черты «честный»');
    expect(conditionPhrase(honest, 'ru', 'dialogue').text).toMatch(/^Диалог начнётся, только если /);
  });

  it('who changes the subject and the verb', () => {
    const me = conditionPhrase({ cond: 'DC_STARVING', who: 0, cmp: 0, value: 1 }, 'ru').short;
    const target = conditionPhrase({ cond: 'DC_STARVING', who: 1, cmp: 0, value: 1 }, 'ru').short;
    expect(me).toBe('я голодаю');
    expect(target).toBe('собеседник голодает');
    expect(conditionPhrase({ cond: 'DC_STARVING', who: 1, cmp: 0, value: 0 }, 'ru').short).toBe('собеседник не голодает');
    expect(conditionPhrase({ cond: 'DC_STARVING', who: 1, cmp: 0, value: 1 }, 'en').short).toMatch(/^the target /);
  });

  it('comparisons of a yes/no condition: «< 1» is «not», «> 1» is never', () => {
    expect(conditionPhrase({ cond: 'DC_STARVING', who: 0, cmp: 1, value: 1 }, 'ru').short).toBe('я не голодаю');
    expect(conditionPhrase({ cond: 'DC_STARVING', who: 0, cmp: 2, value: 1 }, 'ru').short).toMatch(/не выполняется никогда$/);
    expect(conditionPhrase({ cond: 'DC_STARVING', who: 0, cmp: 2, value: -1 }, 'ru').short).toMatch(/выполняется всегда$/);
  });

  it('a number condition keeps the comparison and the number', () => {
    const p = conditionPhrase({ cond: 'DC_RELATIONS', who: 1, cmp: 1, value: 20 }, 'ru');
    expect(p.short).toMatch(/меньше 20/);
    expect(p.code).toBe('DC_RELATIONS < 20');
    expect(conditionPhrase({ cond: 'DC_RELATIONS', who: 1, cmp: 2, value: 20 }, 'en').short).toMatch(/more than 20/);
  });

  it('an unknown condition (FCS Extended) keeps its description or code', () => {
    const p = conditionPhrase({ cond: 'DC_IS_SLEEPING', who: 1, cmp: 0, value: 1, fallbackLabel: 'is sleeping' }, 'ru');
    expect(p.short).toBe('is sleeping (собеседник) = 1');
    expect(p.code).toBe('DC_IS_SLEEPING = 1');
  });

  it('effects read as «Then: …» with their values', () => {
    expect(effectPhrase({ action: 'DA_TRADE' }, 'ru').text).toMatch(/^Затем: /);
    expect(effectPhrase({ action: 'DA_TRADE' }, 'ru').code).toBe('DA_TRADE');
    const pay = effectPhrase({ action: 'DA_TAKE_MONEY', values: [200, 0, 0] }, 'ru');
    expect(pay.short).toContain('200');
    expect(pay.code).toBe('DA_TAKE_MONEY 200/0/0');
    expect(effectPhrase({ action: 'DA_NEW_FCS_THING', values: [1] }, 'en').short).toBe('DA_NEW_FCS_THING 1/0/0');
  });

  it('reference categories join their targets with «or» / «and»', () => {
    expect(lineRefPhrase('my race', ['Шек', 'Улей'], 'ru').text).toMatch(/^Сказать, только если .*Шек или Улей/);
    expect(lineRefPhrase('my race', ['Shek', 'Hive', 'Human'], 'en').short).toMatch(/Shek, Hive or Human/);
    expect(lineRefPhrase('no target race', ['Shek', 'Hive'], 'en').short).toMatch(/Shek, Hive/);
    expect(lineRefPhrase('give item', ['Rice'], 'en').text).toMatch(/^Then: .*Rice/);
    expect(lineRefPhrase('odd category', ['X'], 'en').text).toBe('odd category: X');
  });
});

describe('dialog help: phrases of a record', () => {
  function ctxOf(): ModContext {
    const file: DataFile = {
      fileType: FileType.Data,
      lastId: 0,
      tail: new Uint8Array(),
      records: [
        rec('DIALOGUE_LINE', 'L', (r) => {
          r.ints.set('repetition limit', num('DialogRepetitionEnum', 'DR_ONCE_ONLY'));
          r.floats.set('chance temporary', 50);
          r.refs.set('my race', [ref('R1'), ref('R2')]);
          r.refs.set('change relations', [ref('F', 10)]);
        }),
        rec('RACE', 'R1', (r) => (r.name = b('Shek'))),
        rec('RACE', 'R2', (r) => (r.name = b('Hive'))),
        rec('FACTION', 'F', (r) => (r.name = b('Shek Kingdom'))),
      ],
    };
    return new ModContext({ layers: [{ name: 'gamedata.base', file }], modName: 'Test.mod' });
  }

  it('reads DIALOG_ACTION conditions and effects, references and plain fields', () => {
    const ctx = ctxOf();
    const c = addCondition(ctx, 'L', { cond: num('DialogConditionEnum', 'DC_PERSONALITY_TAG'), who: 0, cmp: 0, value: 1, tag: num('PersonalityTags', 'PT_HONORABLE') });
    addEffect(ctx, 'L', { action: num('DialogActionEnum', 'DA_TAKE_MONEY'), values: [200, 0, 0] });
    const condRef = ctx.get('L')!.refs.get('conditions')!.find((r) => r.target === c)!;
    expect(dialogActionPhrase(ctx, condRef, 'conditions', 'ru')!.text).toBe('Сказать, только если у меня есть черта «честный»');

    const p = recordPhrases(ctx, ctx.get('L')!, 'ru');
    expect(p.conditions.map((x) => x.code)).toEqual([
      'DC_PERSONALITY_TAG PT_HONORABLE = 1',
      'my race: Shek, Hive',
      'repetition limit: DR_ONCE_ONLY',
      'chance temporary: 50',
    ]);
    expect(p.conditions[1]!.short).toMatch(/Shek или Hive/);
    expect(p.conditions[3]!.short).toBe('звучит с шансом 50%');
    expect(p.effects.map((x) => x.code)).toEqual(['DA_TAKE_MONEY 200/0/0', 'change relations: Shek Kingdom (10)']);
    expect(p.effects[1]!.text).toMatch(/^Затем: /);
  });
});
