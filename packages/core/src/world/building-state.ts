/**
 * Состояние нового здания в мире (GAMESTATE_BUILDING `<ключ>-S23`).
 *
 * Без состояния игра считает поставленное модом здание стройплощадкой «на продажу» (0/400
 * стройматериалов) — проверено в игре. У всех 14 637 зданий с состоянием в зонах ванили
 * `is complete` = true, а материалы в состоянии повторяют запись здания:
 *  - `<i>construction mats` — количество i-й ссылки `construction` (v0); без ссылок —
 *    `0construction mats` = `build materials`;
 *  - `construction progress` — их сумма.
 * Хэндлы (`handle*`, `isInsideBuilding*`, `residents*`) не пишем: это номера объектов
 * сохранения, копия чужих дала бы два здания с одним номером. В интерьерах игры состояния
 * без хэндлов — обычное дело (23 тыс. из 28 тыс.).
 */
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import { emptyRecord, type GameRecord } from '../format/types.ts';
import { encodeText } from '../text.ts';

/** Версия формата состояния — как у всех состояний ванили. */
export const BUILDING_STATE_VERSION = 270;

/** Id состояния здания по ключу экземпляра. */
export function buildingStateId(key: string): string {
  return `${key}-S23`;
}

/** Готовое (достроенное) состояние здания `building` с высотой в мире `worldY`. */
export function newBuildingState(building: GameRecord, stateId: string, worldY: number): GameRecord {
  const st = emptyRecord(itemTypeId('GAMESTATE_BUILDING') ?? 0, stateId, encodeText('0'));
  const mats = (building.refs.get('construction') ?? []).map((r) => r.v0);
  if (mats.length === 0) mats.push(building.ints.get('build materials') ?? 0);
  st.floats.set('world Y pos', worldY);
  st.floats.set('player furniture Y offset', 0);
  mats.forEach((n, i) => st.floats.set(`${i}construction mats`, n));
  st.floats.set('construction progress', mats.reduce((a, b) => a + b, 0));
  st.ints.set('version', BUILDING_STATE_VERSION);
  st.ints.set('flags', 0);
  st.ints.set('floornum', 0);
  st.bools.set('is complete', true);
  st.bools.set('is inside building', false);
  st.bools.set('foliage', false);
  st.bools.set('destroyed', false);
  st.strings.set('owner faction ID', encodeText(''));
  st.strings.set('squad template', encodeText(''));
  return st;
}

/**
 * Для `WorldEdits.place`: состояние готового здания, если `record` — здание (BUILDING);
 * иначе состояний нет.
 */
export function newBuildingStates(record: GameRecord | undefined, worldY: number): ((key: string) => GameRecord[]) | undefined {
  if (!record || itemTypeName(record.type) !== 'BUILDING') return undefined;
  return (key) => [newBuildingState(record, buildingStateId(key), worldY)];
}
