/**
 * Town border radius: values checked against the game (The Hub 2500, Rebel Base 437.5).
 */
import { describe, expect, it } from 'vitest';
import { townBorderRadius } from '../src/index.ts';

describe('town border radius', () => {
  it('by town type', () => {
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
  it('multiplier and default type (outpost)', () => {
    expect(townBorderRadius(2, 1.5)).toBe(3750);
    expect(townBorderRadius(undefined, 2)).toBe(2500);
  });
});
