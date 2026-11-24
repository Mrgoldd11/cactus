/** A small shared workspace value (e.g. the selected category). */
import { useSyncExternalStore } from 'react';

export class ValueStore<T> {
  private listeners = new Set<() => void>();
  private value: T;
  constructor(value: T) {
    this.value = value;
  }

  get(): T {
    return this.value;
  }

  set(v: T): void {
    if (Object.is(v, this.value)) return;
    this.value = v;
    for (const fn of this.listeners) fn();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
}

export function useStore<T>(store: ValueStore<T>): T {
  return useSyncExternalStore(store.subscribe, () => store.get());
}
