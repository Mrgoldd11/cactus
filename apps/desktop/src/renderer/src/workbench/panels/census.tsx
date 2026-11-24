/**
 * «NPC census» panel: all characters, grouped by faction or by town (group weight —
 * how many towns its characters live in), filter unique / templates / no dialogue package /
 * no click dialogue / already in the mod. Jumps: to the record, to the conversation player, to «Where in game».
 * Edit: give a dialogue package to the selected characters — one undo. Counting runs in the background after
 * the panel opens.
 */
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { addDialoguePackage, censusNoPackage, npcCensus, type Census, type CensusChar } from '@kenshi-editor/core';
import { useDataLocale, useT } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Table rows at a time. */
const MAX_ROWS = 500;

type GroupBy = 'faction' | 'town';
type Filter = 'all' | 'unique' | 'template' | 'nopkg' | 'notalk' | 'inmod';

const FILTERS: Record<Filter, (c: CensusChar) => boolean> = {
  all: () => true,
  unique: (c) => c.unique,
  template: (c) => !c.unique,
  nopkg: censusNoPackage,
  notalk: (c) => c.talks === 0,
  inmod: (c) => c.status !== undefined,
};

function CensusPanel(): ReactNode {
  const t = useT();
  const dataLocale = useDataLocale();
  const { project, go, open, report } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;

  // Counting after the panel's first render (and after every edit) — the panel opens at once.
  const [census, setCensus] = useState<{ version: number; data: Census } | undefined>();
  useEffect(() => {
    const timer = setTimeout(() => {
      setCensus({ version, data: npcCensus(ctx, { index: project.idsByType() }) });
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [ctx, project, version]);

  const [groupBy, setGroupBy] = useState<GroupBy>('faction');
  const [group, setGroup] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search).trim().toLowerCase();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [pkg, setPkg] = useState('');

  const label = (sid: string, en?: string): string => (ctx.localizedName(sid) ?? en ?? ctx.name(sid) ?? sid);
  const data = census?.data;
  const byId = useMemo(() => new Map((data?.chars ?? []).map((c) => [c.sid, c])), [data]);
  const groups = data ? (groupBy === 'faction' ? data.byFaction : data.byTown) : [];
  const activeGroup = group !== undefined ? groups.find((g) => g.key === group) : undefined;

  const rows = useMemo(() => {
    if (!data) return [];
    const base = activeGroup ? activeGroup.chars.map((sid) => byId.get(sid)!) : data.chars;
    const f = FILTERS[filter];
    return base
      .filter((c) => f(c) && (query === '' || `${c.name}\n${c.localized ?? ''}\n${c.sid}`.toLowerCase().includes(query)))
      .sort((a, b) => b.towns.length - a.towns.length || a.name.localeCompare(b.name));
  }, [data, activeGroup, byId, filter, query]);

  const packages = useMemo(
    () =>
      (project.idsByType().get('DIALOGUE_PACKAGE') ?? [])
        .map((sid) => ({ sid, label: label(sid) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [project, version, dataLocale],
  );
  const selected = [...picked].filter((sid) => byId.has(sid));

  const give = (): void => {
    let n = 0;
    report(
      tryEdit(() => {
        n = addDialoguePackage(ctx, selected, pkg);
      }),
    );
    if (n > 0) setPicked(new Set());
  };
  const toggle = (sid: string): void => {
    const next = new Set(picked);
    if (next.has(sid)) next.delete(sid);
    else next.add(sid);
    setPicked(next);
  };
  const groupName = (key: string, name: string): string => (key === '' ? (groupBy === 'faction' ? t.ceNoFaction : t.ceNoTown) : label(key, name));

  return (
    <div className="mods-panel census-panel" data-testid="census-panel">
      <div className="mods-panel-bar">
        <select
          value={groupBy}
          onChange={(e) => {
            setGroupBy(e.target.value as GroupBy);
            setGroup(undefined);
          }}
          data-testid="census-groupby"
        >
          <option value="faction">{t.ceByFaction}</option>
          <option value="town">{t.ceByTown}</option>
        </select>
        <select value={filter} onChange={(e) => { setFilter(e.target.value as Filter); }} data-testid="census-filter">
          <option value="all">{t.ceAll}</option>
          <option value="unique">{t.ceUnique}</option>
          <option value="template">{t.ceTemplate}</option>
          <option value="nopkg">{t.ceNoPackage}</option>
          <option value="notalk">{t.ceNoTalk}</option>
          <option value="inmod">{t.ceInMod}</option>
        </select>
        <input type="search" placeholder={t.ceSearch} value={search} onChange={(e) => { setSearch(e.target.value); }} data-testid="census-search" />
        <span className="muted" data-testid="census-summary" data-rows={rows.length}>
          {t.ceChars(rows.length)}
        </span>
      </div>
      {!data ? (
        <Empty text={t.ceCounting} />
      ) : (
        <div className="census-body">
          <div className="census-groups" data-testid="census-groups" title={t.ceWeightHint}>
            <button className={`census-group${activeGroup ? '' : ' active'}`} onClick={() => { setGroup(undefined); }} data-testid="census-group" data-key="*">
              <span>{t.ceAllGroups}</span>
              <span className="muted">{t.ceChars(data.chars.length)}</span>
            </button>
            {groups.slice(0, MAX_ROWS).map((g) => (
              <button
                key={g.key}
                className={`census-group${g.key === activeGroup?.key ? ' active' : ''}`}
                onClick={() => { setGroup(g.key); }}
                data-testid="census-group"
                data-key={g.key}
                data-weight={g.weight}
                title={g.key}
              >
                <span>{groupName(g.key, g.name)}</span>
                <span className="muted">
                  {g.chars.length} · {t.ceWeight(g.weight)}
                </span>
              </button>
            ))}
          </div>
          <div className="census-main">
            <div className="mods-panel-bar">
              <button
                onClick={() => {
                  setPicked(new Set([...picked, ...rows.slice(0, MAX_ROWS).map((c) => c.sid)]));
                }}
                data-testid="census-select-all"
              >
                {t.ceSelectAll}
              </button>
              <span className="muted" data-testid="census-selected">
                {t.ceSelected(selected.length)}
              </span>
              <select value={pkg} onChange={(e) => { setPkg(e.target.value); }} data-testid="census-package">
                <option value="">{t.cePackage}</option>
                {packages.map((p) => (
                  <option key={p.sid} value={p.sid}>
                    {p.label}
                  </option>
                ))}
              </select>
              <button className="primary" disabled={pkg === '' || selected.length === 0} onClick={give} data-testid="census-give">
                {t.ceGive(selected.length)}
              </button>
            </div>
            {rows.length === 0 ? (
              <Empty />
            ) : (
              <div className="table-wrap">
                <table className="table census-table" data-testid="census-table">
                  <thead>
                    <tr>
                      <th />
                      <th>{t.ceName}</th>
                      <th>{t.ceFaction}</th>
                      <th>{t.ceTowns}</th>
                      <th>{t.ceSquads}</th>
                      <th>{t.cePackages}</th>
                      <th>{t.ceTalks}</th>
                      <th>{t.ceFlags}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, MAX_ROWS).map((c) => (
                      <tr key={c.sid} className={c.status ? `st-${c.status}` : ''} data-testid="census-row" data-sid={c.sid} data-status={c.status ?? ''} data-packages={c.packages.length}>
                        <td>
                          <input type="checkbox" checked={picked.has(c.sid)} onChange={() => { toggle(c.sid); }} data-testid="census-pick" />
                        </td>
                        <td>
                          <button className="link" onClick={() => { go(c.sid); }} title={`${c.sid}\n${t.ceOpen}`}>
                            {c.localized ?? c.name}
                          </button>
                        </td>
                        <td>{c.factions.map((f) => label(f)).join(', ')}</td>
                        <td title={c.towns.slice(0, 20).map((x) => label(x)).join('\n')}>{c.towns.length}</td>
                        <td>{c.squads.length}</td>
                        <td title={c.packages.map((p) => label(p)).join('\n')}>{c.packages.length}</td>
                        <td>{c.talks}</td>
                        <td className="census-flags">
                          {c.status && <span className="tag changed">★ {t.ceInModFlag}</span>}
                          {c.unique && <span className="tag">{t.ceUniqueFlag}</span>}
                          {c.trader && <span className="tag">{t.ceTrader}</span>}
                          {c.dumb && <span className="tag">{t.ceDumb}</span>}
                        </td>
                        <td className="census-actions">
                          <button onClick={() => { open('player', { sid: c.sid }); }} title={t.cePlayer} data-testid="census-player">
                            ▶
                          </button>
                          <button onClick={() => { open('where', { sid: c.sid }); }} title={t.ceWhere} data-testid="census-where">
                            ⌖
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > MAX_ROWS && <div className="muted">{t.ceCap(MAX_ROWS)}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

registerPanel({
  id: 'census', group: 'data',
  title: (t) => t.panel_census,
  icon: '☷',
  component: CensusPanel,
  area: 'center',
  order: 54,
  hint: (t) => t.censusHint,
});
