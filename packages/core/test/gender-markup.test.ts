import { describe, expect, it } from 'vitest';
import { plainName, stripGenderMarkup } from '../src/index.ts';

describe('gender markup of translations', () => {
  it('Russian names: masculine form whatever the order inside the slashes', () => {
    expect(stripGenderMarkup('Трактирщи/кца1/')).toBe('Трактирщик');
    expect(stripGenderMarkup('Охотни/кца/')).toBe('Охотник');
    expect(stripGenderMarkup('Бежен/каец1/')).toBe('Беженец');
    expect(stripGenderMarkup('Главн/аяый1/')).toBe('Главный');
    expect(stripGenderMarkup('Мелк/аяий1/ охотни/кца1/')).toBe('Мелкий охотник');
    expect(stripGenderMarkup('Противни/кца1/ рабства')).toBe('Противник рабства');
  });

  it('Russian lines: endings, verbs and pronouns', () => {
    expect(stripGenderMarkup('Рад/а/, что ты здесь')).toBe('Рад, что ты здесь');
    expect(stripGenderMarkup('Ты умрёшь за то, что сделал/а1/')).toBe('Ты умрёшь за то, что сделал');
    expect(stripGenderMarkup('Я не мыл/асься/ месяц')).toBe('Я не мылся месяц');
    expect(stripGenderMarkup('Я свобод/енна1/!')).toBe('Я свободен!');
    expect(stripGenderMarkup('Отдай /мненам1/ еду')).toBe('Отдай мне еду');
    expect(stripGenderMarkup('Вот /татот/ идиот')).toBe('Вот тот идиот');
    expect(stripGenderMarkup('полоумн/огоую/')).toBe('полоумного');
  });

  it('leaves substitution words, plain text and other slashes alone', () => {
    expect(stripGenderMarkup('Эй, /FLATSKIN/!')).toBe('Эй, /FLATSKIN/!');
    expect(stripGenderMarkup('/OI/, ты')).toBe('/OI/, ты');
    expect(stripGenderMarkup('Трактирщик')).toBe('Трактирщик');
    expect(stripGenderMarkup('1/2 пути')).toBe('1/2 пути');
    expect(stripGenderMarkup('a / b / c')).toBe('a / b / c');
  });

  it('other languages (plainName keeps working)', () => {
    expect(plainName('Bäcker/FEM-IN-ME/')).toBe('Bäcker');
    expect(plainName('Bandid/OA3/')).toBe('Bandido');
    expect(plainName('Оружейни/кца1/')).toBe('Оружейник');
  });
});
