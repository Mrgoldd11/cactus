/**
 * Node record list: search by name (English/Russian) and id plus operator conditions
 * (`parseSearchQueryParts` from core — the same syntax as `kedit find --query` and MCP `find`), status filter, status colours as in
 * FCS (new — green, changed — yellow, deleted — red struck through), «●» — edit
 * after save. Commands: new, copy, delete, restore, revert.
 */
import { useDeferredValue, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
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
}

const ROW_HEIGHT = 24;

export function RecordList({ project, version, ids, selected, onSelect, searchRef, onNew, onDuplicate, onReport }: Props): ReactNode {
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

  const selIndex = selected !== undefined ? items.findIndex((e) => e.sid === selected) : -1;
  const selStatus = selected !== undefined ? ctx.status(selected) : undefined;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = Math.max(0, Math.min(items.length - 1, selIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    const it = items[next];
    if (it) onSelect(it.sid);
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
        <button
          data-testid="duplicate"
          disabled={selected === undefined || selStatus === 'deleted'}
          onClick={() => {
            if (selected !== undefined) onDuplicate(selected);
          }}
        >
          {t.duplicate}
        </button>
        <button
          data-testid="delete"
          disabled={selected === undefined || selStatus === 'deleted'}
          onClick={() => {
            if (selected !== undefined) onReport(tryEdit(() => {
              ctx.deleteRecord(selected);
            }));
          }}
        >
          {t.delete}
        </button>
        {selStatus === 'deleted' && (
          <button
            onClick={() => {
              if (selected !== undefined) onReport(tryEdit(() => {
                ctx.restoreRecord(selected);
              }));
            }}
          >
            {t.restore}
          </button>
        )}
        {selStatus === 'changed' && (
          <button
            onClick={() => {
              if (selected !== undefined) onReport(tryEdit(() => {
                ctx.revertRecord(selected);
              }));
            }}
          >
            {t.revert}
          </button>
        )}
        <span className="grow" />
        <span className="muted" data-testid="list-count">
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
              className={`list-row list-grid${grid} st-${st} ${e.sid === selected ? 'selected' : ''}`}
              data-sid={e.sid}
              tabIndex={-1}
              onClick={() => {
                onSelect(e.sid);
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
