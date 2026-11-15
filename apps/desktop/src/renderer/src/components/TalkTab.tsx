/**
 * Вкладка «Разговор» у CHARACTER: какие диалоги игра рассматривает на событие (по клику — 1),
 * откуда они берутся (персонаж, его пакет, пакеты отряда, пакет фракции), их очки, условия и
 * действия, какой выберет игра и с чего начнётся разговор. Правило выбора — точное, из кода игры
 * (то же, что `kedit talk`); кнопка «Как игра выбирает» показывает его простыми словами.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  EVENT_TALK,
  refValueEnum,
  simulateTalk,
  type ScorePart,
  type TalkCandidate,
  type TalkLine,
  type TalkSimulation,
} from '@kenshi-editor/core';
import { useT, type Strings } from '../i18n.ts';
import { recordName, useGameTexts } from '../data-names.ts';
import type { Project } from '../project.ts';

interface Props {
  project: Project;
  sid: string;
  version: number;
  onGo: (sid: string) => void;
}

export function TalkTab({ project, sid, version, onGo }: Props): ReactNode {
  const t = useT();
  const [event, setEvent] = useState(EVENT_TALK);
  const translation = useGameTexts(project);


  const result = useMemo((): TalkSimulation | string => {
    try {
      return simulateTalk(project.ctx, sid, event, translation ? { translation } : {});
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [project, sid, event, version, translation]);

  const events = useMemo(() => refValueEnum(project.ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0)?.values ?? [], [project]);

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
        <RulesButton />
      </div>
      {typeof result === 'string' ? (
        <p className="error">{result}</p>
      ) : (
        <TalkBody sim={result} nameOf={(id) => recordName(project.ctx, id)} onGo={onGo} />
      )}
    </div>
  );
}

const pct = (p: number): string => `${String(Math.round(p * 100))}%`;

export function partsText(parts: readonly ScorePart[], t: Strings): string {
  return parts
    .map((p) => {
      const v = `${p.value > 0 ? '+' : ''}${String(p.value)}`;
      return p.key === 'bonus' ? `score bonus ${v}` : `${t[`talkPart_${p.key}`]}${p.count !== undefined ? ` ×${String(p.count)}` : ''} ${v}`;
    })
    .join(', ');
}

function TalkBody({ sim, nameOf, onGo }: { sim: TalkSimulation; nameOf: (sid: string) => string; onGo: (sid: string) => void }): ReactNode {
  const t = useT();
  const byId = new Map(sim.candidates.map((c) => [c.dialog, c]));
  const winner = sim.winner !== undefined ? byId.get(sim.winner) : undefined;
  const pool = sim.pool.map((d) => byId.get(d)).filter((c): c is TalkCandidate => c !== undefined);
  const openingOf = sim.openingOf !== undefined ? byId.get(sim.openingOf) : undefined;
  const overrides = sim.candidates.some((c) => c.verdict === 'if-conditions' || c.verdict === 'tie');
  const dialogName = (d: string): string => {
    const x = byId.get(d);
    return x ? (x.localized ?? x.name) : nameOf(d);
  };
  return (
    <>
      <div className="talk-summary" data-testid="talk-summary">
        {sim.candidates.length === 0 ? (
          t.talkNone
        ) : winner ? (
          <>
            {t.talkWinner}: <DialogLink c={winner} onGo={onGo} />
          </>
        ) : pool.length > 0 ? (
          <>
            {t.talkPool}{' '}
            {pool.map((c, i) => (
              <span key={c.dialog}>
                {i > 0 && ', '}
                <DialogLink c={c} onGo={onGo} /> <span className="muted mono">{pct(c.odds ?? 0)}</span>
              </span>
            ))}
          </>
        ) : (
          t.talkNoAlways
        )}
        {overrides && <div className="muted small">{t.talkOverride}</div>}
      </div>
      {sim.opening.length > 0 && (
        <div className="talk-opening" data-testid="talk-opening">
          <div className="group-title">
            {t.talkOpening}
            {openingOf && openingOf !== winner && ` ${t.talkOpeningOf} «${dialogName(openingOf.dialog)}»`}
          </div>
          {sim.opening.map((l) => (
            <div key={l.id} className="talk-line-block">
              <LineView l={l} onGo={onGo} />
              {l.choices.map((ch) => (
                <div key={ch.id} className="talk-choice">
                  → <LineView l={ch} onGo={onGo} />
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
              <CandidateRow key={c.dialog} c={c} sim={sim} nameOf={nameOf} dialogName={dialogName} onGo={onGo} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function DialogLink({ c, onGo }: { c: TalkCandidate; onGo: (sid: string) => void }): ReactNode {
  return (
    <button
      className={`link ${c.verdict === 'missing' ? 'error' : ''}`}
      title={`${c.dialog}${c.origin !== undefined ? ` · ${c.origin}` : ''}`}
      onClick={() => {
        onGo(c.dialog);
      }}
    >
      {c.localized ?? c.name}
    </button>
  );
}

function CandidateRow({
  c,
  sim,
  nameOf,
  dialogName,
  onGo,
}: {
  c: TalkCandidate;
  sim: TalkSimulation;
  nameOf: (sid: string) => string;
  dialogName: (sid: string) => string;
  onGo: (sid: string) => void;
}): ReactNode {
  const t = useT();
  const names = (ds: readonly string[]): string => ds.map((d) => `«${dialogName(d)}»`).join(', ');
  const odds = c.odds !== undefined && (c.verdict === 'random' || c.verdict === 'tie') ? `, ${t.talkChance} ${pct(c.odds)}` : '';
  const withWhom = c.with?.length ? `; ${t.talkWith} ${names(c.with)}` : '';
  const byWhom = c.verdict === 'shadowed' && c.by !== undefined ? ` ${names([c.by])}` : '';
  const parts = partsText(c.scoreParts, t);
  return (
    <tr className={`talk-row tv-${c.verdict}`} data-testid="talk-candidate" data-dialog={c.dialog} data-verdict={c.verdict}>
      <td className="talk-verdict">
        <span className={`badge tv-${c.verdict}`}>{t[`talkVerdict_${c.verdict}`]}</span>
        <div className="small talk-why" data-testid="talk-why">
          {t[`talkWhy_${c.verdict}`]}
          {byWhom}
          {odds}
          {withWhom}
        </div>
      </td>
      <td>
        <DialogLink c={c} onGo={onGo} />
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
      <td className="talk-score">
        <span className="mono" title={parts}>
          {c.score}
          {c.chance < 100 ? ` · ${String(c.chance)}%` : ''}
        </span>
        {c.scoreParts.some((p) => p.key !== 'bonus') && <div className="muted small">{parts}</div>}
        {c.total !== undefined && c.total !== c.score && (
          <div className="muted small">
            {t.talkScoreTotal} {c.total}
          </div>
        )}
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

function LineView({ l, onGo }: { l: TalkLine; onGo: (sid: string) => void }): ReactNode {
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
        {first ? `«${first.localized ?? first.en}»` : t.talkNoText}
      </button>
      {l.texts.length > 1 && (
        <span className="muted small">
          {' '}
          +{l.texts.length - 1} {t.dgVariants}
        </span>
      )}
      {l.odds !== undefined && l.odds < 1 - 1e-9 && (
        <span className="badge tiny talk-odds" data-testid="talk-line-odds">
          {t.talkChance} {pct(l.odds)}
        </span>
      )}
      {l.oddsIf !== undefined && (
        <span className="badge tiny talk-odds" data-testid="talk-line-odds">
          {t.talkChanceIf} {pct(l.oddsIf)}
        </span>
      )}
      {l.score ? (
        <span className="muted mono small" title={l.scoreParts ? partsText(l.scoreParts, t) : undefined}>
          {' '}
          {t.talkPoints} {l.score}
        </span>
      ) : null}
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

/** Кнопка «Как игра выбирает»: окошко с правилами; закрывается повторным кликом, кликом мимо или Esc. */
function RulesButton(): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      if (box.current && e.target instanceof Node && !box.current.contains(e.target)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <span className="talk-rules-wrap" ref={box}>
      <button
        className={`talk-rules-btn ${open ? 'active' : ''}`}
        data-testid="talk-rules-btn"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span className="talk-rules-q">?</span> {t.talkHow}
      </button>
      {open && (
        <div className="talk-rules" data-testid="talk-rules" role="dialog" aria-label={t.talkHowTitle}>
          <TalkRulesBody />
        </div>
      )}
    </span>
  );
}

/** Правило выбора простыми словами и что значат пометки (окошко «Как игра выбирает» и панель «Как это работает»). */
export function TalkRulesBody(): ReactNode {
  const t = useT();
  return (
    <>
      <div className="group-title">{t.talkHowTitle}</div>
      <ol>
        {t.talkRules.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ol>
      <div className="group-title">{t.talkMarksTitle}</div>
      <ul className="talk-marks">
        {(['wins', 'random', 'if-conditions', 'tie', 'shadowed'] as const).map((v) => (
          <li key={v}>
            <span className={`badge tv-${v}`}>{t[`talkVerdict_${v}`]}</span> {t[`talkMark_${v}`]}
          </li>
        ))}
      </ul>
      <p className="muted small">{t.talkRulesSource}</p>
    </>
  );
}
