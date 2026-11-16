/**
 * Shared selection and workspace context (like selection in Unity: panels do not know about each
 * other, they listen to what is selected). A selection is a record, a dialogue line or a scene object. Each
 * panel takes the latest selection that suits it: the graph — the latest dialogue, «Conversation» — the latest
 * character, the inspector — the latest record. The «back/forward» history follows record selections.
 */
import { useSyncExternalStore } from 'react';

export type Selection =
  | { kind: 'record'; sid: string }
  /** Dialogue line; `dialog` — in which dialogue it was selected (graph, player). */
  | { kind: 'line'; sid: string; dialog?: string; parent?: string }
  /** Scene object (stage 7: 3D view). `sid` — the record the object shows, if any. */
  | { kind: 'scene'; id: string; sid?: string };

export type SelectionKind = Selection['kind'];

const MAX_RECENT = 60;
const MAX_HISTORY = 200;

function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'scene') return a.id === (b as { id: string }).id;
  return a.sid === (b as { sid: string }).sid && (a.kind !== 'line' || a.dialog === (b as { dialog?: string }).dialog);
}

/** The record the selection refers to (for a scene object — if it shows something). */
export function selectionSid(s: Selection): string | undefined {
  return s.kind === 'scene' ? s.sid : s.sid;
}

export class SelectionService {
  /** Latest selections, newest first, no duplicates. */
  private recentList: Selection[] = [];
  private history: string[] = [];
  private pos = -1;
  private listeners = new Set<() => void>();
  private versionNo = 0;

  get version(): number {
    return this.versionNo;
  }

  get recent(): readonly Selection[] {
    return this.recentList;
  }

  /** The latest selection that `accept` takes. */
  latest<T extends Selection = Selection>(accept: (s: Selection) => s is T): T | undefined;
  latest(accept?: (s: Selection) => boolean): Selection | undefined;
  latest(accept: (s: Selection) => boolean = () => true): Selection | undefined {
    return this.recentList.find(accept);
  }

  /** Current navigation history entry. */
  get current(): string | undefined {
    return this.history[this.pos];
  }

  get canBack(): boolean {
    return this.pos > 0;
  }

  get canForward(): boolean {
    return this.pos < this.history.length - 1;
  }

  /** Select. `history: false` — do not push to «back/forward» (e.g. hover in the player). */
  select(item: Selection, options: { history?: boolean } = {}): void {
    const top = this.recentList[0];
    const sid = selectionSid(item);
    const histChange = options.history !== false && sid !== undefined && this.history[this.pos] !== sid;
    if (top && sameSelection(top, item) && !histChange) return;
    this.recentList = [item, ...this.recentList.filter((s) => !sameSelection(s, item))].slice(0, MAX_RECENT);
    if (histChange) {
      this.history = [...this.history.slice(0, this.pos + 1), sid].slice(-MAX_HISTORY);
      this.pos = this.history.length - 1;
    }
    this.emit();
  }

  back(): void {
    if (!this.canBack) return;
    this.pos--;
    this.reselect();
  }

  forward(): void {
    if (!this.canForward) return;
    this.pos++;
    this.reselect();
  }

  /** Remove records that no longer exist from the selection (after undoing a creation etc.). */
  prune(exists: (sid: string) => boolean): void {
    const keep = this.recentList.filter((s) => {
      const sid = selectionSid(s);
      return sid === undefined || exists(sid);
    });
    if (keep.length === this.recentList.length) return;
    this.recentList = keep;
    this.emit();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private reselect(): void {
    const sid = this.history[this.pos];
    if (sid === undefined) return;
    const item: Selection = { kind: 'record', sid };
    this.recentList = [item, ...this.recentList.filter((s) => !sameSelection(s, item))].slice(0, MAX_RECENT);
    this.emit();
  }

  private emit(): void {
    this.versionNo++;
    for (const fn of this.listeners) fn();
  }
}

/** Re-render on every selection change; returns the selection version number. */
export function useSelectionVersion(service: SelectionService): number {
  return useSyncExternalStore(service.subscribe, () => service.version);
}
