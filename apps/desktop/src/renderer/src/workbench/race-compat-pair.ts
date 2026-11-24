/**
 * The pair of races handed to the «Race compatibility» wizard (from «New race based on…» and the race card): the
 * wizard opens with «My race» = `race` and «works like» = `sample`. `stamp` tells a new hand-over
 * of the same pair; the wizard applies each stamp once.
 */
import { ValueStore } from './store.ts';

export interface RaceCompatPair {
  race: string;
  /** Unset — the wizard picks its default sample for `race`. */
  sample?: string;
  stamp: number;
}

export const raceCompatPair = new ValueStore<RaceCompatPair | undefined>(undefined);
