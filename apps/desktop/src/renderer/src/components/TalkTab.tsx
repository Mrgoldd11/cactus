/**
 * Вкладка «Разговор» у CHARACTER: какие диалоги игра рассматривает на событие (по клику — 1),
 * откуда они берутся (персонаж, его пакет, пакеты отряда, пакет фракции), их очки, условия и
 * действия, какой выберет игра и с чего начнётся разговор. Оценка — та же, что `kedit talk`.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  EVENT_TALK,
  refValueEnum,
  simulateTalk,
  type TalkCandidate,
  type TalkLine,
  type TalkSimulation,
  type TranslationIndex,
} from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import type { Project } from '../project.ts';

interface Props {
  project: Project;
  sid: string;
  version: number;
  onGo: (sid: string) => void;
}

export function TalkTab({ project, sid, version, onGo }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const [event, setEvent] = useState(EVENT_TALK);
  const [translation, setTranslation] = useState<TranslationIndex | undefined | null>(null);

  useEffect(() => {
    let alive = true;
    project.translation().then(
      (tr) => {
        if (alive) setTranslation(tr);
      },
      () => {
        if (alive) setTranslation(undefined);
      },
    );
    return () => {
      alive = false;
    };
  }, [project]);

  const result = useMemo((): TalkSimulation | string => {
    try {
      return simulateTalk(project.ctx, sid, event, translation ? { translation } : {});
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [project, sid, event, version, translation]);

  const events = useMemo(() => refValueEnum(project.ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0)?.values ?? [], [project]);
  const ru = lang === 'ru';

  return (
    <div className="talk" data-testid="talk" data-sid={sid}>
      <div className="talk-bar">
        <label>
          {t.talkEvent}{' '}
          <select
            data-testid="talk-event"
            value={event}
            onChange={(e) => {
              setEvent(Number(e.target.value));
            }}
          >
            {!events.some((v) => v.value === event) && <option value={event}>{event}</option>}
            {events.map((v) => (
              <option key={v.value} value={v.value} title={v.description}>
                {v.value} — {v.label ?? v.name}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">
          {translation === null ? t.dgLoadingTr : translation === undefined ? t.dgNoTr : ''}
        </span>
      </div>
      {typeof result === 'string' ? (
        <p className="error">{result}</p>
      ) : (
        <TalkBody sim={result} ru={ru} nameOf={(id) => project.ctx.name(id) ?? id} onGo={onGo} />
      )}
    </div>
  );
}

function TalkBody({ sim, ru, nameOf, onGo }: { sim: TalkSimulation; ru: boolean; nameOf: (sid: string) => string; onGo: (sid: string) => void }): ReactNode {
  const t = useT();
  const winner = sim.candidates.find((c) => c.dialog === sim.winner);
  return (
    <>
      <p className="talk-summary" data-testid="talk-summary">
        {sim.candidates.length === 0 ? (
          t.talkNone
        ) : winner ? (
          <>
            {t.talkWinner}:{' '}
            <DialogLink c={winner} ru={ru} onGo={onGo} />
          </>
        ) : (
          t.talkNoAlways
        )}
      </p>
      {sim.opening.length > 0 && (
        <div className="talk-opening" data-testid="talk-opening">
          <div className="group-title">{t.talkOpening}</div>
          {sim.opening.map((l) => (
            <div key={l.id} className="talk-line-block">
              <LineView l={l} ru={ru} onGo={onGo} />
              {l.choices.map((ch) => (
                <div key={ch.id} className="talk-choice">
                  → <LineView l={ch} ru={ru} onGo={onGo} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {sim.candidates.length > 0 && (
        <table className="table talk-table" data-testid="talk-candidates">
          <thead>
            <tr>
              <th>{t.talkVerdict}</th>
              <th>{t.talkDialog}</th>
              <th>{t.talkScore}</th>
              <th>{t.talkConditions}</th>
              <th>{t.talkFrom}</th>
            </tr>
          </thead>
          <tbody>
            {sim.candidates.map((c) => (
              <CandidateRow key={c.dialog} c={c} sim={sim} ru={ru} nameOf={nameOf} onGo={onGo} />
            ))}
          </tbody>
        </table>
      )}
      {sim.candidates.length > 0 && <p className="muted small">{t.talkEstimate}</p>}
    </>
  );
}

function DialogLink({ c, ru, onGo }: { c: TalkCandidate; ru: boolean; onGo: (sid: string) => void }): ReactNode {
  return (
    <button
      className={`link ${c.verdict === 'missing' ? 'error' : ''}`}
      title={`${c.dialog}${c.origin !== undefined ? ` · ${c.origin}` : ''}`}
      onClick={() => {
        onGo(c.dialog);
      }}
    >
      {(ru ? c.ru : undefined) ?? c.name}
    </button>
  );
}

function CandidateRow({ c, sim, ru, nameOf, onGo }: { c: TalkCandidate; sim: TalkSimulation; ru: boolean; nameOf: (sid: string) => string; onGo: (sid: string) => void }): ReactNode {
  const t = useT();
  const by = c.by !== undefined ? sim.candidates.find((x) => x.dialog === c.by) : undefined;
  return (
    <tr className={`talk-row tv-${c.verdict}`} data-testid="talk-candidate" data-dialog={c.dialog} data-verdict={c.verdict}>
      <td>
        <span className={`badge tv-${c.verdict}`}>{t[`talkVerdict_${c.verdict}`]}</span>
        {by && (
          <div className="muted small">
            ← {(ru ? by.ru : undefined) ?? by.name}
          </div>
        )}
      </td>
      <td>
        <DialogLink c={c} ru={ru} onGo={onGo} />
        {c.origin !== undefined && <div className="muted small mono">{c.origin}</div>}
        {c.actions.length > 0 && (
          <div>
            {c.actions.map((a) => (
              <span key={a} className={`badge tiny talk-action ta-${a}`}>
                {t[`talkAction_${a}`]}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="mono">
        {c.score}
        {c.chance < 100 ? ` · ${c.chance}%` : ''}
      </td>
      <td className="talk-conds">
        {c.conditions.length === 0 ? (
          <span className="muted">{t.talkNoConditions}</span>
        ) : (
          c.conditions.map((x, i) => (
            <div key={i} className="dg-cond mono">
              ? {x}
            </div>
          ))
        )}
      </td>
      <td>
        {c.sources.map((s, i) => (
          <div key={i} className="small">
            {t[`talkVia_${s.via}`]}
            {s.holder !== sim.character && (
              <>
                {': '}
                <button
                  className="link"
                  title={s.holder}
                  onClick={() => {
                    onGo(s.holder);
                  }}
                >
                  {nameOf(s.holder)}
                </button>
              </>
            )}
          </div>
        ))}
      </td>
    </tr>
  );
}

function LineView({ l, ru, onGo }: { l: TalkLine; ru: boolean; onGo: (sid: string) => void }): ReactNode {
  const t = useT();
  const first = l.texts[0];
  return (
    <span className="talk-line" data-testid="talk-line" data-id={l.id}>
      <span className={`dg-chip ${l.choice ? 'choice' : 'npc'}`}>{l.choice ? t.dgPlayer : (l.speakerLabel ?? t.dgNpc)}</span>{' '}
      <button
        className="link"
        title={l.id}
        onClick={() => {
          onGo(l.id);
        }}
      >
        {first ? `«${ru ? (first.ru ?? first.en) : first.en}»` : t.talkNoText}
      </button>
      {l.texts.length > 1 && (
        <span className="muted small">
          {' '}
          +{l.texts.length - 1} {t.dgVariants}
        </span>
      )}
      {l.score ? <span className="muted mono small"> +{l.score}</span> : null}
      {l.chance !== undefined && l.chance < 100 ? <span className="muted mono small"> {l.chance}%</span> : null}
      {l.conditions.map((x, i) => (
        <span key={`c${i}`} className="dg-cond mono small">
          {' '}
          ? {x}
        </span>
      ))}
      {l.effects.map((x, i) => (
        <span key={`e${i}`} className="dg-effect mono small">
          {' '}
          ! {x}
        </span>
      ))}
      {l.shadowedBy !== undefined && <span className="dg-warn small"> ⚠ {t.dgIssue_shadowed}</span>}
    </span>
  );
}
