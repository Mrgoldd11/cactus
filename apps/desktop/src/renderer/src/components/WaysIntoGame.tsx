/**
 * Whether a record gets into the game and how to get it there: the «In game: …» line of the
 * inspector header, the ways into the game from the schema (sold by a trader, lies in the world,
 * a squad has it…) with a button to add the record to such a list, and «Like the sample»: the
 * lists the record's sample is in, added in one undo step.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  addToLists,
  countedUses,
  sameListsAs,
  sampleOf,
  uiText,
  wayOf,
  waysIntoGame,
  wayText,
  whereBrief,
  whereBriefPart,
  whereInGame,
  type ListSlot,
  type WayIn,
  type WhereRole,
  type WorldIndex,
} from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import { tryEdit } from '../hooks.ts';
import type { Project } from '../project.ts';
import { RecordPicker } from './RecordPicker.tsx';

export type InGame = { state: 'checking' } | { state: 'nowhere' } | { state: 'none' } | { state: 'in'; parts: string[]; more: number };

/**
 * The «In game» state of a record. The world (level files) is read only when the data alone
 * finds nothing: a building may still stand in the world.
 */
export function useInGame(project: Project, sid: string, version: number): InGame {
  const lang = useLang();
  const [world, setWorld] = useState<WorldIndex | undefined>();
  const [worldDone, setWorldDone] = useState(false);
  const ctx = project.ctx;
  const res = useMemo(() => {
    try {
      return whereInGame(ctx, sid, world ? { world } : {});
    } catch {
      return undefined;
    }
  }, [ctx, sid, version, world]);
  const empty = res !== undefined && res.facts.length === 0;
  const needWorld = empty && !worldDone;
  useEffect(() => {
    if (!needWorld) return;
    let alive = true;
    project.world().then(
      (w) => {
        if (!alive) return;
        setWorld(w);
        setWorldDone(true);
      },
      () => {
        if (alive) setWorldDone(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [project, needWorld]);
  return useMemo((): InGame => {
    if (!res) return { state: 'none' };
    if (res.facts.length > 0) return { state: 'in', ...whereBrief(res.facts, lang) };
    if (needWorld) return { state: 'checking' };
    const rec = ctx.get(sid);
    const ways = rec ? waysIntoGame(ctx.schema, ctx.typeName(rec.type)) : [];
    if (ways.length === 0) return { state: 'none' };
    const counted = countedUses(ctx, sid, ways);
    if (counted.length > 0) return { state: 'in', parts: counted.map((c) => `${uiText(c.way.title, lang)} (${c.count})`), more: 0 };
    return { state: 'nowhere' };
  }, [res, needWorld, ctx, sid, version, lang]);
}

/** «In game: sold by Priest (holy church) · with Moll   Where in game ▸» */
export function InGameLine({ state, onOpen }: { state: InGame; onOpen: () => void }): ReactNode {
  const t = useT();
  return (
    <div className="in-game" data-testid="in-game" data-state={state.state}>
      <span className="muted">{t.igLabel}</span>{' '}
      {state.state === 'nowhere' && (
        <span className="warn" data-testid="in-game-nowhere" title={t.igNowhereTip}>
          {t.igNowhere}
        </span>
      )}
      {state.state === 'checking' && <span className="muted">{t.igChecking}</span>}
      {state.state === 'none' && (
        <span className="muted" title={t.wyNone}>
          —
        </span>
      )}
      {state.state === 'in' && (
        <span className="in-game-brief" data-testid="in-game-brief">
          {state.parts.join(' · ')}
          {state.more > 0 && <span className="muted"> {t.igMore(state.more)}</span>}
        </span>
      )}
      <button className="link small in-game-open" data-testid="in-game-open" title={t.igOpenTip} onClick={onOpen}>
        {t.igOpen}
      </button>
    </div>
  );
}

const ROLE_ICON: Partial<Record<WhereRole, string>> = { sold: '🛒', lying: '📦', carried: '🧍', member: '👥', lives: '🏠', placed: '📍', says: '💬' };

type Add = (slots: readonly (Omit<ListSlot, 'values'> & { values?: readonly number[] })[], sample?: string) => void;

/** Adding to lists as one undo step, errors to the status line. */
export function useAddToLists(project: Project, sid: string, report: (err: string | undefined) => void): Add {
  return (slots, sample) => {
    report(
      tryEdit(() => {
        addToLists(project.ctx, sid, slots, sample);
      }),
    );
  };
}

/** Ways a record of this type gets into the game; each with a button that adds it to such a list. */
export function WaysList({ project, sid, version, add }: { project: Project; sid: string; version: number; add: Add }): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const [picking, setPicking] = useState<WayIn | undefined>();
  const rec = ctx.get(sid);
  const type = rec ? ctx.typeName(rec.type) : '';
  const ways = useMemo(() => waysIntoGame(ctx.schema, type), [ctx, type]);
  const counts = useMemo(() => new Map(countedUses(ctx, sid, ways).map((c) => [c.way, c.count])), [ctx, sid, ways, version]);
  const has = useMemo(
    () => (picking ? new Set(ctx.referencesTo(sid).filter((e) => e.category === picking.field).map((e) => e.source)) : new Set<string>()),
    [ctx, sid, picking, version],
  );
  if (ways.length === 0) return <p className="muted">{t.wyNone}</p>;
  return (
    <>
      <ul className="ways" data-testid="ways">
        {ways.map((w) => {
          const n = counts.get(w);
          return (
            <li key={`${w.sourceType}.${w.field}`} className={`way ${w.plain ? '' : 'generic'}`} data-testid="way" data-way={`${w.sourceType}.${w.field}`}>
              <span className="way-icon">{(w.role && ROLE_ICON[w.role]) ?? '•'}</span>
              <div className="grow">
                <div className="way-title" title={t.wyCodeTip(`${w.sourceType}.${w.field}`)}>
                  {uiText(w.title, lang)}
                </div>
                {uiText(w.hint, lang) !== '' && <div className="muted small">{uiText(w.hint, lang)}</div>}
              </div>
              {w.action && (
                <button
                  className="small"
                  data-testid="way-add"
                  onClick={() => {
                    setPicking(w);
                  }}
                >
                  {uiText(w.action, lang)}
                </button>
              )}
              {n !== undefined && (
                <span className="muted small" title={t.wyCountTip}>
                  {t.wyCount(n)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {picking && (
        <RecordPicker
          project={project}
          title={t.wyPickTitle(uiText(picking.action ?? picking.title, lang))}
          targetType={picking.sourceType}
          exclude={has}
          onPick={(source) => {
            setPicking(undefined);
            add([{ source, category: picking.field }]);
          }}
          onClose={() => {
            setPicking(undefined);
          }}
        />
      )}
    </>
  );
}

/**
 * «Like the sample»: where the record's sample is in the game and buttons that add the record to
 * the same lists. No known sample — a record of the same type can be chosen to copy from.
 */
export function SampleBlock({ project, sid, version, add, onGo, always }: { project: Project; sid: string; version: number; add: Add; onGo: (sid: string) => void; always: boolean }): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const [chosen, setChosen] = useState<string | undefined>();
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    setChosen(undefined);
  }, [sid]);
  const auto = useMemo(() => sampleOf(ctx, sid), [ctx, sid, version]);
  const sample = chosen ?? auto;
  const rec = ctx.get(sid);
  const type = rec ? ctx.typeName(rec.type) : '';
  // The sample's places in a few words, without repeats (one trader in two squads).
  const facts = useMemo(() => (sample ? [...new Set(whereInGame(ctx, sample).facts.map((f) => whereBriefPart(f, lang)))] : []), [ctx, sample, version, lang]);
  const slots = useMemo(() => (sample ? sameListsAs(ctx, sid, sample) : []), [ctx, sid, sample, version]);
  const name = (s: string): string => ctx.localizedName(s) ?? ctx.name(s) ?? s;

  const picker = picking && (
    <RecordPicker
      project={project}
      title={t.wyPickOtherTitle}
      targetType={type}
      exclude={new Set([sid])}
      onPick={(s) => {
        setPicking(false);
        setChosen(s);
      }}
      onClose={() => {
        setPicking(false);
      }}
    />
  );
  const pickButton = (
    <button
      className="link small"
      data-testid="where-like-pick"
      onClick={() => {
        setPicking(true);
      }}
    >
      {t.wyPickOther}
    </button>
  );

  if (!sample) {
    if (!always) return null;
    return (
      <div className="where-like" data-testid="where-like">
        <span className="muted">{t.wyLikeOther}</span> {pickButton}
        {picker}
      </div>
    );
  }
  if (!always && slots.length === 0) return null;
  return (
    <div className="where-like" data-testid="where-like" data-sample={sample}>
      <div className="where-like-title">
        <button
          className="link strong"
          onClick={() => {
            onGo(sample);
          }}
        >
          {t.wyLikeSample(name(sample))}
        </button>{' '}
        <span className="muted small">({t.wySamplePaths(facts.length)})</span> {pickButton}
      </div>
      {facts.length === 0 ? (
        <p className="muted small">{t.wySampleNowhere}</p>
      ) : (
        <ul className="where-like-facts small">
          {facts.slice(0, 6).map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {slots.length > 0 && (
        <div className="where-like-actions">
          {slots.map((s, i) => {
            const src = ctx.get(s.source);
            const way = src ? wayOf(ctx.schema, type, ctx.typeName(src.type), s.category) : undefined;
            return (
              <button
                key={`${s.source}:${s.category}`}
                className={i === 0 ? 'primary small' : 'small'}
                data-testid="where-same"
                data-source={s.source}
                title={`${s.category} ← ${s.source}`}
                onClick={() => {
                  add([s]);
                }}
              >
                {way ? wayText(way.same, name(s.source), lang) : name(s.source)}
              </button>
            );
          })}
          {slots.length > 1 && (
            <button
              className="small"
              data-testid="where-same-all"
              onClick={() => {
                add(slots, sample);
              }}
            >
              {t.wyAddAll(slots.length)}
            </button>
          )}
        </div>
      )}
      {slots.length === 0 && facts.length > 0 && <p className="muted small">{t.wySampleDone}</p>}
      {picker}
    </div>
  );
}
