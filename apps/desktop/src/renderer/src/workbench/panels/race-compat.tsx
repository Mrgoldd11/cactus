/**
 * «Race compatibility» wizard: choose your race and a sample race; every place the sample is used
 * (armour and clothing, weapons, dialogue conditions, race groups, starts, animation files…) is
 * shown as «was → will be» by group with checkboxes. «Apply» adds the ticked changes into the
 * mod as one undo step. The search itself is in the core (`planRaceCompat`).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyBulk,
  planRaceCompat,
  raceCompatGroupText,
  raceCompatPreview,
  raceMeshes,
  RACE_COMPAT_DEFAULT_ON,
  RACE_COMPAT_GROUPS,
  skeletonWarningText,
  uiText,
  type RaceCompatChange,
  type RaceCompatPlan,
} from '@kenshi-editor/core';
import { errorText, useLang, useT } from '../../i18n.ts';
import { tryEdit, useProjectVersion } from '../../hooks.ts';
import { loadMesh } from '../../three/assets.ts';
import type { Project } from '../../project.ts';
import { registerPanel } from '../registry.ts';
import { useWorkbench } from '../context.ts';
import { Empty } from './common.tsx';

/** Rows shown per group (everything ticked is applied). */
const MAX_ROWS = 300;
const SAMPLE_NAMES = ['greenlander', 'зеленоземец'];

function raceLabel(project: Project, sid: string): string {
  const e = project.entry(sid);
  return e ? e.localized || e.name || sid : sid;
}

/** Default race: the newest race of the mod itself, if any. */
function defaultRace(project: Project, races: readonly string[]): string {
  const own = races.filter((s) => project.status(s) === 'new');
  return own.at(-1) ?? '';
}

function defaultSample(project: Project, races: readonly string[], race: string): string {
  const gl = races.find((s) => s !== race && SAMPLE_NAMES.includes((project.entry(s)?.name ?? '').toLowerCase()));
  return gl ?? '';
}

/** Skeleton link of a race mesh differs between the two races → warning text (async, from the game files). */
function useSkeletonWarning(project: Project, plan: RaceCompatPlan | undefined, lang: string): { text?: string; checking: boolean } {
  const [state, setState] = useState<{ key: string; text?: string; checking: boolean }>({ key: '', checking: false });
  const a = plan ? raceMeshes(project.ctx, plan.race) : {};
  const b = plan ? raceMeshes(project.ctx, plan.sample) : {};
  const key = plan ? `${plan.race}|${plan.sample}|${a.male ?? ''}|${a.female ?? ''}|${b.male ?? ''}|${b.female ?? ''}` : '';
  useEffect(() => {
    if (!plan) return;
    const run = { live: true };
    setState({ key, checking: true });
    const skeleton = (path: string | undefined): Promise<string | undefined> =>
      path ? loadMesh(project.bundle.game, path).then((m) => m?.skeleton, () => undefined) : Promise.resolve(undefined);
    const norm = (s: string | undefined): string | undefined => s?.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
    void (async () => {
      for (const g of ['male', 'female'] as const) {
        const [sa, sb] = (await Promise.all([skeleton(a[g]), skeleton(b[g])])).map(norm);
        if (sa && sb && sa !== sb) {
          if (run.live) setState({ key, text: uiText(skeletonWarningText(plan, sa, sb), lang), checking: false });
          return;
        }
      }
      if (run.live) setState({ key, checking: false });
    })();
    return () => {
      run.live = false;
    };
  }, [key, lang]);
  return state.key === key ? state : { checking: plan !== undefined };
}

function RaceCompatPanel(): ReactNode {
  const t = useT();
  const lang = useLang();
  const { project, go, report, status } = useWorkbench();
  const version = useProjectVersion(project);
  const ctx = project.ctx;
  const races = useMemo(() => {
    const list = (project.idsByType().get('RACE') ?? []).filter((s) => project.status(s) !== 'deleted');
    return [...list].sort((x, y) => raceLabel(project, x).localeCompare(raceLabel(project, y)));
  }, [project, version]);
  const [race, setRace] = useState(() => defaultRace(project, races));
  const [sample, setSample] = useState(() => defaultSample(project, races, defaultRace(project, races)));
  // Checkbox changes against the default choice; reset when the pair of races changes.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    setOverrides(new Map());
  }, [race, sample]);

  const result = useMemo((): { plan?: RaceCompatPlan; error?: string } => {
    if (!race || !sample) return {};
    try {
      return { plan: planRaceCompat(ctx, race, sample, { contextMods: project.contextMods }) };
    } catch (e) {
      return { error: errorText(e) };
    }
  }, [ctx, race, sample, version, project.contextMods.join('\n')]);
  const plan = result.plan;
  const skeleton = useSkeletonWarning(project, plan, lang);

  // Translated record name when the game has one (race names in «was / will be» are translated too).
  const rowName = (c: RaceCompatChange): string => project.entry(c.sid)?.localized || c.name;
  const isOn = (c: RaceCompatChange): boolean => overrides.get(c.key) ?? c.checked;
  const chosen = useMemo(() => (plan ? plan.changes.filter(isOn).map((c) => c.key) : []), [plan, overrides]);
  const groups = useMemo(
    () => RACE_COMPAT_GROUPS.map((g) => ({ g, list: plan?.changes.filter((c) => c.group === g) ?? [] })).filter((x) => x.list.length > 0),
    [plan],
  );
  const contextCount = plan?.changes.filter((c) => c.contextOnly).length ?? 0;

  const setMany = (list: readonly RaceCompatChange[], on: boolean): void => {
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const c of list) next.set(c.key, on);
      return next;
    });
  };
  const apply = (): void => {
    if (!plan || chosen.length === 0) return;
    const p = raceCompatPreview(plan, chosen);
    const err = tryEdit(() => {
      applyBulk(ctx, p);
    });
    report(err);
    if (err === undefined) {
      const n = p.changes.length;
      status({ text: (s) => s.rcDone(n), kind: 'info' });
    }
  };

  if (races.length === 0) return <Empty text={t.rcNoRaces} />;
  const pick = (value: string, onChange: (v: string) => void, testId: string): ReactNode => (
    <select value={value} onChange={(e) => { onChange(e.target.value); }} data-testid={testId}>
      <option value="">{t.rcPick}</option>
      {races.map((s) => (
        <option key={s} value={s}>
          {raceLabel(project, s)}
          {project.status(s) === 'new' ? ' ★' : ''}
        </option>
      ))}
    </select>
  );

  return (
    <div className="mods-panel" data-testid="race-compat-panel">
      <div className="mods-panel-bar">
        <label>
          {t.rcRace} {pick(race, setRace, 'rc-race')}
        </label>
        <label>
          {t.rcLike} {pick(sample, setSample, 'rc-like')}
        </label>
        <button className="primary" disabled={chosen.length === 0} onClick={apply} title={t.rcApplyTip} data-testid="rc-apply">
          {t.rcApply(chosen.length)}
        </button>
      </div>
      <div className="muted mods-panel-note">{t.rcIntro}</div>
      {result.error !== undefined && (
        <div className="bulk-error" data-testid="rc-error">
          {result.error}
        </div>
      )}
      {plan && skeleton.text && (
        <div className="bulk-error" data-testid="rc-skeleton">
          {skeleton.text}
        </div>
      )}
      {plan && skeleton.checking && <div className="muted">{t.rcSkeletonChecking}</div>}
      {contextCount > 0 && <div className="muted" data-testid="rc-context">{t.rcContextNote(contextCount)}</div>}
      {plan && (plan.info.length > 0 || plan.already > 0) && (
        <div className="muted" data-testid="rc-summary">
          {plan.already > 0 && <div>{t.rcAlready(plan.already)}</div>}
          {plan.info.length > 0 && <div>{t.rcInfo(plan.info.length)}</div>}
        </div>
      )}
      {plan && plan.changes.length === 0 && <Empty text={t.rcNothing} />}
      {groups.length > 0 && (
        <div className="table-wrap">
          {groups.map(({ g, list }) => {
            const on = list.filter(isOn).length;
            return (
              <details key={g} className="rc-group" open={RACE_COMPAT_DEFAULT_ON.has(g)} data-testid="rc-group" data-group={g}>
                <summary>
                  <input
                    type="checkbox"
                    checked={on === list.length}
                    ref={(el) => {
                      if (el) el.indeterminate = on > 0 && on < list.length;
                    }}
                    onClick={(e) => { e.stopPropagation(); }}
                    onChange={() => { setMany(list, on < list.length); }}
                    title={t.rcToggleGroup}
                    aria-label={t.rcToggleGroup}
                    data-testid="rc-group-pick"
                  />{' '}
                  <b>{raceCompatGroupText(g, lang)}</b> <span className="muted">— {t.rcGroupCount(on, list.length)}</span>
                  {!RACE_COMPAT_DEFAULT_ON.has(g) && <span className="muted"> ({t.rcGroupOff})</span>}
                </summary>
                <table className="table bulk-table">
                  <thead>
                    <tr>
                      <th className="bulk-check" />
                      <th>{t.rcRecord}</th>
                      <th>{t.rcField}</th>
                      <th>{t.rcBefore}</th>
                      <th>{t.rcAfter}</th>
                      <th>{t.rcFrom}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.slice(0, MAX_ROWS).map((c) => (
                      <tr key={c.key} className={isOn(c) ? undefined : 'bulk-off'} data-testid="rc-row" data-key={c.key}>
                        <td className="bulk-check">
                          <input type="checkbox" checked={isOn(c)} onChange={() => { setMany([c], !isOn(c)); }} aria-label={c.name} data-testid="rc-pick" />
                        </td>
                        <td>
                          <button className="link" onClick={() => { go(c.sid); }} title={`${c.type} ${c.sid}${c.name === rowName(c) ? '' : ` — ${c.name}`}`}>
                            {rowName(c)}
                          </button>
                        </td>
                        <td className="muted">{c.field}</td>
                        <td className="bulk-before">{c.before === '' ? '—' : c.before}</td>
                        <td className="bulk-after">{c.after}</td>
                        <td className="muted" title={c.contextOnly ? t.rcContextOnly(c.origin) : undefined}>
                          {c.origin}
                          {c.contextOnly ? ' ⚠' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {list.length > MAX_ROWS && <div className="muted">… +{list.length - MAX_ROWS}</div>}
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

registerPanel({
  id: 'race-compat',
  group: 'data',
  title: (t) => t.panel_raceCompat,
  icon: '⚭',
  component: RaceCompatPanel,
  area: 'center',
  order: 53,
  hint: (t) => t.raceCompatHint,
});
