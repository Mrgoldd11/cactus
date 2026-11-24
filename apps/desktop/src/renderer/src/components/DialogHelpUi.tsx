/**
 * Dialogue conditions and effects in plain words: a grouped picker with search (translation,
 * English name, DC_/DA_ code) and the ready phrase line «Say only if I am starving» with its code.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  ACTION_GROUP_LABELS,
  ACTION_HELP,
  ACTION_GROUPS,
  CONDITION_GROUP_LABELS,
  CONDITION_GROUPS,
  CONDITION_HELP,
  DIALOG_HELP_MARKS,
  dialogValueHelp,
  enumLabel,
  enumValue,
  enumValueMatches,
  recordPhrases,
  uiText,
  type DialogPhrase,
  type DialogValueHelp,
  type EnumDef,
  type EnumValue,
  type ModContext,
} from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import { useFcsCodes } from '../fcs-codes.ts';

/** «Starving · DC_STARVING»; values without help keep the old «CODE — label» form. */
export function dialogOptionText(def: EnumDef, v: EnumValue, lang: string, codes = true): string {
  const help = dialogValueHelp(def.name, v.name);
  if (help) return codes ? `${uiText(help.label, lang)} · ${v.name}` : uiText(help.label, lang);
  const l = enumLabel(def, v, lang);
  if (!codes && l !== undefined) return l;
  return l !== undefined ? `${v.name} — ${l}` : v.name;
}

/** Tooltip of a value: the explanation and its marks («not described», «not used in vanilla»). */
export function dialogOptionTip(help: DialogValueHelp | undefined, lang: string): string | undefined {
  if (!help) return undefined;
  const marks = [help.undescribed ? DIALOG_HELP_MARKS.undescribed : undefined, help.unused ? DIALOG_HELP_MARKS.unused : undefined]
    .filter((m) => m !== undefined)
    .map((m) => uiText(m, lang));
  return [uiText(help.desc, lang), ...marks.map((m) => `(${m})`)].join(' ');
}

interface Group {
  key: string;
  label: string;
  values: EnumValue[];
}

/** Values of DialogConditionEnum / DialogActionEnum by help group; service and unknown values last. */
function groupValues(def: EnumDef, lang: string, other: string, current: number): Group[] {
  const isCond = def.name === 'DialogConditionEnum';
  const order: readonly string[] = isCond ? CONDITION_GROUPS : ACTION_GROUPS;
  const labels: Readonly<Record<string, { en: string }>> = isCond ? CONDITION_GROUP_LABELS : ACTION_GROUP_LABELS;
  const byKey = new Map<string, EnumValue[]>();
  for (const v of def.values) {
    if ((v.name.endsWith('_END') || v.name === 'DC_NONE' || v.name === 'DA_NONE') && v.value !== current) continue;
    const h = isCond ? CONDITION_HELP[v.name] : ACTION_HELP[v.name];
    const key: string = h?.group ?? 'other';
    byKey.set(key, [...(byKey.get(key) ?? []), v]);
  }
  const keys = [...order.filter((k) => k !== 'service'), 'service', 'other'];
  return keys
    .filter((k) => byKey.has(k))
    .map((k) => ({ key: k, label: k === 'other' ? other : uiText(labels[k]!, lang), values: byKey.get(k)! }));
}

interface DialogValueSelectProps {
  def: EnumDef;
  value: number;
  onChange: (value: number) => void;
  /** How many times each value occurs in the loaded data; absent values get ⚠. */
  usage?: Map<number, number>;
  testId?: string;
}

/** Condition / effect picker: a search field that narrows a grouped list «Starving · DC_STARVING». */
export function DialogValueSelect({ def, value, onChange, usage, testId }: DialogValueSelectProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const codes = useFcsCodes();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupValues(def, lang, t.dhOther, value), [def, lang, t, value]);
  const match = (v: EnumValue): boolean => enumValueMatches(def, v, query, lang);
  const shown = groups.map((g) => ({ ...g, values: g.values.filter(match) })).filter((g) => g.values.length > 0);
  const first = shown[0]?.values[0];
  const cur = enumValue(def, value);
  const curHidden = cur !== undefined && !shown.some((g) => g.values.includes(cur));
  const option = (v: EnumValue): ReactNode => {
    const unusedHere = usage !== undefined && !usage.has(v.value) && v.value !== value;
    const tip = [dialogOptionTip(dialogValueHelp(def.name, v.name), lang), unusedHere ? `⚠ ${t.dhUnusedData}` : undefined].filter(Boolean).join(' ');
    return (
      <option key={v.value} value={v.value} title={tip || undefined}>
        {dialogOptionText(def, v, lang, codes)}
        {unusedHere ? ' ⚠' : ''}
      </option>
    );
  };
  return (
    <span className="ev-select dh-select" data-testid={testId !== undefined ? `${testId}-box` : undefined}>
      <input
        type="search"
        className="ev-search"
        placeholder={t.dhSearch}
        title={t.dhSearchTip}
        value={query}
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
        className="ln-select"
        value={value}
        data-testid={testId}
        title={cur ? dialogOptionTip(dialogValueHelp(def.name, cur.name), lang) : undefined}
        onChange={(e) => {
          onChange(Number(e.target.value));
          setQuery('');
        }}
      >
        {cur === undefined && <option value={value}>{value}</option>}
        {curHidden && option(cur)}
        {shown.map((g) => (
          <optgroup key={g.key} label={g.label}>
            {g.values.map(option)}
          </optgroup>
        ))}
        {query.trim() !== '' && shown.length === 0 && <option disabled>{t.dhNoMatch}</option>}
      </select>
    </span>
  );
}

/** The phrase of a condition or effect with its code: «Say only if I am starving  DC_STARVING = 1». */
export function PhraseLine({
  phrase,
  kind,
  testId,
  mark,
  inline,
}: {
  phrase: DialogPhrase;
  kind: 'cond' | 'effect';
  testId?: string;
  mark?: boolean;
  inline?: boolean;
}): ReactNode {
  const t = useT();
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag className={`dh-phrase ${kind === 'cond' ? 'dg-cond' : 'dg-effect'}${inline ? ' small' : ''}`} data-testid={testId}>
      {inline ? ' ' : ''}
      {mark ? (kind === 'cond' ? '? ' : '! ') : ''}
      {phrase.text}{' '}
      <span className="dh-code mono" title={t.dhCodeTip}>
        {phrase.code}
      </span>
    </Tag>
  );
}

/** Context for views that get only record ids (the Conversation tab): phrases are read from it. */
export const PhraseContext = createContext<ModContext | undefined>(undefined);

/** Phrases of a DIALOGUE / DIALOGUE_LINE by id, `undefined` without a context or a record. */
export function useRecordPhrases(sid: string, on: 'line' | 'dialogue', fields: boolean): ReturnType<typeof recordPhrases> | undefined {
  const ctx = useContext(PhraseContext);
  const lang = useLang();
  const rec = ctx?.get(sid);
  return ctx && rec ? recordPhrases(ctx, rec, lang, on, fields) : undefined;
}

/** A yes / no condition (`kind: 'bool'`) as the game stores it: `= 1` / `= 0`, or `> 0` / `< 1`. */
export function boolCondition(cmp: number, value: number): boolean | undefined {
  if ((cmp === 0 && value === 1) || (cmp === 2 && value === 0)) return true;
  if ((cmp === 0 && value === 0) || (cmp === 1 && value === 1)) return false;
  return undefined;
}

/** «yes / no» instead of a comparison and a number for a yes / no condition; picks store `= 1` / `= 0`. */
export function YesNoSelect({ value, onChange, testId }: { value: boolean; onChange: (yes: boolean) => void; testId?: string }): ReactNode {
  const t = useT();
  return (
    <select className="ln-select yn-select" value={value ? '1' : '0'} data-testid={testId} title={t.ynTip} onChange={(e) => { onChange(e.target.value === '1'); }}>
      <option value="1">{t.ynYes}</option>
      <option value="0">{t.ynNo}</option>
    </select>
  );
}
