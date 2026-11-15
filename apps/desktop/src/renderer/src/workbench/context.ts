/**
 * Что оболочка даёт панелям: проект, общий выбор, открытие панелей, сообщения в строке
 * состояния. Панель берёт это через `useWorkbench()`, а свою запись — через `useFollowed()`.
 */
import { createContext, useContext, type RefObject } from 'react';
import type { Strings } from '../i18n.ts';
import type { Project } from '../project.ts';
import type { PanelDef, PanelParams } from './registry.ts';
import { useSelectionVersion, type Selection, type SelectionService } from './selection.ts';
import { useProjectVersion } from '../hooks.ts';
import type { ValueStore } from './store.ts';

export interface StatusMessage {
  /** Текст собирается при показе — сообщение переводится при смене языка. */
  text: (t: Strings) => string;
  kind: 'info' | 'error';
}

export interface Workbench {
  project: Project;
  selection: SelectionService;
  /** Выбрать запись (и положить в историю «назад/вперёд»). */
  go: (sid: string) => void;
  /** Ошибка правки — в строку состояния. */
  report: (err: string | undefined) => void;
  status: (msg: StatusMessage) => void;
  /** Открыть (или показать) панель; с `params.sid` у многоэкземплярной — отдельная вкладка. */
  open: (panelId: string, params?: PanelParams) => void;
  /** Открыта ли где-нибудь панель этого вида. */
  hasPanel: (panelId: string) => boolean;
  /** Окно создания записи. */
  newRecord: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Категория в дереве — фильтр списка записей. */
  category: ValueStore<string>;
  /** Пересобрать контекст с другими зависимостями или модами контекста (правки сохраняются). */
  reload: (change: { dependencies?: string[]; contextMods?: string[] }) => Promise<void>;
}

export const WorkbenchContext = createContext<Workbench | null>(null);

export function useWorkbench(): Workbench {
  const wb = useContext(WorkbenchContext);
  if (!wb) throw new Error('Панель вне рабочего пространства');
  return wb;
}

/** Подходит ли выбор панели (вид и тип записи). */
export function accepts(project: Project, def: PanelDef, s: Selection): boolean {
  const shows = def.shows;
  if (!shows?.kinds.includes(s.kind)) return false;
  if (!shows.types) return true;
  const sid = s.kind === 'scene' ? s.sid : s.sid;
  const rec = sid === undefined ? undefined : project.record(sid);
  return rec !== undefined && shows.types.includes(project.ctx.typeName(rec.type));
}

export interface Followed {
  /** Запись, которую показывает панель. */
  sid: string | undefined;
  /** Весь выбор (у реплики — ещё и диалог). */
  item: Selection | undefined;
  pinned: boolean;
  /** Версия данных проекта: меняется при каждой правке. */
  version: number;
}

/**
 * Запись панели: закреплённая (`params.sid`) или последний подходящий выбор. Панель
 * перерисовывается при смене выбора и при правках.
 */
export function useFollowed(def: PanelDef, params: PanelParams): Followed {
  const { project, selection } = useWorkbench();
  useSelectionVersion(selection);
  const version = useProjectVersion(project);
  if (params.sid !== undefined) return { sid: params.sid, item: { kind: 'record', sid: params.sid }, pinned: true, version };
  const item = selection.latest((s) => accepts(project, def, s));
  const sid = item === undefined ? undefined : item.kind === 'scene' ? item.sid : item.sid;
  return { sid, item, pinned: false, version };
}
