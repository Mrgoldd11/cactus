/**
 * Records handed from the record list to «Bulk edits» (multi-selection → «Bulk edit (N)»).
 * A snapshot, not the live selection: clicking a record in the bulk preview selects it in the list
 * and would otherwise drop the scope. `stamp` tells a new hand-over from the same ids.
 */
import { ValueStore } from './store.ts';

export interface BulkScope {
  ids: readonly string[];
  stamp: number;
}

export const bulkScope = new ValueStore<BulkScope | undefined>(undefined);
