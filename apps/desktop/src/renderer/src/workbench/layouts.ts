/**
 * Готовые раскладки и размещение панели «по умолчанию». Раскладка — это только какие панели
 * где стоят; сами панели берутся из реестра.
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
  // Соседа нет (панель не зарегистрирована) — просто добавить.
  const ref = position && 'referencePanel' in position ? position.referencePanel : undefined;
  const pos = typeof ref === 'string' && !api.getPanel(ref) ? undefined : position;
  api.addPanel({ id: instanceId(def), component: def.id, title: panelTitle(def, t), params: {}, ...(pos ? { position: pos } : {}), ...extra } as AddPanelOptions);
}

function width(api: DockviewApi, id: string, w: number): void {
  api.getPanel(id)?.group.api.setSize({ width: w });
}

function height(api: DockviewApi, id: string, h: number): void {
  api.getPanel(id)?.group.api.setSize({ height: h });
}

const right = (referencePanel: string): Position => ({ referencePanel, direction: 'right' });
const below = (referencePanel: string): Position => ({ referencePanel, direction: 'below' });
const within = (referencePanel: string): Position => ({ referencePanel, direction: 'within' });

/** Поставить раскладку (всё прежнее убирается). */
export function applyPreset(api: DockviewApi, preset: PresetId, t: Strings): void {
  api.clear();
  if (preset === 'data') {
    add(api, t, 'categories');
    add(api, t, 'records', right('categories'));
    add(api, t, 'inspector', right('records'));
    width(api, 'categories', 240);
    width(api, 'records', Math.max(380, Math.round(api.width * 0.36)));
  } else if (preset === 'dialogue') {
    add(api, t, 'records');
    add(api, t, 'categories', within('records'), { inactive: true });
    add(api, t, 'graph', right('records'));
    add(api, t, 'line', right('graph'));
    add(api, t, 'inspector', within('line'), { inactive: true });
    add(api, t, 'player', below('graph'));
    add(api, t, 'howto', within('player'), { inactive: true });
    add(api, t, 'diagnostics', within('player'), { inactive: true });
    width(api, 'records', 320);
    width(api, 'line', 400);
    height(api, 'player', Math.round(api.height * 0.38));
  } else {
    add(api, t, 'records');
    add(api, t, 'viewport', right('records'));
    add(api, t, 'model', within('viewport'));
    add(api, t, 'components', right('viewport'));
    add(api, t, 'inspector', within('components'), { inactive: true });
    width(api, 'records', 300);
    width(api, 'components', 340);
  }
  const first = preset === 'data' ? 'records' : preset === 'dialogue' ? 'graph' : 'model';
  api.getPanel(first)?.api.setActive();
}

/** Куда встаёт панель области, если в этой области ещё ничего нет. */
const AREA_DIRECTION: Record<PanelArea, 'left' | 'right' | 'below' | 'above'> = { left: 'left', center: 'right', right: 'right', bottom: 'below' };

/**
 * Открыть панель (или показать уже открытую). Встаёт вкладкой к панели той же области,
 * а если таких нет — с нужной стороны окна. `near` — встать вкладкой рядом с этой панелью.
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

/** Все ли панели сохранённой раскладки есть в реестре (иначе раскладку не восстановить). */
export function layoutKnown(layout: unknown): boolean {
  if (typeof layout !== 'object' || layout === null) return false;
  const panels = (layout as { panels?: Record<string, { contentComponent?: string }> }).panels;
  if (!panels || typeof panels !== 'object') return false;
  const known = new Set(allPanels().map((d) => d.id));
  return Object.values(panels).every((p) => typeof p.contentComponent === 'string' && known.has(p.contentComponent));
}
