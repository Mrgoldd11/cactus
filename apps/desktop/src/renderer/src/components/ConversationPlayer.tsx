/**
 * Проигрыватель разговора: персонаж + событие → какие диалоги игра рассматривает, какой выбирает и
 * почему; дальше шаг за шагом — реплика NPC, ответы игрока кнопками. «Как будто»: у любой записи с
 * условиями можно отметить, выполнены ли они, — выбор игры пересчитывается сразу.
 * Правило выбора — из кода игры (`playConversation` в ядре, на `chooseOdds`).
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  buildDialogueGraph,
  dialogueScore,
  EVENT_TALK,
  getEnum,
  PLAY_NPC,
  playConversation,
  playStartList,
  plainName,
  refValueEnum,
  shortEnumLabel,
  type ModContext,
  type PlayAnswer,
  type PlayMode,
  type PlayOption,
  type PlayResult,
  type PlayStep,
  type TranslationIndex,
} from '@kenshi-editor/core';
import { errorText, type Strings, useT } from '../i18n.ts';
import type { Project } from '../project.ts';
import { lineCaption, useTranslation } from './LineInspector.tsx';
import { partsText } from './TalkTab.tsx';
import { AsInGame } from './GameLink.tsx';

interface Props {
  project: Project;
  sid: string;
  version: number;
  onGo: (sid: string) => void;
  onSelectLine: (sid: string, dialog?: string) => void;
}

const pct = (p: number): string => `${String(Math.round(p * 100))}%`;

/** Условия записи одной строкой — как в графе (условия и фильтры). */
function conditionsOf(ctx: ModContext, sid: string, tr: TranslationIndex | undefined): string[] {
  const n = buildDialogueGraph(ctx, sid, { maxNodes: 1, ...(tr ? { translation: tr } : {}) }).nodes[0];
  const out = n ? [...n.conditions, ...n.filters] : [];
  const r = ctx.get(sid);
  if (r?.bools.get('locked')) out.unshift('locked');
  const ch = r?.floats.get('chance temporary') ?? 100;
  if (ch < 100) out.push(`chance ${String(ch)}%`);
  return out;
}

export function ConversationPlayer({ project, sid, version, onGo, onSelectLine }: Props): ReactNode {
  const t = useT();
  const ctx = project.ctx;
  const tr = useTranslation(project);
  const [event, setEvent] = useState(EVENT_TALK);
  const [mode, setMode] = useState<PlayMode>('met');
  const [assume, setAssume] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [answers, setAnswers] = useState<readonly string[]>([]);
  const [prefer, setPrefer] = useState<ReadonlyMap<string, string>>(new Map());

  const result = useMemo((): PlayResult | string => {
    try {
      return playConversation(ctx, sid, { event, mode, assume, answers, prefer });
    } catch (e) {
      return errorText(e);
    }
  }, [ctx, sid, event, mode, assume, answers, prefer, version]);

  const events = useMemo(() => refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0)?.values ?? [], [ctx]);
  const characters = useMemo(() => {
    const out: { sid: string; label: string }[] = [];
    for (const r of ctx.records()) {
      if (ctx.typeName(r.type) !== 'CHARACTER') continue;
      if (!r.refs.get('dialogue')?.length && !r.refs.get('dialogue package')?.length) continue;
      out.push({ sid: r.stringId, label: `${plainName(ctx.localizedName(r.stringId) ?? ctx.name(r.stringId) ?? r.stringId)} — ${r.stringId}` });
    }
    return out.slice(0, 5000);
  }, [ctx, version]);

  /** Ответы, данные до шага `i`: при перевыборе на шаге `i` дальнейшие ответы теряют смысл. */
  const answersBefore = (steps: readonly PlayStep[], i: number): string[] => steps.slice(0, i).flatMap((s) => (s.answered !== undefined ? [s.answered] : []));

  const toggle = (id: string, passes: boolean): void => {
    const rec = ctx.get(id);
    const byMode = rec ? (mode === 'met' ? !rec.bools.get('locked') : false) : false;
    const next = new Map(assume);
    if (!passes === byMode) next.delete(id);
    else next.set(id, !passes);
    setAssume(next);
  };

  const name = (id: string): string => {
    const r = ctx.localizedName(id);
    return r !== undefined ? plainName(r) : (ctx.name(id) ?? id);
  };

  return (
    <div className="player" data-testid="player" data-sid={sid}>
      <div className="talk-bar">
        <label>
          {t.plCharacter}{' '}
          <input
            className="pl-character"
            data-testid="pl-character"
            list="pl-characters"
            placeholder={name(sid)}
            onChange={(e) => {
              const m = /— (\S+)$/.exec(e.target.value);
              if (m?.[1] !== undefined && ctx.get(m[1])) {
                onGo(m[1]);
                e.target.value = '';
              }
            }}
          />
          <datalist id="pl-characters">
            {characters.map((c) => (
              <option key={c.sid} value={c.label} />
            ))}
          </datalist>
        </label>
        <label>
          {t.talkEvent}{' '}
          <select
            className="pl-event"
            data-testid="pl-event"
            value={event}
            onChange={(e) => {
              setEvent(Number(e.target.value));
              setAnswers([]);
              setPrefer(new Map());
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
        <label title={t.plModeHint}>
          {t.plMode}{' '}
          <select
            data-testid="pl-mode"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value === 'none' ? 'none' : 'met');
              setAssume(new Map());
            }}
          >
            <option value="met">{t.plMode_met}</option>
            <option value="none">{t.plMode_none}</option>
          </select>
        </label>
        <span className="spacer" />
        {assume.size > 0 && (
          <button className="small" data-testid="pl-reset-asif" onClick={() => { setAssume(new Map()); }}>
            {t.plResetAsIf} ({assume.size})
          </button>
        )}
        <button className="small" data-testid="pl-restart" onClick={() => { setAnswers([]); setPrefer(new Map()); }}>
          ⟲ {t.plRestart}
        </button>
      </div>
      <AsInGame
        sid={sid}
        event={event}
        editorChoice={typeof result === 'string' ? undefined : result.steps[0]?.path[0]?.node}
        onGo={onGo}
        name={name}
      />
      {typeof result === 'string' ? (
        <p className="error">{result}</p>
      ) : (
        <ol className="pl-steps">
          {result.steps.map((s, i) => (
            <Step
              key={`${String(i)}:${s.from}`}
              ctx={ctx}
              tr={tr}
              t={t}
              step={s}
              index={i}
              npcName={name(sid)}
              dialog={result.steps[0]?.path[0]?.node}
              last={i === result.steps.length - 1}
              waiting={result.waiting}
              name={name}
              onGo={onGo}
              onSelectLine={onSelectLine}
              onToggle={toggle}
              onPrefer={(key, choice) => {
                const p = new Map(prefer);
                p.set(key, choice);
                setPrefer(p);
                setAnswers(answersBefore(result.steps, i));
              }}
              onAnswer={(a) => {
                setAnswers([...answersBefore(result.steps, i), a]);
              }}
              onBack={() => {
                setAnswers(answersBefore(result.steps, i));
              }}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

interface StepProps {
  ctx: ModContext;
  tr: TranslationIndex | undefined;
  t: Strings;
  step: PlayStep;
  index: number;
  npcName: string;
  dialog: string | undefined;
  last: boolean;
  waiting: boolean;
  name: (sid: string) => string;
  onGo: (sid: string) => void;
  onSelectLine: (sid: string, dialog?: string) => void;
  onToggle: (sid: string, passes: boolean) => void;
  onPrefer: (key: string, sid: string) => void;
  onAnswer: (sid: string) => void;
  onBack: () => void;
}

function Step(p: StepProps): ReactNode {
  const { ctx, tr, t, step, index, dialog } = p;
  const caption = (id: string): string => lineCaption(ctx, id, tr);
  const speaker = (id: string): string => {
    const sp = ctx.get(id)?.ints.get('speaker') ?? 0;
    if (sp === 0) return p.npcName;
    if (sp === 1 || sp === 2) return t.plPlayer;
    const def = getEnum(ctx.schema, 'TalkerEnum');
    return def ? shortEnumLabel(def, sp) : String(sp);
  };
  return (
    <li className="pl-step" data-testid="pl-step" data-index={index}>
      {step.options.length > 0 && (
        <Choice
          {...p}
          title={index === 0 ? t.plWhichDialog : t.plWhichLine}
          options={step.options}
          keyOf={step.from}
          isDialog={index === 0}
        />
      )}
      {step.path
        .filter((l) => l.options.length > 1 || l.options.some((o) => !o.always))
        .map((l) => (
          <Choice key={l.node} {...p} title={`${t.plInside} ${index === 0 && l.node === dialog ? `«${p.name(l.node)}»` : caption(l.node)}`} options={l.options} keyOf={l.node} isDialog={false} />
        ))}
      {step.said !== undefined && (
        <div className="pl-said" data-testid="pl-said" data-sid={step.said}>
          <span className="pl-speaker">{speaker(step.said)}:</span>{' '}
          <button className="link" title={t.plOpenLine} onClick={() => { p.onSelectLine(step.said!, dialog); }}>
            {caption(step.said)}
          </button>
        </div>
      )}
      {(step.answers.length > 0 || step.npcToo) && (
        <Answers {...p} answers={step.answers} />
      )}
      {step.end !== undefined && (
        <div className="pl-end small" data-testid="pl-end" data-end={step.end}>
          ⏹ {step.end === 'nothing-next' ? t.plEndNext : t.plEndFits}
        </div>
      )}
    </li>
  );
}

function Answers(p: StepProps & { answers: readonly PlayAnswer[] }): ReactNode {
  const { t, step, ctx, tr } = p;
  const answered = step.answered;
  return (
    <div className="pl-answers">
      <div className="small muted">{answered === undefined ? t.plChooseAnswer : t.plAnswered}</div>
      {p.answers.map((a) => {
        const chosen = answered === a.sid;
        return (
          <div key={a.sid} className={`pl-answer-row${a.shown ? '' : ' pl-hidden'}${chosen ? ' pl-chosen' : ''}`}>
            <button
              className="pl-answer"
              data-testid={a.shown ? 'pl-answer' : 'pl-answer-hidden'}
              data-sid={a.sid}
              disabled={!a.shown}
              title={a.shown ? undefined : t.plHiddenHint}
              onClick={() => { p.onAnswer(a.sid); }}
            >
              {chosen ? '▶ ' : '→ '}
              {lineCaption(ctx, a.sid, tr)}
            </button>
            {!a.always && <AsIf {...p} sid={a.sid} passes={a.shown} />}
          </div>
        );
      })}
      {step.npcToo && (
        <div className={`pl-answer-row${answered === PLAY_NPC ? ' pl-chosen' : ''}`}>
          <button className="pl-answer" data-testid="pl-npc" title={t.plNpcHint} onClick={() => { p.onAnswer(PLAY_NPC); }}>
            ↪ {t.plNpc}
          </button>
        </div>
      )}
      {answered !== undefined && (
        <button className="link small" data-testid="pl-back" onClick={p.onBack}>
          ↶ {t.plBack}
        </button>
      )}
    </div>
  );
}

function AsIf(p: StepProps & { sid: string; passes: boolean }): ReactNode {
  const conds = conditionsOf(p.ctx, p.sid, p.tr);
  return (
    <label className="pl-asif small" data-testid="pl-asif" data-sid={p.sid} title={conds.length ? `${p.t.talkConditions}: ${conds.join('; ')}` : undefined}>
      <input
        type="checkbox"
        checked={p.passes}
        onChange={() => {
          p.onToggle(p.sid, p.passes);
        }}
      />{' '}
      {p.t.plAsIf}
      {conds.length > 0 && <span className="muted mono pl-conds"> ({conds.join('; ')})</span>}
    </label>
  );
}

function Choice(p: StepProps & { title: string; options: readonly PlayOption[]; keyOf: string; isDialog: boolean }): ReactNode {
  const { t, ctx, tr } = p;
  return (
    <div className="pl-choice">
      <div className="small pl-choice-title">{p.title}</div>
      <table className="table pl-table">
        <tbody>
          {p.options.map((o) => {
            const rec = ctx.get(o.sid);
            const parts = rec ? dialogueScore(ctx, rec).parts : [];
            return (
              <tr key={o.sid} className={`pl-opt pl-${o.why}`} data-testid="pl-option" data-sid={o.sid} data-why={o.why}>
                <td className="pl-mark">{o.why === 'chosen' || o.why === 'chosen-random' ? '▶' : ''}</td>
                <td>
                  <button
                    className="link"
                    onClick={() => {
                      if (p.isDialog) p.onGo(o.sid);
                      else p.onSelectLine(o.sid, p.dialog);
                    }}
                  >
                    {p.isDialog ? p.name(o.sid) : lineCaption(ctx, o.sid, tr)}
                  </button>
                  {p.isDialog && o.sources && o.sources.length > 0 && (
                    <span className="muted small"> · {[...new Set(o.sources.map((s) => t[`talkVia_${s.via}`]))].join(', ')}</span>
                  )}
                </td>
                <td className="mono small" title={partsText(parts, t)}>
                  {o.score}
                </td>
                <td className="small" data-testid="pl-why">
                  {whyText(o, t)}
                  {o.why === 'random' && (
                    <>
                      {' '}
                      <button className="link small" data-testid="pl-prefer" onClick={() => { p.onPrefer(p.keyOf, o.sid); }}>
                        {t.plPrefer}
                      </button>
                    </>
                  )}
                </td>
                <td>{!o.always && o.why !== 'missing' && <AsIf {...p} sid={o.sid} passes={o.passes} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function whyText(o: PlayOption, t: Strings): string {
  switch (o.why) {
    case 'chosen':
      return t.plWhy_chosen;
    case 'chosen-random':
      return `${t.plWhy_chosenRandom} (${t.talkChance} ${pct(o.odds)})`;
    case 'random':
      return `${t.plWhy_random} (${t.talkChance} ${pct(o.odds)})`;
    case 'outscored':
      return t.plWhy_outscored;
    case 'fails':
      return t.plWhy_fails;
    case 'empty':
      return t.plWhy_empty;
    case 'missing':
      return t.talkWhy_missing;
  }
}

/** Пример к правилу выбора на выбранном персонаже: сколько диалогов, что выберет игра при условиях и без. */
export function TalkExample({ project, sid, version }: { project: Project; sid: string | undefined; version: number }): ReactNode {
  const t = useT();
  const ctx = project.ctx;
  const tr = useTranslation(project);
  const data = useMemo(() => {
    const rec = sid === undefined ? undefined : ctx.get(sid);
    if (sid === undefined || !rec || ctx.typeName(rec.type) !== 'CHARACTER') return undefined;
    try {
      const count = playStartList(ctx, sid, EVENT_TALK).size;
      const pick = (mode: PlayMode): { dialog?: string; why?: PlayOption['why']; said?: string } => {
        const s = playConversation(ctx, sid, { mode, limit: 1 }).steps[0];
        const o = s?.options.find((x) => x.why === 'chosen' || x.why === 'chosen-random');
        return { ...(o ? { dialog: o.sid, why: o.why } : {}), ...(s?.said !== undefined ? { said: s.said } : {}) };
      };
      return { sid, count, met: pick('met'), none: pick('none') };
    } catch {
      return undefined;
    }
  }, [ctx, sid, version]);
  const name = (id: string): string => {
    const r = ctx.localizedName(id);
    return r !== undefined ? plainName(r) : (ctx.name(id) ?? id);
  };
  if (!data) return <p className="muted small">{t.howtoPick}</p>;
  const line = (label: string, p: { dialog?: string; why?: PlayOption['why']; said?: string }): ReactNode => (
    <li>
      {label}{' '}
      {p.dialog === undefined ? (
        <b>{t.howtoNothing}</b>
      ) : (
        <>
          <b>«{name(p.dialog)}»</b>
          {p.why === 'chosen-random' && <span className="muted"> ({t.plWhy_chosenRandom})</span>}
          {p.said !== undefined && (
            <>
              ; {t.howtoSays}: <i>{lineCaption(ctx, p.said, tr)}</i>
            </>
          )}
        </>
      )}
    </li>
  );
  return (
    <div className="howto-example" data-testid="howto-example">
      <div className="group-title">{t.howtoExample}</div>
      {data.count === 0 ? (
        <p>
          <b>{name(data.sid)}</b> — {t.howtoNoDialogs}
        </p>
      ) : (
        <>
          <p>
            <b>{name(data.sid)}</b> — {t.howtoHas} {data.count}.
          </p>
          <ul>
            {line(t.howtoMet, data.met)}
            {line(t.howtoNone, data.none)}
          </ul>
        </>
      )}
      <p className="muted small">{t.howtoTry}</p>
    </div>
  );
}
