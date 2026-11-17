/**
 * The pair of races handed to the «Race compatibility» wizard (from «New race based on…»): the
 * wizard opens with «My race» = `race` and «works like» = `sample`. `stamp` tells a new hand-over
 * of the same pair; the wizard applies each stamp once.
 */
import { ValueStore } from './store.ts';

export interface RaceCompatPair {
  race: string;
  sample: string;
  stamp: number;
}

export const raceCompatPair = new ValueStore<RaceCompatPair | undefined>(undefined);
