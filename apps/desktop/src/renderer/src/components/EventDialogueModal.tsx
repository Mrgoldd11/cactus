/**
 * «New dialogue on event» window (G6). One form with three numbered steps: the event; who says it
 * (everyone with a package, or a character / squad / faction package field, optionally only one
 * race); the lines and the dialogue conditions. Under them the «what happens with the score» line
 * from the core (`eventDialogueScore`): the bonus, the strongest rival and the tie. The caller
 * creates the dialogue (`createEventDialogue`, one undo step).
 * «Make one like it…» of the «▶ Play» strip (G7) opens it filled from a sample dialogue
 * (`eventDialogueLike`): race, conditions, the line chain, the repetition limit and «monologue».
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  CONDITION_HELP,
  conditionPhrase,
  dialogPickItems,
  EVENT_TALK,
  eventDialogueBaseName,
  eventDialogueLike,
  eventDialogueProblem,
  eventDialogueScore,
  eventDialogueTarget,
  eventHelp,
  fieldEnum,
  freeRecordName,
  holderFields,
  lineRefPhrase,
  uiText,
  type DialogPickItem,
  type DialogWhen,
  type EventDialogueScore,
  type EventDialogueSpec,
  type EventDialogueWho,
} from '@kenshi-editor/core';
import { recordName } from '../data-names.ts';
import { useLang, useT } from '../i18n.ts';
import type { Project } from '../project.ts';
import { EventSelect, eventEnum, eventText } from './EventUi.tsx';
import { DialogPicker } from './LinePanelParts.tsx';
import { boolCondition, YesNoSelect } from './DialogHelpUi.tsx';
import { enumText, useFcsCodes, withoutCode } from '../fcs-codes.ts';
import { RecordPicker } from './RecordPicker.tsx';
import { Modal } from './widgets.tsx';

export type EventDialogueKind = 'package' | 'character' | 'squad' | 'faction';

const KINDS: readonly EventDialogueKind[] = ['package', 'character', 'squad', 'faction'];
const KIND_TYPE: Readonly<Record<EventDialogueKind, string>> = {
  package: 'DIALOGUE_PACKAGE',
  character: 'CHARACTER',
  squad: 'SQUAD_TEMPLATE',
  faction: 'FACTION',
};
/** ComparisonEnum: 0 `=`, 1 `<`, 2 `>`. */
const CMP_SYMBOLS = ['=', '<', '>'];

export interface EventDialoguePreset {
  /** EventTriggerEnum value to start with. */
  event?: number;
  /** A package, character, squad or faction to start with (other records are ignored). */
  who?: string;
  /** A DIALOGUE to copy: race, conditions, lines, repetition limit and «monologue» («Make one like it…»). */
  like?: string;
}

/** A DC_ condition (who / comparison / value) or a reference category with its target record. */
type CondRow = { item: DialogPickItem; who: number; cmp: number; v: number } | { item: DialogPickItem; target: string };

interface LineDraft {
  speaker: number;
  texts: string[];
}

interface Props {
  project: Project;
  preset: EventDialoguePreset;
  onCreate: (spec: EventDialogueSpec) => void;
  onClose: () => void;
}

function kindOf(project: Project, sid: string | undefined): EventDialogueKind | undefined {
  const type = sid !== undefined ? project.entry(sid)?.type : undefined;
  return KINDS.find((k) => KIND_TYPE[k] === type);
}

/** The window's rows for the sample's conditions; what the rows cannot show (world states) stays as is. */
function likeConds(items: readonly DialogPickItem[], when: readonly DialogWhen[]): { rows: CondRow[]; extra: DialogWhen[] } {
  const rows: CondRow[] = [];
  const extra: DialogWhen[] = [];
  for (const w of when) {
    if ('cond' in w && w.tag === undefined) {
      const item = items.find((i) => i.source === 'enum' && i.value === w.cond);
      if (item) {
        rows.push({ item, who: w.who, cmp: w.cmp ?? 0, v: w.v });
        continue;
      }
    } else if ('ref' in w) {
      const item = items.find((i) => i.source === 'ref' && i.category === w.ref);
      if (item) {
        for (const target of w.targets) rows.push({ item, target });
        continue;
      }
    }
    extra.push(w);
  }
  return { rows, extra };
}

function condWhen(row: CondRow): DialogWhen {
  if ('target' in row) return { ref: row.item.category ?? '', targets: [row.target] };
  return { cond: row.item.value ?? 0, who: row.who, v: row.v, cmp: row.cmp };
}

export function EventDialogueModal({ project, preset, onCreate, onClose }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const codes = useFcsCodes();
  const ctx = project.ctx;
  const evDef = useMemo(() => eventEnum(ctx), [ctx]);
  const repDef = useMemo(() => fieldEnum(ctx.schema, 'DIALOGUE', 'repetition limit'), [ctx]);
  const presetKind = kindOf(project, preset.who);
  // «Make one like it…»: the sample, read once when the window opens.
  const [like] = useState(() => {
    const d = preset.like !== undefined ? eventDialogueLike(ctx, preset.like) : undefined;
    return d ? { ...d, ...likeConds(dialogPickItems(ctx, 'DIALOGUE', 'condition', lang), d.when) } : undefined;
  });

  const [event, setEvent] = useState(preset.event ?? 0);
  const [kind, setKind] = useState<EventDialogueKind>(presetKind ?? 'package');
  const [whoSid, setWhoSid] = useState<string | undefined>(presetKind !== undefined ? preset.who : undefined);
  const [field, setField] = useState<string | undefined>();
  const [fieldPkg, setFieldPkg] = useState<string | undefined>();
  const [own, setOwn] = useState(false);
  const [raceOn, setRaceOn] = useState(like?.race !== undefined);
  const [race, setRace] = useState<string | undefined>(like?.race);
  const [lines, setLines] = useState<LineDraft[]>(() => like?.lines.map((l) => ({ speaker: l.speaker, texts: [...l.texts] })) ?? [{ speaker: 0, texts: [''] }]);
  const [mono, setMono] = useState<boolean | undefined>(like?.monologue);
  const [conds, setConds] = useState<CondRow[]>(like?.rows ?? []);
  const [rep, setRep] = useState<number | undefined>(like?.rep);
  const [name, setName] = useState<string | undefined>();
  const [bonus, setBonus] = useState<number | undefined>();
  const [condPick, setCondPick] = useState(false);
  const [pick, setPick] = useState<'who' | 'race' | DialogPickItem | undefined>();

  const whoType = whoSid !== undefined ? project.entry(whoSid)?.type : undefined;
  const fields = kind === 'package' || whoType === undefined ? [] : holderFields(whoType);
  const curField = field !== undefined && fields.includes(field) ? field : fields[0];
  const who = useMemo((): EventDialogueWho | undefined => {
    if (whoSid === undefined || whoType !== KIND_TYPE[kind]) return undefined;
    if (kind === 'package') return { kind: 'package', pkg: whoSid };
    if (curField === undefined) return undefined;
    const w: EventDialogueWho = { kind: 'holder', sid: whoSid, field: curField, own };
    if (fieldPkg !== undefined) w.pkg = fieldPkg;
    return w;
  }, [whoSid, whoType, kind, curField, own, fieldPkg]);
  const target = useMemo(() => (who ? eventDialogueTarget(ctx, who) : undefined), [ctx, who]);
  // The shared package option keeps its own count while «own package» is chosen (it is not the target then).
  const shared = useMemo(() => (who?.kind === 'holder' && who.own ? eventDialogueTarget(ctx, { ...who, own: false }) : target), [ctx, who, target]);

  const eventCode = evDef?.values.find((v) => v.value === event)?.name;
  const holderRaw = whoSid !== undefined ? ctx.name(whoSid) || whoSid : '';
  const raceSid = raceOn ? race : undefined;
  const autoName = event === 0 ? '' : freeRecordName(ctx, 'DIALOGUE', eventDialogueBaseName(raceSid !== undefined ? `${holderRaw} ${ctx.name(raceSid)}` : holderRaw, eventCode, event));
  const when = useMemo(() => [...conds.map(condWhen), ...(like?.extra ?? [])], [conds, like]);
  const monologue = mono ?? event !== EVENT_TALK;

  // The spec without the repetition limit and the bonus: they default from the score.
  const draft = useMemo((): EventDialogueSpec | undefined => {
    if (!who) return undefined;
    const s: EventDialogueSpec = { event, who, name: name ?? autoName, lines: lines.map((l) => ({ speaker: l.speaker, texts: l.texts })), when, monologue };
    if (raceSid !== undefined) s.race = raceSid;
    return s;
  }, [who, event, name, autoName, lines, when, monologue, raceSid]);
  const score = useMemo((): EventDialogueScore | undefined => {
    if (!draft || event <= 0) return undefined;
    try {
      return eventDialogueScore(ctx, draft);
    } catch {
      return undefined;
    }
  }, [ctx, draft, event]);
  const autoRep = (score?.bestDialog !== undefined ? ctx.get(score.bestDialog)?.ints.get('repetition limit') : undefined) ?? 0;
  const spec = useMemo((): EventDialogueSpec | undefined => {
    if (!draft) return undefined;
    const s: EventDialogueSpec = { ...draft, rep: rep ?? autoRep };
    if (bonus !== undefined) s.scoreBonus = bonus;
    return s;
  }, [draft, rep, autoRep, bonus]);
  const shown = score && spec ? (bonus !== undefined ? { ...score, bonus, key: score.base + bonus } : score) : undefined;

  const problem = ((): string | undefined => {
    if (!spec) return t.edPickTitles[kind];
    if (raceOn && race === undefined) return t.edPickTitles['race'];
    const p = eventDialogueProblem(ctx, spec);
    return p ? uiText(p, lang) : undefined;
  })();

  const setLine = (i: number, f: (l: LineDraft) => LineDraft): void => {
    setLines((ls) => ls.map((l, k) => (k === i ? f(l) : l)));
  };
  const addCond = (item: DialogPickItem): void => {
    setCondPick(false);
    if (item.source === 'ref') {
      setPick(item);
      return;
    }
    const number = CONDITION_HELP[item.code]?.kind === 'number';
    setConds((cs) => [...cs, { item, who: 0, cmp: number ? 2 : 0, v: number ? 0 : 1 }]);
  };

  const condText = (row: CondRow): string =>
    'target' in row
      ? lineRefPhrase(row.item.category ?? '', [recordName(ctx, row.target)], lang, 'dialogue').short
      : conditionPhrase({ cond: row.item.code, who: row.who, cmp: row.cmp, value: row.v, fallbackLabel: row.item.label }, lang, 'dialogue').short;

  const whoName = whoSid !== undefined ? recordName(ctx, whoSid) : undefined;
  const pkgLabel = target?.pkg !== undefined ? recordName(ctx, target.pkg) : freeRecordName(ctx, 'DIALOGUE_PACKAGE', `${holderRaw} dialogues`);
  const evLabel = eventText(evDef, event, lang, codes);
  const will = spec
    ? (target?.pkg === undefined && whoName !== undefined ? t.edWillPkg(pkgLabel, whoName) : '') +
      t.edWillNew(name ?? autoName, lines.length, pkgLabel, evLabel)
    : undefined;

  const scoreLines = ((): string[] => {
    if (!shown) return [];
    if (shown.best === undefined) return [t.edScoreAlone];
    const rival = shown.bestDialog !== undefined ? recordName(ctx, shown.bestDialog) : '';
    const out = [`${t.edScoreVs(shown.key, shown.best, rival)}: ${t.edOutcome[outcomeOf(shown.key, shown.best)] ?? ''}`];
    const locked = shown.rivals.filter((r) => r.locked).length;
    const why =
      bonus !== undefined
        ? t.edBonusManual(bonus, shown.autoBonus)
        : shown.autoBonus > 0
          ? shown.conditional
            ? t.edBonusWhyCond(shown.autoBonus)
            : t.edBonusWhyPlain(shown.autoBonus)
          : '';
    out.push([why, t.edWithout(shown.base, shown.best, shown.outcomeWithout)].filter(Boolean).join(' ') + (locked > 0 ? t.edLocked(locked) : ''));
    return out;
  })();

  const unused = eventCode !== undefined && eventHelp(eventCode)?.unused === true;
  const pickType = pick === 'who' ? KIND_TYPE[kind] : pick === 'race' ? 'RACE' : pick?.targetType;
  const pickTitle = pick === 'who' ? t.edPickTitles[kind]! : pick === 'race' ? t.edPickTitles['race']! : pick ? t.edPickTarget(pick.label) : '';

  return (
    <>
      <Modal
        title={t.edTitle}
        onClose={onClose}
        wide
        testId="event-dialogue-modal"
        footer={
          <>
            <span className="grow ed-will" data-testid="ed-will">
              {will !== undefined && (
                <>
                  <b>{t.edWill}:</b> {will}
                </>
              )}
            </span>
            <button onClick={onClose}>{t.cancel}</button>
            <button
              className="primary"
              disabled={problem !== undefined}
              title={problem}
              data-testid="ed-create"
              onClick={() => {
                if (problem === undefined && spec) onCreate(spec);
              }}
            >
              {t.create}
            </button>
          </>
        }
      >
        <div className="ed-form">
          {like && preset.like !== undefined && (
            <div className="hint ed-like" data-testid="ed-like" data-sid={preset.like}>
              {t.psLikeFrom(recordName(ctx, preset.like))}
              {like.extra.length > 0 && ` ${t.psLikeExtra(like.extra.length)}`}
            </div>
          )}
          <section className="ed-step">
            <h4>
              <span className="ed-num">1</span> {t.edStepEvent}
            </h4>
            <div className="hint">{t.edEventIntro}</div>
            {evDef ? (
              <EventSelect def={evDef} value={event} onChange={setEvent} testId="ed-event" />
            ) : (
              <input type="number" value={event} data-testid="ed-event" onChange={(e) => { setEvent(Number(e.target.value) || 0); }} />
            )}
            {unused && <div className="ed-warn">{t.edUnusedWarn}</div>}
          </section>

          <section className="ed-step">
            <h4>
              <span className="ed-num">2</span> {t.edStepWho}
            </h4>
            <div className="ed-kinds" role="radiogroup">
              {KINDS.map((k) => (
                <label key={k} title={t.edKindTips[k]}>
                  <input
                    type="radio"
                    name="ed-kind"
                    checked={kind === k}
                    data-testid={`ed-kind-${k}`}
                    onChange={() => {
                      setKind(k);
                      setWhoSid(undefined);
                      setFieldPkg(undefined);
                    }}
                  />
                  {t.edKinds[k]}
                </label>
              ))}
            </div>
            <div className="ed-row">
              <button data-testid="ed-who" onClick={() => { setPick('who'); }} title={t.edKindTips[kind]}>
                {whoSid !== undefined && whoType === KIND_TYPE[kind] ? recordName(ctx, whoSid) : t.edPick}
              </button>
              {kind === 'package' && target && <span className="hint">{t.edHolders(target.sharedBy)}</span>}
              {fields.length > 1 && (
                <label>
                  {t.edField}{' '}
                  <select value={curField} data-testid="ed-field" onChange={(e) => { setField(e.target.value); }}>
                    {fields.map((f) => (
                      <option key={f} value={f}>
                        {withoutCode(t.edFields[f] ?? f, codes)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {kind !== 'package' && target && (
              <div className="ed-row">
                {target.existing.length === 0 ? (
                  <span className="hint" data-testid="ed-no-pkg">
                    {t.edNoPkg(pkgLabel)}
                  </span>
                ) : (
                  <>
                    <label>
                      <input type="radio" name="ed-own" checked={!own} data-testid="ed-shared" onChange={() => { setOwn(false); }} />
                      {t.edShared(recordName(ctx, shared?.pkg ?? target.existing[0]!), shared?.pkg !== undefined ? shared.sharedBy : 0)}
                    </label>
                    {target.existing.length > 1 && !own && (
                      <select value={target.pkg} onChange={(e) => { setFieldPkg(e.target.value); }}>
                        {target.existing.map((p) => (
                          <option key={p} value={p}>
                            {recordName(ctx, p)}
                          </option>
                        ))}
                      </select>
                    )}
                    <label>
                      <input type="radio" name="ed-own" checked={own} data-testid="ed-own" onChange={() => { setOwn(true); }} />
                      {t.edOwn}
                    </label>
                  </>
                )}
              </div>
            )}
            <div className="ed-row" title={t.edRaceTip}>
              <label>
                <input type="checkbox" checked={raceOn} data-testid="ed-race-on" onChange={(e) => { setRaceOn(e.target.checked); }} />
                {t.edOnlyRace}
              </label>
              {raceOn && (
                <button data-testid="ed-race" onClick={() => { setPick('race'); }}>
                  {race !== undefined ? recordName(ctx, race) : t.edPick}
                </button>
              )}
            </div>
          </section>

          <section className="ed-step">
            <h4>
              <span className="ed-num">3</span> {t.edStepLines}
            </h4>
            {lines.map((l, i) => (
              <div className="ed-line" key={i} data-testid="ed-line">
                <div className="ed-row">
                  <b>{i === 0 ? t.edLine(1) : t.edLineAfter(i + 1)}</b>
                  <span>{t.edSpeaker}</span>
                  <select value={l.speaker} data-testid="ed-speaker" onChange={(e) => { setLine(i, (x) => ({ ...x, speaker: Number(e.target.value) })); }}>
                    <option value={0}>{t.edSpeakerMe}</option>
                    <option value={1}>{t.edSpeakerTarget}</option>
                  </select>
                  <span className="grow" />
                  {lines.length > 1 && (
                    <button className="small" title={t.edRemoveLine} onClick={() => { setLines((ls) => ls.filter((_, k) => k !== i)); }}>
                      ✕
                    </button>
                  )}
                </div>
                {l.texts.map((text, j) => (
                  <div className="ed-row" key={j}>
                    <textarea
                      rows={2}
                      value={text}
                      placeholder={t.edTextPlaceholder}
                      data-testid="ed-text"
                      onChange={(e) => {
                        const v = e.target.value;
                        setLine(i, (x) => ({ ...x, texts: x.texts.map((s, k) => (k === j ? v : s)) }));
                      }}
                    />
                    {l.texts.length > 1 && (
                      <button className="small" title={t.edRemoveVariant} onClick={() => { setLine(i, (x) => ({ ...x, texts: x.texts.filter((_, k) => k !== j) })); }}>
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <div className="ed-row">
                  <button className="small" data-testid="ed-add-variant" onClick={() => { setLine(i, (x) => ({ ...x, texts: [...x.texts, ''] })); }}>
                    {t.edAddVariant}
                  </button>
                  {l.texts.length > 1 && <span className="hint">{t.edVariantHint}</span>}
                </div>
              </div>
            ))}
            <div className="ed-row">
              <button className="small" data-testid="ed-add-line" onClick={() => { setLines((ls) => [...ls, { speaker: ls.length % 2, texts: [''] }]); }}>
                {t.edAddLine}
              </button>
              <span className="grow" />
              <label title={t.edMonologueHint}>
                <input type="checkbox" checked={monologue} data-testid="ed-monologue" onChange={(e) => { setMono(e.target.checked); }} />
                {t.edMonologue}
              </label>
            </div>

            <div className="ed-conds" data-testid="ed-conds">
              <b>{t.edConds}:</b> {conds.length === 0 && raceSid === undefined && <span className="hint">{t.edCondsNone}</span>}
              {raceSid !== undefined && <div className="ed-cond">{lineRefPhrase('my race', [recordName(ctx, raceSid)], lang, 'dialogue').short}</div>}
              {conds.map((row, i) => (
                <div className="ed-cond ed-row" key={i} data-testid="ed-cond" title={row.item.code}>
                  <span className="grow">{condText(row)}</span>
                  {!('target' in row) && (
                    <>
                      <select
                        value={row.who}
                        title={t.edCondWho}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setConds((cs) => cs.map((c, k) => (k === i ? { ...row, who: v } : c)));
                        }}
                      >
                        <option value={0}>{t.edSpeakerMe}</option>
                        <option value={1}>{t.edSpeakerTarget}</option>
                      </select>
                      {CONDITION_HELP[row.item.code]?.kind === 'bool' && boolCondition(row.cmp, row.v) !== undefined ? (
                        <YesNoSelect
                          value={boolCondition(row.cmp, row.v)!}
                          testId="ed-cond-yes"
                          onChange={(yes) => {
                            setConds((cs) => cs.map((c, k) => (k === i ? { ...row, cmp: 0, v: yes ? 1 : 0 } : c)));
                          }}
                        />
                      ) : (
                        <>
                        <select
                          value={row.cmp}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setConds((cs) => cs.map((c, k) => (k === i ? { ...row, cmp: v } : c)));
                          }}
                        >
                          {CMP_SYMBOLS.map((s, k) => (
                            <option key={k} value={k}>
                              {s}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          className="ed-num-input"
                          value={row.v}
                          title={t.edCondValue}
                          onChange={(e) => {
                            const v = Number(e.target.value) || 0;
                            setConds((cs) => cs.map((c, k) => (k === i ? { ...row, v } : c)));
                          }}
                        />
                        </>
                      )}
                    </>
                  )}
                  <button className="small" title={t.edRemoveCond} onClick={() => { setConds((cs) => cs.filter((_, k) => k !== i)); }}>
                    ✕
                  </button>
                </div>
              ))}
              {condPick ? (
                <DialogPicker ctx={ctx} ownerType="DIALOGUE" kind="condition" onPick={addCond} onClose={() => { setCondPick(false); }} />
              ) : (
                <button className="small" data-testid="ed-add-cond" onClick={() => { setCondPick(true); }}>
                  {t.edAddCond}
                </button>
              )}
            </div>

            <div className="ed-grid">
              <label title={t.edRepTip}>{t.edRep}</label>
              {repDef ? (
                <select value={rep ?? autoRep} data-testid="ed-rep" title={t.edRepTip} onChange={(e) => { setRep(Number(e.target.value)); }}>
                  {repDef.values.map((v) => (
                    <option key={v.value} value={v.value}>
                      {enumText(repDef, v.value, lang, codes)}
                    </option>
                  ))}
                </select>
              ) : (
                <input type="number" value={rep ?? autoRep} data-testid="ed-rep" onChange={(e) => { setRep(Number(e.target.value) || 0); }} />
              )}
              <label>{t.edName}</label>
              <input value={name ?? autoName} data-testid="ed-name" placeholder={t.edNameLater} title={t.edNameTip} onChange={(e) => { setName(e.target.value); }} />
              <label>{t.edBonus}</label>
              <span className="ed-row">
                <input
                  type="number"
                  className="ed-num-input"
                  data-testid="ed-bonus"
                  value={bonus ?? score?.autoBonus ?? 0}
                  onChange={(e) => { setBonus(Math.max(0, Math.round(Number(e.target.value) || 0))); }}
                />
                {bonus !== undefined && (
                  <button className="small" title={t.edBonusAutoTip} data-testid="ed-bonus-auto" onClick={() => { setBonus(undefined); }}>
                    {t.edBonusAuto}
                  </button>
                )}
              </span>
            </div>
          </section>

          {scoreLines.length > 0 && (
            <div className={`ed-score ed-score-${shown ? outcomeOf(shown.key, shown.best) : 'alone'}`} data-testid="ed-score">
              <div className="ed-score-lead" data-testid="ed-score-lead">{t.edScoreLead}</div>
              <b>{t.edScoreTitle}:</b>
              {scoreLines.map((s, i) => (
                <div key={i}>{s}</div>
              ))}
            </div>
          )}
        </div>
      </Modal>
      {pick !== undefined && (
        <RecordPicker
          project={project}
          title={pickTitle}
          targetType={pickType}
          exclude={new Set()}
          onPick={(sid) => {
            if (pick === 'who') {
              setWhoSid(sid);
              setFieldPkg(undefined);
              setOwn(false);
            } else if (pick === 'race') setRace(sid);
            else setConds((cs) => [...cs, { item: pick, target: sid }]);
            setPick(undefined);
          }}
          onClose={() => { setPick(undefined); }}
        />
      )}
    </>
  );
}

/** The outcome of `key` against the strongest rival (the core rule, for a bonus set by hand). */
function outcomeOf(key: number, best: number | undefined): 'alone' | 'first' | 'tie' | 'shadowed' {
  return best === undefined ? 'alone' : key > best ? 'first' : key === best ? 'tie' : 'shadowed';
}
