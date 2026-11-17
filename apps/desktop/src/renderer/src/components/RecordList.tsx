/**
 * Node record list: search by name (English/Russian) and id plus operator conditions
 * (`parseSearchQueryParts` from core — the same syntax as `kedit find --query` and MCP `find`), status filter, status colours as in
 * FCS (new — green, changed — yellow, deleted — red struck through), «●» — edit
 * after save. Commands: new, copy, delete, restore, revert.
 *
 * Multi-selection as in Explorer: Ctrl+click toggles a record, Shift+click (Shift+arrows) selects a range
 * from the anchor, Ctrl+A selects all, Esc clears. The focused record (the one the inspector shows) is
 * still the shared selection; the extra marked records live here. Commands then act on all of them
 * as one edit, and «Bulk edit (N)» hands them to the bulk panel.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { matchesFilter, parseSearchQueryParts, unknownFilterKeys, type RecordStatus } from '@kenshi-editor/core';
import { errorText, useDataLocale, useT } from '../i18n.ts';
import { tryEdit } from '../hooks.ts';
import type { IndexEntry, Project } from '../project.ts';
import { VirtualList } from './VirtualList.tsx';

type StatusFilter = 'all' | 'mod' | RecordStatus;
const STATUS_FILTERS: StatusFilter[] = ['all', 'mod', 'new', 'changed', 'deleted'];

interface Props {
  project: Project;
  version: number;
  ids: readonly string[];
  selected: string | undefined;
  onSelect: (sid: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  onNew: () => void;
  onDuplicate: (sid: string) => void;
  onReport: (err: string | undefined) => void;
  /** Open «Bulk edits» for these records (multi-selection). */
  onBulk?: (sids: readonly string[]) => void;
  /** «New race based on…» (shown for the races category); the focused record is the suggested sample. */
  onNewRace?: (sample: string | undefined) => void;
}

const ROW_HEIGHT = 24;
const NO_MARKS: ReadonlySet<string> = new Set();

/** Ids from `a` to `b` inclusive in list order (either direction); just `b` if `a` is not in the list. */
export function rangeIds(items: readonly { sid: string }[], a: string, b: string): string[] {
  const i = items.findIndex((e) => e.sid === a);
  const j = items.findIndex((e) => e.sid === b);
  if (j < 0) return [];
  if (i < 0) return [b];
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return items.slice(lo, hi + 1).map((e) => e.sid);
}

function isTextField(target: EventTarget): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}

export function RecordList({ project, version, ids, selected, onSelect, searchRef, onNew, onDuplicate, onReport, onBulk, onNewRace }: Props): ReactNode {
  const t = useT();
  const dataLocale = useDataLocale();
  // The translation column exists only when names come in a data language.
  const hasTr = dataLocale !== undefined;
  const grid = hasTr ? '' : ' no-tr';
  const ctx = project.ctx;
  const [query, setQuery] = useState('');
  // Filtering tens of thousands of records may lag behind typing; the box itself stays responsive.
  const deferredQuery = useDeferredValue(query);
  const [helpOpen, setHelpOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // The list scrollbar narrows its rows; the header gets the same right padding, otherwise the headings shift.
  const [gutter, setGutter] = useState(0);

  const parsed = useMemo(() => {
    const p = parseSearchQueryParts(deferredQuery);
    return { ...p, unknown: unknownFilterKeys(ctx, p.filters) };
  }, [ctx, deferredQuery]);

  const items = useMemo(() => {
    const terms = parsed.words;
    const filters = parsed.filters;
    const out: IndexEntry[] = [];
    for (const sid of ids) {
      const e = project.entry(sid);
      if (!e) continue;
      if (statusFilter !== 'all') {
        const st = ctx.status(sid);
        if (statusFilter === 'mod' ? st === 'base' : st !== statusFilter) continue;
      }
      if (!terms.every((term) => e.hay.includes(term))) continue;
      if (filters.length) {
        // Records deleted by the mod are matched by their last state in the lower layers.
        const rec = ctx.get(sid) ?? ctx.lower(sid);
        if (!rec || !filters.every((f) => matchesFilter(ctx, rec, f))) continue;
      }
      out.push(e);
    }
    return out.sort((a, b) => (a.hay < b.hay ? -1 : a.hay > b.hay ? 1 : 0));
  }, [project, ctx, ids, parsed, statusFilter, version]);

  const hints = [
    ...parsed.errors.map((e) => t.searchBadCondition(errorText(e))),
    ...(parsed.unknown.length ? [t.searchUnknownKeys(parsed.unknown.join(', '))] : []),
  ];

  // Extra marked records (multi-selection); empty — only the focused record is selected.
  const [marks, setMarks] = useState<ReadonlySet<string>>(NO_MARKS);
  // Start of Shift ranges: the last record clicked without Shift.
  const anchor = useRef<string | undefined>(undefined);
  // The record this list itself just focused: such a selection change keeps the marks.
  const ownSelect = useRef<string | undefined>(undefined);
  const focus = (sid: string): void => {
    ownSelect.current = sid;
    onSelect(sid);
  };
  // Rows that left the list (another node, search, filter, a removed record) leave the marks too.
  useEffect(() => {
    setMarks((m) => {
      if (m.size === 0) return m;
      const shown = new Set(items.map((it) => it.sid));
      const kept = [...m].filter((sid) => shown.has(sid));
      return kept.length === m.size ? m : kept.length > 0 ? new Set(kept) : NO_MARKS;
    });
  }, [items]);
  // A record selected elsewhere (another panel, back/forward) drops the multi-selection.
  useEffect(() => {
    if (selected === ownSelect.current) {
      ownSelect.current = undefined;
      return;
    }
    ownSelect.current = undefined;
    anchor.current = selected;
    setMarks((m) => (selected !== undefined && m.has(selected) ? m : NO_MARKS));
  }, [selected]);

  // What the commands act on, in list order: the marked records or just the focused one.
  const picked = useMemo((): string[] => {
    if (marks.size === 0) return selected !== undefined ? [selected] : [];
    return items.filter((e) => marks.has(e.sid)).map((e) => e.sid);
  }, [marks, items, selected]);
  const multi = picked.length > 1;
  const isPicked = (sid: string): boolean => (marks.size === 0 ? sid === selected : marks.has(sid));
  const pickedStatus = picked.map((sid) => ctx.status(sid));
  const nLive = pickedStatus.filter((s) => s !== 'deleted').length;
  const nDeleted = pickedStatus.filter((s) => s === 'deleted').length;
  const nChanged = pickedStatus.filter((s) => s === 'changed').length;

  const selIndex = selected !== undefined ? items.findIndex((e) => e.sid === selected) : -1;
  const selStatus = selected !== undefined ? ctx.status(selected) : undefined;

  const clickRow = (e: MouseEvent, sid: string): void => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.shiftKey) {
      const range = rangeIds(items, anchor.current ?? selected ?? sid, sid);
      setMarks(ctrl ? new Set([...picked, ...range]) : new Set(range));
      focus(sid);
      return;
    }
    anchor.current = sid;
    if (!ctrl) {
      setMarks(NO_MARKS);
      focus(sid);
      return;
    }
    const next = new Set(marks.size > 0 ? marks : selected !== undefined ? [selected] : []);
    if (next.delete(sid)) {
      setMarks(next.size > 0 ? next : NO_MARKS);
      // The focused record was unmarked: the focus moves to another marked one.
      if (sid === selected) {
        const other = items.find((it) => next.has(it.sid));
        if (other) focus(other.sid);
      }
    } else {
      next.add(sid);
      setMarks(next);
      focus(sid);
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const inField = isTextField(e.target);
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyA' && !inField) {
      e.preventDefault();
      setMarks(new Set(items.map((it) => it.sid)));
      if (selIndex < 0 && items[0]) focus(items[0].sid);
      return;
    }
    if (e.key === 'Escape' && !inField && marks.size > 0) {
      e.preventDefault();
      setMarks(NO_MARKS);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = Math.max(0, Math.min(items.length - 1, selIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    const it = items[next];
    if (!it) return;
    if (e.shiftKey) {
      setMarks(new Set(rangeIds(items, anchor.current ?? selected ?? it.sid, it.sid)));
      focus(it.sid);
      return;
    }
    anchor.current = it.sid;
    setMarks(NO_MARKS);
    focus(it.sid);
  };

  const duplicate = (): void => {
    if (!multi) {
      if (selected !== undefined) onDuplicate(selected);
      return;
    }
    onReport(
      tryEdit(() => {
        const copies = ctx.duplicateRecords(picked);
        const last = copies.at(-1);
        if (last === undefined) return;
        setMarks(new Set(copies));
        anchor.current = copies[0];
        focus(last);
      }),
    );
  };

  return (
    <div className="list-pane" onKeyDown={onKeyDown}>
      <div className="list-filters">
        <input
          ref={searchRef}
          className="search"
          data-testid="search"
          placeholder={t.search}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
        <button
          className={`search-help-btn${helpOpen ? ' active' : ''}`}
          data-testid="search-help"
          title={t.searchHelpTip}
          aria-expanded={helpOpen}
          onClick={() => {
            setHelpOpen(!helpOpen);
          }}
        >
          ?
        </button>
        <select
          data-testid="status-filter"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as StatusFilter);
          }}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === 'all' ? t.statusAll : s === 'mod' ? t.statusMod : t[`status_${s}`]}
            </option>
          ))}
        </select>
      </div>
      {helpOpen && (
        <div className="search-help" data-testid="search-help-popover">
          <div className="search-help-title">{t.searchHelpTitle}</div>
          <div>{t.searchHelpIntro}</div>
          <div>{t.searchHelpOps}</div>
          <div>{t.searchHelpKeywords}</div>
          <div>{t.searchHelpPath}</div>
          <div className="search-help-title">{t.searchHelpExamples}</div>
          {t.searchHelpEx.map(([q, what]) => (
            <button
              key={q}
              className="search-help-ex"
              onClick={() => {
                setQuery(q);
                searchRef.current?.focus();
              }}
            >
              <code>{q}</code> — {what}
            </button>
          ))}
        </div>
      )}
      {hints.length > 0 && (
        <div className="search-hint" data-testid="search-hint">
          {hints.map((h) => (
            <div key={h}>{h}</div>
          ))}
        </div>
      )}
      <div className="list-actions">
        <button data-testid="new-record" onClick={onNew}>
          + {t.newRecord}
        </button>
        <button data-testid="duplicate" disabled={multi ? nLive === 0 : selected === undefined || selStatus === 'deleted'} onClick={duplicate}>
          {t.duplicate}
          {multi && nLive > 0 ? ` (${nLive})` : ''}
        </button>
        {onNewRace && (
          <button
            data-testid="list-new-race"
            title={t.nrOpenTip}
            onClick={() => {
              onNewRace(selected !== undefined && selStatus !== 'deleted' ? selected : undefined);
            }}
          >
            {t.nrOpen}
          </button>
        )}
        <button
          data-testid="delete"
          disabled={multi ? nLive === 0 : selected === undefined || selStatus === 'deleted'}
          onClick={() => {
            if (multi)
              onReport(
                tryEdit(() => {
                  ctx.deleteRecords(picked);
                }),
              );
            else if (selected !== undefined) onReport(tryEdit(() => {
              ctx.deleteRecord(selected);
            }));
          }}
        >
          {t.delete}
          {multi && nLive > 0 ? ` (${nLive})` : ''}
        </button>
        {(multi ? nDeleted > 0 : selStatus === 'deleted') && (
          <button
            data-testid="restore"
            onClick={() => {
              if (multi)
                onReport(
                  tryEdit(() => {
                    ctx.restoreRecords(picked);
                  }),
                );
              else if (selected !== undefined) onReport(tryEdit(() => {
                ctx.restoreRecord(selected);
              }));
            }}
          >
            {t.restore}
            {multi ? ` (${nDeleted})` : ''}
          </button>
        )}
        {(multi ? nChanged > 0 : selStatus === 'changed') && (
          <button
            data-testid="revert"
            onClick={() => {
              if (multi)
                onReport(
                  tryEdit(() => {
                    ctx.revertRecords(picked);
                  }),
                );
              else if (selected !== undefined) onReport(tryEdit(() => {
                ctx.revertRecord(selected);
              }));
            }}
          >
            {t.revert}
            {multi ? ` (${nChanged})` : ''}
          </button>
        )}
        {multi && onBulk && nLive > 0 && (
          <button
            data-testid="list-bulk"
            title={t.listBulkTip}
            onClick={() => {
              onBulk(picked.filter((sid) => ctx.status(sid) !== 'deleted'));
            }}
          >
            {t.listBulk(nLive)}
          </button>
        )}
        <span className="grow" />
        {multi && (
          <span className="list-picked" data-testid="list-picked" title={t.listPickTip}>
            {t.listPicked(picked.length)}
          </span>
        )}
        <span className="muted" data-testid="list-count" title={t.listPickTip}>
          {t.records}: {items.length}
        </span>
      </div>
      <div className={`list-header list-grid${grid}`} style={{ paddingRight: 8 + gutter }} data-testid="list-header">
        <span title={t.colName}>{t.colName}</span>
        {hasTr && (
          <span title={`${t.colTranslation} (${dataLocale})`} data-testid="col-translation">
            {t.colTranslation}
          </span>
        )}
        <span title={t.colId}>{t.colId}</span>
        <span title={t.colType}>{t.colType}</span>
      </div>
      <VirtualList
        items={items}
        rowHeight={ROW_HEIGHT}
        scrollToIndex={selIndex}
        testId="record-list"
        className="record-list"
        onGutter={setGutter}
        renderRow={(e) => {
          const st = ctx.status(e.sid) ?? 'base';
          return (
            <div
              className={`list-row list-grid${grid} st-${st}${isPicked(e.sid) ? ' selected' : ''}${multi && e.sid === selected ? ' focused' : ''}`}
              data-sid={e.sid}
              tabIndex={-1}
              onMouseDown={(ev) => {
                // Shift+click must not select text across rows.
                if (ev.shiftKey) {
                  ev.preventDefault();
                  ev.currentTarget.focus();
                }
              }}
              onClick={(ev) => {
                clickRow(ev, e.sid);
              }}
            >
              <span className="name" title={e.name}>
                {ctx.isDirty(e.sid) && <span className="dirty-dot">● </span>}
                {e.name}
              </span>
              {hasTr && (
                <span className="tr-name" title={e.localized}>
                  {e.localized}
                </span>
              )}
              <span className="sid mono" title={e.sid}>
                {e.sid}
              </span>
              <span className="type">{e.type}</span>
            </div>
          );
        }}
      />
    </div>
  );
}
