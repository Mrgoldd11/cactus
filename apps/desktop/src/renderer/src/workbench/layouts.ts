/**
 * Preset layouts and «default» panel placement. A layout is only which panels
 * stand where; the panels themselves come from the registry.
 */
import type { AddPanelOptions, DockviewApi } from 'dockview-react';
import type { Strings } from '../i18n.ts';
import { allPanels, instanceId, panelDef, type PanelArea, type PanelDef, type PanelParams } from './registry.ts';

export type PresetId = 'data' | 'dialogue' | 'scene';

export const PRESETS: readonly PresetId[] = ['data', 'dialogue', 'scene'];

export function isPreset(v: unknown): v is PresetId {
  return typeof v === 'string' && (PRESETS as readonly string[]).includes(v);
}

export function panelTitle(def: PanelDef, t: Strings, pinnedName?: string): string {
  const base = `${def.icon} ${def.title(t)}`;
  return pinnedName === undefined ? base : `${def.icon} ${pinnedName}`;
}

type Position = AddPanelOptions['position'];

function add(api: DockviewApi, t: Strings, id: string, position?: Position, extra: Partial<AddPanelOptions> = {}): void {
  const def = panelDef(id);
  if (!def) return;
  // No neighbour (panel not registered) — just add it.
  const ref = position && 'referencePanel' in position ? position.referencePanel : undefined;
  const pos = typeof ref === 'string' && !api.getPanel(ref) ? undefined : position;
  api.addPanel({ id: instanceId(def), component: def.id, title: panelTitle(def, t), params: {}, ...(pos ? { position: pos } : {}), ...extra } as AddPanelOptions);
}

function width(api: DockviewApi, id: string, w: number): void {
  api.getPanel(id)?.group.api.setSize({ width: w });
}

const right = (referencePanel: string): Position => ({ referencePanel, direction: 'right' });
const within = (referencePanel: string): Position => ({ referencePanel, direction: 'within' });

/** Apply a layout (everything before is removed). */
export function applyPreset(api: DockviewApi, preset: PresetId, t: Strings): void {
  api.clear();
  if (preset === 'data') {
    add(api, t, 'categories');
    add(api, t, 'records', right('categories'));
    add(api, t, 'inspector', right('records'));
    width(api, 'categories', 240);
    width(api, 'records', Math.max(380, Math.round(api.width * 0.36)));
  } else if (preset === 'dialogue') {
    // G1: the package (events and their dialogues) on the left, the graph at full height in the centre;
    // the player opens only by the graph's «▶ Play» button.
    add(api, t, 'package');
    add(api, t, 'records', within('package'), { inactive: true });
    add(api, t, 'categories', within('package'), { inactive: true });
    add(api, t, 'graph', right('package'));
    add(api, t, 'line', right('graph'));
    add(api, t, 'inspector', within('line'), { inactive: true });
    add(api, t, 'howto', within('line'), { inactive: true });
    add(api, t, 'diagnostics', within('line'), { inactive: true });
    width(api, 'package', 340);
    width(api, 'line', 400);
  } else {
    // «World»: record list on the left, map in the centre, the selected object and its model on the right.
    add(api, t, 'records');
    add(api, t, 'world', right('records'));
    add(api, t, 'inspector', right('world'));
    add(api, t, 'model', within('inspector'));
    add(api, t, 'where', within('inspector'), { inactive: true });
    width(api, 'records', 300);
    width(api, 'inspector', 360);
    api.getPanel('inspector')?.api.setActive();
  }
  const first = preset === 'data' ? 'records' : preset === 'dialogue' ? 'graph' : 'world';
  api.getPanel(first)?.api.setActive();
}

/** Where an area panel goes if that area has nothing yet. */
const AREA_DIRECTION: Record<PanelArea, 'left' | 'right' | 'below' | 'above'> = { left: 'left', center: 'right', right: 'right', bottom: 'below' };

/**
 * Open a panel (or show an already open one). It becomes a tab next to a panel of the same area,
 * and if there is none — on the right side of the window. `near` — become a tab next to this panel.
 */
export function openPanel(api: DockviewApi, t: Strings, id: string, params: PanelParams = {}, near?: string): void {
  const def = panelDef(id);
  if (!def) return;
  const iid = instanceId(def, params);
  const existing = api.getPanel(iid);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const nearPanel = near === undefined ? undefined : api.getPanel(near);
  const sibling = nearPanel ?? api.panels.find((p) => panelDef(p.api.component)?.area === def.area);
  let position: Position;
  if (sibling) position = within(sibling.id);
  else if (def.area === 'center') {
    const side = api.panels.find((p) => panelDef(p.api.component)?.area === 'left');
    position = side ? right(side.id) : { direction: 'right' };
  } else position = { direction: AREA_DIRECTION[def.area] };
  api.addPanel({ id: iid, component: def.id, title: panelTitle(def, t), params, position });
}

/**
 * Open a panel in its own group below `below` (G9, M8: «Check» must not hide the line panel behind a tab).
 * Returns false when there is no `below` panel: the caller opens the panel the usual way.
 */
export function openBelow(api: DockviewApi, t: Strings, id: string, below: string): boolean {
  const ref = api.getPanel(below);
  const def = panelDef(id);
  if (!ref || !def) return false;
  const iid = instanceId(def);
  const cur = api.getPanel(iid);
  if (cur && cur.group !== ref.group) {
    cur.api.setActive();
    return true;
  }
  cur?.api.close();
  api.addPanel({ id: iid, component: def.id, title: panelTitle(def, t), params: {}, position: { referencePanel: ref.id, direction: 'below' } });
  return true;
}

/** Whether all panels of the saved layout are in the registry (otherwise the layout cannot be restored). */
export function layoutKnown(layout: unknown): boolean {
  if (typeof layout !== 'object' || layout === null) return false;
  const panels = (layout as { panels?: Record<string, { contentComponent?: string }> }).panels;
  if (!panels || typeof panels !== 'object') return false;
  const known = new Set(allPanels().map((d) => d.id));
  return Object.values(panels).every((p) => typeof p.contentComponent === 'string' && known.has(p.contentComponent));
}
