/**
 * Hand-overs around the «Add animations» wizard. `addAnimsRace` — the race the wizard opens with (from the
 * record list or «Model»). `modelClipRequest` — after the wizard, «Model» selects this clip of the record and
 * plays it. `stamp` tells a new hand-over of the same value; each is applied once.
 */
import { ValueStore } from './store.ts';

export const addAnimsRace = new ValueStore<{ race: string; stamp: number } | undefined>(undefined);

export const modelClipRequest = new ValueStore<{ sid: string; clip: string; stamp: number } | undefined>(undefined);
