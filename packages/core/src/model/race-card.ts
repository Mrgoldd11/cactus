/**
 * Race card of the inspector: what has been done with a race and what is left, computed from the
 * data alone (nothing is stored), so it is right for races made in Cactus, in FCS or through MCP.
 *
 * - the sample: the race this one most looks like (same meshes, part maps, reference lists) or
 *   stands next to in lists (armour, dialogue, race groups) — the sample of the compatibility wizard;
 * - compatibility: how many default changes `planRaceCompat` still offers and how many places
 *   already list the race;
 * - own animations: animation files of the race that the mod itself added.
 */
import type { GameRecord } from '../format/types.ts';
import type { ModContext } from './context.ts';
import { planRaceCompat } from './race-compat.ts';

const RACE = 'RACE';

/** Below this score a race is not called a sample (an empty race matches nothing meaningful). */
const MIN_SAMPLE_SCORE = 3;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Non-empty text and file fields with the same value, and non-empty reference lists with the same targets. */
function sameFields(a: GameRecord, b: GameRecord): number {
  let n = 0;
  for (const map of ['files', 'strings'] as const) {
    for (const [k, v] of a[map]) {
      if (v.length === 0) continue;
      const w = b[map].get(k);
      if (w && bytesEqual(v, w)) n++;
    }
  }
  for (const [k, list] of a.refs) {
    if (list.length === 0) continue;
    const other = b.refs.get(k);
    if (!other || other.length !== list.length) continue;
    const targets = new Set(other.map((r) => r.target));
    if (list.every((r) => targets.has(r.target))) n++;
  }
  return n;
}

/**
 * The race `race` most likely copies or works like, or undefined when nothing is close enough.
 * Only races the mod did not create itself are candidates.
 */
export function guessRaceSample(ctx: ModContext, race: string): string | undefined {
  const rec = ctx.get(race);
  if (!rec || ctx.typeName(rec.type) !== RACE) return undefined;
  const raceType = ctx.typeId(RACE);
  const score = new Map<string, number>();
  for (const sid of ctx.allStringIds()) {
    if (sid === race) continue;
    const h = ctx.headline(sid);
    if (!h || h.type !== raceType) continue;
    const st = ctx.status(sid);
    if (st === 'new' || st === 'deleted') continue;
    const other = ctx.get(sid);
    if (other) score.set(sid, sameFields(rec, other));
  }
  // Lists where the race stands next to another race (after the compatibility wizard).
  const seen = new Set<string>();
  for (const e of ctx.referencesTo(race)) {
    if (!e.ref || e.source === race) continue;
    const key = `${e.source}|${e.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const r of ctx.get(e.source)?.refs.get(e.category) ?? []) {
      const s = score.get(r.target);
      if (s !== undefined) score.set(r.target, s + 1);
    }
  }
  let best: string | undefined;
  let bestScore = MIN_SAMPLE_SCORE - 1;
  for (const [sid, s] of score) {
    if (s > bestScore) {
      best = sid;
      bestScore = s;
    }
  }
  return best;
}

export interface RaceCardState {
  /** The race is a record the mod created (not a vanilla or dependency race). */
  own: boolean;
  /** Guessed sample race (see `guessRaceSample`); only for the mod's own races. */
  sample?: string;
  /** Compatibility with the sample: default-ticked changes still offered, places already done. */
  compat?: { todo: number; already: number };
  /** Animation files of the race that are records of the mod itself. */
  ownAnimations: number;
}

export function raceCardState(ctx: ModContext, race: string, options: { contextMods?: readonly string[] } = {}): RaceCardState {
  const rec = ctx.get(race);
  const own = ctx.status(race) === 'new';
  const ownAnimations = (rec?.refs.get('animation files') ?? []).filter((r) => ctx.status(r.target) === 'new').length;
  if (!own) return { own, ownAnimations };
  const sample = guessRaceSample(ctx, race);
  if (sample === undefined) return { own, ownAnimations };
  const plan = planRaceCompat(ctx, race, sample, options);
  return { own, sample, compat: { todo: plan.changes.filter((c) => c.checked).length, already: plan.already }, ownAnimations };
}
