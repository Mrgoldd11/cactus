/**
 * Package dialogue events in the interface: a picker with search (by name, EV_ code, number) and
 * the «Plays when: <event> — who: <character> (via package …)» line of DIALOGUE and its lines.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  dialogueWhen,
  enumValue,
  enumValueMatches,
  EVENT_GROUP_LABELS,
  EVENT_GROUPS,
  EVENT_UNUSED_LABEL,
  eventHelp,
  formatEnumValue,
  shortEnumLabel,
  lineDialogues,
  quote,
  refValueEnum,
  transitionsTo,
  uiText,
  type EnumDef,
  type EnumValue,
  type ModContext,
  type WhenHolder,
  type WhenSource,
} from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import { useFcsCodes } from '../fcs-codes.ts';
import { recordName } from '../data-names.ts';

/** EventTriggerEnum of the schema (or the built-in one). */
export function eventEnum(ctx: ModContext): EnumDef | undefined {
  return refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
}

/** `Acid rain · EV_ACID_RAIN (62)` in the interface language; a bare number only without the enum. */
export function eventText(def: EnumDef | undefined, value: number, lang: string, codes = true): string {
  if (!def) return String(value);
  return codes ? formatEnumValue(def, value, lang) : shortEnumLabel(def, value, lang);
}

/** Tooltip of an event: what happened and who the target is. */
export function eventTip(def: EnumDef | undefined, value: number, lang: string, targetWord: string, noTarget: string): string {
  const v = def ? enumValue(def, value) : undefined;
  const h = v ? eventHelp(v.name) : undefined;
  if (!h) return v?.description ?? '';
  const target = h.target === null ? noTarget : h.target ? uiText(h.target, lang) : undefined;
  return `${uiText(h.desc, lang)}${target !== undefined ? `\n${targetWord} ${target}` : ''}`;
}

interface Group {
  key: string;
  label: string;
  values: EnumValue[];
}

/** Values in picker groups: EV_NONE first, then by kind, the ones the game never raises last. */
function groupValues(def: EnumDef, lang: string, other: string): { none: EnumValue | undefined; groups: Group[] } {
  const byKey = new Map<string, EnumValue[]>();
  let none: EnumValue | undefined;
  for (const v of def.values) {
    if (v.value === 0) {
      none = v;
      continue;
    }
    const h = eventHelp(v.name);
    const key = !h ? 'other' : h.unused ? 'unused' : h.group;
    byKey.set(key, [...(byKey.get(key) ?? []), v]);
  }
  const keys = [...EVENT_GROUPS.filter((g) => g !== 'service'), 'unused', 'service', 'other'];
  const label = (k: string): string =>
    k === 'unused' ? uiText(EVENT_UNUSED_LABEL, lang) : k === 'other' ? other : uiText(EVENT_GROUP_LABELS[k as keyof typeof EVENT_GROUP_LABELS], lang);
  return { none, groups: keys.filter((k) => byKey.has(k)).map((k) => ({ key: k, label: label(k), values: byKey.get(k)! })) };
}

interface EventSelectProps {
  def: EnumDef;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  testId?: string;
  className?: string;
}

/** Event picker: a search field (name, EV_ code, number) that narrows a grouped list. */
export function EventSelect({ def, value, onChange, disabled = false, testId, className }: EventSelectProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const codes = useFcsCodes();
  const [query, setQuery] = useState('');
  const { none, groups } = useMemo(() => groupValues(def, lang, t.evOther), [def, lang, t]);
  const match = (v: EnumValue): boolean => enumValueMatches(def, v, query, lang);
  const shown = groups.map((g) => ({ ...g, values: g.values.filter(match) })).filter((g) => g.values.length > 0);
  const first = shown[0]?.values[0];
  const known = def.values.some((v) => v.value === value);
  const cur = enumValue(def, value);
  const curHidden = known && cur !== undefined && cur.value !== 0 && !match(cur);
  return (
    <span className={`ev-select ${className ?? ''}`} data-testid={testId !== undefined ? `${testId}-box` : undefined}>
      <input
        type="search"
        className="ev-search"
        placeholder={t.evSearch}
        title={t.evSearchTip}
        value={query}
        disabled={disabled}
        data-testid={testId !== undefined ? `${testId}-search` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && first) {
            onChange(first.value);
            setQuery('');
          } else if (e.key === 'Escape') setQuery('');
        }}
      />
      <select
        value={value}
        disabled={disabled}
        data-testid={testId}
        title={eventTip(def, value, lang, t.pwTarget, t.pwNoTarget)}
        onChange={(e) => {
          onChange(Number(e.target.value));
          setQuery('');
        }}
      >
        {!known && <option value={value}>{eventText(def, value, lang, codes)}</option>}
        {none && <option value={none.value}>{eventText(def, none.value, lang, codes)}</option>}
        {curHidden && <option value={cur.value}>{eventText(def, cur.value, lang, codes)}</option>}
        {shown.map((g) => (
          <optgroup key={g.key} label={g.label}>
            {g.values.map((v) => (
              <option key={v.value} value={v.value} title={eventTip(def, v.value, lang, t.pwTarget, t.pwNoTarget)}>
                {eventText(def, v.value, lang, codes)}
              </option>
            ))}
          </optgroup>
        ))}
        {query.trim() !== '' && shown.length === 0 && <option disabled>{t.evNoMatch}</option>}
      </select>
    </span>
  );
}

/** One row of «Plays when»: the source and, for a line, the dialogue it belongs to. */
interface WhenRow {
  dialog: string;
  source: WhenSource;
}

const FOLD = 3;

/** Which DIALOGUE and DIALOGUE_LINE records get the line; other types — none. */
export function hasPlaysWhen(type: string): boolean {
  return type === 'DIALOGUE' || type === 'DIALOGUE_LINE';
}

/** «Plays when: <event> — who: <holder> (via package «…»)»; several sources fold to «and N more». */
export function PlaysWhen({ ctx, sid, type, version, onGo }: { ctx: ModContext; sid: string; type: string; version: number; onGo: (sid: string) => void }): ReactNode {
  const t = useT();
  const lang = useLang();
  const codes = useFcsCodes();
  const [open, setOpen] = useState(false);
  const isLine = type === 'DIALOGUE_LINE';
  const rows = useMemo((): WhenRow[] => {
    const dialogs = isLine ? lineDialogues(ctx, sid) : [sid];
    return dialogs.flatMap((dialog) => dialogueWhen(ctx, dialog).map((source) => ({ dialog, source })));
  }, [ctx, sid, isLine, version]);
  // In no package but other dialogues lead into it: not a dead dialogue.
  const entered = useMemo(() => rows.length === 0 && (isLine ? lineDialogues(ctx, sid) : [sid]).some((d) => transitionsTo(ctx, d).length > 0), [ctx, sid, isLine, rows, version]);
  const def = eventEnum(ctx);
  if (!hasPlaysWhen(type)) return null;
  const name = (s: string): string => quote(recordName(ctx, s), lang);
  const link = (s: string, text: string = name(s)): ReactNode => (
    <button
      className="link small"
      title={s}
      onClick={() => {
        onGo(s);
      }}
    >
      {text}
    </button>
  );
  const shown = open ? rows : rows.slice(0, FOLD);
  const firstEvent = rows.find((r) => r.source.events.length > 0)?.source.events[0];
  const tip = firstEvent !== undefined ? eventTip(def, firstEvent, lang, t.pwTarget, t.pwNoTarget) : '';
  return (
    <div className="plays-when" data-testid="plays-when" data-state={rows.length > 0 ? 'in' : 'nowhere'} title={t.pwHelpTip}>
      <span className="muted">{t.pwLabel}</span>{' '}
      {rows.length === 0 && entered && (
        <span data-testid="plays-when-from" title={t.dwFromDialogueTip}>
          ↪ {t.dwFromDialogue}
        </span>
      )}
      {rows.length === 0 && !entered && (
        <span className="warn" data-testid="plays-when-nowhere" title={t.pwNowhereTip}>
          {t.pwNowhere}
        </span>
      )}
      {rows.length > 0 && (
        <ul className="pw-list">
          {shown.map(({ dialog, source }, i) => (
            <li key={`${dialog}:${source.pkg ?? source.holders[0]?.field ?? ''}:${i}`} className="pw-row" data-testid="plays-when-row" data-pkg={source.pkg}>
              {isLine && (
                <>
                  <span className="muted">{t.pwInDialog[0]}</span>
                  {link(dialog)}
                  <span className="muted">{t.pwInDialog[1]}</span>,{' '}
                </>
              )}
              <span className="pw-events" data-testid="plays-when-events">
                {source.events.length === 0
                  ? source.pkg !== undefined
                    ? t.pwNoEvents
                    : source.start !== undefined
                      ? `📢 ${t.dwStart(source.start)}`
                      : t.pwAnnouncement
                  : source.events.map((e, k) => (
                      <span key={e} title={eventTip(def, e, lang, t.pwTarget, t.pwNoTarget)}>
                        {k > 0 ? ', ' : ''}
                        {eventText(def, e, lang, codes)}
                      </span>
                    ))}
              </span>
              {' — '}
              <span className="muted">{t.pwWho}</span> <Holders source={source} link={link} name={name} />
            </li>
          ))}
          {rows.length > FOLD && (
            <li>
              <button
                className="link small"
                data-testid="plays-when-more"
                onClick={() => {
                  setOpen(!open);
                }}
              >
                {open ? t.pwLess : t.pwMore(rows.length - FOLD)}
              </button>
            </li>
          )}
        </ul>
      )}
      {tip !== '' && (
        <div className="muted small pw-tip" data-testid="plays-when-tip" title={tip}>
          {tip.replace(/\n/g, ' · ')}
        </div>
      )}
    </div>
  );
}

function Holders({ source, link, name }: { source: WhenSource; link: (s: string, text?: string) => ReactNode; name: (s: string) => string }): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pkg = source.pkg;
  if (source.holders.length === 0)
    return (
      <>
        <span className="warn" title={t.pwNobodyTip}>
          {t.pwNobody}
        </span>
        {pkg !== undefined && (
          <span className="muted pw-via">
            {' '}
            {t.pwVia[0]}
            {link(pkg)}
            {t.pwVia[1]}
          </span>
        )}
      </>
    );
  // One link per holder; a character with the package in two fields is listed once.
  const bySid = new Map<string, WhenHolder[]>();
  for (const h of source.holders) bySid.set(h.sid, [...(bySid.get(h.sid) ?? []), h]);
  const holders = [...bySid.values()];
  const shown = open ? holders : holders.slice(0, FOLD);
  // The heir is named when every holder gets the package through the same one.
  const throughs = new Set(source.holders.map((h) => h.through ?? ''));
  const heir = throughs.size === 1 ? source.holders[0]!.through : undefined;
  const tipOf = (hs: WhenHolder[]): string =>
    `${hs[0]!.type} · ${hs.map((h) => `${h.field}${h.through !== undefined ? ` · ${name(h.through)}` : ''}`).join(', ')}`;
  return (
    <>
      {shown.map((hs, i) => (
        <span key={hs[0]!.sid} title={tipOf(hs)}>
          {i > 0 ? ', ' : ''}
          {link(hs[0]!.sid)}
        </span>
      ))}
      {holders.length > FOLD && ' '}
      {holders.length > FOLD && (
        <button
          className="link small"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? t.pwLess : t.pwMore(holders.length - FOLD)}
        </button>
      )}{' '}
      {pkg !== undefined ? (
        <span className="muted pw-via">
          {heir !== undefined ? (
            <>
              {t.pwViaHeir[0]}
              {link(pkg)}
              {t.pwViaHeir[1]}
              {link(heir)}
              {t.pwViaHeir[2]}
            </>
          ) : (
            <>
              {t.pwVia[0]}
              {link(pkg)}
              {t.pwVia[1]}
            </>
          )}
        </span>
      ) : (
        <span className="muted">({t.dwField(source.holders[0]!.type, source.holders[0]!.field)})</span>
      )}
    </>
  );
}
