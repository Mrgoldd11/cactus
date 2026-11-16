/**
 * Panel registry (like contribution points in VS Code). A panel declares itself with one
 * `registerPanel` call in its file in `workbench/panels/`; the shell («Window» menu, layouts,
 * saving) takes everything from the registry and knows nothing about specific panels.
 */
import type { ComponentType } from 'react';
import type { DockviewPanelApi } from 'dockview-react';
import type { Strings } from '../i18n.ts';
import type { SelectionKind } from './selection.ts';

/** Where the panel goes by default when opened from the «Window» menu. */
export type PanelArea = 'left' | 'center' | 'right' | 'bottom';

/** Window menu sections, in menu order; the first three match the layout presets. */
export const PANEL_GROUPS = ['data', 'dialogue', 'scene', 'mod'] as const;
export type PanelGroup = (typeof PANEL_GROUPS)[number];

/** Panel instance parameters (saved in the layout). */
export interface PanelParams {
  /** Pinned record: the panel shows it instead of the current selection. */
  sid?: string;
}

export interface PanelProps {
  def: PanelDef;
  params: PanelParams;
  api: DockviewPanelApi;
}

export interface PanelDef {
  /** Stable id: the panel is stored in the layout under it. */
  id: string;
  title: (t: Strings) => string;
  /** Icon in the tab and in the menu (a character). */
  icon: string;
  component: ComponentType<PanelProps>;
  area: PanelArea;
  /**
   * What the panel can show: selection kinds and record types (`CHARACTER`, `DIALOGUE`…).
   * A panel with `shows` follows the selection and can be pinned to a record (⊙).
   */
  shows?: { kinds: readonly SelectionKind[]; types?: readonly string[] };
  /** Several instances can be opened, each pinned to its own record. */
  multi?: boolean;
  /** Section of the Window menu the panel is listed in. */
  group: PanelGroup;
  /** Place in the «Window» menu. */
  order: number;
  /** Description in the menu. */
  hint?: (t: Strings) => string;
  /** Placeholder for the future (scene): marked in the menu. */
  placeholder?: boolean;
}

const panels = new Map<string, PanelDef>();

export function registerPanel(def: PanelDef): PanelDef {
  if (panels.has(def.id)) throw new Error(`Panel ${def.id} is already registered`);
  panels.set(def.id, def);
  return def;
}

export function panelDef(id: string): PanelDef | undefined {
  return panels.get(id);
}

export function allPanels(): PanelDef[] {
  return [...panels.values()].sort((a, b) => a.order - b.order);
}

/** Instance id in the layout: a single panel — its id, a pinned copy — `id:sid`. */
export function instanceId(def: PanelDef, params: PanelParams = {}): string {
  return def.multi && params.sid !== undefined ? `${def.id}:${params.sid}` : def.id;
}
