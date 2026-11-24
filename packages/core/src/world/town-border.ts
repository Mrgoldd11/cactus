/**
 * Town border: a circle around the center, radius is the game's `Town::getRadius()`.
 *
 * Decoded from the exe (Steam 1.0.65, `Town::getRadius` = RVA 0x925FE0) and checked in game via the bridge:
 * the Hub (type 2) — 2500, Rebel Base (type 9) — 437.5. The radius depends only on the town type
 * (`type` of the TOWN record, the same number as the game's `townType`) and the `town radius mult` multiplier:
 *   type 2 (city) — 2500; 3 (village) — 937.5; 4 (ruins) — 875; 9 — 437.5;
 *   8 and 10 — 0 (no border); everything else (0 nest, 1 outpost, 5–7 camp/army/prison, unknown) — 1250.
 * Not handled: the game has a rare branch (town object field 0x51C > 1 — mod data does not have it),
 * in which case the radius is taken from that field.
 */

/** Default type of a TOWN record without a `type` field — TOWN_OUTPOST. */
export const TOWN_DEFAULT_TYPE = 1;

const BASE_RADIUS: Record<number, number> = { 2: 2500, 3: 937.5, 4: 875, 8: 0, 9: 437.5, 10: 0 };

/** Town border radius by type and the `town radius mult` multiplier; 0 — no border. */
export function townBorderRadius(type: number = TOWN_DEFAULT_TYPE, mult = 1): number {
  const base = BASE_RADIUS[type] ?? 1250;
  return base * mult;
}
