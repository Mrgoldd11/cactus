/**
 * Line (and dialogue) inspector: speaker, texts (English — editable, Russian — game translation),
 * conditions and effects with names from the game enums, score and chance, what comes next (answer order,
 * links), where the line is heard. Everything via core commands: one undo per edit.
 *
 * Vanilla lines are edited just like your own: the mod stores the difference on top of the game. «As in game»
 * shows the original record, «Restore as in game» removes the mod edits.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  addCondition,
  addEffect,
  addLine,
  canMoveLine,
  CHOICE_SPEAKERS,
  conditionOf,
  decodeText,
  deleteLine,
  describeDialogAction,
  dialogActionPhrase,
  dialogEnumUsage,
  dialogValueHelp,
  dialogueScore,
  duplicateLine,
  effectOf,
  fieldEnum,
  formatScoreParts,
  getEnum,
  lineParents,
  lineTexts,
  linkLine,
  LINE_REF_HELP,
  linksChanged,
  moveCopies,
  moveLine,
  removeAction,
  removedLinks,
  recordPhrases,
  revertLine,
  revertLinks,
  setLineTexts,
  quote,
  shortEnumLabel,
  translatedText,
  unlinkLine,
  uiText,
  updateCondition,
  updateEffect,
  type DialogEnumUsage,
  type EnumDef,
  type EnumValue,
  type GameRecord,
  type ModContext,
  type Reference,
  type TranslationIndex,
} from '@kenshi-editor/core';
import { useDataLocale, useLang, useT, type Strings } from '../i18n.ts';
import { useGameTexts } from '../data-names.ts';
import type { Project } from '../project.ts';
import { tryEdit } from '../hooks.ts';
import { CommitInput } from './widgets.tsx';
import { PlaysWhen } from './EventUi.tsx';
import { DialogValueSelect, dialogOptionText, dialogOptionTip, PhraseLine } from './DialogHelpUi.tsx';

interface Props {
  project: Project;
  sid: string;
  /** The branch the line was selected from (for copy). */
  parent?: string;
  version: number;
  onGo: (sid: string) => void;
  /** Select a line (in the graph and here). */
  onSelect: (sid: string, parent?: string) => void;
  onReport: (err: string | undefined) => void;
}

/** Line choice fields: [dictionary, key, enum]. */
const LINE_FIELDS: readonly { key: string; dict: 'ints' | 'floats'; en?: string }[] = [
  { key: 'score bonus', dict: 'ints' },
  { key: 'chance temporary', dict: 'floats' },
  { key: 'chance permanent', dict: 'floats' },
  { key: 'repetition limit', dict: 'ints', en: 'DialogRepetitionEnum' },
  { key: 'target is type', dict: 'ints', en: 'CharacterTypeEnum' },
];

const usageCache = new WeakMap<ModContext, DialogEnumUsage>();

/** Which conditions and effects exist in the data (vanilla + dependencies) — computed once. */
/** Field label by translation string key (keys are built from the field name). */
function lnText(t: Strings, key: string): string {
  const v = (t as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : key;
}

function enumUsage(ctx: ModContext): DialogEnumUsage {
  let u = usageCache.get(ctx);
  if (!u) usageCache.set(ctx, (u = dialogEnumUsage(ctx)));
  return u;
}

/** Game texts of the data language; undefined while loading or when there is none. */
export function useTranslation(project: Project): TranslationIndex | undefined {
  return useGameTexts(project) ?? undefined;
}

/** Short line label: text (Russian if present) or name. */
export function lineCaption(ctx: ModContext, sid: string, tr: TranslationIndex | undefined, lang = 'en'): string {
  const r = ctx.get(sid) ?? ctx.lower(sid);
  if (!r) return sid;
  const en = r.strings.has('text0') ? decodeText(r.strings.get('text0')!) : '';
  const s = translatedText(tr, sid, 'text0', en) ?? en;
  const text = s === '' ? decodeText(r.name) : quote(s, lang);
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

function isChoice(rec: GameRecord | undefined): boolean {
  return rec !== undefined && CHOICE_SPEAKERS.has(rec.ints.get('speaker') ?? 0);
}

export function StatusBadge({ status }: { status: string | undefined }): ReactNode {
  const t = useT();
  if (status !== 'new' && status !== 'changed' && status !== 'deleted') return null;
  return (
    <span className={`st-badge st-${status}`} data-testid="status-badge" data-status={status}>
      {t[`lineStatus_${status}`]}
    </span>
  );
}

/** Enum value dropdown; `usage` — how many times the value occurs in the data (used ones first). */
function EnumSelect({ def, value, onChange, usage, testId }: { def: EnumDef; value: number; onChange: (v: number) => void; usage?: Map<number, number>; testId?: string }): ReactNode {
  const t = useT();
  const lang = useLang();
  const values = def.values.filter((v) => !v.name.endsWith('_END') || v.value === value);
  const used = usage ? values.filter((v) => usage.has(v.value) || v.value === value) : values;
  const unused = usage ? values.filter((v) => !usage.has(v.value) && v.value !== value) : [];
  const label = (v: EnumValue): string => dialogOptionText(def, v, lang);
  const tip = (v: EnumValue): string | undefined => dialogOptionTip(dialogValueHelp(def.name, v.name), lang);
  return (
    <select
      className="ln-select"
      value={value}
      data-testid={testId}
      onChange={(e) => {
        onChange(Number(e.target.value));
      }}
    >
      {!values.some((v) => v.value === value) && <option value={value}>{value}</option>}
      {usage ? (
        <>
          <optgroup label={t.lnUsedInGame}>
            {used.map((v) => (
              <option key={v.value} value={v.value} title={tip(v)}>
                {label(v)}
              </option>
            ))}
          </optgroup>
          {unused.length > 0 && (
            <optgroup label={t.lnUnusedInGame}>
              {unused.map((v) => (
                <option key={v.value} value={v.value} title={tip(v)}>
                  {label(v)} ⚠
                </option>
              ))}
            </optgroup>
          )}
        </>
      ) : (
        values.map((v) => (
          <option key={v.value} value={v.value} title={tip(v)}>
            {label(v)}
          </option>
        ))
      )}
    </select>
  );
}

function NumberInput({ value, onCommit, testId, int }: { value: number; onCommit: (v: number) => void; testId?: string; int?: boolean }): ReactNode {
  return (
    <CommitInput
      className="ln-num mono"
      value={String(value)}
      {...(testId !== undefined ? { testId } : {})}
      onCommit={(s) => {
        const n = Number(s.replace(',', '.'));
        if (Number.isFinite(n)) onCommit(int ? Math.round(n) : n);
      }}
    />
  );
}

export function LineInspector({ project, sid, parent, version, onGo, onSelect, onReport }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const tr = useTranslation(project);
  const [asInGame, setAsInGame] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMove, setConfirmMove] = useState<{ child: string; dir: -1 | 1; copies: string[] } | undefined>(undefined);
  useEffect(() => {
    setConfirmDelete(false);
    setConfirmMove(undefined);
  }, [sid]);

  const rec = ctx.get(sid);
  const lower = ctx.lower(sid);
  const status = ctx.status(sid);
  const shown = rec ?? lower;
  const parents = useMemo(() => lineParents(ctx, sid), [ctx, sid, version]);
  if (!shown) return <div className="panel-empty muted">{t.nothingToShow}</div>;
  const type = ctx.typeName(shown.type);
  const isLine = type === 'DIALOGUE_LINE';
  const edit = (fn: () => void): void => {
    onReport(tryEdit(fn));
  };
  const talker = getEnum(ctx.schema, 'TalkerEnum')!;
  const name = (s: string): string => lineCaption(ctx, s, tr, lang);

  return (
    <div className="panel-scroll line-inspector" data-testid="line-inspector" data-sid={sid}>
      <div className="ln-head">
        <span className={`dg-chip ${isLine ? (isChoice(shown) ? 'choice' : 'npc') : 'head'}`}>
          {isLine ? (isChoice(shown) ? t.dgPlayer : shortEnumLabel(talker, shown.ints.get('speaker') ?? 0, lang)) : type}
        </span>
        <span className="mono small muted" title={t.lnIdHint}>
          {sid}
        </span>
        <StatusBadge status={status} />
        <span className="spacer" />
        <button className="link small" onClick={() => { onGo(sid); }} title={t.lnOpenInspector}>
          ↗ {t.panel_inspector}
        </button>
      </div>
      <PlaysWhen ctx={ctx} sid={sid} type={type} version={version} onGo={onGo} />
      <div className="ln-actions">
        {lower && (
          <button className={`small${asInGame ? ' active' : ''}`} data-testid="ln-as-in-game" onClick={() => { setAsInGame(!asInGame); }}>
            ◎ {t.lnShowInGame}
          </button>
        )}
        {(status === 'changed' || status === 'deleted') && (
          <button className="small" data-testid="ln-revert" title={t.lnRevertHint} onClick={() => { edit(() => { if (isLine) revertLine(ctx, sid); else ctx.revertRecord(sid); }); }}>
            ↺ {t.lnRevert}
          </button>
        )}
        {isLine && rec && (
          <button
            className="small"
            data-testid="ln-duplicate"
            onClick={() => { edit(() => {
                const p = parent ?? parents[0];
                onSelect(duplicateLine(ctx, sid, p), p);
              }); }
            }
          >
            ⧉ {t.lnDuplicate}
          </button>
        )}
        {isLine && rec && (
          <button className="small danger" data-testid="ln-delete" onClick={() => { setConfirmDelete(true); }}>
            ✕ {t.lnDelete}
          </button>
        )}
      </div>
      {status === 'new' && <div className="ln-note muted small">{t.lnNewNote}</div>}
      {status === 'deleted' && <div className="ln-note warn small">{t.lnDeletedNote}</div>}
      {confirmDelete && (
        <div className="ln-confirm" data-testid="ln-delete-confirm">
          <div>{parents.length > 0 ? `${t.lnDeleteUsed} ${parents.length}:` : t.lnDeleteUnused}</div>
          <ul>
            {parents.slice(0, 8).map((p) => (
              <li key={p}>
                <button className="link" onClick={() => { onSelect(p); }}>
                  {name(p)}
                </button>
              </li>
            ))}
          </ul>
          {status !== 'new' && <div className="small muted">{t.lnDeleteVanilla}</div>}
          <div className="row">
            <button
              className="danger"
              data-testid="ln-delete-yes"
              onClick={() => {
                setConfirmDelete(false);
                edit(() => {
                  deleteLine(ctx, sid);
                });
              }}
            >
              {t.lnDeleteYes}
            </button>
            <button onClick={() => { setConfirmDelete(false); }}>{t.cancel}</button>
          </div>
        </div>
      )}

      {asInGame && lower && <InGame ctx={ctx} rec={lower} tr={tr} t={t} />}

      {rec && isLine && (
        <>
          <Section title={t.lnSpeaker}>
            <EnumSelect def={talker} value={rec.ints.get('speaker') ?? 0} testId="ln-speaker" onChange={(v) => { edit(() => { ctx.setField(sid, 'ints', 'speaker', v); }); }} />
            <div className="small muted">{isChoice(rec) ? t.lnSpeakerChoice : t.lnSpeakerNpc}</div>
          </Section>
          <Texts ctx={ctx} sid={sid} rec={rec} lower={lower} tr={tr} t={t} edit={edit} />
          <Section title={t.lnChoose}>
            <ChooseFields ctx={ctx} sid={sid} rec={rec} lower={lower} t={t} edit={edit} />
          </Section>
        </>
      )}
      {rec && (
        <>
          <Conditions ctx={ctx} sid={sid} rec={rec} t={t} edit={edit} />
          {isLine && <Effects ctx={ctx} sid={sid} rec={rec} t={t} edit={edit} />}
          <Filters ctx={ctx} rec={rec} t={t} onGo={onGo} />
          <Next
            ctx={ctx}
            sid={sid}
            rec={rec}
            t={t}
            name={name}
            edit={edit}
            onSelect={onSelect}
            askMove={(child, dir) => {
              const copies = moveCopies(ctx, sid, child, dir);
              if (copies.length === 0) edit(() => moveLine(ctx, sid, child, dir));
              else setConfirmMove({ child, dir, copies });
            }}
          />
          {confirmMove && (
            <div className="ln-confirm" data-testid="ln-move-confirm">
              <div>{t.lnMoveCopy}</div>
              <ul>
                {confirmMove.copies.map((c) => (
                  <li key={c}>{name(c)}</li>
                ))}
              </ul>
              <div className="small muted">{t.lnMoveCopyTr}</div>
              <div className="row">
                <button
                  data-testid="ln-move-yes"
                  onClick={() => {
                    const m = confirmMove;
                    setConfirmMove(undefined);
                    edit(() => moveLine(ctx, sid, m.child, m.dir));
                  }}
                >
                  {t.lnMoveYes}
                </button>
                <button onClick={() => { setConfirmMove(undefined); }}>{t.cancel}</button>
              </div>
            </div>
          )}
        </>
      )}
      <Section title={`${t.lnWhere} (${parents.length})`}>
        {parents.length === 0 && <div className="small warn">{isLine ? t.lnOrphan : t.lnNoParents}</div>}
        <ul className="ln-list">
          {parents.map((p) => (
            <li key={p}>
              <button className="link" onClick={() => { onSelect(p); }}>
                {name(p)}
              </button>{' '}
              <span className="mono small muted">{p}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }): ReactNode {
  return (
    <div className="ln-section">
      <div className="ln-section-title">
        <span>{title}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}

interface Part {
  ctx: ModContext;
  sid: string;
  rec: GameRecord;
  t: Strings;
  edit: (fn: () => void) => void;
}

function Texts({ ctx, sid, rec, lower, tr, t, edit }: Part & { lower: GameRecord | undefined; tr: TranslationIndex | undefined }): ReactNode {
  const dataLocale = useDataLocale();
  const texts = lineTexts(rec);
  const lowerTexts = lower ? lineTexts(lower) : [];
  const set = (next: string[]): void => {
    edit(() => {
      setLineTexts(ctx, sid, next);
    });
  };
  return (
    <Section
      title={t.lnTexts}
      extra={
        <button className="small" data-testid="ln-text-add" onClick={() => { set([...texts, '']); }}>
          + {t.lnTextAdd}
        </button>
      }
    >
      {texts.length > 1 && <div className="small muted">{t.lnTextsHint}</div>}
      {texts.map((x, i) => {
        const trText = translatedText(tr, sid, `text${i}`, x);
        const was = lowerTexts[i];
        return (
          <div key={i} className="ln-text">
            <div className="row">
              <CommitInput multiline className="ln-text-input" value={x} testId={`ln-text-${i}`} placeholder={t.lnTextPlaceholder} onCommit={(v) => { set(texts.map((y, k) => (k === i ? v : y))); }} />
              {texts.length > 1 && (
                <button className="small" title={t.lnTextRemove} onClick={() => { set(texts.filter((_, k) => k !== i)); }}>
                  ✕
                </button>
              )}
            </div>
            {trText !== undefined && <div className="ln-ru small">{dataLocale}: {trText}</div>}
            {trText === undefined && was !== undefined && was !== x && tr?.get(sid)?.get(`text${i}`) && <div className="small muted">{t.lnTrStale}</div>}
          </div>
        );
      })}
    </Section>
  );
}

function ChooseFields({ ctx, sid, rec, lower, t, edit }: Part & { lower: GameRecord | undefined }): ReactNode {
  const lang = useLang();
  const score = dialogueScore(ctx, rec);
  return (
    <>
      <div className="ln-grid">
        {LINE_FIELDS.map((f) => {
          const v = rec[f.dict].get(f.key) ?? (f.key.startsWith('chance') ? 100 : 0);
          const lo = lower?.[f.dict].get(f.key);
          const changed = lower !== undefined && lo !== undefined && lo !== v;
          const def = f.en ? getEnum(ctx.schema, f.en) : undefined;
          const commit = (n: number): void => { edit(() => { ctx.setField(sid, f.dict, f.key, n); }); };
          return (
            <div key={f.key} className="ln-field" title={lnText(t, `lnField_${f.key.replace(/ /g, '_')}`)}>
              <label className="small">{lnText(t, `lnFieldName_${f.key.replace(/ /g, '_')}`)}</label>
              {def ? <EnumSelect def={def} value={v} onChange={commit} testId={`ln-f-${f.key}`} /> : <NumberInput value={v} onCommit={commit} int={f.dict === 'ints'} testId={`ln-f-${f.key}`} />}
              {changed && (
                <button className="link small" title={`${t.lnInGame}: ${String(lo)}`} onClick={() => { edit(() => { ctx.resetField(sid, f.dict, f.key); }); }}>
                  ↺ {String(lo)}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="small muted" data-testid="ln-score">
        {t.lnScore}: {score.total}
        {score.parts.length > 1 ? ` (${formatScoreParts(score.parts, lang)})` : ''}
      </div>
    </>
  );
}

function Conditions({ ctx, sid, rec, t, edit }: Part): ReactNode {
  const refs = rec.refs.get('conditions') ?? [];
  const lang = useLang();
  const on = ctx.typeName(rec.type) === 'DIALOGUE' ? 'dialogue' : 'line';
  const usage = enumUsage(ctx).conditions;
  const condDef = getEnum(ctx.schema, 'DialogConditionEnum')!;
  const talker = getEnum(ctx.schema, 'TalkerEnum')!;
  const cmpDef = getEnum(ctx.schema, 'ComparisonEnum')!;
  const common = [...usage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
  return (
    <Section
      title={`${t.lnConditions} (${refs.length})`}
      extra={
        <button className="small" data-testid="ln-cond-add" onClick={() => { edit(() => void addCondition(ctx, sid, { cond: common, who: 0, cmp: 0, value: 1 })); }}>
          + {t.lnAdd}
        </button>
      }
    >
      {refs.length === 0 && <div className="small muted">{t.lnNoConditions}</div>}
      {refs.map((r) => {
        const c = conditionOf(ctx, r);
        const a = ctx.get(r.target);
        if (!c || !a) return <ReadOnlyRef key={r.target} ctx={ctx} r={r} cat="conditions" />;
        const tagDef = fieldEnum(ctx.schema, 'DIALOG_ACTION', 'tag', a);
        const phrase = dialogActionPhrase(ctx, r, 'conditions', lang, on);
        return (
          <div key={r.target} className="ln-action" data-testid="ln-cond">
            <EnumSelect def={talker} value={c.who} onChange={(v) => { edit(() => void updateCondition(ctx, sid, r.target, { who: v })); }} />
            <DialogValueSelect def={condDef} value={c.cond} usage={usage} testId="ln-cond-name" onChange={(v) => { edit(() => void updateCondition(ctx, sid, r.target, { cond: v })); }} />
            {tagDef && <EnumSelect def={tagDef} value={c.tag ?? -1} onChange={(v) => { edit(() => void updateCondition(ctx, sid, r.target, { tag: v })); }} />}
            <EnumSelect def={cmpDef} value={c.cmp} onChange={(v) => { edit(() => void updateCondition(ctx, sid, r.target, { cmp: v })); }} />
            <NumberInput value={c.value} int testId="ln-cond-value" onCommit={(v) => { edit(() => void updateCondition(ctx, sid, r.target, { value: v })); }} />
            <button className="small" title={t.lnRemove} onClick={() => { edit(() => { removeAction(ctx, sid, 'conditions', r.target); }); }}>
              ✕
            </button>
            {phrase && <PhraseLine phrase={phrase} kind="cond" testId="ln-cond-phrase" />}
          </div>
        );
      })}
    </Section>
  );
}

function Effects({ ctx, sid, rec, t, edit }: Part): ReactNode {
  const refs = rec.refs.get('effects') ?? [];
  const lang = useLang();
  const usage = enumUsage(ctx).actions;
  const def = getEnum(ctx.schema, 'DialogActionEnum')!;
  const common = [...usage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1;
  return (
    <Section
      title={`${t.lnEffects} (${refs.length})`}
      extra={
        <button className="small" data-testid="ln-effect-add" onClick={() => { edit(() => void addEffect(ctx, sid, { action: common })); }}>
          + {t.lnAdd}
        </button>
      }
    >
      {refs.length === 0 && <div className="small muted">{t.lnNoEffects}</div>}
      {refs.map((r) => {
        const e = effectOf(ctx, r);
        if (!e) return <ReadOnlyRef key={r.target} ctx={ctx} r={r} cat="effects" />;
        const vals = e.values ?? [0, 0, 0];
        const phrase = dialogActionPhrase(ctx, r, 'effects', lang);
        return (
          <div key={r.target} className="ln-action" data-testid="ln-effect">
            <DialogValueSelect def={def} value={e.action} usage={usage} testId="ln-effect-name" onChange={(v) => { edit(() => void updateEffect(ctx, sid, r.target, { action: v })); }} />
            {[0, 1, 2].map((k) => (
              <NumberInput key={k} value={vals[k] ?? 0} onCommit={(v) => { edit(() => void updateEffect(ctx, sid, r.target, { values: vals.map((x, j) => (j === k ? v : x)) })); }} />
            ))}
            <button className="small" title={t.lnRemove} onClick={() => { edit(() => { removeAction(ctx, sid, 'effects', r.target); }); }}>
              ✕
            </button>
            {phrase && <PhraseLine phrase={phrase} kind="effect" testId="ln-effect-phrase" />}
          </div>
        );
      })}
    </Section>
  );
}

function ReadOnlyRef({ ctx, r, cat }: { ctx: ModContext; r: Reference; cat: string }): ReactNode {
  const lang = useLang();
  const phrase = dialogActionPhrase(ctx, r, cat, lang);
  if (phrase) return <PhraseLine phrase={phrase} kind={cat === 'effects' ? 'effect' : 'cond'} />;
  return <div className="dg-cond mono">{describeDialogAction(ctx, r, cat, lang) ?? r.target}</div>;
}

/** Filter references and other effects (race, faction, items, unlock dialogue…) — edited in the inspector. */
const OWN_CATEGORIES: ReadonlySet<string> = new Set(['lines', 'conditions', 'effects', 'dialogs']);

function Filters({ ctx, rec, t, onGo }: { ctx: ModContext; rec: GameRecord; t: Strings; onGo: (sid: string) => void }): ReactNode {
  const lang = useLang();
  const items = [...rec.refs.entries()].filter(([c, l]) => !OWN_CATEGORIES.has(c) && l.length > 0);
  if (items.length === 0) return null;
  return (
    <Section title={t.lnFilters}>
      <div className="small muted">{t.lnFiltersHint}</div>
      <ul className="ln-list">
        {items.flatMap(([c, l]) =>
          l.map((r) => (
            <li key={`${c}:${r.target}`}>
              <span className="small" title={LINE_REF_HELP[c] ? uiText(LINE_REF_HELP[c].desc, lang) : undefined}>
                {LINE_REF_HELP[c] ? `${uiText(LINE_REF_HELP[c].label, lang)} · ` : ''}
                <span className="mono">{c}</span>:
              </span>{' '}
              <button className="link" onClick={() => { onGo(r.target); }}>
                {ctx.localizedName(r.target) ?? ctx.name(r.target) ?? r.target}
              </button>
              {r.v0 !== 0 && <span className="mono small muted"> {r.v0}</span>}
            </li>
          )),
        )}
      </ul>
    </Section>
  );
}

function Next({
  ctx,
  sid,
  rec,
  t,
  name,
  edit,
  onSelect,
  askMove,
}: Part & { name: (s: string) => string; onSelect: (sid: string, parent?: string) => void; askMove: (child: string, dir: -1 | 1) => void }): ReactNode {
  const refs = rec.refs.get('lines') ?? [];
  const removed = removedLinks(ctx, sid);
  const changed = ctx.lower(sid) !== undefined && linksChanged(ctx, sid);
  const isLine = ctx.typeName(rec.type) === 'DIALOGUE_LINE';
  const after = (speaker: number): void => { edit(() => {
      onSelect(addLine(ctx, sid, { speaker, text: '' }), sid);
    }); };
  return (
    <Section
      title={`${t.lnNext} (${refs.length})`}
      extra={
        changed ? (
          <button className="link small" data-testid="ln-revert-links" title={t.lnRevertLinksHint} onClick={() => { edit(() => { revertLinks(ctx, sid); }); }}>
            ↺ {t.lnRevertLinks}
          </button>
        ) : undefined
      }
    >
      {refs.length === 0 && <div className="small muted">{isLine ? (isChoice(rec) ? t.lnEndChoice : t.lnEndNpc) : t.lnNoLines}</div>}
      <ol className="ln-next" data-testid="ln-next">
        {refs.map((r, i) => {
          const child = ctx.get(r.target);
          return (
            <li key={r.target} data-testid="ln-next-item" data-sid={r.target}>
              <span className={`dg-chip ${isChoice(child) ? 'choice' : 'npc'}`}>{isChoice(child) ? t.dgPlayer : t.dgNpc}</span>{' '}
              <button className="link" onClick={() => { onSelect(r.target, sid); }}>
                {name(r.target)}
              </button>{' '}
              <StatusBadge status={ctx.status(r.target)} />
              <span className="ln-next-btns">
                <button className="small" title={t.lnUp} disabled={!canMoveLine(ctx, sid, r.target, -1)} data-testid="ln-up" onClick={() => { askMove(r.target, -1); }}>
                  ↑
                </button>
                <button className="small" title={t.lnDown} disabled={!canMoveLine(ctx, sid, r.target, 1)} data-testid="ln-down" onClick={() => { askMove(r.target, 1); }}>
                  ↓
                </button>
                <button className="small" title={t.lnUnlink} data-testid="ln-unlink" onClick={() => { edit(() => { unlinkLine(ctx, sid, r.target); }); }}>
                  ✂
                </button>
              </span>
              {i === 0 && refs.length > 1 && !isChoice(child) && <div className="small muted">{t.lnOrderHint}</div>}
            </li>
          );
        })}
      </ol>
      {removed.length > 0 && (
        <div className="ln-removed small" data-testid="ln-removed">
          <div className="muted">{t.lnRemovedLinks}</div>
          {removed.map((r) => (
            <div key={r}>
              <s>{name(r)}</s>{' '}
              {ctx.get(r) ? (
                <button className="link small" onClick={() => { edit(() => { linkLine(ctx, sid, r); }); }}>
                  ↺ {t.lnRelink}
                </button>
              ) : (
                <span className="muted">({t.lineStatus_deleted})</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="row ln-add">
        {(!isLine || isChoice(rec)) && (
          <button className="small" data-testid="ln-add-npc" onClick={() => { after(0); }}>
            + {t.lnAddNpc}
          </button>
        )}
        {isLine && (
          <button className="small" data-testid="ln-add-answer" onClick={() => { after(1); }}>
            + {t.lnAddAnswer}
          </button>
        )}
        {isLine && !isChoice(rec) && (
          <button className="small" onClick={() => { after(0); }}>
            + {t.lnAddNpcMore}
          </button>
        )}
      </div>
      <div className="small muted">{t.lnLinkHint}</div>
    </Section>
  );
}

/** Record as in game (lower layers): read only. */
function InGame({ ctx, rec, tr, t }: { ctx: ModContext; rec: GameRecord; tr: TranslationIndex | undefined; t: Strings }): ReactNode {
  const lang = useLang();
  const talker = getEnum(ctx.schema, 'TalkerEnum')!;
  const isLine = ctx.typeName(rec.type) === 'DIALOGUE_LINE';
  const phrases = recordPhrases(ctx, rec, lang, isLine ? 'line' : 'dialogue');
  return (
    <div className="ln-ingame" data-testid="ln-ingame">
      <div className="ln-section-title">{t.lnInGameTitle}</div>
      {isLine && (
        <div className="small">
          {t.lnSpeaker}: {shortEnumLabel(talker, rec.ints.get('speaker') ?? 0, lang)} · {t.lnScore}: {dialogueScore(ctx, rec).total} · {rec.floats.get('chance temporary') ?? 100}%
        </div>
      )}
      {isLine &&
        lineTexts(rec).map((x, i) => (
          <div key={i} className="dg-text">
            {quote(translatedText(tr, rec.stringId, `text${i}`, x) ?? x, lang)}
          </div>
        ))}
      {phrases.conditions.map((p, i) => (
        <PhraseLine key={`c${i}`} phrase={p} kind="cond" mark testId="ln-ingame-cond" />
      ))}
      {phrases.effects.map((p, i) => (
        <PhraseLine key={`e${i}`} phrase={p} kind="effect" mark testId="ln-ingame-effect" />
      ))}
      <ol className="ln-next">
        {(rec.refs.get('lines') ?? []).map((r) => (
          <li key={r.target}>{lineCaption(ctx, r.target, tr, lang)}</li>
        ))}
      </ol>
    </div>
  );
}
