/**
 * Радиус границы города: значения сверены с игрой (Хаб 2500, База Мятежников 437.5).
 */
import { describe, expect, it } from 'vitest';
import { townBorderRadius } from '../src/index.ts';

describe('радиус границы города', () => {
  it('по типу города', () => {
    expect(townBorderRadius(2)).toBe(2500);
    expect(townBorderRadius(9)).toBe(437.5);
    expect(townBorderRadius(3)).toBe(937.5);
    expect(townBorderRadius(4)).toBe(875);
    expect(townBorderRadius(1)).toBe(1250);
    expect(townBorderRadius(0)).toBe(1250);
    expect(townBorderRadius(8)).toBe(0);
    expect(townBorderRadius(10)).toBe(0);
    expect(townBorderRadius(42)).toBe(1250);
  });
  it('множитель и тип по умолчанию (застава)', () => {
    expect(townBorderRadius(2, 1.5)).toBe(3750);
    expect(townBorderRadius(undefined, 2)).toBe(2500);
  });
});
