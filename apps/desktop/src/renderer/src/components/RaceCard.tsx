/**
 * Race card of the inspector (between the record header and the tabs): what has been done with a
 * race and what is left, with the race actions — compatibility, own animations, a new race based on
 * this one. Everything is computed from the data (`raceCardState`), nothing is stored but the folded
 * state of the card. Folds into one line so it never pushes the fields away.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { modelOfRecord, raceCardState, type RaceCardState } from '@kenshi-editor/core';
import { useT, type Strings } from '../i18n.ts';
import { publishable, type Project } from '../project.ts';
import { useWorkbench } from '../workbench/context.ts';
import { raceCompatPair } from '../workbench/race-compat-pair.ts';
import { addAnimsRace } from '../workbench/anim-requests.ts';
import { modelKey, modelThumbnail } from '../three/thumbnail.ts';

const FOLD_KEY = 'cactus.card.RACE';

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}

function raceName(project: Project, sid: string): string {
  const e = project.entry(sid);
  return e ? e.localized || e.name || sid : sid;
}

interface Step {
  id: 'sample' | 'compat' | 'anims';
  done: boolean;
  label: string;
  text: ReactNode;
  action?: { label: string; run: () => void; testId: string };
}

function steps(t: Strings, project: Project, st: RaceCardState, act: { compat: () => void; anims: () => void; go: (sid: string) => void }): Step[] {
  const anims: Step = {
    id: 'anims',
    done: st.ownAnimations > 0,
    label: t.rcdAnims,
    text: st.ownAnimations > 0 ? t.rcdAnimsSome(st.ownAnimations) : t.rcdAnimsNone,
    action: { label: t.rcdAdd, run: act.anims, testId: 'race-card-anims-btn' },
  };
  if (!st.own) return [anims];
  const sample = st.sample;
  const compat = st.compat;
  return [
    {
      id: 'sample',
      done: sample !== undefined,
      label: t.rcdSample,
      text:
        sample === undefined ? (
          t.rcdSampleNone
        ) : (
          <button
            className="link"
            data-testid="race-card-sample-link"
            onClick={() => {
              act.go(sample);
            }}
          >
            {raceName(project, sample)}
          </button>
        ),
    },
    {
      id: 'compat',
      done: compat !== undefined && compat.todo === 0,
      label: t.rcdCompat,
      text:
        compat === undefined
          ? t.rcdCompatNone
          : compat.todo > 0
            ? t.rcdCompatTodo(compat.todo)
            : compat.already > 0
              ? t.rcdCompatDone(compat.already)
              : t.rcdCompatNothing,
      action: { label: compat !== undefined && compat.todo === 0 ? t.rcdChange : t.rcdSetUp, run: act.compat, testId: 'race-card-compat-btn' },
    },
    anims,
  ];
}

/** Still picture of the race model: built once, cached; undefined while loading or when there is none. */
function useThumbnail(project: Project, sid: string, version: number, enabled: boolean): { url?: string; none: boolean } {
  const model = useMemo(() => (enabled ? modelOfRecord(project.ctx, sid) : undefined), [project, sid, version, enabled]);
  const key = model && model.pieces.length > 0 ? modelKey(model) : '';
  const [shot, setShot] = useState<{ key: string; url?: string }>({ key: '' });
  useEffect(() => {
    if (!model || key === '') return;
    let live = true;
    void modelThumbnail(project.bundle.game, model).then((url) => {
      if (live) setShot({ key, url });
    });
    return () => {
      live = false;
    };
  }, [key, project]);
  if (key === '') return { none: true };
  if (shot.key !== key) return { none: false };
  return { url: shot.url, none: shot.url === undefined };
}

export function RaceCard({ project, sid, version }: { project: Project; sid: string; version: number }): ReactNode {
  const t = useT();
  const { open, go, newRace, save } = useWorkbench();
  const [folded, setFolded] = useState(readFolded);
  const state = useMemo(() => raceCardState(project.ctx, sid, { contextMods: project.contextMods }), [project, sid, version]);
  const thumb = useThumbnail(project, sid, version, !folded);
  const inGameFolder = publishable(project);

  const fold = (v: boolean): void => {
    setFolded(v);
    try {
      localStorage.setItem(FOLD_KEY, v ? '1' : '0');
    } catch {
      // Storage may be unavailable; folding still works for this card.
    }
  };
  const act = {
    compat: (): void => {
      raceCompatPair.set({ race: sid, sample: state.sample, stamp: Date.now() });
      open('race-compat');
    },
    anims: (): void => {
      addAnimsRace.set({ race: sid, stamp: Date.now() });
      open('add-anims');
    },
    go,
  };
  const list = steps(t, project, state, act);
  const done = list.filter((s) => s.done).length;
  const next = list.find((s) => !s.done);
  const title = state.own ? t.rcdTitle : t.rcdTitleOther;
  const summary = state.own ? `${t.rcdSteps(done, list.length)} — ${next ? t.rcdNext(next.label.toLowerCase()) : t.rcdAllDone}` : undefined;
  const newFrom = (
    <button
      className="small"
      data-testid="race-card-new-from"
      onClick={() => {
        newRace(sid);
      }}
    >
      {t.rcdNewFrom}
    </button>
  );
  const saveLine = state.own && !inGameFolder && (
    <li className="warn" data-testid="race-card-save">
      <span className="race-card-text">{t.rcdNotInGame}</span>
      <button
        className="small"
        data-testid="race-card-save-btn"
        onClick={() => {
          void save(project.path !== undefined);
        }}
      >
        {t.rcdSave}
      </button>
    </li>
  );

  if (folded) {
    const action = next?.action ?? (state.own ? undefined : list[0]?.action);
    return (
      <div className="race-card folded" data-testid="race-card" data-folded="1" data-own={state.own ? '1' : '0'}>
        {state.own && (
          <span className="race-card-marks" aria-hidden>
            {list.map((s) => (s.done ? '✓' : '○')).join('')}
          </span>
        )}
        <b>{title}</b>
        {summary !== undefined && <span className="muted race-card-summary">· {summary}</span>}
        {state.own && !inGameFolder && (
          <span className="warn" title={t.rcdNotInGame}>
            ⚠
          </span>
        )}
        <span className="grow" />
        {action && (
          <button className="small" data-testid="race-card-next" onClick={action.run}>
            {action.label}
          </button>
        )}
        {!state.own && newFrom}
        <button className="small" data-testid="race-card-fold" title={t.rcdCollapseTip} onClick={() => { fold(false); }}>
          ▸ {t.rcdExpand}
        </button>
      </div>
    );
  }

  return (
    <div className="race-card" data-testid="race-card" data-folded="0" data-own={state.own ? '1' : '0'}>
      <button
        className="race-card-thumb"
        data-testid="race-card-model"
        title={t.rcdModelTip}
        onClick={() => {
          open('model');
        }}
      >
        {thumb.url !== undefined ? <img src={thumb.url} alt="" /> : <span className="race-card-noimg">{thumb.none ? t.rcdNoModel : '…'}</span>}
        <span className="race-card-caption muted">{t.rcdModel}</span>
      </button>
      <div className="race-card-main">
        <div className="race-card-head">
          <b>{title}</b>
          {summary !== undefined && <span className="muted race-card-summary">· {summary}</span>}
          <span className="grow" />
          <button className="small" data-testid="race-card-fold" title={t.rcdCollapseTip} onClick={() => { fold(true); }}>
            ▴ {t.rcdCollapse}
          </button>
        </div>
        {!state.own && <div className="muted race-card-hint">{t.rcdOtherHint}</div>}
        <ul className="race-card-steps">
          {list.map((s) => (
            <li key={s.id} data-testid={`race-card-${s.id}`} data-done={s.done ? '1' : '0'} className={s.done ? 'done' : ''}>
              <span className="race-card-mark" aria-hidden>
                {s.done ? '✓' : '○'}
              </span>
              <span className="race-card-text" title={s.id === 'sample' ? t.rcdSampleTip : s.id === 'compat' ? t.rcdCompatTip : undefined}>
                {s.label}: {s.text}
              </span>
              {s.action && (
                <button className="small" data-testid={s.action.testId} onClick={s.action.run}>
                  {s.action.label}
                </button>
              )}
            </li>
          ))}
          {saveLine}
        </ul>
        <div className="race-card-actions">{newFrom}</div>
      </div>
    </div>
  );
}
