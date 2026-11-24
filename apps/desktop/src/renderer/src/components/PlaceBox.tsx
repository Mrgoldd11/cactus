/**
 * «Place…» field with a dropdown: a click on the field (or the arrow) opens the whole list of
 * records of the needed types — it can be scrolled, and typed text narrows it (Russian/English name and id).
 * The list is virtual: thousands of records do not slow it down. ↑/↓ — choose, Enter — place, Esc — close.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { IndexEntry, Project } from '../project.ts';
import { VirtualList } from './VirtualList.tsx';

interface Props {
  project: Project;
  /** Record types that can be placed (`BUILDING`, …). */
  types: readonly string[];
  placeholder: string;
  title?: string;
  /** «Nothing found» label and «n of m». */
  emptyText: string;
  countText: (shown: number, total: number) => string;
  /** Label right of the name (type, id…). */
  detail?: (e: IndexEntry) => string;
  /** Field `data-testid`; the list has it with the `-hits` suffix. */
  testId: string;
  onPick: (sid: string) => void;
}

const ROW = 24;
const MAX_ROWS = 12;
const WIDTH = 380;

export function PlaceBox({ project, types, placeholder, title, emptyText, countText, detail, testId, onPick }: Props): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [alignRight, setAlignRight] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => { document.removeEventListener('mousedown', away); };
  }, [open]);

  const pool = useMemo(() => {
    if (!open) return [];
    const byType = project.idsByType();
    const out: IndexEntry[] = [];
    for (const t of types) {
      for (const sid of byType.get(t) ?? []) {
        if (project.ctx.status(sid) === 'deleted') continue;
        const e = project.entry(sid);
        if (e) out.push(e);
      }
    }
    const label = (e: IndexEntry): string => (e.localized || e.name || e.sid).toLowerCase();
    return out.sort((a, b) => label(a).localeCompare(label(b)));
  }, [open, project, types]);

  const items = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length === 0 ? pool : pool.filter((e) => terms.every((t) => e.hay.includes(t)));
  }, [pool, query]);

  const cur = Math.min(cursor, items.length - 1);

  const show = (): void => {
    const r = wrap.current?.getBoundingClientRect();
    setAlignRight(r !== undefined && r.left + WIDTH > window.innerWidth - 8);
    setOpen(true);
  };

  const pick = (e: IndexEntry | undefined): void => {
    if (!e) return;
    setOpen(false);
    setQuery('');
    setCursor(0);
    onPick(e.sid);
  };

  const height = Math.min(Math.max(items.length, 1), MAX_ROWS) * ROW;

  return (
    <span ref={wrap} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <input
        ref={input}
        data-testid={testId}
        role="combobox"
        aria-expanded={open}
        placeholder={placeholder}
        title={title}
        value={query}
        style={{ width: 200, paddingRight: 22 }}
        onFocus={show}
        onClick={() => { if (!open) show(); }}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
          if (!open) show();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            if (!open) show();
            else setCursor(Math.min(items.length - 1, cur + 1));
          } else if (e.key === 'ArrowUp') setCursor(Math.max(0, cur - 1));
          else if (e.key === 'Enter') pick(items[cur]);
          else if (e.key === 'Escape') {
            if (open) setOpen(false);
            else setQuery('');
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <span
        aria-hidden
        className="muted"
        style={{ position: 'absolute', right: 6, cursor: 'pointer', fontSize: '0.8em', userSelect: 'none' }}
        onMouseDown={(e) => {
          e.preventDefault();
          if (open) setOpen(false);
          else {
            show();
            input.current?.focus();
          }
        }}
      >
        {open ? '▴' : '▾'}
      </span>
      {open && (
        <div
          className="menu"
          data-testid={`${testId}-hits`}
          style={{ left: alignRight ? 'auto' : 0, right: alignRight ? 0 : 'auto', width: WIDTH, padding: 0 }}
        >
          {items.length === 0 ? (
            <div className="muted" style={{ padding: '8px 12px' }}>{emptyText}</div>
          ) : (
            <div style={{ height, display: 'flex', flexDirection: 'column' }}>
              <VirtualList
                items={items}
                rowHeight={ROW}
                scrollToIndex={cur}
                testId={`${testId}-list`}
                renderRow={(e, i) => (
                  <div
                    className={`menu-item ${i === cur ? 'selected' : ''}`}
                    data-sid={e.sid}
                    style={{ cursor: 'pointer', height: '100%', background: i === cur ? 'var(--sel)' : undefined }}
                    onMouseEnter={() => { setCursor(i); }}
                    onClick={() => { pick(e); }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{e.localized || e.name || e.sid}</span>
                    <span className="muted" style={{ fontSize: '0.85em' }}>{detail ? detail(e) : e.sid}</span>
                  </div>
                )}
              />
            </div>
          )}
          <div className="muted" style={{ fontSize: '0.8em', padding: '2px 12px', borderTop: '1px solid var(--border)' }}>
            {countText(items.length, pool.length)}
          </div>
        </div>
      )}
    </span>
  );
}
