/**
 * Редактор записи: заголовок (имя, id, тип, статус, слои) и вкладки — поля по схеме fcs.def,
 * ссылки с выбором записи, обратные ссылки, «где в игре», разница с ванилью по полям.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  contextLayers,
  isVanillaLayer,
  recordConflicts,
  touchedBy,
  decodeText,
  defaultValue,
  encodeText,
  fieldRows,
  formatFieldValue,
  formatFloat,
  formatRefValues,
  formatScalar,
  isRemovedRef,
  modRecordDiff,
  refGroups,
  refLabel,
  type EnumDef,
  type FieldChange,
  type FieldRow,
  type GameRecord,
  type ModContext,
  type RefGroup,
  type RefRow,
  type ScalarValue,
} from '@kenshi-editor/core';
import { useLang, useT, type Strings } from '../i18n.ts';
import { tryEdit } from '../hooks.ts';
import type { Project } from '../project.ts';
import { CommitInput } from './widgets.tsx';
import { RecordPicker } from './RecordPicker.tsx';
import { WhereTab } from './WhereTab.tsx';
import { DIALOGUE_GRAPH_TYPES, DialogueGraphTab } from './DialogueGraphTab.tsx';
import { TalkTab } from './TalkTab.tsx';
import { conflictFieldLabel } from '../workbench/panels/conflicts.tsx';

interface Props {
  project: Project;
  version: number;
  sid: string;
  onGo: (sid: string) => void;
  onReport: (err: string | undefined) => void;
}

type Tab = 'fields' | 'refs' | 'back' | 'graph' | 'talk' | 'where' | 'diff';

export function RecordEditor({ project, version, sid, onGo, onReport }: Props): ReactNode {
  const t = useT();
  const ctx = project.ctx;
  const [chosenTab, setTab] = useState<Tab>('fields');
  const rec = project.record(sid);
  const status = ctx.status(sid);
  const origin = ctx.origin(sid);
  const deleted = status === 'deleted';
  const backRefs = useMemo(() => ctx.referencesTo(sid), [ctx, sid, version]);
  const groups = useMemo(() => refGroups(ctx, sid), [ctx, sid, version]);
  const others = useMemo(() => {
    const report = touchedBy(contextLayers(ctx), sid);
    const layers = report.touches.map((x) => x.layer).filter((l) => l !== ctx.modName && !isVanillaLayer(l));
    return { layers, conflicts: recordConflicts(report) };
  }, [ctx, sid, version]);
  const refCount = groups.reduce((n, g) => n + g.rows.filter((r) => r.state !== 'removed').length, 0);

  if (!rec) {
    return (
      <div className="record-editor empty muted" data-testid="record-editor">
        {t.noSelection} <span className="mono">{sid}</span>
      </div>
    );
  }
  const localized = ctx.localizedName(sid);
  const hasGraph = DIALOGUE_GRAPH_TYPES.has(ctx.typeName(rec.type));
  const hasTalk = ctx.typeName(rec.type) === 'CHARACTER';
  const tab: Tab = (chosenTab === 'graph' && !hasGraph) || (chosenTab === 'talk' && !hasTalk) ? 'fields' : chosenTab;
  const edit = (fn: () => void): void => {
    onReport(tryEdit(fn));
  };

  return (
    <div className="record-editor" data-testid="record-editor">
      <div className="record-head">
        <div className="row">
          <CommitInput
            className={`name-input st-${status ?? 'base'}`}
            testId="record-name"
            value={decodeText(rec.name)}
            disabled={deleted}
            title={t.name}
            onCommit={(text) => {
              edit(() => {
                ctx.renameRecord(sid, text);
              });
            }}
          />
          <span className={`badge st-${status ?? 'base'}`} data-testid="record-status">
            {t[`status_${status ?? 'base'}`]}
            {ctx.isDirty(sid) ? ' ●' : ''}
          </span>
        </div>
        <div className="record-meta">
          {localized !== undefined && <span className="tr-name">{localized}</span>}
          <span className="mono selectable" data-testid="record-sid">
            {sid}
          </span>
          <span className="badge">{ctx.typeName(rec.type)}</span>
          {origin && (
            <span className="muted" title={t.layers}>
              {origin.layers.join(' → ')}
            </span>
          )}
        </div>
        {others.layers.length > 0 && (
          <div className="record-others muted" data-testid="record-others">
            {t.alsoChangedBy}: {others.layers.join(', ')}
            {others.conflicts.length > 0 && (
              <span
                className="warn"
                data-testid="record-conflicts"
                title={others.conflicts.map((f) => t.conflictFieldTip(conflictFieldLabel(t, project, f), f.winner)).join('\n')}
              >
                ⚠ {t.conflictFields(others.conflicts.length)}
              </span>
            )}
          </div>
        )}
        {deleted && (
          <div className="banner error">
            {t.status_deleted}
            <button
              className="small"
              onClick={() => {
                edit(() => {
                  ctx.restoreRecord(sid);
                });
              }}
            >
              {t.restore}
            </button>
          </div>
        )}
      </div>
      <div className="tabs">
        <TabButton tab="fields" cur={tab} set={setTab} label={t.tabFields} />
        <TabButton tab="refs" cur={tab} set={setTab} label={`${t.tabRefs} (${refCount})`} />
        <TabButton tab="back" cur={tab} set={setTab} label={`${t.tabBackRefs} (${backRefs.length})`} />
        {hasGraph && <TabButton tab="graph" cur={tab} set={setTab} label={t.tabGraph} />}
        {hasTalk && <TabButton tab="talk" cur={tab} set={setTab} label={t.tabTalk} />}
        <TabButton tab="where" cur={tab} set={setTab} label={t.tabWhere} />
        <TabButton tab="diff" cur={tab} set={setTab} label={t.tabDiff} marked={status !== 'base'} />
      </div>
      <div className="tab-body">
        {tab === 'fields' && <FieldsTab ctx={ctx} rec={rec} sid={sid} version={version} disabled={deleted} edit={edit} />}
        {tab === 'refs' && <RefsTab project={project} sid={sid} groups={groups} disabled={deleted} edit={edit} onGo={onGo} />}
        {tab === 'back' && <BackRefsTab project={project} sid={sid} entries={backRefs} onGo={onGo} />}
        {tab === 'graph' && <DialogueGraphTab project={project} sid={sid} version={version} onGo={onGo} />}
        {tab === 'talk' && <TalkTab project={project} sid={sid} version={version} onGo={onGo} />}
        {tab === 'where' && <WhereTab project={project} sid={sid} version={version} onGo={onGo} />}
        {tab === 'diff' && <DiffTab ctx={ctx} sid={sid} version={version} onGo={onGo} />}
      </div>
    </div>
  );
}

function TabButton({ tab, cur, set, label, marked }: { tab: Tab; cur: Tab; set: (t: Tab) => void; label: string; marked?: boolean }): ReactNode {
  return (
    <button
      className={`tab ${tab === cur ? 'active' : ''}`}
      data-testid={`tab-${tab}`}
      onClick={() => {
        set(tab);
      }}
    >
      {label}
      {marked ? ' •' : ''}
    </button>
  );
}

// ---------------------------------------------------------------- поля

function displayValue(ctx: ModContext, rec: GameRecord, row: FieldRow, v: ScalarValue | undefined): string {
  if (v === undefined) return '';
  if (row.dict === 'strings' || row.dict === 'files') return decodeText(v as Uint8Array);
  if (row.dict === 'floats') return formatFloat(v as number);
  if (row.dict === 'vec3s' || row.dict === 'vec4s') return (v as number[]).map(formatFloat).join(', ');
  return formatFieldValue(ctx, rec, row.dict, row.key, v);
}

/** Текст из поля ввода → значение поля; строка — ошибка разбора. */
function parseValue(row: FieldRow, text: string): ScalarValue | string {
  switch (row.dict) {
    case 'strings':
    case 'files':
      return encodeText(text);
    case 'ints': {
      const n = Number(text.trim());
      if (!Number.isInteger(n) || n < -2147483648 || n > 4294967295) return `int: ${text}`;
      return n > 2147483647 ? n - 4294967296 : n;
    }
    case 'floats': {
      const n = Number(text.trim().replace(',', '.'));
      if (!Number.isFinite(n)) return `float: ${text}`;
      return Math.fround(n);
    }
    case 'vec3s':
    case 'vec4s': {
      const len = row.dict === 'vec3s' ? 3 : 4;
      const parts = text.split(/[\s,;()]+/).filter(Boolean).map(Number);
      if (parts.length !== len || parts.some((n) => !Number.isFinite(n))) return `vec${len}: ${text}`;
      return parts.map(Math.fround) as ScalarValue;
    }
    case 'bools':
      return text === 'true';
  }
}

function FieldsTab({ ctx, rec, sid, version, disabled, edit }: { ctx: ModContext; rec: GameRecord; sid: string; version: number; disabled: boolean; edit: (fn: () => void) => void }): ReactNode {
  const t = useT();
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => fieldRows(ctx, sid), [ctx, sid, version]);
  const f = filter.toLowerCase();
  const shown = rows.filter((r) => (showHidden || !r.hidden) && (!f || r.key.toLowerCase().includes(f)));
  const groups: { category: string; rows: FieldRow[] }[] = [];
  for (const r of shown) {
    let g = groups.find((x) => x.category === r.category);
    if (!g) groups.push((g = { category: r.category, rows: [] }));
    g.rows.push(r);
  }
  const hiddenCount = rows.filter((r) => r.hidden).length;

  const set = (row: FieldRow, v: ScalarValue): void => {
    edit(() => {
      ctx.setField(sid, row.dict, row.key, v);
    });
  };
  const setText = (row: FieldRow, text: string): void => {
    const v = parseValue(row, text);
    if (typeof v === 'string') edit(() => {
      throw new Error(v);
    });
    else set(row, v);
  };

  return (
    <div className="fields" data-testid="fields">
      <div className="fields-tools">
        <input
          placeholder={t.field}
          value={filter}
          data-testid="field-filter"
          onChange={(e) => {
            setFilter(e.target.value);
          }}
        />
        {hiddenCount > 0 && (
          <label className="muted">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => {
                setShowHidden(e.target.checked);
              }}
            />{' '}
            {t.showHidden} ({hiddenCount})
          </label>
        )}
      </div>
      <div className="field-grid field-header">
        <span>{t.field}</span>
        <span>{t.value}</span>
        <span>{t.vanillaValue}</span>
        <span />
      </div>
      {groups.map((g) => (
        <div key={g.category} className="field-group">
          {g.category && <div className="group-title">{g.category}</div>}
          {g.rows.map((row) => (
            <FieldLine
              key={`${row.dict}:${row.key}`}
              ctx={ctx}
              rec={rec}
              row={row}
              disabled={disabled}
              t={t}
              onSet={(v) => {
                set(row, v);
              }}
              onText={(text) => {
                setText(row, text);
              }}
              onReset={() => {
                edit(() => {
                  ctx.resetField(sid, row.dict, row.key);
                });
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function fieldTitle(row: FieldRow, t: Strings): string {
  const parts = [`${row.key} (${row.dict})`];
  if (row.def?.description) parts.push(row.def.description);
  if (row.def?.inferred) parts.push(t.inferredHint);
  if (row.def?.builtin) parts.push(t.builtinHint);
  if (!row.def) parts.push(t.inferredHint);
  if (row.hidden) parts.push(t.hiddenByCondition);
  return parts.join('\n\n');
}

interface FieldLineProps {
  ctx: ModContext;
  rec: GameRecord;
  row: FieldRow;
  disabled: boolean;
  t: Strings;
  onSet: (v: ScalarValue) => void;
  onText: (text: string) => void;
  onReset: () => void;
}

function FieldLine({ ctx, rec, row, disabled, t, onSet, onText, onReset }: FieldLineProps): ReactNode {
  const shownValue = row.value ?? (row.def ? defaultValue(ctx.schema, row.def) : undefined);
  const canReset = row.state === 'changed' || row.state === 'added' || row.state === 'removed';
  return (
    <div className={`field-grid field-row fs-${row.state} ${row.hidden ? 'hidden-field' : ''}`} data-field={row.key}>
      <span className="field-name" title={fieldTitle(row, t)}>
        {row.key}
        {(row.def?.inferred === true || !row.def) && (
          <span className="badge tiny" title={t.inferredHint}>
            {t.inferred}
          </span>
        )}
        {row.def?.builtin === true && (
          <span className="badge tiny" title={t.builtinHint}>
            FCS
          </span>
        )}
      </span>
      <span className="field-value">
        <FieldInput ctx={ctx} rec={rec} row={row} value={shownValue} disabled={disabled} onSet={onSet} onText={onText} />
      </span>
      <span className="field-lower muted" title={row.lower !== undefined ? displayValue(ctx, rec, row, row.lower) : undefined}>
        {row.lower !== undefined ? displayValue(ctx, rec, row, row.lower) : ''}
      </span>
      <span>
        {canReset && !disabled && (
          <button className="small" title={row.lower !== undefined ? t.resetField : t.removeField} onClick={onReset} data-testid={`reset-${row.key}`}>
            ↺
          </button>
        )}
      </span>
    </div>
  );
}

function enumOptions(e: EnumDef, value: number | undefined): ReactNode[] {
  const opts = e.values.map((v) => (
    <option key={v.value} value={v.value} title={v.description}>
      {v.name}
      {v.label !== undefined ? ` — ${v.label}` : ''}
    </option>
  ));
  if (value !== undefined && !e.values.some((v) => v.value === value)) opts.unshift(
    <option key={`x${value}`} value={value}>
      {value} (?)
    </option>,
  );
  return opts;
}

function colorHex(v: number): string {
  return `#${((v >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}

function FieldInput({ ctx, rec, row, value, disabled, onSet, onText }: { ctx: ModContext; rec: GameRecord; row: FieldRow; value: ScalarValue | undefined; disabled: boolean; onSet: (v: ScalarValue) => void; onText: (text: string) => void }): ReactNode {
  const testId = `field-${row.key}`;
  if (row.dict === 'bools') {
    return (
      <input
        type="checkbox"
        data-testid={testId}
        checked={value === true}
        disabled={disabled}
        onChange={(e) => {
          onSet(e.target.checked);
        }}
      />
    );
  }
  if (row.dict === 'ints' && row.enum && row.def?.bitset !== true) {
    return (
      <select
        data-testid={testId}
        value={typeof value === 'number' ? value : ''}
        disabled={disabled}
        onChange={(e) => {
          onSet(Number(e.target.value));
        }}
      >
        {value === undefined && <option value="" />}
        {enumOptions(row.enum, typeof value === 'number' ? value : undefined)}
      </select>
    );
  }
  const text = row.dict === 'ints' ? (value === undefined ? '' : String(value)) : displayValue(ctx, rec, row, value);
  const input = (
    <CommitInput
      value={text}
      testId={testId}
      disabled={disabled}
      multiline={row.def?.multiline === true && row.dict === 'strings'}
      className={row.value === undefined ? 'placeholder-value' : undefined}
      onCommit={onText}
    />
  );
  if (row.def?.kind === 'color' && row.dict === 'ints') {
    const n = typeof value === 'number' ? value : 0;
    return (
      <span className="color-field">
        <input
          type="color"
          value={colorHex(n)}
          disabled={disabled}
          onChange={(e) => {
            const rgb = parseInt(e.target.value.slice(1), 16);
            onSet((((n >>> 0) & 0xff000000) | rgb) | 0);
          }}
        />
        {input}
      </span>
    );
  }
  return input;
}

// ---------------------------------------------------------------- ссылки

function RefsTab({ project, sid, groups, disabled, edit, onGo }: { project: Project; sid: string; groups: RefGroup[]; disabled: boolean; edit: (fn: () => void) => void; onGo: (sid: string) => void }): ReactNode {
  const t = useT();
  const ctx = project.ctx;
  const [picker, setPicker] = useState<RefGroup | undefined>();
  const filled = groups.filter((g) => g.rows.length > 0);
  const empty = groups.filter((g) => g.rows.length === 0);

  return (
    <div className="refs" data-testid="refs">
      {filled.length === 0 && <p className="muted">{t.noRefs}</p>}
      {filled.map((g) => (
        <div key={g.category} className="ref-group" data-category={g.category}>
          <div className="group-title" title={g.def?.description}>
            <span>{g.category}</span>
            {g.targetType !== undefined && <span className="muted"> → {g.targetType}</span>}
            <span className="muted"> ({g.rows.filter((r) => r.state !== 'removed').length})</span>
            <span className="grow" />
            {!disabled && (
              <button
                className="small"
                data-testid={`ref-add-${g.category}`}
                onClick={() => {
                  setPicker(g);
                }}
              >
                + {t.add}
              </button>
            )}
          </div>
          <div className="ref-grid ref-header">
            <span>{t.name}</span>
            {[0, 1, 2].map((i) => (
              <span key={i}>{g.valueLabels[i] ?? ''}</span>
            ))}
            <span />
          </div>
          {g.rows.map((row) => (
            <RefLine
              key={`${row.ref.target}:${row.state}`}
              ctx={ctx}
              sid={sid}
              group={g}
              row={row}
              disabled={disabled}
              edit={edit}
              onGo={onGo}
              t={t}
            />
          ))}
        </div>
      ))}
      {empty.length > 0 && !disabled && (
        <div className="empty-cats">
          <span className="muted">{t.add}:</span>
          {empty.map((g) => (
            <button
              key={g.category}
              className="chip"
              title={`${g.def?.description ?? ''}${g.targetType !== undefined ? `\n→ ${g.targetType}` : ''}`}
              data-testid={`ref-add-${g.category}`}
              onClick={() => {
                setPicker(g);
              }}
            >
              + {g.category}
            </button>
          ))}
        </div>
      )}
      {picker && (
        <RecordPicker
          project={project}
          title={`${t.pickRecord}: ${picker.category}`}
          targetType={picker.targetType}
          exclude={new Set(picker.rows.filter((r) => r.state !== 'removed').map((r) => r.ref.target))}
          onPick={(target) => {
            const cat = picker.category;
            setPicker(undefined);
            edit(() => {
              ctx.addReference(sid, cat, target);
            });
          }}
          onClose={() => {
            setPicker(undefined);
          }}
        />
      )}
    </div>
  );
}

function RefLine({ ctx, sid, group, row, disabled, edit, onGo, t }: { ctx: ModContext; sid: string; group: RefGroup; row: RefRow; disabled: boolean; edit: (fn: () => void) => void; onGo: (sid: string) => void; t: Strings }): ReactNode {
  const r = row.ref;
  const values = [r.v0, r.v1, r.v2];
  const removed = row.state === 'removed';
  const setValue = (i: number, v: number): void => {
    const next = [...values];
    next[i] = v;
    edit(() => {
      ctx.addReference(sid, group.category, r.target, next);
    });
  };
  const missing = row.targetName === undefined;
  return (
    <div className={`ref-grid ref-row rs-${row.state}`} data-target={r.target}>
      <span className="ref-target">
        <button
          className={`link st-${row.targetStatus ?? 'base'} ${missing ? 'error' : ''}`}
          title={`${r.target}${row.targetType !== undefined ? ` · ${row.targetType}` : ''}`}
          onClick={() => {
            onGo(r.target);
          }}
        >
          {missing ? `<${t.missingTarget}> ${r.target}` : row.targetName}
        </button>
        {removed && <span className="muted"> — {t.removedRef}</span>}
      </span>
      {[0, 1, 2].map((i) => {
        if (i >= group.valueLabels.length) return <span key={i} />;
        const e = group.valueEnums[i];
        const v = values[i]!;
        const lowerV = row.lower ? [row.lower.v0, row.lower.v1, row.lower.v2][i] : undefined;
        const title = lowerV !== undefined && lowerV !== v ? `${t.vanillaValue}: ${lowerV}` : undefined;
        if (e) {
          return (
            <span key={i} title={title}>
              <select
                value={v}
                disabled={disabled || removed}
                onChange={(ev) => {
                  setValue(i, Number(ev.target.value));
                }}
              >
                {enumOptions(e, v)}
              </select>
            </span>
          );
        }
        return (
          <span key={i} title={title}>
            <CommitInput
              value={String(v)}
              disabled={disabled || removed}
              testId={`ref-v${i}-${r.target}`}
              onCommit={(text) => {
                const n = Number(text.trim());
                if (Number.isInteger(n)) setValue(i, n);
                else edit(() => {
                  throw new Error(`v${i}: ${text}`);
                });
              }}
            />
          </span>
        );
      })}
      <span>
        {!disabled && !removed && (
          <button
            className="small"
            title={t.remove}
            data-testid={`ref-remove-${r.target}`}
            onClick={() => {
              edit(() => {
                ctx.removeReference(sid, group.category, r.target);
              });
            }}
          >
            ✕
          </button>
        )}
        {!disabled && removed && (
          <button
            className="small"
            title={t.restore}
            onClick={() => {
              edit(() => {
                ctx.addReference(sid, group.category, r.target, values);
              });
            }}
          >
            ↺
          </button>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- обратные ссылки

const BACK_LIMIT = 1000;

function BackRefsTab({ project, sid, entries, onGo }: { project: Project; sid: string; entries: ReturnType<ModContext['referencesTo']>; onGo: (sid: string) => void }): ReactNode {
  const t = useT();
  const lang = useLang();
  if (entries.length === 0) return <p className="muted">{t.noBackRefs}</p>;
  return (
    <div className="backrefs" data-testid="backrefs" data-sid={sid}>
      <table className="table">
        <thead>
          <tr>
            <th>{t.name}</th>
            <th>{t.type}</th>
            <th>{t.tabRefs}</th>
            <th>v0 v1 v2</th>
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, BACK_LIMIT).map((e, i) => {
            const src = project.entry(e.source);
            return (
              <tr key={`${e.source}:${e.category}:${i}`}>
                <td>
                  <button
                    className={`link st-${project.ctx.status(e.source) ?? 'base'}`}
                    title={e.source}
                    onClick={() => {
                      onGo(e.source);
                    }}
                  >
                    {src?.name ?? e.source}
                  </button>
                </td>
                <td>{src?.type}</td>
                <td>{e.category}</td>
                <td className="mono">{e.ref ? formatRefValues(e.ref, lang) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {entries.length > BACK_LIMIT && <p className="muted">… +{entries.length - BACK_LIMIT}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- разница с ванилью

function changeCells(ctx: ModContext, rec: GameRecord, c: FieldChange, lang: string): [string, string, string] {
  switch (c.kind) {
    case 'name':
      return ['name', decodeText(c.before), decodeText(c.after)];
    case 'type':
      return ['type', ctx.typeName(c.before), ctx.typeName(c.after)];
    case 'flags':
      return ['flags', `0x${c.before.toString(16)}`, `0x${c.after.toString(16)}`];
    case 'field': {
      const fmt = (v: ScalarValue | undefined): string => (v === undefined ? '—' : c.dict === 'ints' ? formatFieldValue(ctx, rec, c.dict, c.key, v, lang) : formatScalar(c.dict, v));
      return [c.key, fmt(c.before), fmt(c.after)];
    }
    case 'ref': {
      const target = c.target.replace(/#\d+$/, '');
      const fmt = (r: typeof c.before): string => (!r || isRemovedRef(r) ? '—' : formatRefValues(r));
      return [`${c.category} → ${refLabel(ctx, target, lang)}`, fmt(c.before), fmt(c.after)];
    }
    case 'refOrder':
      return [c.category, c.before.length.toString(), c.after.length.toString()];
    case 'instance':
      return [`instance ${c.key}`, c.before ? c.before.target : '—', c.after ? c.after.target : '—'];
  }
}

function DiffTab({ ctx, sid, version, onGo }: { ctx: ModContext; sid: string; version: number; onGo: (sid: string) => void }): ReactNode {
  const t = useT();
  const lang = useLang();
  const diff = useMemo(() => modRecordDiff(ctx, sid), [ctx, sid, version]);
  const status = ctx.status(sid);
  if (status === 'deleted') return <p className="error">{t.status_deleted}</p>;
  if (!diff) return <p className="muted">{t.noChanges}</p>;
  const rec = (diff.after ?? diff.before)!;
  return (
    <div className="diff" data-testid="diff">
      {diff.change === 'added' && <p className="st-new">{t.status_new}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>{t.field}</th>
            <th>{t.before}</th>
            <th>{t.after}</th>
          </tr>
        </thead>
        <tbody>
          {diff.fields.map((c, i) => {
            const [field, before, after] = changeCells(ctx, rec, c, lang);
            const kind = c.kind === 'field' || c.kind === 'ref' || c.kind === 'instance' ? (c.before === undefined ? 'added' : c.after === undefined ? 'removed' : 'changed') : 'changed';
            return (
              <tr key={i} className={`fs-${kind}`}>
                <td>
                  {c.kind === 'ref' ? (
                    <button
                      className="link"
                      onClick={() => {
                        onGo(c.target.replace(/#\d+$/, ''));
                      }}
                    >
                      {field}
                    </button>
                  ) : (
                    field
                  )}
                </td>
                <td className="mono">{before}</td>
                <td className="mono">{after}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
