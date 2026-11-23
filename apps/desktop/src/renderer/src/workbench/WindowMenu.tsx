/**
 * «Window» menu: all panels from the registry (check mark — open; click opens or closes),
 * preset layouts and «Reset layout».
 */
import { useRef, useState, type ReactNode } from 'react';
import type { DockviewApi } from 'dockview-react';
import { useT } from '../i18n.ts';
import { useDismiss } from '../hooks.ts';
import { allPanels, PANEL_GROUPS, type PanelDef, type PanelGroup } from './registry.ts';
import { PRESETS, type PresetId } from './layouts.ts';

interface Props {
  api: DockviewApi | undefined;
  preset: PresetId;
  onPreset: (p: PresetId) => void;
  onOpen: (panelId: string) => void;
}

/** Three layout buttons next to the «Window» menu: click — switch at once. */
export function LayoutSwitch({ api, preset, onPreset }: Pick<Props, 'api' | 'preset' | 'onPreset'>): ReactNode {
  const t = useT();
  return (
    <div className="layout-switch" role="radiogroup">
      {PRESETS.map((p) => (
        <button
          key={p}
          role="radio"
          aria-checked={p === preset}
          className={p === preset ? 'active' : ''}
          disabled={!api}
          data-testid={`window-preset-${p}`}
          onClick={() => {
            onPreset(p);
          }}
        >
          {t[`preset_${p}`]}
        </button>
      ))}
    </div>
  );
}

export function WindowMenu({ api, preset, onPreset, onOpen }: Props): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => {
    setOpen(false);
  });

  const isOpen = (id: string): boolean => api?.panels.some((p) => p.api.component === id) ?? false;
  const toggle = (id: string): void => {
    if (!api) return;
    const shown = api.panels.filter((p) => p.api.component === id);
    if (shown.length > 0) for (const p of shown) p.api.close();
    else onOpen(id);
  };

  const groupTitle = (g: PanelGroup): string => (g === 'mod' ? t.windowGroup_mod : t[`preset_${g}`]);
  const item = (d: PanelDef): ReactNode => (
    <button
      key={d.id}
      role="menuitemcheckbox"
      aria-checked={isOpen(d.id)}
      className="menu-item"
      data-testid={`window-panel-${d.id}`}
      title={d.shows ? t.followsHint : undefined}
      onClick={() => {
        toggle(d.id);
        setOpen(false);
      }}
    >
      <span className="menu-check">{isOpen(d.id) ? '✓' : ''}</span>
      <span className="menu-icon">{d.icon}</span>
      {d.title(t)}
      {d.placeholder && <span className="muted"> · {t.placeholderSoon}</span>}
    </button>
  );

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        data-testid="window-menu"
        className={open ? 'active' : ''}
        disabled={!api}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        {t.windowMenu} ▾
      </button>
      {open && api && (
        <div className="menu" role="menu" data-testid="window-menu-list">
          {PANEL_GROUPS.map((g) => {
            const list = allPanels().filter((d) => d.group === g && !d.placeholder);
            if (list.length === 0) return null;
            return (
              <div key={g} role="group" aria-label={groupTitle(g)} data-testid={`window-group-${g}`}>
                {g !== PANEL_GROUPS[0] && <div className="menu-sep" />}
                <div className="menu-group">{groupTitle(g)}</div>
                {list.map(item)}
              </div>
            );
          })}
          <div className="menu-sep" />
          <button
            className="menu-item"
            data-testid="window-reset"
            onClick={() => {
              onPreset(preset);
              setOpen(false);
            }}
          >
            <span className="menu-check" />
            {t.resetLayout}
          </button>
        </div>
      )}
    </div>
  );
}
