/**
 * «Mod cleanup»: what `scanCleanup` proposes to remove from the mod, grouped by rule, with
 * checkboxes per group and per item. Nothing changes until «Remove selected»; that is one history step.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { applyCleanup, CLEANUP_GROUP_LABELS, CLEANUP_GROUP_RULES, CLEANUP_GROUPS, scanCleanup, uiText, type CleanupItem } from '@kenshi-editor/core';
import { useLang, useT } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';

/** Items rendered per group before «show more» (big vanilla-sized mods have thousands). */
const GROUP_PAGE = 200;

function CleanupPanel(): ReactNode {
  const { project, go, report } = useWorkbench();
  const t = useT();
  const lang = useLang();
  const version = useProjectVersion(project);
  const [scanNo, setScanNo] = useState(0);
  // Unticked items (everything is ticked by default): survives rescans by item id.
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [more, setMore] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState<string | undefined>();
  const scan = useMemo(() => scanCleanup(project.ctx), [project, version, scanNo]);
  const chosen = scan.items.filter((i) => !off.has(i.id));

  const setOffFor = (items: readonly CleanupItem[], unticked: boolean): void => {
    setOff((prev) => {
      const next = new Set(prev);
      for (const i of items) {
        if (unticked) next.add(i.id);
        else next.delete(i.id);
      }
      return next;
    });
  };
  const flip = (set: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };
  const apply = (): void => {
    if (!chosen.length) return;
    const n = chosen.length;
    const err = tryEdit(() => {
      applyCleanup(project.ctx, chosen);
    });
    report(err);
    if (!err) setNote(t.cleanupDone(n));
  };

  return (
    <div className="mods-panel panel-scroll" data-testid="cleanup-panel">
      <div className="mods-panel-bar">
        <button onClick={() => { setScanNo((n) => n + 1); setNote(undefined); }} data-testid="cleanup-rescan">
          ↻ {t.cleanupRescan}
        </button>
        <button className="primary" disabled={chosen.length === 0} onClick={apply} data-testid="cleanup-apply">
          {t.cleanupApply(chosen.length)}
        </button>
        <span className="grow" />
        <span className="muted small">{t.cleanupHint}</span>
      </div>
      {note !== undefined && <div className="small muted" data-testid="cleanup-note">{note}</div>}
      {scan.items.length === 0 ? (
        <p className="panel-empty muted" data-testid="cleanup-empty">✓ {t.cleanupNothing}</p>
      ) : (
        CLEANUP_GROUPS.map((g) => {
          const items = scan.items.filter((i) => i.group === g);
          if (!items.length) return null;
          const on = items.filter((i) => !off.has(i.id)).length;
          const expanded = open.has(g);
          const limit = more.has(g) ? Infinity : GROUP_PAGE;
          return (
            <div key={g} className="issue-group" data-testid="cleanup-group" data-group={g}>
              <div className="issue-group-head">
                <label>
                  <input
                    type="checkbox"
                    checked={on === items.length}
                    ref={(el) => { if (el) el.indeterminate = on > 0 && on < items.length; }}
                    onChange={(e) => { setOffFor(items, !e.target.checked); }}
                    data-testid="cleanup-group-check"
                  />{' '}
                  <b>{uiText(CLEANUP_GROUP_LABELS[g], lang)}</b> <span className="muted" data-testid="cleanup-group-count">{`${on} / ${items.length}`}</span>
                </label>
                <button className="small link" onClick={() => { setOpen(flip(open, g)); }} data-testid="cleanup-expand">
                  {expanded ? '▾' : '▸'} {t.cleanupShowItems}
                </button>
              </div>
              <div className="small muted">{`${t.cleanupRule}: ${uiText(CLEANUP_GROUP_RULES[g], lang)}`}</div>
              {expanded && (
                <ul className="issues fixable">
                  {items.slice(0, limit).map((i) => {
                    const name = project.ctx.name(i.stringId);
                    return (
                      <li key={i.id} data-testid="cleanup-item" data-sid={i.stringId}>
                        <input type="checkbox" checked={!off.has(i.id)} onChange={(e) => { setOffFor([i], !e.target.checked); }} data-testid="cleanup-check" />
                        <button className="link" onClick={() => { go(i.stringId); }}>
                          {`${i.stringId}${name !== undefined ? ` «${name}»` : ''}: ${uiText(i.texts, lang)}`}
                        </button>
                      </li>
                    );
                  })}
                  {items.length > limit && (
                    <li>
                      <button className="link" onClick={() => { setMore(flip(more, g)); }}>{`… +${items.length - limit}`}</button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })
      )}
      <div className="small muted">{t.cleanupNote}</div>
    </div>
  );
}

registerPanel({
  id: 'cleanup',
  group: 'mod',
  title: (t) => t.panel_cleanup,
  icon: '✧',
  component: CleanupPanel,
  area: 'center',
  order: 82,
  hint: (t) => t.cleanupHint,
});
