/**
 * «Package» panel (left column of the «Dialogues» layout): a dialogue package as a list of events,
 * the way the FCS package window is built around its event list. On top the package and who has it
 * (characters, squads, factions, the field) and what it inherits; then a search over events and
 * dialogues, the «Busy | All | + inherited» switch and the events by group, each with its dialogues.
 * A click on a dialogue selects it, so the graph shows it.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ModContext } from '@kenshi-editor/core';
import {
  EVENT_GROUP_LABELS,
  EVENT_UNUSED_LABEL,
  dialogueUnlockers,
  dialogueUnlocks,
  eventHelp,
  filterPackageEvents,
  heldPackage,
  packageOverview,
  uiText,
  type PackageEventGroup,
  type PackageEventMode,
  type PackageEventRow,
  type PackageOverview,
  type WhenHolder,
} from '@kenshi-editor/core';
import { useLang, useT, type Strings } from '../../i18n.ts';
import { recordName } from '../../data-names.ts';
import { eventEnum, eventTip } from '../../components/EventUi.tsx';
import { RecordPicker } from '../../components/RecordPicker.tsx';
import type { Project } from '../../project.ts';
import { registerPanel, type PanelProps } from '../registry.ts';
import { useFollowed, useWorkbench } from '../context.ts';
import { useSelectionVersion } from '../selection.ts';

/** The last package shown, so the panel opens on it again. */
const LAST_KEY = 'kedit.packagePanel.last';
const MODE_KEY = 'kedit.packagePanel.mode';
/** Holders listed by name before «and N more». */
const SHOWN_HOLDERS = 2;

function readMode(): PackageEventMode {
  const m = localStorage.getItem(MODE_KEY);
  return m === 'all' || m === 'inherited' ? m : 'busy';
}

function groupLabel(g: PackageEventGroup, lang: string, t: Strings): string {
  if (g === 'unused') return uiText(EVENT_UNUSED_LABEL, lang);
  if (g === 'other') return t.evOther;
  return uiText(EVENT_GROUP_LABELS[g], lang);
}

function PackagePanel({ def, params }: PanelProps): ReactNode {
  const { project, selection } = useWorkbench();
  const t = useT();
  const { sid: followed, version } = useFollowed(def, params);
  useSelectionVersion(selection);
  // A package chosen in the panel itself: it wins until the selection brings another record.
  const [pick, setPick] = useState<{ sid: string; over: string | undefined } | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const fromSelection = followed !== undefined ? heldPackage(project.ctx, followed) : undefined;
  const last = localStorage.getItem(LAST_KEY) ?? undefined;
  const pkg =
    pick && pick.over === followed && project.record(pick.sid)
      ? pick.sid
      : (fromSelection ?? (last !== undefined && project.record(last) ? last : undefined));
  useEffect(() => {
    if (pkg !== undefined) localStorage.setItem(LAST_KEY, pkg);
  }, [pkg]);
  const choose = (sid: string): void => {
    setPick({ sid, over: followed });
  };
  return (
    <div className="panel-scroll pk-panel" data-testid="package-panel" data-sid={pkg ?? ''}>
      <div className="pk-head">
        <div className="pk-who muted small">{t.pkWho}</div>
        <button className="pk-pick" data-testid="pk-pick" title={t.pkPickTip} onClick={() => { setPicking(true); }}>
          <span className="pk-pick-name">{pkg !== undefined ? recordName(project.ctx, pkg) : t.pkPick}</span>
          <span className="pk-caret">▼</span>
        </button>
      </div>
      {pkg === undefined ? (
        <div className="panel-empty muted">{t.pkNone}</div>
      ) : (
        <PackageBody key={pkg} project={project} pkg={pkg} version={version} onChoose={choose} />
      )}
      {picking && (
        <RecordPicker
          project={project}
          title={t.pkPickTitle}
          targetType="DIALOGUE_PACKAGE"
          exclude={new Set()}
          onPick={(sid) => {
            choose(sid);
            setPicking(false);
          }}
          onClose={() => { setPicking(false); }}
        />
      )}
    </div>
  );
}

function PackageBody({ project, pkg, version, onChoose }: { project: Project; pkg: string; version: number; onChoose: (sid: string) => void }): ReactNode {
  const { selection, go } = useWorkbench();
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const overview = useMemo(() => packageOverview(ctx, pkg), [ctx, pkg, version]);
  const evDef = useMemo(() => eventEnum(ctx), [ctx]);
  const [mode, setModeState] = useState<PackageEventMode>(readMode);
  const setMode = (m: PackageEventMode): void => {
    localStorage.setItem(MODE_KEY, m);
    setModeState(m);
  };
  const [query, setQuery] = useState('');
  const name = (sid: string): string => recordName(ctx, sid);
  const rows = useMemo(() => filterPackageEvents(evDef, overview, mode, query, lang, name), [evDef, overview, mode, query, lang]);
  // The dialogue the graph shows (the latest selected DIALOGUE, or the dialogue of the latest line).
  const shown = selection.latest((s) => (s.kind === 'record' && ctx.typeName(project.record(s.sid)?.type ?? -1) === 'DIALOGUE') || (s.kind === 'line' && s.dialog !== undefined));
  const current = shown?.kind === 'record' ? shown.sid : shown?.kind === 'line' ? shown.dialog : undefined;
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(overview.events.filter((e) => current !== undefined && e.own.includes(current)).map((e) => e.event)));
  const toggle = (ev: number): void => {
    const next = new Set(open);
    if (next.has(ev)) next.delete(ev);
    else next.add(ev);
    setOpen(next);
  };
  const searching = query.trim() !== '';
  const all = overview.events.length;
  return (
    <>
      <Holders project={project} overview={overview} />
      <Inherits project={project} overview={overview} onChoose={onChoose} />
      <div className="pk-stats small muted" data-testid="pk-stats">
        {t.pkOwnDialogs(overview.ownDialogs)}
        {overview.inheritedDialogs > 0 && ` · ${t.pkInheritedDialogs(overview.inheritedDialogs)}`}
      </div>
      <input
        className="pk-search"
        data-testid="pk-search"
        placeholder={t.pkSearch}
        title={t.pkSearchTip}
        value={query}
        onChange={(e) => { setQuery(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
      />
      <div className="pk-seg" role="radiogroup" data-testid="pk-mode">
        <button className={mode === 'busy' ? 'active' : ''} data-testid="pk-mode-busy" title={t.pkBusyTip} onClick={() => { setMode('busy'); }}>
          {t.pkBusy(overview.ownEvents)}
        </button>
        <button className={mode === 'all' ? 'active' : ''} data-testid="pk-mode-all" title={t.pkAllTip} onClick={() => { setMode('all'); }}>
          {t.pkAll(all)}
        </button>
        <button
          className={mode === 'inherited' ? 'active' : ''}
          data-testid="pk-mode-inherited"
          title={t.pkInheritedTip(overview.withInheritedEvents, overview.inheritedDialogs)}
          onClick={() => { setMode('inherited'); }}
        >
          {t.pkInherited}
        </button>
      </div>
      <div className="pk-list" data-testid="pk-list">
        {rows.length === 0 && <div className="muted small pk-empty">{searching ? t.pkNothing : t.pkNoBusy}</div>}
        {rows.map((row, i) => (
          <EventRow
            key={row.event.event}
            project={project}
            row={row}
            groupHead={i === 0 || rows[i - 1]!.event.group !== row.event.group ? groupLabel(row.event.group, lang, t) : undefined}
            open={searching || open.has(row.event.event)}
            current={current}
            onToggle={() => { toggle(row.event.event); }}
            onDialog={go}
          />
        ))}
      </div>
      <div className="pk-foot">
        <button className="small" disabled title={t.pkAddSoon} data-testid="pk-new-dialog">
          {t.pkNewDialog}
        </button>
      </div>
    </>
  );
}

interface EventRowProps {
  project: Project;
  row: PackageEventRow;
  groupHead: string | undefined;
  open: boolean;
  current: string | undefined;
  onToggle: () => void;
  onDialog: (sid: string) => void;
}

function EventRow({ project, row, groupHead, open, current, onToggle, onDialog }: EventRowProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const evDef = eventEnum(ctx);
  const ev = row.event;
  const help = ev.name !== undefined ? eventHelp(ev.name) : undefined;
  const label = help ? uiText(help.label, lang) : undefined;
  const count = row.own.length + row.inherited.length;
  const total = ev.own.length;
  return (
    <>
      {groupHead !== undefined && <div className="pk-grp">{groupHead}</div>}
      <div
        className={`pk-ev${total === 0 && row.inherited.length === 0 ? ' empty' : ''}${open ? ' open' : ''}`}
        data-testid="pk-event"
        data-event={ev.event}
        title={eventTip(evDef, ev.event, lang, t.pwTarget, t.pwNoTarget)}
        onClick={onToggle}
      >
        <span className="pk-tw">{count > 0 ? (open ? '▾' : '▸') : ''}</span>
        <span className="pk-ev-name">
          {label ?? t.pkUnknownEvent(ev.event)}
          <span className="pk-code">
            {ev.name ?? ''} ({ev.event})
          </span>
        </span>
        <span className="pk-n" data-testid="pk-event-count" title={t.pkCountTip(ev.own.length, ev.inherited.length)}>
          {total > 0 ? total : ''}
          {row.inherited.length > 0 && <span className="muted">+{row.inherited.length}</span>}
        </span>
        <button
          className="pk-plus"
          data-testid="pk-add"
          disabled
          title={t.pkAddSoon}
          onClick={(e) => { e.stopPropagation(); }}
        >
          +
        </button>
      </div>
      {open &&
        row.own.map((d) => (
          <DialogRow key={`o:${d}`} ctx={ctx} name={recordName(ctx, d)} sid={d} sel={d === current} onOpen={onDialog} />
        ))}
      {open &&
        row.inherited.map((d) => (
          <DialogRow key={`i:${d.dialog}`} ctx={ctx} name={recordName(ctx, d.dialog)} sid={d.dialog} sel={d.dialog === current} from={recordName(ctx, d.pkg)} onOpen={onDialog} />
        ))}
    </>
  );
}

/** Dialogue names for a «← unlocked by» / «→ unlocks» note: clickable, the full list in the tooltip. */
const SHOWN_LINKS = 2;

function LinkNames({ ctx, sids, onOpen }: { ctx: ModContext; sids: readonly string[]; onOpen: (sid: string) => void }): ReactNode {
  const t = useT();
  const shown = sids.slice(0, SHOWN_LINKS);
  return (
    <>
      {shown.map((d, i) => (
        <span key={d}>
          {i > 0 ? ', ' : ' '}
          <button
            className="link pk-link-name"
            data-testid="pk-link"
            data-sid={d}
            title={`${t.pkOpenGraph}\n${d}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(d);
            }}
          >
            «{recordName(ctx, d)}»
          </button>
        </span>
      ))}
      {sids.length > shown.length && ` ${t.pkMore(sids.length - shown.length)}`}
    </>
  );
}

function DialogRow({ ctx, name, sid, sel, from, onOpen }: { ctx: ModContext; name: string; sid: string; sel: boolean; from?: string; onOpen: (sid: string) => void }): ReactNode {
  const t = useT();
  const locked = ctx.get(sid)?.bools.get('locked') === true;
  // Transitions between dialogues (G3): who unlocks a locked dialogue, what this one unlocks.
  const unlockers = locked ? dialogueUnlockers(ctx, sid) : [];
  const unlocks = dialogueUnlocks(ctx, sid);
  const names = (list: readonly string[]): string => list.map((d) => `«${recordName(ctx, d)}» ${d}`).join('\n');
  return (
    <div
      className={`pk-dl${sel ? ' sel' : ''}${from !== undefined ? ' inherited' : ''}${locked ? ' locked' : ''}`}
      data-testid="pk-dialog"
      data-sid={sid}
      title={`${t.pkOpenGraph}\n${sid}`}
      onClick={() => { onOpen(sid); }}
    >
      <span className="pk-dl-name">
        {locked && (
          <span className="pk-lock" data-testid="pk-locked" title={t.pkLockedTip}>
            🔒{' '}
          </span>
        )}
        {name}
      </span>
      {from !== undefined && <span className="pk-from muted small">{t.pkFrom(from)}</span>}
      {locked && unlockers.length > 0 && (
        <span className="pk-unlocked-by" data-testid="pk-unlocked-by" title={t.pkUnlockedByTip(names(unlockers))}>
          {t.pkUnlockedBy}
          <LinkNames ctx={ctx} sids={unlockers} onOpen={onOpen} />
        </span>
      )}
      {locked && unlockers.length === 0 && (
        <span className="pk-unlocked-by none" data-testid="pk-nobody-unlocks" title={t.pkNobodyUnlocksTip}>
          {t.pkNobodyUnlocks}
        </span>
      )}
      {unlocks.length > 0 && (
        <span className="pk-unlocks" data-testid="pk-unlocks" title={t.pkUnlocksTip(names(unlocks))}>
          {t.pkUnlocks}
          <LinkNames ctx={ctx} sids={unlocks} onOpen={onOpen} />
        </span>
      )}
    </div>
  );
}

function Holders({ project, overview }: { project: Project; overview: PackageOverview }): ReactNode {
  const { go } = useWorkbench();
  const t = useT();
  const [more, setMore] = useState<ReadonlySet<string>>(new Set());
  const direct = overview.holders.filter((h) => h.through === undefined);
  const through = overview.holders.length - direct.length;
  const groups = new Map<string, WhenHolder[]>();
  for (const h of direct) {
    const k = `${h.type}\n${h.field}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  if (!overview.holders.length)
    return (
      <div className="pk-holders warn small" data-testid="pk-holders" title={t.pwNobodyTip}>
        {t.pwNobody}
      </div>
    );
  const typeWord = (type: string): string => (t as unknown as Record<string, string | undefined>)[`pkType${type}`] ?? type;
  return (
    <div className="pk-holders small" data-testid="pk-holders">
      {[...groups].map(([k, list]) => {
        const all = more.has(k);
        const shown = all ? list : list.slice(0, SHOWN_HOLDERS);
        return (
          <div key={k} className="pk-holder-group">
            <span className="muted">{typeWord(list[0]!.type)}:</span>{' '}
            {shown.map((h, i) => (
              <span key={h.sid}>
                {i > 0 && ', '}
                <button className="link" data-testid="pk-holder" data-sid={h.sid} onClick={() => { go(h.sid); }}>
                  {recordName(project.ctx, h.sid)}
                </button>
              </span>
            ))}
            {list.length > SHOWN_HOLDERS && (
              <>
                {' '}
                <button className="link muted" data-testid="pk-holders-more" onClick={() => {
                  const next = new Set(more);
                  if (all) next.delete(k);
                  else next.add(k);
                  setMore(next);
                }}>
                  {all ? t.pkLess : t.pkMore(list.length - SHOWN_HOLDERS)}
                </button>
              </>
            )}
            <span className="muted">
              {' · '}
              {t.pkField} <code className="pk-code">{list[0]!.field}</code>
            </span>
          </div>
        );
      })}
      {through > 0 && (
        <div className="muted" title={t.pkThroughTip}>
          {t.pkThrough(through)}
        </div>
      )}
    </div>
  );
}

/** «inherits 5 packages ▸ (npc basic human, …)»: a click on a name shows that package. */
function Inherits({ project, overview, onChoose }: { project: Project; overview: PackageOverview; onChoose: (sid: string) => void }): ReactNode {
  const t = useT();
  const n = overview.inherits.length;
  if (n === 0) return <div className="pk-inherits small muted" data-testid="pk-inherits">{t.pkInheritsNone}</div>;
  return (
    <details className="pk-inherits small" data-testid="pk-inherits">
      <summary title={t.pkInheritsTip}>
        {t.pkInherits(n)} <span className="muted">({overview.inherits.slice(0, 1).map((s) => recordName(project.ctx, s)).join(', ')}{n > 1 ? ', …' : ''})</span>
      </summary>
      <ul>
        {overview.inherits.map((s) => (
          <li key={s}>
            <button className="link" data-testid="pk-inherit" data-sid={s} onClick={() => { onChoose(s); }}>
              {recordName(project.ctx, s)}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

registerPanel({
  id: 'package', group: 'dialogue',
  title: (t) => t.panel_package,
  hint: (t) => t.panel_package_hint,
  icon: '☰',
  component: PackagePanel,
  area: 'left',
  // A character, squad or faction stands for the package it holds.
  shows: { kinds: ['record'], types: ['DIALOGUE_PACKAGE', 'CHARACTER', 'SQUAD_TEMPLATE', 'FACTION'] },
  order: 38,
});
