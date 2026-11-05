/**
 * Реестр панелей (как contribution points в VS Code). Панель объявляет себя одним вызовом
 * `registerPanel` в своём файле в `workbench/panels/`; оболочка (меню «Окно», раскладки,
 * сохранение) берёт всё из реестра и про конкретные панели не знает.
 */
import type { ComponentType } from 'react';
import type { DockviewPanelApi } from 'dockview-react';
import type { Strings } from '../i18n.ts';
import type { SelectionKind } from './selection.ts';

/** Куда панель встаёт по умолчанию, если её открыть из меню «Окно». */
export type PanelArea = 'left' | 'center' | 'right' | 'bottom';

/** Параметры экземпляра панели (сохраняются в раскладке). */
export interface PanelParams {
  /** Закреплённая запись: панель показывает её, а не текущий выбор. */
  sid?: string;
}

export interface PanelProps {
  def: PanelDef;
  params: PanelParams;
  api: DockviewPanelApi;
}

export interface PanelDef {
  /** Постоянный id: под ним панель хранится в раскладке. */
  id: string;
  title: (t: Strings) => string;
  /** Значок во вкладке и в меню (символ). */
  icon: string;
  component: ComponentType<PanelProps>;
  area: PanelArea;
  /**
   * Что панель умеет показывать: виды выбора и типы записей (`CHARACTER`, `DIALOGUE`…).
   * Панель с `shows` следует за выбором, её можно закрепить на записи (📌).
   */
  shows?: { kinds: readonly SelectionKind[]; types?: readonly string[] };
  /** Можно открыть несколько экземпляров, каждый закреплён на своей записи. */
  multi?: boolean;
  /** Место в меню «Окно». */
  order: number;
  /** Пояснение в меню. */
  hint?: (t: Strings) => string;
  /** Заготовка на будущее (сцена): помечается в меню. */
  placeholder?: boolean;
}

const panels = new Map<string, PanelDef>();

export function registerPanel(def: PanelDef): PanelDef {
  if (panels.has(def.id)) throw new Error(`Панель ${def.id} уже зарегистрирована`);
  panels.set(def.id, def);
  return def;
}

export function panelDef(id: string): PanelDef | undefined {
  return panels.get(id);
}

export function allPanels(): PanelDef[] {
  return [...panels.values()].sort((a, b) => a.order - b.order);
}

/** id экземпляра в раскладке: одиночная панель — её id, закреплённая копия — `id:sid`. */
export function instanceId(def: PanelDef, params: PanelParams = {}): string {
  return def.multi && params.sid !== undefined ? `${def.id}:${params.sid}` : def.id;
}
