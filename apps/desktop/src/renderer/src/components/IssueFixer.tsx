/**
 * «Diagnostics» panel body: mod check problems grouped by kind, with fixes from core
 * (`issueFixes` / `planFixes`), multi-select, per-mod ignore list and a rescan button.
 * Every fix (one or a batch) is one history step. Kinds are shown by name; the code is a hint.
 */

/** Window event: the toolbar «Diagnostics» button asks the panel to check the mod again. */
export const RESCAN_EVENT = 'kedit:diagnostics-rescan';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyFixPlan, applyOps, FIX_KIND_LABELS, formatIssueText, ISSUE_CODE_LABELS, issueFixes, issueKey, issueSeverityText, planFixes, uiText, validateMod, type IssueCode, type IssueFix, type ValidationIssue } from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import { tryEdit, useProjectVersion } from '../hooks.ts';
import type { Project } from '../project.ts';

interface Row {
  issue: ValidationIssue;
  key: string;
  /** Unique within the list (two equal issues can exist). */
  id: string;
  fixes: IssueFix[];
  ignored: boolean;
}

export function IssueFixer({ project, onGo, onReport }: { project: Project; onGo: (sid: string) => void; onReport: (err: string | undefined) => void }): ReactNode {
  const t = useT();
  const lang = useLang();
  const version = useProjectVersion(project);
  const [scan, setScan] = useState(0);
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(new Set());
  const [showIgnored, setShowIgnored] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState<string | undefined>();
  const ref = project.ref;
  const refKey = `${ref.path ?? ''}|${ref.modName}`;

  useEffect(() => {
    let live = true;
    void window.kedit
      .readIgnoreList(ref)
      .then((keys) => {
        if (live) setIgnored(new Set(keys));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [refKey]);

  useEffect(() => {
    const onRescan = (): void => {
      setScan((n) => n + 1);
    };
    window.addEventListener(RESCAN_EVENT, onRescan);
    return () => {
      window.removeEventListener(RESCAN_EVENT, onRescan);
    };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const seen = new Map<string, number>();
    return validateMod(project.ctx).map((issue) => {
      const key = issueKey(issue);
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return { issue, key, id: n ? `${key}#${n}` : key, fixes: issueFixes(project.ctx, issue), ignored: ignored.has(key) };
    });
  }, [project, version, scan, ignored]);

  const shown = rows.filter((r) => showIgnored || !r.ignored);
  const hidden = rows.length - rows.filter((r) => !r.ignored).length;
  const errors = rows.filter((r) => !r.ignored && r.issue.severity === 'error').length;
  const warnings = rows.filter((r) => !r.ignored).length - errors;
  const groups = useMemo(() => {
    const m = new Map<IssueCode, Row[]>();
    for (const r of shown) {
      const list = m.get(r.issue.code);
      if (list) list.push(r);
      else m.set(r.issue.code, [r]);
    }
    return [...m.entries()];
  }, [rows, showIgnored]);
  const chosen = shown.filter((r) => selected.has(r.id));

  const saveIgnored = (next: Set<string>): void => {
    setIgnored(next);
    void window.kedit.writeIgnoreList(ref, [...next]).catch(() => undefined);
  };
  const setIgnoredFor = (list: readonly Row[], on: boolean): void => {
    const next = new Set(ignored);
    for (const r of list) {
      if (on) next.add(r.key);
      else next.delete(r.key);
    }
    saveIgnored(next);
    setSelected(new Set());
  };
  const toggle = (ids: readonly string[], on: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };
  const fixMany = (list: readonly Row[]): void => {
    const plan = planFixes(project.ctx, list.map((r) => r.issue));
    if (!plan.ops.length) {
      setNote(t.fixDone(0, plan.skipped.length));
      return;
    }
    const err = tryEdit(() => {
      applyFixPlan(project.ctx, plan);
    });
    onReport(err);
    if (!err) {
      setNote(t.fixDone(plan.fixed.length, plan.skipped.length));
      setSelected(new Set());
    }
  };
  const fixOne = (fix: IssueFix): void => {
    const err = tryEdit(() => {
      applyOps(project.ctx, fix.ops, 'исправление: 1');
    });
    onReport(err);
    if (!err) setNote(t.fixDone(1, 0));
  };

  return (
    <div className="issue-fixer" data-testid="issue-fixer">
      <div className="mods-panel-bar">
        <button onClick={() => { setScan((n) => n + 1); setNote(undefined); }} title={t.fixRescanTip} data-testid="fix-rescan">
          ↻ {t.fixRescan}
        </button>
        <button className="primary" disabled={chosen.length === 0} onClick={() => { fixMany(chosen); }} title={t.fixSelectedTip} data-testid="fix-selected">
          {t.fixSelected(chosen.length)}
        </button>
        <button disabled={chosen.length === 0} onClick={() => { setIgnoredFor(chosen, true); }} data-testid="fix-ignore-selected">
          {t.fixIgnoreSelected}
        </button>
        <label>
          <input type="checkbox" checked={showIgnored} onChange={(e) => { setShowIgnored(e.target.checked); }} data-testid="fix-show-ignored" /> {t.fixShowIgnored}
          {hidden > 0 && <span className="muted">{` (${t.fixIgnoredCount(hidden)})`}</span>}
        </label>
        <span className="grow" />
        {rows.length > 0 && <span className="muted" data-testid="fix-counts">{`${errors} ${t.errors}, ${warnings} ${t.warnings}`}</span>}
      </div>
      {note !== undefined && <div className="small muted" data-testid="fix-note">{note}</div>}
      {shown.length === 0 ? (
        <p className="panel-empty muted" data-testid="validation-ok">✓ {t.diagnosticsOk}</p>
      ) : (
        groups.map(([code, list]) => {
          const fixable = list.filter((r) => !r.ignored && r.fixes.length > 0);
          const allOn = list.every((r) => selected.has(r.id));
          return (
            <div key={code} className="issue-group" data-testid="fix-group" data-code={code}>
              <div className="issue-group-head">
                <label>
                  <input type="checkbox" checked={allOn} onChange={(e) => { toggle(list.map((r) => r.id), e.target.checked); }} data-testid="fix-group-check" />{' '}
                  <b title={code}>{uiText(ISSUE_CODE_LABELS[code], lang)}</b> <span className="muted">({list.length})</span>{' '}
                  <span className="muted small" data-testid="fix-group-code">{code}</span>
                </label>
                {fixable.length > 0 && (
                  <button className="small" onClick={() => { fixMany(fixable); }} title={t.fixAllOfKindTip} data-testid="fix-all-kind">
                    {t.fixAllOfKind(fixable.length)}
                  </button>
                )}
              </div>
              <ul className="issues fixable">
                {list.map((r) => (
                  <li key={r.id} className={`${r.issue.severity}${r.ignored ? ' ignored' : ''}`} data-testid="fix-issue" data-key={r.key}>
                    <input type="checkbox" checked={selected.has(r.id)} onChange={(e) => { toggle([r.id], e.target.checked); }} data-testid="fix-check" />
                    <button className="link" title={r.issue.code} onClick={() => { onGo(r.issue.stringId); }}>
                      {`${issueSeverityText(r.issue, lang)} ${formatIssueText(project.ctx, r.issue, lang)}`}
                    </button>
                    {r.ignored && <span className="muted small">{` [${t.fixIgnoredMark}]`}</span>}
                    <span className="issue-actions">
                      {r.fixes.length === 0 && <span className="muted small">{t.fixNoFix}</span>}
                      {r.fixes.map((f, n) => (
                        <button
                          key={f.kind}
                          className={`small${n === 0 ? ' primary' : ''}`}
                          title={uiText(f.texts, lang)}
                          onClick={() => { fixOne(f); }}
                          data-testid={`fix-${f.kind}`}
                        >
                          {uiText(FIX_KIND_LABELS[f.kind], lang)}
                        </button>
                      ))}
                      <button className="small" title={r.ignored ? undefined : t.fixIgnoreTip} onClick={() => { setIgnoredFor([r], !r.ignored); }} data-testid="fix-ignore">
                        {r.ignored ? t.fixUnignore : t.fixIgnore}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
      <div className="small muted">{t.fixNote}</div>
    </div>
  );
}
