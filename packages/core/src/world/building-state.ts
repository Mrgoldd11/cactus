/**
 * State of a new building in the world (GAMESTATE_BUILDING `<key>-S23`).
 *
 * Without a state the game treats a mod-placed building as a construction site "for sale" (0/400
 * building materials) — checked in game. All 14,637 buildings with a state in vanilla zones have
 * `is complete` = true, and the materials in the state mirror the building record:
 *  - `<i>construction mats` — amount of the i-th `construction` reference (v0); without references —
 *    `0construction mats` = `build materials`;
 *  - `construction progress` — their sum.
 * Handles (`handle*`, `isInsideBuilding*`, `residents*`) are not written: they are save object
 * numbers, and copying someone else's would give two buildings with one number. In game interiors, states
 * without handles are common (23k of 28k).
 */
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import { emptyRecord, type GameRecord } from '../format/types.ts';
import { encodeText } from '../text.ts';

/** State format version — same as all vanilla states. */
export const BUILDING_STATE_VERSION = 270;

/** Building state id by instance key. */
export function buildingStateId(key: string): string {
  return `${key}-S23`;
}

/** Finished (fully built) state of building `building` at world height `worldY`. */
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
 * For `WorldEdits.place`: the finished-building state if `record` is a building (BUILDING);
 * otherwise there are no states.
 */
export function newBuildingStates(record: GameRecord | undefined, worldY: number): ((key: string) => GameRecord[]) | undefined {
  if (!record || itemTypeName(record.type) !== 'BUILDING') return undefined;
  return (key) => [newBuildingState(record, buildingStateId(key), worldY)];
}
