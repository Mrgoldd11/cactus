/**
 * «Conversation» tab on CHARACTER: which dialogues the game considers for an event (on click — 1),
 * where they come from (character, its package, squad packages, faction package), their scores, conditions and
 * effects, which one the game picks and where the conversation starts. The selection rule is exact, from the game code
 * (same as `kedit talk`); the «How the game chooses» button explains it in plain words.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  EVENT_TALK,
  quote,
  refValueEnum,
  simulateTalk,
  type ScorePart,
  type TalkCandidate,
  type TalkLine,
  type TalkSimulation,
} from '@kenshi-editor/core';
import { errorText, type Strings, useLang, useT } from '../i18n.ts';
import { useDismiss } from '../hooks.ts';
import { recordName, useGameTexts } from '../data-names.ts';
import type { Project } from '../project.ts';
import { EventSelect } from './EventUi.tsx';
import { PhraseContext, PhraseLine, useRecordPhrases } from './DialogHelpUi.tsx';

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
      return errorText(e);
    }
  }, [project, sid, event, version, translation]);

  const evDef = useMemo(() => refValueEnum(project.ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0), [project]);

  return (
    <div className="talk" data-testid="talk" data-sid={sid}>
      <div className="talk-bar">
        <label>
          {t.talkEvent}{' '}
          {evDef ? (
            <EventSelect def={evDef} value={event} testId="talk-event" onChange={setEvent} />
          ) : (
            <span data-testid="talk-event">{event}</span>
          )}
        </label>
        <span className="muted small">
          {translation === null ? t.dgLoadingTr : translation === undefined ? t.dgNoTr : ''}
        </span>
        <RulesButton />
      </div>
      {typeof result === 'string' ? (
        <p className="error">{result}</p>
      ) : (
        <PhraseContext.Provider value={project.ctx}>
          <TalkBody sim={result} nameOf={(id) => recordName(project.ctx, id)} onGo={onGo} />
        </PhraseContext.Provider>
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
  const lang = useLang();
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
            {openingOf && openingOf !== winner && ` ${t.talkOpeningOf} ${quote(dialogName(openingOf.dialog), lang)}`}
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
  const lang = useLang();
  const names = (ds: readonly string[]): string => ds.map((d) => quote(dialogName(d), lang)).join(', ');
  const odds = c.odds !== undefined && (c.verdict === 'random' || c.verdict === 'tie') ? `, ${t.talkChance} ${pct(c.odds)}` : '';
  const withWhom = c.with?.length ? `; ${t.talkWith} ${names(c.with)}` : '';
  const byWhom = c.verdict === 'shadowed' && c.by !== undefined ? ` ${names([c.by])}` : '';
  const parts = partsText(c.scoreParts, t);
  const phrases = useRecordPhrases(c.dialog, 'dialogue', true);
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
        ) : phrases ? (
          <>
            {phrases.conditions.map((p, i) => (
              <PhraseLine key={i} phrase={p} kind="cond" mark testId="talk-cond-phrase" />
            ))}
            {c.conditions.includes('unique') && <div className="dg-cond mono">? unique</div>}
          </>
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
  const lang = useLang();
  const first = l.texts[0];
  const phrases = useRecordPhrases(l.id, 'line', false);
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
        {first ? quote(first.localized ?? first.en, lang) : t.talkNoText}
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
      {phrases
        ? phrases.conditions.map((p, i) => <PhraseLine key={`c${i}`} phrase={p} kind="cond" mark inline />)
        : l.conditions.map((x, i) => (
            <span key={`c${i}`} className="dg-cond mono small">
              {' '}
              ? {x}
            </span>
          ))}
      {phrases
        ? phrases.effects.map((p, i) => <PhraseLine key={`e${i}`} phrase={p} kind="effect" mark inline />)
        : l.effects.map((x, i) => (
            <span key={`e${i}`} className="dg-effect mono small">
              {' '}
              ! {x}
            </span>
          ))}
      {l.shadowedBy !== undefined && <span className="dg-warn small"> ⚠ {t.dgIssue_shadowed}</span>}
    </span>
  );
}

/** «How the game chooses» button: a popup with the rules; closes on a second click, a click outside or Esc. */
function RulesButton(): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useDismiss(open, box, () => {
    setOpen(false);
  });
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

/** The selection rule in plain words and what the marks mean (the «How the game chooses» popup and the «How it works» panel). */
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
