/**
 * Общий выбор и контекст рабочего пространства (как выделение в Unity: панели не знают друг о
 * друге, а слушают, что выбрано). Выбор — запись, реплика диалога или объект сцены. Каждая
 * панель берёт последний подходящий ей выбор: граф — последний диалог, «Разговор» — последнего
 * персонажа, инспектор — последнюю запись. История «назад/вперёд» — по выбору записей.
 */
import { useSyncExternalStore } from 'react';

export type Selection =
  | { kind: 'record'; sid: string }
  /** Реплика диалога; `dialog` — в каком диалоге её выбрали (граф, плеер). */
  | { kind: 'line'; sid: string; dialog?: string }
  /** Объект сцены (этап 7: 3D-вид). `sid` — запись, которую объект показывает, если есть. */
  | { kind: 'scene'; id: string; sid?: string };

export type SelectionKind = Selection['kind'];

const MAX_RECENT = 60;
const MAX_HISTORY = 200;

function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'scene') return a.id === (b as { id: string }).id;
  return a.sid === (b as { sid: string }).sid && (a.kind !== 'line' || a.dialog === (b as { dialog?: string }).dialog);
}

/** Запись, к которой относится выбор (у объекта сцены — если он что-то показывает). */
export function selectionSid(s: Selection): string | undefined {
  return s.kind === 'scene' ? s.sid : s.sid;
}

export class SelectionService {
  /** Последние выборы, самый свежий первым, без повторов. */
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

  /** Последний выбор, который принимает `accept`. */
  latest<T extends Selection = Selection>(accept: (s: Selection) => s is T): T | undefined;
  latest(accept?: (s: Selection) => boolean): Selection | undefined;
  latest(accept: (s: Selection) => boolean = () => true): Selection | undefined {
    return this.recentList.find(accept);
  }

  /** Текущая запись истории навигации. */
  get current(): string | undefined {
    return this.history[this.pos];
  }

  get canBack(): boolean {
    return this.pos > 0;
  }

  get canForward(): boolean {
    return this.pos < this.history.length - 1;
  }

  /** Выбрать. `history: false` — не класть в «назад/вперёд» (например, наведение в плеере). */
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

  /** Убрать из выбора записи, которых больше нет (после отмены создания и т. п.). */
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

/** Перерисовываться при каждом изменении выбора; возвращает номер версии выбора. */
export function useSelectionVersion(service: SelectionService): number {
  return useSyncExternalStore(service.subscribe, () => service.version);
}
