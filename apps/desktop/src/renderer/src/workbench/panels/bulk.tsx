/**
 * Панель «Массовые правки»: записи одного типа по условиям полей → одна операция над полем
 * (задать, умножить, прибавить, заменить текст, в том числе по regex). Таблица «было → станет»
 * пересчитывается сразу; «Применить» — одна правка (одна отмена на всю пачку).
 */
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyBulk, bulkFieldValue, bulkSelect, BULK_KINDS, BULK_REF_KINDS, restrictBulk, enumValue, fieldEnum, itemTypeId, COMPARE_TYPES, DICT_FOR_KIND, BULK_NAME_FIELD, parseFieldFilter, previewBulk, type BulkKind, type BulkPreview, type FieldDef, type FieldFilter, type ModContext } from '@kenshi-editor/core';
import { useT, type Strings } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Строк предпросмотра за раз (применяется всё). */
const MAX_ROWS = 500;
/** Подходящих записей, пока операция не заполнена, — сколько можно сортировать и листать. */
const SAMPLE_POOL = 2000;
/** Строк «подходящих записей» на экране. */
const SAMPLE_ROWS = 20;
/** Колонок со значениями полей из условий фильтра. */
const MAX_COND_COLS = 3;

interface SortState {
  col: string;
  dir: 1 | -1;
}

/** Числа сравниваются как числа, остальное — как текст; пусто всегда в конце. */
function sortRows<T>(rows: T[], sort: SortState | undefined, get: (row: T, col: string) => string): T[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    const x = get(a, sort.col);
    const y = get(b, sort.col);
    if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
    const nx = Number(x);
    const ny = Number(y);
    const d = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    return d * sort.dir;
  });
}
/** Поле считается «классом», если у записей типа не больше стольких разных значений. */
const MAX_CLASS_VALUES = 24;
/** Записей типа, просматриваемых при подсчёте классов. */
const SCAN_LIMIT = 3000;

interface ValueGroup {
  field: string;
  values: { value: number; label: string; count: number; names: string[] }[];
}

function parseFilters(text: string): FieldFilter[] {
  return text
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(parseFieldFilter);
}

/** Подпись поля: «цена (value)» по-русски, иначе просто ключ. */
function fieldText(t: Strings, key: string): string {
  const ru = t.bulkFieldRu[key];
  return ru ? `${ru} (${key})` : key;
}

/** Скалярные поля типа по схеме: числа, флаги, текст. */
function scalarDefs(ctx: ModContext, type: string): FieldDef[] {
  const ts = ctx.schema?.types.get(type);
  return [...(ts?.fields.values() ?? [])].filter((f) => {
    const d = DICT_FOR_KIND[f.kind];
    return d === 'ints' || d === 'floats' || d === 'bools' || d === 'strings' || d === 'files';
  });
}

/** Списки ссылок типа по схеме (оружие, предметы в списке торговца…). */
function refDefs(ctx: ModContext, type: string): FieldDef[] {
  const ts = ctx.schema?.types.get(type);
  return [...(ts?.fields.values() ?? [])].filter((f) => f.kind === 'reference');
}

/** Поля, подходящие операции: числа — «умножить/прибавить», текст — «заменить», любые — «задать», списки — «ссылка». */
function namesFor(kind: BulkKind, defs: readonly FieldDef[], refs: readonly FieldDef[] = []): string[] {
  if ((BULK_REF_KINDS as readonly string[]).includes(kind)) return refs.map((f) => f.name);
  const dict = (f: FieldDef): string | undefined => DICT_FOR_KIND[f.kind];
  if (kind === 'mul' || kind === 'add') return defs.filter((f) => f.kind !== 'enum' && f.kind !== 'color' && (dict(f) === 'ints' || dict(f) === 'floats')).map((f) => f.name);
  if (kind === 'replace') return [BULK_NAME_FIELD, ...defs.filter((f) => dict(f) === 'strings' || dict(f) === 'files').map((f) => f.name)];
  return defs.map((f) => f.name);
}

function kindLabel(t: Strings, k: BulkKind): string {
  return { set: t.bulkSet, mul: t.bulkMul, add: t.bulkAdd, replace: t.bulkReplace, refAdd: t.bulkRefAdd, refRemove: t.bulkRefRemove }[k];
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
  // Конструктор условия фильтра: поле, сравнение, значение.
  const [cField, setCField] = useState('');
  const [cOp, setCOp] = useState('=');
  const [cValue, setCValue] = useState('');

  const [refValues, setRefValues] = useState('');
  // Записи, которым галочку сняли (их «Применить» не тронет); сортировка таблицы.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<SortState | undefined>(undefined);

  // Поля типа (скалярные поля схемы и списки ссылок) — для списков и подсказок.
  const fieldDefs = useMemo(() => scalarDefs(ctx, type), [ctx, type]);
  const refFieldDefs = useMemo(() => refDefs(ctx, type), [ctx, type]);
  const isRefKind = (BULK_REF_KINDS as readonly string[]).includes(kind);
  const fieldOptions = useMemo(() => {
    const names = namesFor(kind, fieldDefs, refFieldDefs);
    return field !== '' && !names.includes(field) ? [field, ...names] : names;
  }, [kind, fieldDefs, refFieldDefs, field]);
  const changeType = (next: string): void => {
    setType(next);
    setCField('');
    setCValue('');
    setSort(undefined);
    const nextDefs = scalarDefs(ctx, next);
    if (!namesFor(kind, nextDefs, refDefs(ctx, next)).includes(field)) setField('');
  };
  const changeKind = (next: BulkKind): void => {
    setKind(next);
    if ((fieldDefs.length > 0 || refFieldDefs.length > 0) && !namesFor(next, fieldDefs, refFieldDefs).includes(field)) setField('');
  };
  // Классы: enum-поля типа с небольшим числом значений — «skill category: 0 (Katana, Nodachi…), 1 (…)».
  const valueGroups = useMemo((): ValueGroup[] => {
    const enumFields = fieldDefs.filter((f) => f.kind === 'enum');
    if (enumFields.length === 0) return [];
    const typeNo = itemTypeId(type);
    const acc = new Map<string, Map<number, { count: number; names: string[] }>>(enumFields.map((f) => [f.name, new Map()]));
    for (const sid of (byType.get(type) ?? []).slice(0, SCAN_LIMIT)) {
      const rec = ctx.get(sid);
      if (!rec || rec.type !== typeNo) continue;
      for (const f of enumFields) {
        const v = rec.ints.get(f.name);
        if (v === undefined) continue;
        const m = acc.get(f.name)!;
        const e = m.get(v) ?? { count: 0, names: [] };
        e.count++;
        if (e.names.length < 3) e.names.push(ctx.localizedName(sid) ?? ctx.name(sid) ?? sid);
        m.set(v, e);
      }
    }
    const out: ValueGroup[] = [];
    for (const f of enumFields) {
      const m = acc.get(f.name)!;
      if (m.size < 2 || m.size > MAX_CLASS_VALUES) continue;
      const def = fieldEnum(ctx.schema, type, f.name);
      const values = [...m.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([value, e]) => ({ value, label: (def ? enumValue(def, value)?.name : undefined) ?? '', count: e.count, names: e.names }));
      out.push({ field: f.name, values });
    }
    return out;
  }, [ctx, byType, type, fieldDefs, version]);
  const addToFilter = (name: string): void => {
    setFilter((f) => (f.trim() === '' ? name : `${f.trim().replace(/;$/, '')}; ${name}`));
  };

  // Условие по полю: обычное поле, список ссылок (длина / ссылка на запись) или Ref (входящие ссылки).
  const cGroup = valueGroups.find((g) => g.field === cField);
  const cBool = fieldDefs.find((f) => f.name === cField)?.kind === 'bool';
  const cClass: 'scalar' | 'reflist' | 'refcount' = cField === 'Ref' ? 'refcount' : refFieldDefs.some((f) => f.name === cField) ? 'reflist' : 'scalar';
  const condOps = t.bulkCmp.filter(([o]) => (cClass === 'scalar' ? true : cClass === 'reflist' ? o !== ':' && o !== '!:' && o !== '?' : ['=', '!=', '>', '>=', '<', '<='].includes(o)));
  const changeCondField = (next: string): void => {
    setCField(next);
    setCValue('');
    const cls = next === 'Ref' ? 'refcount' : refFieldDefs.some((f) => f.name === next) ? 'reflist' : 'scalar';
    if (cls !== 'scalar' && [':', '!:', '?'].includes(cOp)) setCOp('=');
    if (cls === 'refcount' && cOp === 'exists') setCOp('>');
  };
  const condReady = cField !== '' && (cOp === 'exists' || cValue.trim() !== '');
  const addCondition = (): void => {
    if (!condReady) return;
    addToFilter(cOp === 'exists' ? `${cField}?` : `${cField}${cOp}${cValue.trim()}`);
    setCValue('');
  };

  const input = useDeferredValue({ type, search, filter, modOnly, kind, field, find, regex, caseSensitive, value, refValues });
  const inputKey = JSON.stringify(input);
  // Другие условия — другой набор записей: галочки и сортировка начинаются заново.
  useEffect(() => {
    setExcluded(new Set());
  }, [inputKey]);
  const result = useMemo((): { preview?: BulkPreview; error?: string; missing?: 'field' | 'value' | 'find'; matched?: number; sample?: string[]; condKeys: string[] } => {
    const missing = input.field.trim() === '' ? 'field' : input.kind === 'replace' ? (input.find === '' ? 'find' : undefined) : input.value.trim() === '' ? 'value' : undefined;
    const query = { type: input.type, ids: byType.get(input.type) ?? [], fields: [] as FieldFilter[], modOnly: input.modOnly, ...(input.search.trim() !== '' ? { text: input.search } : {}) };
    let condKeys: string[] = [];
    try {
      query.fields = parseFilters(input.filter);
      const refNames = new Set(refDefs(ctx, input.type).map((f) => f.name));
      condKeys = [...new Set(query.fields.map((f) => f.key))].filter((k) => k !== 'Ref' && !k.includes('.') && !refNames.has(k)).slice(0, MAX_COND_COLS);
      if (missing) {
        const recs = bulkSelect(ctx, query);
        return { missing, matched: recs.length, sample: recs.slice(0, SAMPLE_POOL).map((r) => r.stringId), condKeys };
      }
      let values: number[] | undefined;
      if (input.kind === 'refAdd' && input.refValues.trim() !== '') {
        values = input.refValues
          .trim()
          .split(/[\s,;]+/)
          .map((x) => Number(x.replace(',', '.')));
        if (values.length > 3 || values.some((n) => !Number.isFinite(n))) throw new Error(t.bulkRefValuesTip);
      }
      const preview = previewBulk(
        ctx,
        query,
        { kind: input.kind, field: input.field, value: input.value, ...(values ? { values } : {}), ...(input.kind === 'replace' ? { find: input.find, regex: input.regex, caseSensitive: input.caseSensitive } : {}) },
      );
      return { preview, condKeys };
    } catch (e) {
      return { error: (e as Error).message, condKeys, ...(missing ? { missing } : {}) };
    }
  }, [ctx, byType, input, version]);
  const p = result.preview;
  // С учётом снятых галочек: что реально применится.
  const chosen = useMemo(() => (p ? restrictBulk(p, (sid) => !excluded.has(sid)) : undefined), [p, excluded]);
  const total = p?.changes.length ?? 0;
  const nChosen = chosen?.changes.length ?? 0;

  const cell = (sid: string, key: string): string => {
    const rec = ctx.get(sid);
    return (rec ? bulkFieldValue(ctx, rec, key) : undefined) ?? '';
  };
  const sortBy = (col: string): void => {
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : undefined));
  };
  const opKey = !isRefKind && field.trim() !== '' && field !== BULK_NAME_FIELD ? field : '';
  // Таблица «пока операция не заполнена»: текущее значение меняемого поля и поля из условий.
  const sampleCols = [...(opKey !== '' ? [opKey] : []), ...result.condKeys.filter((k) => k !== opKey)];
  const sampleRows = useMemo(() => {
    const rows = (result.sample ?? []).map((sid) => ({ sid, name: ctx.localizedName(sid) ?? ctx.name(sid) ?? sid, cells: Object.fromEntries(sampleCols.map((k) => [k, cell(sid, k)])) }));
    return sortRows(rows, sort, (r, col) => (col === 'name' ? r.name : (r.cells[col] ?? '')));
  }, [ctx, result.sample, sampleCols.join('\n'), sort, version]);
  // Таблица предпросмотра: было / станет и значения полей из условий.
  const tableCols = result.condKeys.filter((k) => k !== p?.changes[0]?.field);
  const tableRows = useMemo(() => {
    const rows = (p?.changes ?? []).map((c) => ({ c, cells: Object.fromEntries(tableCols.map((k) => [k, cell(c.sid, k)])) }));
    return sortRows(rows, sort, (r, col) => (col === 'name' ? r.c.name : col === 'before' ? r.c.before : col === 'after' ? r.c.after : (r.cells[col] ?? '')));
  }, [ctx, p, tableCols.join('\n'), sort, version]);

  const toggleRow = (sid: string): void => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (!next.delete(sid)) next.add(sid);
      return next;
    });
  };
  const toggleAll = (): void => {
    setExcluded(nChosen > 0 ? new Set((p?.changes ?? []).map((c) => c.sid)) : new Set());
  };

  const apply = (): void => {
    if (!chosen || chosen.ops.length === 0) return;
    report(
      tryEdit(() => {
        applyBulk(ctx, chosen);
      }),
    );
  };
  const head = (id: string, label: string): ReactNode => (
    <th className="bulk-sort" onClick={() => { sortBy(id); }} title={t.bulkSortTip} data-testid={`bulk-sort-${id}`}>
      {label}
      {sort?.col === id ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <div className="mods-panel" data-testid="bulk-panel">
      <div className="mods-panel-bar">
        <label>
          {t.cmpType}{' '}
          <select value={type} onChange={(e) => { changeType(e.target.value); }} data-testid="bulk-type">
            {types.map((k) => (
              <option key={k} value={k}>
                {k} ({byType.get(k)?.length ?? 0})
              </option>
            ))}
          </select>
        </label>
        <input type="search" placeholder={t.bulkSearchPh} title={t.bulkSearchTip} value={search} onChange={(e) => { setSearch(e.target.value); }} data-testid="bulk-search" />
        <input type="search" placeholder={t.bulkFilterPh} title={t.bulkFilterTip} value={filter} onChange={(e) => { setFilter(e.target.value); }} data-testid="bulk-filter" />
        <div className="fac-help bulk-filter-help" data-testid="bulk-filter-help">
          <button className="fac-help-btn" aria-label={t.bulkFilterHelpTip} title={t.bulkFilterHelpTip}>
            ?
          </button>
          <div className="fac-help-pop" role="tooltip">
            <strong>{t.bulkFilterHelpTitle}</strong>
            <table>
              <thead>
                <tr>
                  {t.bulkOpsHead.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.bulkOpsRows.map(([what, mean, example]) => (
                  <tr key={what}>
                    <td>
                      <code>{what}</code>
                    </td>
                    <td>{mean}</td>
                    <td>
                      <code>{example}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {valueGroups.length > 0 && (
              <>
                <div className="bulk-fields-title">{t.bulkValuesTitle(type)}</div>
                {valueGroups.map((g) => (
                  <div key={g.field} className="bulk-values-group">
                    <code>{g.field}</code>
                    <div className="bulk-fields-list">
                      {g.values.map((v) => (
                        <button key={v.value} type="button" className="link" onClick={() => { addToFilter(`${g.field}=${String(v.value)}`); }}>
                          {v.value}
                          {v.label !== '' && ` ${v.label}`} ({v.count}: {v.names.join(', ')}
                          {v.count > v.names.length ? '…' : ''})
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
            <div className="bulk-fields-title">{t.bulkFieldsOf(type, fieldDefs.length)}</div>
            <div className="bulk-fields-list">
              {fieldDefs.map((f) => (
                <button key={f.name} type="button" className="link" title={f.description ?? f.name} onClick={() => { addToFilter(f.name); }}>
                  {f.name}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label title={t.bulkModOnlyTip}>
          <input type="checkbox" checked={modOnly} onChange={(e) => { setModOnly(e.target.checked); }} data-testid="bulk-mod-only" /> {t.bulkModOnly}
        </label>
      </div>
      <div className="mods-panel-bar bulk-cond" title={t.bulkCondTip} data-testid="bulk-cond">
        <span className="muted">{t.bulkCondTitle}</span>
        <select value={cField} onChange={(e) => { changeCondField(e.target.value); }} data-testid="bulk-cond-field">
          <option value="">{t.bulkCondField}</option>
          {fieldDefs.map((f) => (
            <option key={f.name} value={f.name}>
              {fieldText(t, f.name)}
            </option>
          ))}
          {refFieldDefs.length > 0 && (
            <optgroup label={t.bulkCondRefList}>
              {refFieldDefs.map((f) => (
                <option key={f.name} value={f.name}>
                  {fieldText(t, f.name)}
                </option>
              ))}
            </optgroup>
          )}
          <option value="Ref">{t.bulkCondRefCount}</option>
        </select>
        <select value={cOp} onChange={(e) => { setCOp(e.target.value); }} data-testid="bulk-cond-op">
          {condOps.map(([o, label]) => (
            <option key={o} value={o}>
              {o} {label}
            </option>
          ))}
        </select>
        {cOp !== 'exists' &&
          (cGroup ? (
            <select value={cValue} onChange={(e) => { setCValue(e.target.value); }} data-testid="bulk-cond-value">
              <option value="">{t.bulkCondPickValue}</option>
              {cGroup.values.map((v) => (
                <option key={v.value} value={String(v.value)}>
                  {v.value}
                  {v.label !== '' && ` ${v.label}`} — {v.names.join(', ')}
                  {v.count > v.names.length ? '…' : ''} ({v.count})
                </option>
              ))}
            </select>
          ) : cClass === 'scalar' && cBool ? (
            <select value={cValue} onChange={(e) => { setCValue(e.target.value); }} data-testid="bulk-cond-value">
              <option value="">{t.bulkCondPickValue}</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input placeholder={t.bulkCondValue} value={cValue} onChange={(e) => { setCValue(e.target.value); }} onKeyDown={(e) => { if (e.key === 'Enter') addCondition(); }} data-testid="bulk-cond-value" />
          ))}
        <button disabled={!condReady} onClick={addCondition} data-testid="bulk-cond-add">
          {t.bulkCondAdd}
        </button>
      </div>
      <div className="mods-panel-bar bulk-op">
        <select value={kind} onChange={(e) => { changeKind(e.target.value as BulkKind); }} data-testid="bulk-op">
          {BULK_KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(t, k)}
            </option>
          ))}
        </select>
        {fieldDefs.length > 0 || refFieldDefs.length > 0 ? (
          <select value={field} title={t.bulkFieldTip} onChange={(e) => { setField(e.target.value); }} data-testid="bulk-field">
            <option value="">{t.bulkPickField}</option>
            {fieldOptions.map((f) => (
              <option key={f} value={f}>
                {fieldText(t, f)}
              </option>
            ))}
          </select>
        ) : (
          <input placeholder={t.bulkFieldPh} title={t.bulkFieldTip} value={field} onChange={(e) => { setField(e.target.value); }} data-testid="bulk-field" />
        )}
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
        <input placeholder={t.bulkValuePh(kind)} title={t.bulkValueTip(kind)} value={value} onChange={(e) => { setValue(e.target.value); }} data-testid="bulk-value" />
        {kind === 'refAdd' && <input placeholder={t.bulkRefValuesPh} title={t.bulkRefValuesTip} value={refValues} onChange={(e) => { setRefValues(e.target.value); }} data-testid="bulk-ref-values" />}
        <button className="primary" disabled={!chosen || chosen.ops.length === 0} onClick={apply} data-testid="bulk-apply">
          {t.bulkApply(nChosen)}
        </button>
      </div>
      <div className="muted mods-panel-note">
        <div className="fac-help" data-testid="bulk-help">
          <button className="fac-help-btn" aria-label={t.bulkHelpTip} title={t.bulkHelpTip}>
            ?
          </button>
          <div className="fac-help-pop" role="tooltip">
            <strong>{t.bulkHelpTitle}</strong>
            <table>
              <thead>
                <tr>
                  {t.bulkHelpHead.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.bulkHelpRows.map(([what, why, example]) => (
                  <tr key={what}>
                    <td>{what}</td>
                    <td>{why}</td>
                    <td>{example === '' ? '' : <code>{example}</code>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="bulk-help-examples">
              {t.bulkHelpExamples.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>{' '}
        {t.bulkNote}
      </div>
      <div className="bulk-examples" data-testid="bulk-examples">
        <span className="muted">{t.bulkExamplesTitle}</span>
        {t.bulkExamples.map(([title, exType, exFilter, exKind, exField, exValue]) => (
          <button
            key={title}
            type="button"
            className="link"
            onClick={() => {
              if (byType.has(exType)) setType(exType);
              setSearch('');
              setFilter(exFilter);
              setKind(exKind as BulkKind);
              setField(exField);
              setValue(exValue);
              setRefValues('');
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {result.error !== undefined && (
        <div className="bulk-error" data-testid="bulk-error">
          {result.error}
        </div>
      )}
      {p && (
        <div className="bulk-sentence" data-testid="bulk-sentence">
          {t.bulkSentence({ kind, field: t.bulkFieldRu[field] ?? field, value, find, type, filter, search, modOnly, changes: nChosen, matched: p.matched })}
        </div>
      )}
      {p && (
        <div className="muted" data-testid="bulk-summary">
          {t.bulkSummary(p.matched, p.changes.length, p.skipped.length)}
          {total > 0 && (
            <>
              {' · '}
              <span data-testid="bulk-chosen">{t.bulkChosen(nChosen, total)}</span>
            </>
          )}
        </div>
      )}
      {!p ? (
        <div className="panel-empty bulk-need" data-testid="bulk-need">
          {result.missing && <div data-testid="bulk-need-what">{t.bulkNeed(result.missing, kind)}</div>}
          {result.matched !== undefined && <div className="muted">{t.bulkMatchedNow(result.matched)}</div>}
          {result.sample && result.sample.length > 0 && (
            <div className="bulk-sample" data-testid="bulk-sample">
              <div className="muted">{t.bulkSampleTitle(result.matched ?? 0, Math.min(SAMPLE_ROWS, sampleRows.length))}</div>
              <table className="table bulk-table">
                <thead>
                  <tr>
                    {head('name', t.cmpName)}
                    {sampleCols.map((k) => head(k, fieldText(t, k)))}
                  </tr>
                </thead>
                <tbody>
                  {sampleRows.slice(0, SAMPLE_ROWS).map((r) => (
                    <tr key={r.sid} data-testid="bulk-sample-row">
                      <td>
                        <button className="link" onClick={() => { go(r.sid); }} title={r.sid}>
                          {r.name}
                        </button>
                      </td>
                      {sampleCols.map((k) => (
                        <td key={k}>{r.cells[k] === '' ? '—' : r.cells[k]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!result.missing && result.error === undefined && <div className="muted">{t.bulkEmpty}</div>}
        </div>
      ) : p.changes.length === 0 ? (
        <Empty text={t.bulkNothing} />
      ) : (
        <div className="table-wrap">
          <table className="table bulk-table" data-testid="bulk-table">
            <thead>
              <tr>
                <th className="bulk-check">
                  <input
                    type="checkbox"
                    checked={nChosen === total}
                    ref={(el) => {
                      if (el) el.indeterminate = nChosen > 0 && nChosen < total;
                    }}
                    onChange={toggleAll}
                    title={t.bulkPickAll}
                    aria-label={t.bulkPickAll}
                    data-testid="bulk-pick-all"
                  />
                </th>
                {head('name', t.cmpName)}
                <th>{t.bulkField}</th>
                {head('before', t.bulkBefore)}
                {head('after', t.bulkAfter)}
                {tableCols.map((k) => head(k, fieldText(t, k)))}
              </tr>
            </thead>
            <tbody>
              {tableRows.slice(0, MAX_ROWS).map(({ c, cells }) => (
                <tr key={c.sid} className={excluded.has(c.sid) ? 'bulk-off' : undefined} data-testid="bulk-row" data-sid={c.sid} data-before={c.before} data-after={c.after}>
                  <td className="bulk-check">
                    <input type="checkbox" checked={!excluded.has(c.sid)} onChange={() => { toggleRow(c.sid); }} title={t.bulkPickRow} aria-label={t.bulkPickRow} data-testid="bulk-pick" />
                  </td>
                  <td>
                    <button className="link" onClick={() => { go(c.sid); }} title={c.sid}>
                      {c.name}
                    </button>
                  </td>
                  <td className="muted">{c.field}</td>
                  <td className="bulk-before">{c.before === '' ? '—' : c.before}</td>
                  <td className="bulk-after">{c.after === '' ? '—' : c.after}</td>
                  {tableCols.map((k) => (
                    <td key={k} className="muted">
                      {cells[k] === '' ? '—' : cells[k]}
                    </td>
                  ))}
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
