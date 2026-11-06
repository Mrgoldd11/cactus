/**
 * Состояние нового здания: готовое (`is complete`), материалы как в записи здания,
 * не здание — состояний нет.
 */
import { describe, expect, it } from 'vitest';
import { buildingStateId, emptyRecord, encodeText, itemTypeId, itemTypeName, newBuildingState, newBuildingStates } from '../src/index.ts';

function building(fill: (r: ReturnType<typeof emptyRecord>) => void = () => undefined) {
  const r = emptyRecord(itemTypeId('BUILDING')!, '10-x.mod', encodeText('Лаба'));
  fill(r);
  return r;
}

describe('состояние нового здания', () => {
  it('готовое, материалы из ссылок construction, высота в мире', () => {
    const rec = building((r) => {
      r.refs.set('construction', [
        { target: 'A', v0: 300, v1: 0, v2: 0 },
        { target: 'B', v0: 100, v1: 0, v2: 0 },
      ]);
    });
    const st = newBuildingState(rec, buildingStateId('5-k'), 812.5);
    expect(st.stringId).toBe('5-k-S23');
    expect(itemTypeName(st.type)).toBe('GAMESTATE_BUILDING');
    expect(st.bools.get('is complete')).toBe(true);
    expect(st.floats.get('world Y pos')).toBe(812.5);
    expect(st.floats.get('0construction mats')).toBe(300);
    expect(st.floats.get('1construction mats')).toBe(100);
    expect(st.floats.get('construction progress')).toBe(400);
    expect(st.ints.get('version')).toBe(270);
  });

  it('без ссылок construction — build materials', () => {
    const st = newBuildingState(building((r) => r.ints.set('build materials', 40)), 'k-S23', 0);
    expect(st.floats.get('0construction mats')).toBe(40);
    expect(st.floats.get('construction progress')).toBe(40);
  });

  it('состояния только у зданий', () => {
    expect(newBuildingStates(undefined, 0)).toBeUndefined();
    expect(newBuildingStates(emptyRecord(itemTypeId('ITEM')!, 'i', encodeText('i')), 0)).toBeUndefined();
    const make = newBuildingStates(building(), 3)!;
    const [st] = make('7-k');
    expect(st?.stringId).toBe('7-k-S23');
  });
});
