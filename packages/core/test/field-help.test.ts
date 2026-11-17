import { describe, expect, it } from 'vitest';
import { FIELD_HELP_TYPES, fieldHelp } from '../src/index.ts';

describe('fieldHelp', () => {
  it('gives a short name, a translated description and the «empty» text', () => {
    const h = fieldHelp('ITEM', 'races', 'ru');
    expect(h.label).toBe('кто может носить');
    expect(h.description).toMatch(/расы/);
    expect(h.empty).toBe('пусто — все расы');
    expect(fieldHelp('ITEM', 'weight kg', 'zh').label).toBe('重量（千克）');
  });

  it('a TYPE:field entry wins over the plain one', () => {
    expect(fieldHelp('ITEM', 'mesh', 'ru').description).toMatch(/ножнах/);
    expect(fieldHelp('CHARACTER', 'mesh', 'ru').description).toMatch(/случайной/);
    expect(fieldHelp('CHARACTER', 'mesh', 'ru').empty).toBe('пусто — случайная модель');
    expect(fieldHelp('ITEM', 'mesh', 'ru').empty).toBeUndefined();
  });

  it('English has only the «empty» texts', () => {
    expect(fieldHelp('ITEM', 'races', 'en')).toEqual({ empty: 'empty — all races' });
    expect(fieldHelp('ITEM', 'weight kg', 'en')).toEqual({});
  });

  it('a language without a dictionary gets the English «empty» texts', () => {
    expect(fieldHelp('ITEM', 'races', 'de')).toEqual({ empty: 'empty — all races' });
  });

  it('types outside the dictionaries get nothing', () => {
    expect(FIELD_HELP_TYPES.has('TOWN')).toBe(false);
    expect(fieldHelp('TOWN', 'races', 'ru')).toEqual({});
  });
});
