/**
 * Record editor: header (name, id, type, status, layers) and tabs — fields by the fcs.def schema
 * with the reference lists below them (as in FCS) and a description bar of the selected field,
 * back references, «where in game», per-field difference from vanilla.
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
  enumLabel,
  fieldHelp,
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
  type FieldDef,
  type FieldHelp,
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
import { InGameLine, useInGame } from './WaysIntoGame.tsx';
import { DIALOGUE_GRAPH_TYPES, DialogueGraphTab } from './DialogueGraphTab.tsx';
import { TalkTab } from './TalkTab.tsx';
import { conflictFieldLabel } from '../workbench/panels/conflicts.tsx';

interface Props {
  project: Project;
  version: number;
  sid: string;
  onGo: (sid: string) => void;
  onReport: (err: string | undefined) => void;
  /** Card of the record type (the race card), shown between the header and the tabs. */
  card?: ReactNode;
}

type Tab = 'fields' | 'back' | 'graph' | 'talk' | 'where' | 'diff';

export function RecordEditor({ project, version, sid, onGo, onReport, card }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const [chosenTab, setTab] = useState<Tab>('fields');
  const rec = project.record(sid);
  const status = ctx.status(sid);
  const origin = ctx.origin(sid);
  const deleted = status === 'deleted';
  const backRefs = useMemo(() => ctx.referencesTo(sid), [ctx, sid, version]);
  const groups = useMemo(() => refGroups(ctx, sid, lang), [ctx, sid, version, lang]);
  const inGame = useInGame(project, sid, version);
  const others = useMemo(() => {
    const report = touchedBy(contextLayers(ctx), sid);
    const layers = report.touches.map((x) => x.layer).filter((l) => l !== ctx.modName && !isVanillaLayer(l));
    return { layers, conflicts: recordConflicts(report) };
  }, [ctx, sid, version]);

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
        <InGameLine
          state={inGame}
          onOpen={() => {
            setTab('where');
          }}
        />
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
      {!deleted && card}
      <div className="tabs">
        <TabButton tab="fields" cur={tab} set={setTab} label={t.tabFields} />
        <TabButton tab="back" cur={tab} set={setTab} label={`${t.tabBackRefs} (${backRefs.length})`} />
        {hasGraph && <TabButton tab="graph" cur={tab} set={setTab} label={t.tabGraph} />}
        {hasTalk && <TabButton tab="talk" cur={tab} set={setTab} label={t.tabTalk} />}
        <TabButton tab="where" cur={tab} set={setTab} label={inGame.state === 'nowhere' ? `${t.tabWhere} ⚠` : t.tabWhere} />
        <TabButton tab="diff" cur={tab} set={setTab} label={t.tabDiff} marked={status !== 'base'} />
      </div>
      <div className={`tab-body ${tab === 'fields' ? 'fields-body' : ''}`}>
        {tab === 'fields' && <FieldsTab project={project} rec={rec} sid={sid} version={version} groups={groups} disabled={deleted} edit={edit} onGo={onGo} />}
        {tab === 'back' && <BackRefsTab project={project} sid={sid} entries={backRefs} onGo={onGo} />}
        {tab === 'graph' && <DialogueGraphTab project={project} sid={sid} version={version} onGo={onGo} />}
        {tab === 'talk' && <TalkTab project={project} sid={sid} version={version} onGo={onGo} />}
        {tab === 'where' && <WhereTab project={project} sid={sid} version={version} onGo={onGo} onReport={onReport} />}
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

// ---------------------------------------------------------------- fields

function displayValue(ctx: ModContext, rec: GameRecord, row: FieldRow, v: ScalarValue | undefined, lang: string): string {
  if (v === undefined) return '';
  if (row.dict === 'strings' || row.dict === 'files') return decodeText(v as Uint8Array);
  if (row.dict === 'floats') return formatFloat(v as number);
  if (row.dict === 'vec3s' || row.dict === 'vec4s') return (v as number[]).map(formatFloat).join(', ');
  return formatFieldValue(ctx, rec, row.dict, row.key, v, lang);
}

/** Text from an input → field value; a string — parse error. */
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

/** The selected line of the «Fields» tab: a field or a reference list. */
interface Selection {
  kind: 'field' | 'ref';
  key: string;
}

interface FieldsTabProps {
  project: Project;
  rec: GameRecord;
  sid: string;
  version: number;
  groups: RefGroup[];
  disabled: boolean;
  edit: (fn: () => void) => void;
  onGo: (sid: string) => void;
}

/** Fields by fcs.def groups, then the reference lists (as in FCS), and the description bar of the selected line. */
function FieldsTab({ project, rec, sid, version, groups, disabled, edit, onGo }: FieldsTabProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const typeName = ctx.typeName(rec.type);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Selection | undefined>();
  const [picker, setPicker] = useState<RefGroup | undefined>();
  const rows = useMemo(() => fieldRows(ctx, sid), [ctx, sid, version]);
  const helps = useMemo(() => {
    const m = new Map<string, FieldHelp>();
    for (const r of rows) m.set(`field:${r.key}`, fieldHelp(typeName, r.def?.name ?? r.key, lang));
    for (const g of groups) m.set(`ref:${g.category}`, fieldHelp(typeName, g.category, lang));
    return m;
  }, [rows, groups, typeName, lang]);
  const helpOf = (kind: Selection['kind'], key: string): FieldHelp => helps.get(`${kind}:${key}`) ?? {};
  const withLabels = [...helps.values()].some((h) => h.label !== undefined);
  const f = filter.trim().toLowerCase();
  const matches = (kind: Selection['kind'], key: string): boolean => !f || key.toLowerCase().includes(f) || (helpOf(kind, key).label?.toLowerCase().includes(f) ?? false);
  const shown = rows.filter((r) => (showHidden || !r.hidden) && matches('field', r.key));
  const shownRefs = groups.filter((g) => matches('ref', g.category));
  const fieldGroups: { category: string; rows: FieldRow[] }[] = [];
  for (const r of shown) {
    let g = fieldGroups.find((x) => x.category === r.category);
    if (!g) fieldGroups.push((g = { category: r.category, rows: [] }));
    g.rows.push(r);
  }
  const hiddenCount = rows.filter((r) => r.hidden).length;
  const isSelected = (kind: Selection['kind'], key: string): boolean => selected?.kind === kind && selected.key === key;
  const select = (kind: Selection['kind'], key: string): void => {
    if (!isSelected(kind, key)) setSelected({ kind, key });
  };

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
    <div className={`fields ${withLabels ? 'with-labels' : ''}`} data-testid="fields">
      <div className="fields-scroll">
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
          {withLabels && <span />}
          <span>{t.value}</span>
          <span>{t.vanillaValue}</span>
          <span />
        </div>
        {fieldGroups.map((g) => (
          <div key={g.category} className="field-group">
            {g.category && <div className="group-title">{g.category}</div>}
            {g.rows.map((row) => (
              <FieldLine
                key={`${row.dict}:${row.key}`}
                ctx={ctx}
                rec={rec}
                row={row}
                help={helpOf('field', row.key)}
                withLabels={withLabels}
                selected={isSelected('field', row.key)}
                onSelect={() => {
                  select('field', row.key);
                }}
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
        {shownRefs.length > 0 && (
          <div className="field-group ref-fields" data-testid="refs">
            <div className="group-title">{t.tabRefs}</div>
            {shownRefs.map((g) => (
              <RefField
                key={g.category}
                ctx={ctx}
                sid={sid}
                group={g}
                help={helpOf('ref', g.category)}
                withLabels={withLabels}
                selected={isSelected('ref', g.category)}
                onSelect={() => {
                  select('ref', g.category);
                }}
                disabled={disabled}
                edit={edit}
                onGo={onGo}
                onPick={() => {
                  setPicker(g);
                }}
              />
            ))}
          </div>
        )}
      </div>
      <FieldHelpBar selected={selected} rows={rows} groups={groups} help={selected ? helpOf(selected.kind, selected.key) : {}} />
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
  help: FieldHelp;
  withLabels: boolean;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
  t: Strings;
  onSet: (v: ScalarValue) => void;
  onText: (text: string) => void;
  onReset: () => void;
}

function FieldLine({ ctx, rec, row, help, withLabels, selected, onSelect, disabled, t, onSet, onText, onReset }: FieldLineProps): ReactNode {
  const lang = useLang();
  const shownValue = row.value ?? (row.def ? defaultValue(ctx.schema, row.def) : undefined);
  const canReset = row.state === 'changed' || row.state === 'added' || row.state === 'removed';
  return (
    <div
      className={`field-grid field-row fs-${row.state} ${row.hidden ? 'hidden-field' : ''} ${selected ? 'selected' : ''}`}
      data-field={row.key}
      onMouseDown={onSelect}
      onFocusCapture={onSelect}
    >
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
      {withLabels && (
        <span className="field-label" title={help.label}>
          {help.label ?? ''}
        </span>
      )}
      <span className="field-value">
        <FieldInput ctx={ctx} rec={rec} row={row} value={shownValue} placeholder={help.empty} disabled={disabled} onSet={onSet} onText={onText} />
      </span>
      <span className="field-lower muted" title={row.lower !== undefined ? displayValue(ctx, rec, row, row.lower, lang) : undefined}>
        {row.lower !== undefined ? displayValue(ctx, rec, row, row.lower, lang) : ''}
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

/** Technical line of the description bar: the fcs.def kind of the field (type codes are fine here). */
function fieldKindText(def: FieldDef | undefined, fallback: string): string {
  if (!def) return fallback;
  if (def.kind === 'reference' || def.kind === 'instance') return `${def.kind} → ${def.targetType ?? '?'}`;
  if (def.kind === 'enum' && def.enumName !== undefined) return `enum ${def.enumName}`;
  return def.kind;
}

/** FCS «Object view»-like bar under the fields: what the selected field or reference list means. */
function FieldHelpBar({ selected, rows, groups, help }: { selected: Selection | undefined; rows: FieldRow[]; groups: RefGroup[]; help: FieldHelp }): ReactNode {
  const t = useT();
  const row = selected?.kind === 'field' ? rows.find((r) => r.key === selected.key) : undefined;
  const group = selected?.kind === 'ref' ? groups.find((g) => g.category === selected.key) : undefined;
  if (!selected || (!row && !group)) {
    return (
      <div className="field-help muted" data-testid="field-help">
        {t.fieldHelpNone}
      </div>
    );
  }
  const def = row ? row.def : group?.def;
  const original = def?.description?.trim();
  const text = help.description ?? original;
  const notes: string[] = [];
  if (row && (row.def?.inferred === true || !row.def)) notes.push(t.inferredHint);
  if (row?.def?.builtin === true) notes.push(t.builtinHint);
  if (row?.hidden === true) notes.push(t.hiddenByCondition);
  return (
    <div className="field-help" data-testid="field-help" data-help-field={selected.key}>
      <div className="fh-title">
        <b>{selected.key}</b>
        {help.label !== undefined && <span> — {help.label}</span>}
      </div>
      {text ? (
        <div className="fh-text" data-testid="field-help-text">
          {text}
        </div>
      ) : (
        <div className="muted">{t.fieldNoDescription}</div>
      )}
      {help.empty !== undefined && <div className="fh-empty">{help.empty}</div>}
      {notes.map((n) => (
        <div key={n} className="muted fh-note">
          {n}
        </div>
      ))}
      <div className="fh-src muted">
        fcs.def · {fieldKindText(def, row?.dict ?? 'reference')}
        {help.description !== undefined && original ? ` · ${original}` : ''}
      </div>
    </div>
  );
}

function enumOptions(e: EnumDef, value: number | undefined, lang: string): ReactNode[] {
  const opts = e.values.map((v) => (
    <option key={v.value} value={v.value} title={v.description}>
      {v.name}
      {v.label !== undefined ? ` — ${enumLabel(e, v, lang) ?? v.label}` : ''}
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

function FieldInput({ ctx, rec, row, value, placeholder, disabled, onSet, onText }: { ctx: ModContext; rec: GameRecord; row: FieldRow; value: ScalarValue | undefined; placeholder?: string | undefined; disabled: boolean; onSet: (v: ScalarValue) => void; onText: (text: string) => void }): ReactNode {
  const lang = useLang();
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
        {enumOptions(row.enum, typeof value === 'number' ? value : undefined, lang)}
      </select>
    );
  }
  const text = row.dict === 'ints' ? (value === undefined ? '' : String(value)) : displayValue(ctx, rec, row, value, lang);
  const input = (
    <CommitInput
      value={text}
      testId={testId}
      disabled={disabled}
      multiline={row.def?.multiline === true && row.dict === 'strings'}
      placeholder={placeholder}
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

// ---------------------------------------------------------------- references

interface RefFieldProps {
  ctx: ModContext;
  sid: string;
  group: RefGroup;
  help: FieldHelp;
  withLabels: boolean;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
  edit: (fn: () => void) => void;
  onGo: (sid: string) => void;
  onPick: () => void;
}

/** One reference list among the fields: a line like a field (what «empty» means, «Choose…»), then its entries. */
function RefField({ ctx, sid, group, help, withLabels, selected, onSelect, disabled, edit, onGo, onPick }: RefFieldProps): ReactNode {
  const t = useT();
  const live = group.rows.filter((r) => r.state !== 'removed').length;
  const tip = `${group.def?.description ?? ''}${group.targetType !== undefined ? `\n→ ${group.targetType}` : ''}`.trim();
  const empty = help.empty ?? t.refEmpty;
  return (
    <div className="ref-group" data-category={group.category}>
      <div className={`field-grid field-row ref-field ${selected ? 'selected' : ''}`} data-ref={group.category} onMouseDown={onSelect} onFocusCapture={onSelect}>
        <span className="field-name" title={tip}>
          {group.category}
        </span>
        {withLabels && (
          <span className="field-label" title={help.label}>
            {help.label ?? ''}
          </span>
        )}
        <span className="field-value ref-summary">
          {live === 0 ? (
            <span className="ref-empty" title={empty} data-testid={`ref-empty-${group.category}`}>
              {empty}
            </span>
          ) : (
            <span className="muted">{t.refCount(live)}</span>
          )}
          {!disabled && (
            <button className="small" data-testid={`ref-add-${group.category}`} title={tip || t.refPickTip} onClick={onPick}>
              + {t.refPick}
            </button>
          )}
        </span>
        <span />
      </div>
      {group.rows.length > 0 && (
        <div className="ref-list">
          <div className="ref-grid ref-header">
            <span />
            {[0, 1, 2].map((i) => (
              <span key={i}>{group.valueLabels[i] ?? ''}</span>
            ))}
            <span />
          </div>
          {group.rows.map((row) => (
            <RefLine key={`${row.ref.target}:${row.state}`} ctx={ctx} sid={sid} group={group} row={row} disabled={disabled} edit={edit} onGo={onGo} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function RefLine({ ctx, sid, group, row, disabled, edit, onGo, t }: { ctx: ModContext; sid: string; group: RefGroup; row: RefRow; disabled: boolean; edit: (fn: () => void) => void; onGo: (sid: string) => void; t: Strings }): ReactNode {
  const lang = useLang();
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
                {enumOptions(e, v, lang)}
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

// ---------------------------------------------------------------- back references

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

// ---------------------------------------------------------------- difference from vanilla

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
