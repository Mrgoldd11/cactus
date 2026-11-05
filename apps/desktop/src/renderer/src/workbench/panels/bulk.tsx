/**
 * Панель «Массовые правки»: записи одного типа по условиям полей → одна операция над полем
 * (задать, умножить, прибавить, заменить текст, в том числе по regex). Таблица «было → станет»
 * пересчитывается сразу; «Применить» — одна правка (одна отмена на всю пачку).
 */
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { applyBulk, BULK_KINDS, COMPARE_TYPES, DICT_FOR_KIND, BULK_NAME_FIELD, parseFieldFilter, previewBulk, type BulkKind, type BulkPreview, type FieldFilter } from '@kenshi-editor/core';
import { useT, type Strings } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Строк предпросмотра за раз (применяется всё). */
const MAX_ROWS = 500;

function parseFilters(text: string): FieldFilter[] {
  return text
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(parseFieldFilter);
}

function kindLabel(t: Strings, k: BulkKind): string {
  return { set: t.bulkSet, mul: t.bulkMul, add: t.bulkAdd, replace: t.bulkReplace }[k];
}

function BulkPanel(): ReactNode {
  const t = useT();
  const { project, go, report } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const byType = project.idsByType();
  const types = useMemo(() => {
    const rest = [...byType.keys()].filter((k) => !(COMPARE_TYPES as readonly string[]).includes(k)).sort();
    return [...COMPARE_TYPES.filter((k) => byType.has(k)), ...rest];
  }, [byType]);
  const [type, setType] = useState<string>(() => types[0] ?? 'WEAPON');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [modOnly, setModOnly] = useState(false);
  const [kind, setKind] = useState<BulkKind>('mul');
  const [field, setField] = useState('value');
  const [find, setFind] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [value, setValue] = useState('');

  // Поля типа для подсказки (скалярные поля схемы; для замены текста — ещё имя записи).
  const fields = useMemo(() => {
    const ts = ctx.schema?.types.get(type);
    const list = [...(ts?.fields.values() ?? [])].filter((f) => {
      const d = DICT_FOR_KIND[f.kind];
      return d === 'ints' || d === 'floats' || d === 'bools' || d === 'strings';
    });
    return [BULK_NAME_FIELD, ...list.map((f) => f.name)];
  }, [ctx, type]);

  const input = useDeferredValue({ type, search, filter, modOnly, kind, field, find, regex, caseSensitive, value });
  const result = useMemo((): { preview?: BulkPreview; error?: string } => {
    if (input.field.trim() === '' || (input.kind !== 'replace' && input.value.trim() === '') || (input.kind === 'replace' && input.find === '')) return {};
    try {
      const preview = previewBulk(
        ctx,
        { type: input.type, ids: byType.get(input.type) ?? [], fields: parseFilters(input.filter), modOnly: input.modOnly, ...(input.search.trim() !== '' ? { text: input.search } : {}) },
        { kind: input.kind, field: input.field, value: input.value, ...(input.kind === 'replace' ? { find: input.find, regex: input.regex, caseSensitive: input.caseSensitive } : {}) },
      );
      return { preview };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [ctx, byType, input, version]);
  const p = result.preview;

  const apply = (): void => {
    if (!p || p.ops.length === 0) return;
    report(
      tryEdit(() => {
        applyBulk(ctx, p);
      }),
    );
  };

  return (
    <div className="mods-panel" data-testid="bulk-panel">
      <div className="mods-panel-bar">
        <label>
          {t.cmpType}{' '}
          <select value={type} onChange={(e) => { setType(e.target.value); }} data-testid="bulk-type">
            {types.map((k) => (
              <option key={k} value={k}>
                {k} ({byType.get(k)?.length ?? 0})
              </option>
            ))}
          </select>
        </label>
        <input type="search" placeholder={t.cmpSearch} value={search} onChange={(e) => { setSearch(e.target.value); }} data-testid="bulk-search" />
        <input type="search" placeholder={t.cmpFilter} title={t.cmpFilterTip} value={filter} onChange={(e) => { setFilter(e.target.value); }} data-testid="bulk-filter" />
        <label title={t.bulkModOnlyTip}>
          <input type="checkbox" checked={modOnly} onChange={(e) => { setModOnly(e.target.checked); }} data-testid="bulk-mod-only" /> {t.bulkModOnly}
        </label>
      </div>
      <div className="mods-panel-bar bulk-op">
        <select value={kind} onChange={(e) => { setKind(e.target.value as BulkKind); }} data-testid="bulk-op">
          {BULK_KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(t, k)}
            </option>
          ))}
        </select>
        <input list="bulk-fields" placeholder={t.bulkField} value={field} onChange={(e) => { setField(e.target.value); }} data-testid="bulk-field" />
        <datalist id="bulk-fields">
          {fields.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        {kind === 'replace' && (
          <>
            <input placeholder={t.bulkFind} value={find} onChange={(e) => { setFind(e.target.value); }} data-testid="bulk-find" />
            <label title={t.bulkRegexTip}>
              <input type="checkbox" checked={regex} onChange={(e) => { setRegex(e.target.checked); }} data-testid="bulk-regex" /> regex
            </label>
            <label>
              <input type="checkbox" checked={caseSensitive} onChange={(e) => { setCaseSensitive(e.target.checked); }} data-testid="bulk-case" /> {t.bulkCase}
            </label>
          </>
        )}
        <input placeholder={kind === 'replace' ? t.bulkWith : t.bulkValue} value={value} onChange={(e) => { setValue(e.target.value); }} data-testid="bulk-value" />
        <button className="primary" disabled={!p || p.ops.length === 0} onClick={apply} data-testid="bulk-apply">
          {t.bulkApply(p?.changes.length ?? 0)}
        </button>
      </div>
      <div className="muted mods-panel-note">{t.bulkNote}</div>
      {result.error !== undefined && (
        <div className="bulk-error" data-testid="bulk-error">
          {result.error}
        </div>
      )}
      {p && (
        <div className="muted" data-testid="bulk-summary">
          {t.bulkSummary(p.matched, p.changes.length, p.skipped.length)}
        </div>
      )}
      {!p ? (
        <Empty text={t.bulkEmpty} />
      ) : p.changes.length === 0 ? (
        <Empty text={t.bulkNothing} />
      ) : (
        <div className="table-wrap">
          <table className="table bulk-table" data-testid="bulk-table">
            <thead>
              <tr>
                <th>{t.cmpName}</th>
                <th>{t.bulkField}</th>
                <th>{t.bulkBefore}</th>
                <th>{t.bulkAfter}</th>
              </tr>
            </thead>
            <tbody>
              {p.changes.slice(0, MAX_ROWS).map((c) => (
                <tr key={c.sid} data-testid="bulk-row" data-sid={c.sid} data-before={c.before} data-after={c.after}>
                  <td>
                    <button className="link" onClick={() => { go(c.sid); }} title={c.sid}>
                      {c.name}
                    </button>
                  </td>
                  <td className="muted">{c.field}</td>
                  <td className="bulk-before">{c.before === '' ? '—' : c.before}</td>
                  <td className="bulk-after">{c.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.changes.length > MAX_ROWS && <div className="muted">{t.bulkCap(MAX_ROWS)}</div>}
        </div>
      )}
      {p && p.skipped.length > 0 && (
        <details className="bulk-skipped" data-testid="bulk-skipped">
          <summary>{t.bulkSkipped(p.skipped.length)}</summary>
          <ul>
            {p.skipped.slice(0, 100).map((s) => (
              <li key={s.sid}>
                <button className="link" onClick={() => { go(s.sid); }}>
                  {s.name}
                </button>{' '}
                <span className="muted">— {s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

registerPanel({
  id: 'bulk',
  title: (t) => t.panel_bulk,
  icon: '⇶',
  component: BulkPanel,
  area: 'center',
  order: 52,
  hint: (t) => t.bulkHint,
});
