/**
 * Dropdown menus of the editor toolbar, built like the «Window» menu. By default the «Mod» menu:
 * mod-level actions (mod info, dependencies, backups, publish) grouped so the toolbar fits one row;
 * with `testId` and `label` the same dropdown serves the «Create» menu.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n.ts';

export interface ModMenuItem {
  testId: string;
  label: ReactNode;
  title?: string;
  /** When set, the item is disabled and this text is shown under its label. */
  disabledHint?: string;
  onClick: () => void;
}

interface Props {
  items: ModMenuItem[];
  /** Extra content on the menu button itself (e.g. the FCS Extended badge). */
  badge?: ReactNode;
  title?: string;
  /** Test id of the menu button; the list gets `<testId>-list`. Default — the «Mod» menu. */
  testId?: string;
  /** Text of the menu button. Default — «Mod». */
  label?: ReactNode;
}

export function ModMenu({ items, badge, title, testId = 'mod-menu', label }: Props): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        data-testid={testId}
        className={open ? 'active' : ''}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        {label ?? t.modMenu}
        {badge}
        {' ▾'}
      </button>
      {open && (
        <div className="menu" role="menu" data-testid={`${testId}-list`}>
          {items.map((it) => (
            <button
              key={it.testId}
              role="menuitem"
              className="menu-item"
              data-testid={it.testId}
              title={it.disabledHint ?? it.title}
              disabled={it.disabledHint !== undefined}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <span className="menu-check" />
              <span className="menu-label">
                {it.label}
                {it.disabledHint !== undefined && <span className="menu-hint">{it.disabledHint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
