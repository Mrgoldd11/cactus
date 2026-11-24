/**
 * «Item comparison» panel: records of one type (weapons, crossbows, armour, items,
 * backpacks — or any other type) in a table. Columns — fields from the schema (column choice),
 * sorting by clicking a header, filters by name and by field (`value>1000`), editing right
 * in the cell (one edit — one undo step). ▲▼ — the largest and smallest in the column, colour —
 * who changed the value: the mod itself or other loaded mods.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { applyOps, COMPARE_TYPES, compareTable, matchesFilter, parseFieldFilter, type CompareColumn, type CompareRow, type FieldFilter } from '@kenshi-editor/core';
import { useDataLocale, useT, type Strings } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { shortcut } from '../../keys.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Table rows at a time: beyond that — narrow the filter. */
const MAX_ROWS = 500;

interface Sort {
  key: string;
  desc: boolean;
}

interface Editing {
  sid: string;
  key: string;
  text: string;
}

function parseFilters(text: string): FieldFilter[] {
  return text
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(parseFieldFilter);
}

function cellTip(t: Strings, col: CompareColumn, row: CompareRow): string {
  const c = row.cells.get(col.key);
  const lines = [col.key];
  if (col.description) lines.push(col.description);
  if (c?.mark === 'mine') lines.push(t.cmpMine);
  if (c?.layers?.length) lines.push(`${t.cmpMods} ${c.layers.join(', ')}`);
  return lines.join('\n');
}

function CompareCellView({ col, row, range, editing, onEdit, onCommit, onCancel }: {
  col: CompareColumn;
  row: CompareRow;
  range: { min: number; max: number } | undefined;
  editing: Editing | undefined;
  onEdit: (text: string) => void;
  onCommit: (text: string) => void;
  onCancel: () => void;
}): ReactNode {
  const t = useT();
  const c = row.cells.get(col.key);
  const v = c?.value;
  const top = range !== undefined && typeof v === 'number' && v === range.max;
  const bottom = range !== undefined && typeof v === 'number' && v === range.min;
  const cls = ['cmp-cell', col.kind === 'number' ? 'num' : '', c?.mark === 'mine' ? 'cmp-mine' : c?.mark === 'mods' ? 'cmp-mods' : '', top ? 'cmp-max' : '', bottom ? 'cmp-min' : ''].filter(Boolean).join(' ');
  const here = editing?.sid === row.sid && editing.key === col.key;
  return (
    <td
      className={cls}
      title={`${cellTip(t, col, row)}${top ? `\n▲ ${t.cmpMax}` : bottom ? `\n▼ ${t.cmpMin}` : ''}`}
      data-testid="cmp-cell"
      data-sid={row.sid}
      data-field={col.key}
      data-value={c?.text ?? ''}
      onClick={() => {
        if (here) return;
        if (col.kind === 'bool') onCommit(v === true ? 'false' : 'true');
        else onEdit(c?.text ?? '');
      }}
    >
      {here ? (
        <input
          autoFocus
          value={editing.text}
          onChange={(e) => { onEdit(e.target.value); }}
          onBlur={onCancel}
          onKeyDown={(e) => {
            const k = shortcut(e);
            if (k === 'enter') onCommit(editing.text);
            else if (k === 'escape') onCancel();
          }}
          data-testid="cmp-input"
        />
      ) : (
        <>
          {col.kind === 'bool' ? (v === true ? '✓' : v === false ? '·' : '') : (c?.text ?? '')}
          {top && <span className="cmp-flag">▲</span>}
          {bottom && <span className="cmp-flag">▼</span>}
        </>
      )}
    </td>
  );
}

function ComparePanel(): ReactNode {
  const t = useT();
  const dataLocale = useDataLocale();
  const { project, go, report } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const [type, setType] = useState<string>('WEAPON');
  const [query, setQuery] = useState('');
  const [filterText, setFilterText] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [picker, setPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [sort, setSort] = useState<Sort | undefined>();
  const [editing, setEditing] = useState<Editing | undefined>();

  const byType = project.idsByType();
  const types = useMemo(() => {
    const rest = [...byType.keys()].filter((k) => !(COMPARE_TYPES as readonly string[]).includes(k)).sort();
    return [...COMPARE_TYPES.filter((k) => byType.has(k)), ...rest];
  }, [byType]);
  const table = useMemo(() => compareTable(ctx, type, { ids: byType.get(type) ?? [] }), [ctx, type, byType, version]);
  const columnKeys = chosen[type] ?? table.defaultColumns;
  const columns = columnKeys.map((k) => table.columns.find((c) => c.key === k)).filter((c): c is CompareColumn => c !== undefined);

  const { filters, filterError } = useMemo((): { filters: FieldFilter[]; filterError?: string } => {
    try {
      return { filters: parseFilters(filterText) };
    } catch {
      return { filters: [], filterError: t.cmpBadFilter(filterText) };
    }
  }, [filterText, t]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = table.rows;
    if (q !== '') list = list.filter((r) => `${r.sid}\n${r.name}\n${r.localized ?? ''}`.toLowerCase().includes(q));
    if (onlyChanged) list = list.filter((r) => r.addedBy !== undefined || r.status === 'changed' || [...r.cells.values()].some((c) => c.mark !== undefined));
    if (filters.length > 0) {
      list = list.filter((r) => {
        const rec = ctx.get(r.sid);
        return rec !== undefined && filters.every((f) => matchesFilter(ctx, rec, f));
      });
    }
    if (sort) {
      const col = table.columns.find((c) => c.key === sort.key);
      const val = (r: CompareRow): number | string => {
        if (sort.key === '') return r.localized ?? r.name;
        const c = r.cells.get(sort.key);
        if (col?.kind === 'number') return typeof c?.value === 'number' ? c.value : -Infinity;
        if (col?.kind === 'bool') return c?.value === true ? 1 : 0;
        return c?.text ?? '';
      };
      list = [...list].sort((a, b) => {
        const x = val(a);
        const y = val(b);
        const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return sort.desc ? -d : d;
      });
    }
    return list;
  }, [table, query, onlyChanged, filters, sort, dataLocale, ctx]);

  const toggleSort = (key: string): void => {
    setSort((s) => (s?.key === key ? (s.desc ? undefined : { key, desc: true }) : { key, desc: false }));
  };
  const setColumns = (keys: string[]): void => {
    setChosen((c) => ({ ...c, [type]: keys }));
  };
  const commit = (sid: string, key: string, text: string): void => {
    const col = table.columns.find((c) => c.key === key);
    setEditing(undefined);
    if (!col) return;
    const cur = table.rows.find((r) => r.sid === sid)?.cells.get(key)?.text;
    if (cur === text) return;
    report(tryEdit(() => { applyOps(ctx, [{ op: 'set', id: sid, field: key, value: text, dict: col.dict }], `${sid}: ${key}`); }));
  };

  const pickerCols = table.columns.filter((c) => pickerQuery.trim() === '' || c.key.toLowerCase().includes(pickerQuery.trim().toLowerCase()));

  return (
    <div className="mods-panel" data-testid="compare-panel">
      <div className="mods-panel-bar">
        <label>
          {t.cmpType}{' '}
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setSort(undefined);
              setEditing(undefined);
            }}
            data-testid="cmp-type"
          >
            {types.map((k) => (
              <option key={k} value={k}>
                {k} ({byType.get(k)?.length ?? 0})
              </option>
            ))}
          </select>
        </label>
        <input type="search" placeholder={t.cmpSearch} value={query} onChange={(e) => { setQuery(e.target.value); }} data-testid="cmp-search" />
        <input
          type="search"
          className={filterError ? 'invalid' : ''}
          placeholder={t.cmpFilter}
          title={filterError ?? t.cmpFilterTip}
          value={filterText}
          onChange={(e) => { setFilterText(e.target.value); }}
          data-testid="cmp-filter"
        />
        <label title={t.cmpOnlyChangedTip}>
          <input type="checkbox" checked={onlyChanged} onChange={(e) => { setOnlyChanged(e.target.checked); }} data-testid="cmp-only-changed" /> {t.cmpOnlyChanged}
        </label>
        <button onClick={() => { setPicker((p) => !p); }} className={picker ? 'active' : ''} data-testid="cmp-columns">
          {t.cmpColumns}
        </button>
        <span className="muted" data-testid="cmp-summary">
          {t.cmpSummary(rows.length, table.rows.length)}
        </span>
      </div>
      {picker && (
        <div className="cmp-picker" data-testid="cmp-picker">
          <div className="mods-panel-bar">
            <input type="search" placeholder={t.cmpColumnsFilter} value={pickerQuery} onChange={(e) => { setPickerQuery(e.target.value); }} data-testid="cmp-columns-filter" />
            <button onClick={() => { setColumns(table.defaultColumns); }}>{t.cmpColumnsDefault}</button>
            <button onClick={() => { setColumns(table.columns.filter((c) => c.varies).map((c) => c.key)); }}>{t.cmpColumnsAll}</button>
          </div>
          <div className="cmp-picker-list">
            {pickerCols.map((c) => (
              <label key={c.key} title={c.description ?? ''} className={c.varies ? '' : 'muted'}>
                <input
                  type="checkbox"
                  checked={columnKeys.includes(c.key)}
                  onChange={(e) => {
                    setColumns(e.target.checked ? [...columnKeys, c.key] : columnKeys.filter((k) => k !== c.key));
                  }}
                  data-testid={`cmp-col-${c.key}`}
                />{' '}
                {c.key}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="muted mods-panel-note">{t.cmpNote}</div>
      {rows.length === 0 ? (
        <Empty text={t.cmpNone} />
      ) : (
        <div className="table-wrap">
          <table className="table cmp-table" data-testid="cmp-table">
            <thead>
              <tr>
                <th onClick={() => { toggleSort(''); }} className="cmp-sort">
                  {t.cmpName}
                  {sort?.key === '' ? (sort.desc ? ' ↓' : ' ↑') : ''}
                </th>
                {columns.map((c) => (
                  <th key={c.key} onClick={() => { toggleSort(c.key); }} className="cmp-sort" title={c.description ?? c.key} data-testid="cmp-head" data-field={c.key}>
                    {c.key}
                    {sort?.key === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((r) => (
                <tr key={r.sid} data-sid={r.sid}>
                  <td className="cmp-name">
                    <button className="link" onClick={() => { go(r.sid); }} title={`${r.sid}${r.addedBy ? `\n${t.cmpAdded(r.addedBy)}` : ''}`}>
                      {r.localized ?? r.name}
                    </button>
                    {r.addedBy !== undefined && <span className="cmp-added">+</span>}
                  </td>
                  {columns.map((c) => (
                    <CompareCellView
                      key={c.key}
                      col={c}
                      row={r}
                      range={table.range(c.key)}
                      editing={editing}
                      onEdit={(text) => { setEditing({ sid: r.sid, key: c.key, text }); }}
                      onCommit={(text) => { commit(r.sid, c.key, text); }}
                      onCancel={() => { setEditing(undefined); }}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > MAX_ROWS && <div className="muted">{t.cmpCap(MAX_ROWS)}</div>}
        </div>
      )}
    </div>
  );
}

registerPanel({
  id: 'compare', group: 'data',
  title: (t) => t.panel_compare,
  icon: '⚖',
  component: ComparePanel,
  area: 'center',
  order: 51,
  hint: (t) => t.compareHint,
});
