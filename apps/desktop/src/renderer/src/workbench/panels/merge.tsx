/**
 * Панель «Слияние модов» (как «Merge» в FCS): выбрать мод-источник — увидеть, чем он отличается
 * от активного (новые, изменённые, удалённые записи), по каждой записи выбрать «игнор / принять /
 * отклонить», по конфликтным полям — чьё значение взять, и слить выбранное одной правкой
 * (одна отмена). Решения («отклонено», «слито оттуда-то и когда») хранятся в файле рядом с модом.
 * Вся логика — в ядре (`model/merge.ts`), панель только показывает и вызывает его.
 */
import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import {
  applyMerge,
  checkMergeSource,
  FileType,
  mergeClosure,
  mergeFixReferences,
  MergeError,
  planMerge,
  readDataFile,
  rejectMerge,
  unrejectMerge,
  type LevelDataInfo,
  type MergeChange,
  type MergeChoice,
  type MergeKind,
  type MergePlan,
  type MergeResult,
  type MergeSource,
} from '@kenshi-editor/core';
import type { ModEntry } from '../../../../shared/api.ts';
import { useLang, useT, type Strings } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import type { Project } from '../../project.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Строк в таблице за раз; «Показать ещё» добавляет столько же. */
const PAGE = 300;

/** То, что панель помнит о слиянии, пока открыт проект (закрыли и снова открыли панель — всё на месте). */
interface Session {
  path: string | undefined;
  source: MergeSource | undefined;
  levelData: LevelDataInfo | undefined;
  error: string | undefined;
  accepted: Set<string>;
  resolutions: Record<string, Record<string, MergeChoice>>;
  recursive: boolean;
  fixRefs: boolean;
  levels: boolean;
  defaultConflict: MergeChoice;
  showSkipped: boolean;
  result: MergeResult | undefined;
  mods: ModEntry[] | undefined;
}

const sessions = new WeakMap<Project, Session>();

function sessionOf(project: Project): Session {
  let s = sessions.get(project);
  if (!s) {
    s = {
      path: undefined,
      source: undefined,
      levelData: undefined,
      error: undefined,
      accepted: new Set(),
      resolutions: {},
      recursive: false,
      fixRefs: false,
      levels: false,
      defaultConflict: 'mine',
      showSkipped: false,
      result: undefined,
      mods: undefined,
    };
    sessions.set(project, s);
  }
  return s;
}

const KIND_MARK: Record<MergeKind, string> = { new: '+', changed: '~', deleted: '−' };

function reasonText(t: Strings, c: MergeChange): string {
  return c.conflict === 'both' ? t.mgReasonBoth : c.conflict === 'mine-deleted' ? t.mgReasonMineDeleted : c.conflict === 'source-deleted' ? t.mgReasonSourceDeleted : '';
}

/** Что получится, если слить выбранное сейчас (без записи в мод). */
function previewOf(plan: MergePlan, s: Session): { accepted: number; created: number; changed: number; deleted: number; byClosure: number; toSource: number; toMine: number } {
  const bySid = new Map(plan.changes.map((c) => [c.sid, c]));
  let sids = [...s.accepted].filter((x) => bySid.has(x));
  const base = new Set(sids);
  if (s.recursive) sids = mergeClosure(plan, sids);
  if (s.fixRefs) {
    const extra = mergeFixReferences(plan, sids);
    sids = plan.changes.filter((c) => sids.includes(c.sid) || extra.includes(c.sid)).map((c) => c.sid);
  }
  const p = { accepted: 0, created: 0, changed: 0, deleted: 0, byClosure: 0, toSource: 0, toMine: 0 };
  for (const sid of sids) {
    const c = bySid.get(sid)!;
    if (c.rejected || c.blocked) continue;
    p.accepted++;
    if (!base.has(sid)) p.byClosure++;
    p[c.kind === 'new' ? 'created' : c.kind === 'changed' ? 'changed' : 'deleted']++;
    const keys = c.fields.filter((f) => f.conflict).map((f) => f.key);
    if (c.conflict && c.conflict !== 'both') keys.push('record');
    for (const k of keys) {
      if ((s.resolutions[sid]?.[k] ?? s.defaultConflict) === 'source') p.toSource++;
      else p.toMine++;
    }
  }
  return p;
}

function ChangeDetail({ change, session, project, onPick, onOpen }: {
  change: MergeChange;
  session: Session;
  project: Project;
  onPick: (sid: string, key: string, choice: MergeChoice) => void;
  onOpen: (sid: string) => void;
}): ReactNode {
  const t = useT();
  const choiceOf = (key: string): MergeChoice => session.resolutions[change.sid]?.[key] ?? session.defaultConflict;
  const recordLevel = change.conflict === 'mine-deleted' || change.conflict === 'source-deleted';
  return (
    <div className="mg-detail" data-testid="merge-detail" data-sid={change.sid}>
      <div className="mg-detail-head">
        <code>{change.sid}</code>
        {project.entry(change.sid) && (
          <button className="link" onClick={() => { onOpen(change.sid); }}>
            {t.mgOpen}
          </button>
        )}
      </div>
      {change.conflict && <div className="mg-reason">{reasonText(t, change)}</div>}
      {change.blocked !== undefined && <div className="mg-reason">{t.mgBlocked(change.blocked)}</div>}
      {change.rejectedStale && <div className="mg-reason">{t.mgStale}</div>}
      {change.kind === 'new' && !recordLevel && <div className="muted">{t.mgRecordNew}</div>}
      {change.kind === 'deleted' && <div className="muted">{t.mgRecordDeleted}</div>}
      {change.links.length > 0 && <div className="muted">{t.mgLinks(change.links.length)}</div>}
      {change.dangling.length > 0 && <div className="mg-reason">{t.mgRowDangling(change.dangling.length)}</div>}
      {recordLevel && (
        <div className="mg-pick" data-testid="merge-record-pick">
          {(['mine', 'source'] as const).map((choice) => (
            <label key={choice}>
              <input
                type="radio"
                name={`mg-record-${change.sid}`}
                checked={choiceOf('record') === choice}
                onChange={() => { onPick(change.sid, 'record', choice); }}
                data-testid="merge-pick"
                data-sid={change.sid}
                data-field="record"
                data-choice={choice}
              />{' '}
              {choice === 'mine' ? t.mgKeepRecord : change.conflict === 'source-deleted' ? t.mgDeleteRecord : t.mgRestoreRecord}
            </label>
          ))}
        </div>
      )}
      {change.fields.length > 0 && (
        <table className="table mg-fields">
          <tbody>
            {change.fields.map((f) => (
              <tr key={f.key} className={f.conflict ? 'mg-field-conflict' : ''} data-testid="merge-field" data-field={f.key} data-conflict={f.conflict ? '1' : '0'}>
                <td className="mg-field-label" title={f.text}>
                  {f.label}
                  {f.conflict && <span className="mg-badge" title={t.mgFieldConflict}> ⚠</span>}
                </td>
                <td className="mg-before" title={t.mgWas}>
                  {f.before ?? '—'}
                </td>
                <td className="mg-arrow">→</td>
                <td className="mg-after" title={t.mgBecomes}>
                  {f.after ?? '—'}
                </td>
                <td className="mg-pick">
                  {f.conflict &&
                    (['mine', 'source'] as const).map((choice) => (
                      <label key={choice} title={choice === 'mine' ? (f.before ?? '—') : (f.after ?? '—')}>
                        <input
                          type="radio"
                          name={`mg-${change.sid}-${f.key}`}
                          checked={choiceOf(f.key) === choice}
                          onChange={() => { onPick(change.sid, f.key, choice); }}
                          data-testid="merge-pick"
                          data-sid={change.sid}
                          data-field={f.key}
                          data-choice={choice}
                        />{' '}
                        {choice === 'mine' ? t.mgMine : t.mgTheirs}
                      </label>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MergePanel(): ReactNode {
  const t = useT();
  const ru = useLang() === 'ru';
  const { project, go, report, status } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const session = sessionOf(project);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [type, setType] = useState('');
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<Record<MergeKind, boolean>>({ new: true, changed: true, deleted: true });
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [anchor, setAnchor] = useState<string | undefined>();
  const [focus, setFocus] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  // Установленные моды — для выпадающего списка источника.
  useEffect(() => {
    if (session.mods !== undefined) return;
    let alive = true;
    void window.kedit.listMods(project.bundle.game).then((mods) => {
      if (!alive) return;
      session.mods = mods;
      force();
    });
    return () => {
      alive = false;
    };
  }, [project, session]);

  const options = useMemo(() => ({ showRejected: session.showSkipped, ...(session.levelData ? { levelData: session.levelData } : {}) }), [session.showSkipped, session.levelData]);

  const { plan, planError } = useMemo((): { plan?: MergePlan; planError?: string } => {
    if (!session.source) return {};
    try {
      return { plan: planMerge(ctx, session.source, project.ledger, options) };
    } catch (e) {
      return { planError: e instanceof Error ? e.message : String(e) };
    }
    // version: список пересчитывается после каждой правки, отмены и сохранения.
  }, [ctx, project, session.source, options, version]);

  // Выбор, которого больше нет в списке (слили, отменили, отклонили), снимаем.
  useEffect(() => {
    if (!plan) return;
    const have = new Set(plan.changes.filter((c) => !c.rejected && !c.blocked).map((c) => c.sid));
    let dropped = false;
    for (const sid of [...session.accepted]) {
      if (!have.has(sid)) {
        session.accepted.delete(sid);
        dropped = true;
      }
    }
    if (dropped) force();
  }, [plan, session]);

  const loadSource = async (path: string | undefined): Promise<void> => {
    session.accepted.clear();
    session.resolutions = {};
    session.result = undefined;
    session.error = undefined;
    session.path = path;
    session.source = undefined;
    session.levelData = undefined;
    setNotice(undefined);
    setExpanded(new Set());
    setLimit(PAGE);
    if (path === undefined || path === '') {
      force();
      return;
    }
    const r = await window.kedit.readMergeSource(path);
    if (!r.ok) {
      session.error = `${t.mgBadFile} ${r.error}`;
      force();
      return;
    }
    try {
      checkMergeSource(ctx, r.name);
      const file = readDataFile(r.bytes);
      if (file.fileType !== FileType.Mod && file.fileType !== FileType.MergeMod) throw new MergeError(`«${r.name}»: ${t.mgBadFile}`);
      session.source = { name: r.name, file };
      session.levelData = r.levelData;
    } catch (e) {
      session.error = e instanceof Error ? e.message : String(e);
    }
    force();
  };

  const browse = (): void => {
    void window.kedit.chooseModFile(project.bundle.game).then((p) => {
      if (p !== null) void loadSource(p);
    });
  };

  const rows = useMemo(() => {
    if (!plan) return [];
    const q = query.trim().toLowerCase();
    return plan.changes.filter((c) => {
      if (!kinds[c.kind]) return false;
      if (type !== '' && c.typeName !== type) return false;
      if (onlyConflicts && !c.conflict) return false;
      if (q !== '' && !`${c.sid}\n${c.name}\n${c.ruName ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [plan, kinds, type, onlyConflicts, query]);

  const types = useMemo(() => [...new Set((plan?.changes ?? []).map((c) => c.typeName))].sort(), [plan]);
  const mergeable = (c: MergeChange): boolean => !c.rejected && c.blocked === undefined;

  const setState = (c: MergeChange, state: 'ignore' | 'accept' | 'reject', range = false): void => {
    if (!session.source || !plan) return;
    const targets = range && anchor !== undefined && state === 'accept' ? (() => {
      const a = rows.findIndex((r) => r.sid === anchor);
      const b = rows.findIndex((r) => r.sid === c.sid);
      return a >= 0 && b >= 0 ? rows.slice(Math.min(a, b), Math.max(a, b) + 1) : [c];
    })() : [c];
    if (state === 'reject') {
      for (const x of targets) session.accepted.delete(x.sid);
      rejectMerge(ctx, session.source, project.ledger, targets.map((x) => x.sid), options);
      project.bump();
    } else {
      const back = targets.filter((x) => x.rejected);
      if (back.length > 0) {
        unrejectMerge(project.ledger, session.source, back.map((x) => x.sid));
        project.bump();
      }
      for (const x of targets) {
        if (state === 'accept' && mergeable({ ...x, rejected: false })) session.accepted.add(x.sid);
        else session.accepted.delete(x.sid);
      }
    }
    setAnchor(c.sid);
    force();
  };

  const selectShown = (): void => {
    for (const c of rows) if (mergeable(c)) session.accepted.add(c.sid);
    force();
  };

  const rejectSelected = (): void => {
    if (!session.source || session.accepted.size === 0) return;
    rejectMerge(ctx, session.source, project.ledger, [...session.accepted], options);
    session.accepted.clear();
    project.bump();
    force();
  };

  const apply = (): void => {
    if (!session.source || session.accepted.size === 0) return;
    let result: MergeResult | undefined;
    const err = tryEdit(() => {
      result = applyMerge(
        ctx,
        session.source!,
        project.ledger,
        { accept: [...session.accepted], resolutions: session.resolutions, conflicts: session.defaultConflict, recursive: session.recursive, fixReferences: session.fixRefs, levelData: session.levels },
        options,
      );
    });
    report(err);
    if (err !== undefined || !result) return;
    session.result = result;
    session.accepted.clear();
    session.resolutions = {};
    if (result.accepted.length > 0) status({ text: (s) => s.mgStatusMerged(result!.accepted.length, session.source!.name), kind: 'info' });
    project.bump();
    force();
  };

  const nextConflict = (): void => {
    const list = rows.filter((c) => c.conflict && !c.rejected);
    if (list.length === 0) {
      setNotice(t.mgNoConflicts);
      return;
    }
    setNotice(undefined);
    const i = list.findIndex((c) => c.sid === focus);
    const next = list[(i + 1) % list.length]!;
    setFocus(next.sid);
    const idx = rows.findIndex((c) => c.sid === next.sid);
    if (idx >= limit) setLimit(Math.ceil((idx + 1) / PAGE) * PAGE);
    setExpanded((e) => new Set(e).add(next.sid));
    setTimeout(() => {
      document.querySelector(`[data-testid="merge-row"][data-sid="${CSS.escape(next.sid)}"]`)?.scrollIntoView({ block: 'center' });
    }, 0);
  };

  const pick = (sid: string, key: string, choice: MergeChoice): void => {
    session.resolutions[sid] = { ...session.resolutions[sid], [key]: choice };
    force();
  };

  const toggleKind = (k: MergeKind): void => {
    setKinds((x) => ({ ...x, [k]: !x[k] }));
  };

  const preview = plan ? previewOf(plan, session) : undefined;
  const lastMerge = session.source ? [...project.ledger.store(ctx).log].reverse().find((e) => e.source.toLowerCase() === session.source!.name.toLowerCase()) : undefined;
  const pickable = (session.mods ?? []).filter((m) => m.fileName.toLowerCase() !== ctx.modName.toLowerCase());
  const conflictCount = plan?.changes.filter((c) => c.conflict && !c.rejected).length ?? 0;

  return (
    <div className="mods-panel mg-panel" data-testid="merge-panel">
      <div className="mods-panel-bar">
        <label>
          {t.mgSource}{' '}
          <select value={session.path ?? ''} onChange={(e) => { void loadSource(e.target.value); }} data-testid="merge-source">
            <option value="">{t.mgPick}</option>
            {session.path !== undefined && !pickable.some((m) => m.path === session.path) && <option value={session.path}>{session.path}</option>}
            {pickable.map((m) => (
              <option key={m.path} value={m.path}>
                {m.fileName}
                {m.source === 'workshop' ? ' (workshop)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button onClick={browse} data-testid="merge-browse">
          {t.mgBrowse}
        </button>
        <button
          onClick={() => { void loadSource(session.path); }}
          disabled={session.path === undefined}
          title={t.mgRefreshTip}
          data-testid="merge-refresh"
        >
          {t.mgRefresh}
        </button>
        {plan && (
          <span className="muted" data-testid="merge-counts">
            {t.mgCounts(plan.counts)}
          </span>
        )}
      </div>

      {project.ledgerError !== undefined && <div className="mg-warn">{t.mgStoreBad(project.ledgerError)}</div>}
      {session.error !== undefined && (
        <div className="mg-warn" data-testid="merge-error">
          {session.error}
        </div>
      )}
      {planError !== undefined && <div className="mg-warn">{t.mgNoPlan} {planError}</div>}

      {!session.source && session.error === undefined && <div className="muted mods-panel-note">{t.mgIntro(ctx.modName)}</div>}

      {plan && session.source && (
        <>
          {plan.warnings.map((w) => (
            <div key={w} className="mg-warn">
              {w}
            </div>
          ))}
          {plan.missingDependencies.length > 0 && <div className="mg-warn">{t.mgMissingDeps(plan.missingDependencies.join(', '))}</div>}
          {plan.levelData && (
            <div className="mg-warn" data-testid="merge-level-found">
              {t.mgLevelFound(plan.levelData.files.length, plan.levelData.dir)}
            </div>
          )}
          {lastMerge && <div className="muted mods-panel-note">{t.mgLast(new Date(lastMerge.at).toLocaleString(ru ? 'ru-RU' : 'en-GB'), lastMerge.accepted)}</div>}

          <div className="mods-panel-bar">
            {(['new', 'changed', 'deleted'] as const).map((k) => (
              <label key={k} title={t.mgKindTip}>
                <input type="checkbox" checked={kinds[k]} onChange={() => { toggleKind(k); }} data-testid={`merge-kind-${k}`} />{' '}
                <span className={`mg-kind-${k}`}>{k === 'new' ? t.mgKindNew : k === 'changed' ? t.mgKindChanged : t.mgKindDeleted}</span>
              </label>
            ))}
            <select value={type} onChange={(e) => { setType(e.target.value); }} data-testid="merge-type" title={t.mgType}>
              <option value="">{t.mgTypeAll}</option>
              {types.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input type="search" placeholder={t.mgSearch} value={query} onChange={(e) => { setQuery(e.target.value); }} data-testid="merge-search" />
            <label>
              <input type="checkbox" checked={onlyConflicts} onChange={(e) => { setOnlyConflicts(e.target.checked); }} data-testid="merge-only-conflicts" /> {t.mgOnlyConflicts}
            </label>
            <button onClick={nextConflict} disabled={conflictCount === 0} data-testid="merge-next-conflict">
              {t.mgNextConflict}
              {conflictCount > 0 ? ` (${conflictCount})` : ''}
            </button>
            <label title={t.mgShowSkippedTip}>
              <input
                type="checkbox"
                checked={session.showSkipped}
                onChange={(e) => {
                  session.showSkipped = e.target.checked;
                  force();
                }}
                data-testid="merge-show-skipped"
              />{' '}
              {t.mgShowSkipped}
            </label>
            <span className="muted" data-testid="merge-shown">
              {t.mgShown(rows.length, plan.changes.length)}
            </span>
          </div>
          {notice !== undefined && <div className="muted mods-panel-note">{notice}</div>}

          {plan.changes.length === 0 ? (
            <Empty text={t.mgIdentical} />
          ) : (
            <div className="table-wrap">
              <table className="table mg-table" data-testid="merge-table">
                <thead>
                  <tr>
                    <th />
                    <th />
                    <th>{t.mgType}</th>
                    <th>{t.cmpName}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((c) => {
                    const state = c.rejected ? 'reject' : session.accepted.has(c.sid) ? 'accept' : 'ignore';
                    const open = expanded.has(c.sid);
                    return [
                      <tr
                        key={c.sid}
                        className={['mg-row', c.conflict ? 'mg-conflict' : '', state === 'accept' ? 'mg-accepted' : '', c.rejected ? 'mg-rejected' : '', focus === c.sid ? 'mg-focus' : ''].filter(Boolean).join(' ')}
                        data-testid="merge-row"
                        data-sid={c.sid}
                        data-kind={c.kind}
                        data-state={state}
                        data-conflict={c.conflict ? '1' : '0'}
                      >
                        <td className="mg-states">
                          {(['ignore', 'accept', 'reject'] as const).map((s) => (
                            <button
                              key={s}
                              className={`mg-state mg-state-${s}${state === s ? ' active' : ''}`}
                              title={s === 'ignore' ? t.mgIgnore : s === 'accept' ? t.mgAccept : t.mgReject}
                              disabled={s === 'accept' && c.blocked !== undefined}
                              onClick={(e) => { setState(c, s, e.shiftKey); }}
                              data-testid={`merge-${s}`}
                            >
                              {s === 'ignore' ? '○' : s === 'accept' ? '✓' : '✕'}
                            </button>
                          ))}
                        </td>
                        <td className={`mg-kind mg-kind-${c.kind}`}>{KIND_MARK[c.kind]}</td>
                        <td className="muted">{c.typeName}</td>
                        <td>
                          <button
                            className="link"
                            onClick={() => {
                              setExpanded((e) => {
                                const n = new Set(e);
                                if (n.has(c.sid)) n.delete(c.sid);
                                else n.add(c.sid);
                                return n;
                              });
                              setFocus(c.sid);
                            }}
                            title={c.sid}
                            data-testid="merge-expand"
                          >
                            {open ? '▾' : '▸'} {ru ? (c.ruName ?? c.name) : c.name}
                          </button>
                        </td>
                        <td className="muted">
                          {c.conflict && <span className="mg-badge" title={reasonText(t, c)}>⚠ {c.conflictCount > 0 ? c.conflictCount : ''}</span>}
                          {c.kind === 'changed' && <span> {c.fields.length}</span>}
                          {c.blocked !== undefined && <span title={c.blocked}> 🚫</span>}
                          {c.rejectedStale && <span title={t.mgStale}> ⟳</span>}
                        </td>
                      </tr>,
                      open && (
                        <tr key={`${c.sid}#d`} className="mg-detail-row">
                          <td colSpan={5}>
                            <ChangeDetail change={c} session={session} project={project} onPick={pick} onOpen={go} />
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
              {rows.length > limit && (
                <div className="muted">
                  {t.mgCap(limit)}{' '}
                  <button onClick={() => { setLimit((n) => n + PAGE); }} data-testid="merge-more">
                    {t.mgMore}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="mg-footer">
            <div className="mods-panel-bar">
              <button onClick={selectShown} data-testid="merge-select-shown">
                {t.mgSelectShown}
              </button>
              <button onClick={() => { session.accepted.clear(); force(); }} disabled={session.accepted.size === 0} data-testid="merge-clear">
                {t.mgClear}
              </button>
              <button onClick={rejectSelected} disabled={session.accepted.size === 0} data-testid="merge-reject-selected">
                {t.mgRejectSelected(session.accepted.size)}
              </button>
              <label title={t.mgRecursiveTip}>
                <input type="checkbox" checked={session.recursive} onChange={(e) => { session.recursive = e.target.checked; force(); }} data-testid="merge-recursive" /> {t.mgRecursive}
              </label>
              <label title={t.mgFixRefsTip}>
                <input type="checkbox" checked={session.fixRefs} onChange={(e) => { session.fixRefs = e.target.checked; force(); }} data-testid="merge-fix-refs" /> {t.mgFixRefs}
              </label>
              <label>
                {t.mgConflictsDefault}{' '}
                <select value={session.defaultConflict} onChange={(e) => { session.defaultConflict = e.target.value as MergeChoice; force(); }} data-testid="merge-default-conflict">
                  <option value="mine">{t.mgConflictsMine}</option>
                  <option value="source">{t.mgConflictsSource}</option>
                </select>
              </label>
              {plan.levelData && (
                <label title={t.mgLevelDataTip}>
                  <input type="checkbox" checked={session.levels} onChange={(e) => { session.levels = e.target.checked; force(); }} data-testid="merge-levels" /> {t.mgLevelData}
                </label>
              )}
              <button className="primary" onClick={apply} disabled={session.accepted.size === 0} data-testid="merge-apply">
                {t.mgApply(session.accepted.size)}
              </button>
            </div>
            <div className="muted" data-testid="merge-preview">
              {preview && preview.accepted > 0 ? t.mgPreview(preview) : t.mgNothing}
            </div>
            {session.result && (
              <div className="mg-result" data-testid="merge-result">
                <div>
                  {t.mgDone({
                    accepted: session.result.accepted.length,
                    created: session.result.created,
                    changed: session.result.changed,
                    deleted: session.result.deleted,
                    tookSource: session.result.tookSource,
                    keptMine: session.result.keptMine,
                    addedByClosure: session.result.addedByClosure.length,
                    skipped: session.result.skipped.length,
                  })}
                </div>
                {session.result.accepted.length > 0 && <div className="muted">{t.mgUndoHint}</div>}
                {session.result.skipped.length > 0 && (
                  <div className="muted">
                    {t.mgSkippedTitle}: {session.result.skipped.map((s) => `${s.sid} — ${s.reason}`).join('; ')}
                  </div>
                )}
                {session.result.dangling.length > 0 && <div className="mg-warn">{t.mgDangling(session.result.dangling.length)}</div>}
                {session.levels && session.result.notes.length > 0 && <div className="mg-warn" data-testid="merge-level-note">{t.mgLevelNote}</div>}
              </div>
            )}
            <div className="muted mods-panel-note">{t.mgFilesNote}</div>
          </div>
        </>
      )}
    </div>
  );
}

registerPanel({
  id: 'merge',
  title: (t) => t.panel_merge,
  icon: '⇄',
  component: MergePanel,
  area: 'center',
  order: 52,
  hint: (t) => t.mergeHint,
});
