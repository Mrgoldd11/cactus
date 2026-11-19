/**
 * Dialogue conditions and effects in plain words: lookup of the value help, search by translation,
 * English or code, and ready phrases «who → condition → comparison → value»
 * («Say only if I have the “honorable” trait»). Pure functions over value names; reading
 * DIALOG_ACTION records is in `model/dialog-phrase.ts`.
 */
import { uiText, type UiText } from '../ui-text.ts';
import { ACTION_HELP } from './action-help.ts';
import { CONDITION_HELP } from './condition-help.ts';
import { t, type ActionGroup, type ActionHelp, type ConditionGroup, type ConditionHelp, type DialogValueHelp } from './dialog-help-types.ts';
import {
  CHARACTER_TYPE_HELP,
  COMPARISON_HELP,
  PERCEPTION_TAG_HELP,
  PERSONALITY_HELP,
  REPETITION_HELP,
  TALKER_HELP,
} from './dialog-enum-help.ts';
import { LINE_FIELD_HELP, LINE_REF_HELP } from './line-ref-help.ts';

export * from './dialog-help-types.ts';
export { ACTION_HELP } from './action-help.ts';
export { CONDITION_HELP } from './condition-help.ts';
export * from './dialog-enum-help.ts';
export * from './line-ref-help.ts';

/** Help tables by enum name: every value of these enums has an entry (see the completeness test). */
export const DIALOG_HELP_TABLES: Readonly<Record<string, Readonly<Record<string, DialogValueHelp>>>> = {
  DialogConditionEnum: CONDITION_HELP,
  DialogActionEnum: ACTION_HELP,
  TalkerEnum: TALKER_HELP,
  ComparisonEnum: COMPARISON_HELP,
  DialogRepetitionEnum: REPETITION_HELP,
  CharacterTypeEnum: CHARACTER_TYPE_HELP,
  PersonalityTags: PERSONALITY_HELP,
  CharacterPerceptionTags_LongTerm: PERCEPTION_TAG_HELP,
};

/** Help of one value, `undefined` for unknown enums and values (FCS Extended additions). */
export function dialogValueHelp(enumName: string, valueName: string): DialogValueHelp | undefined {
  return DIALOG_HELP_TABLES[enumName]?.[valueName];
}

export const CONDITION_GROUPS: readonly ConditionGroup[] = ['relations', 'who', 'state', 'captivity', 'place', 'squad', 'money', 'service'];
export const CONDITION_GROUP_LABELS: Readonly<Record<ConditionGroup, UiText>> = {
  relations: t('Relations and memory', 'Отношения и память', '关系与记忆'),
  who: t('Who they are', 'Кто это', '身份'),
  state: t('Health and state', 'Здоровье и состояние', '健康与状态'),
  captivity: t('Prison, slaves, law', 'Тюрьма, рабство, закон', '监狱、奴隶、法律'),
  place: t('Place and town', 'Место и город', '地点与城镇'),
  squad: t('Squad', 'Отряд', '小队'),
  money: t('Money and bounties', 'Деньги и награды', '金钱与悬赏'),
  service: t('Service values', 'Служебные', '内部值'),
};

export const ACTION_GROUPS: readonly ActionGroup[] = ['trade', 'squad', 'fight', 'law', 'relations', 'dialog', 'service'];
export const ACTION_GROUP_LABELS: Readonly<Record<ActionGroup, UiText>> = {
  trade: t('Trade and money', 'Торговля и деньги', '交易与金钱'),
  squad: t('Squad and AI', 'Отряд и AI', '小队与 AI'),
  fight: t('Fight and raids', 'Бой и набеги', '战斗与袭击'),
  law: t('Law and slaves', 'Закон и рабство', '法律与奴隶'),
  relations: t('Relations', 'Отношения', '关系'),
  dialog: t('Conversation', 'Разговор', '对话'),
  service: t('Other', 'Прочее', '其他'),
};

/** Marks shown next to a value. */
export const DIALOG_HELP_MARKS = {
  undescribed: t('not described', 'не описано', '未描述'),
  unused: t('not used in vanilla', 'в ванили не используется', '原版未使用'),
} as const;

/** «Starving · DC_STARVING»; the bare code when there is no help. */
export function dialogValueText(enumName: string, valueName: string, lang = 'en'): string {
  const h = dialogValueHelp(enumName, valueName);
  return h ? `${uiText(h.label, lang)} · ${valueName}` : valueName;
}

const fold = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

/**
 * Whether a value matches a search: its code (`DC_STARV`, `starving`, `is sneaking`) or its name
 * in the interface language or in English («голод», «starv»). Every word of the query must match.
 */
export function dialogHelpMatches(enumName: string, valueName: string, query: string, lang = 'en'): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const h = dialogValueHelp(enumName, valueName);
  const hay = fold([valueName, valueName.replace(/_/g, ' '), h ? uiText(h.label, lang) : '', h ? h.label.en : ''].join(' | '));
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** A phrase and the codes it is made of: `text` with the lead-in, `short` without, `code` for display next to it. */
export interface DialogPhrase {
  text: string;
  short: string;
  code: string;
}

const LEAD: Readonly<Record<'line' | 'dialogue' | 'effect', UiText>> = {
  line: t('Say only if {c}', 'Сказать, только если {c}', '仅当{c}时才说'),
  dialogue: t('Start only if {c}', 'Диалог начнётся, только если {c}', '仅当{c}时对话才开始'),
  effect: t('Then: {c}', 'Затем: {c}', '然后：{c}'),
};
const ALWAYS = t('{c}: always true', '{c}: выполняется всегда', '{c}：总是成立');
const NEVER = t('{c}: never true', '{c}: не выполняется никогда', '{c}：永远不成立');
const CMP_SYMBOL = ['=', '<', '>'] as const;
const CMP_NAMES = ['CE_EQUALS', 'CE_LESS_THAN', 'CE_MORE_THAN'] as const;
const TALKER_NAMES = Object.keys(TALKER_HELP);

const lead = (kind: keyof typeof LEAD, short: string, lang: string): string => uiText(LEAD[kind], lang).replace('{c}', short);

/**
 * Fills a phrase template (syntax in `ConditionHelp.phrase`): verb forms `<first|third>`, then
 * the yes/no parts `[yes|no]`, then the `{name}` values.
 */
export function fillPhrase(template: string, opts: { first?: boolean; yes?: boolean; vars?: Readonly<Record<string, string>> }): string {
  let s = template.replace(/<([^<>|]*)\|([^<>]*)>/g, (_, a: string, b: string) => (opts.first ? a : b));
  s = s.replace(/\[([^[\]|]*)\|([^[\]]*)\]/g, (_, a: string, b: string) => (opts.yes === false ? b : a));
  s = s.replace(/\{(\w+)\}/g, (m, k: string) => opts.vars?.[k] ?? m);
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** Which of «true» (1) and «false» (0) pass `x <cmp> value`. */
function boolTruth(cmp: number, value: number): { yes: boolean; no: boolean } {
  const test = (x: number) => (cmp === 1 ? x < value : cmp === 2 ? x > value : x === value);
  return { yes: test(1), no: test(0) };
}

export interface ConditionPhraseInput {
  /** `DialogConditionEnum` value name: `DC_STARVING`. */
  cond: string;
  /** `TalkerEnum` value number (`who`); T_ME when absent. */
  who?: number;
  /** `ComparisonEnum` number (`compare by`): 0 `=`, 1 `<`, 2 `>`. */
  cmp?: number;
  /** The compared value (v0 of the reference). */
  value: number;
  /** Value name of `tag` (`PT_HONORABLE`, `LT_FREED_ME`), when the condition has one. */
  tag?: string;
  /** Name to use for a condition without help (FCS Extended description). */
  fallbackLabel?: string;
}

/** Ready condition phrase: «Say only if I have the “honorable” trait». */
export function conditionPhrase(input: ConditionPhraseInput, lang = 'en', on: 'line' | 'dialogue' = 'line'): DialogPhrase {
  const whoNum = input.who ?? 0;
  const whoName = TALKER_NAMES[whoNum];
  const talker = whoName !== undefined ? TALKER_HELP[whoName] : undefined;
  const s = talker ? uiText(talker.forms.s, lang) : `#${whoNum}`;
  const o = talker ? uiText(talker.forms.o, lang) : `#${whoNum}`;
  const cmp = input.cmp ?? 0;
  const sym = CMP_SYMBOL[cmp] ?? '=';
  const tagHelp = input.tag !== undefined ? (PERSONALITY_HELP[input.tag] ?? PERCEPTION_TAG_HELP[input.tag]) : undefined;
  const tag = tagHelp ? uiText(tagHelp.label, lang) : (input.tag ?? '');
  const code = [input.cond, input.tag].filter(Boolean).join(' ') + ` ${sym} ${input.value}`;
  const help: ConditionHelp | undefined = CONDITION_HELP[input.cond];
  if (!help) {
    const short = `${input.fallbackLabel ?? input.cond} (${s}) ${sym} ${input.value}`;
    return { text: lead(on, short, lang), short, code };
  }
  const first = whoNum === 0;
  const tpl = uiText(help.phrase, lang);
  let short: string;
  if (help.kind === 'number') {
    const cmpName = CMP_NAMES[cmp];
    const word = cmpName ? uiText(COMPARISON_HELP[cmpName]!.word, lang) : sym;
    short = fillPhrase(tpl, { first, vars: { s, o, tag, cmp: word, n: String(input.value) } });
  } else {
    const truth = boolTruth(cmp, input.value);
    const vars = { s, o, tag, cmp: sym, n: String(input.value) };
    if (truth.yes !== truth.no) short = fillPhrase(tpl, { first, yes: truth.yes, vars });
    else short = uiText(truth.yes ? ALWAYS : NEVER, lang).replace('{c}', fillPhrase(tpl, { first, yes: true, vars }));
  }
  return { text: lead(on, short, lang), short, code };
}

/** Ready effect phrase: «Then: the player pays 200 cats». */
export function effectPhrase(input: { action: string; values?: readonly number[] }, lang = 'en'): DialogPhrase {
  const [v0 = 0, v1 = 0, v2 = 0] = input.values ?? [];
  const code = v0 || v1 || v2 ? `${input.action} ${v0}/${v1}/${v2}` : input.action;
  const help: ActionHelp | undefined = ACTION_HELP[input.action];
  const short = help ? fillPhrase(uiText(help.phrase, lang), { vars: { v0: String(v0), v1: String(v1), v2: String(v2) } }) : code;
  return { text: lead('effect', short, lang), short, code };
}

const OR = t(' or ', ' или ', '或');
const AND = t(', ', ', ', '、');

/**
 * Phrase of a DIALOGUE_LINE reference category with the names of its targets:
 * «Say only if my race is Shek or Hive». Unknown categories give `category: names`.
 */
export function lineRefPhrase(category: string, names: readonly string[], lang = 'en', on: 'line' | 'dialogue' = 'line'): DialogPhrase {
  const code = `${category}: ${names.join(', ')}`;
  const help = LINE_REF_HELP[category];
  if (!help) return { text: code, short: code, code };
  const sep = uiText(help.join === 'or' ? OR : AND, lang);
  const list = names.length > 1 ? `${names.slice(0, -1).join(uiText(AND, lang))}${sep}${names.at(-1)}` : (names[0] ?? '');
  const short = fillPhrase(uiText(help.phrase, lang), { vars: { list } });
  return { text: lead(help.kind === 'condition' ? on : 'effect', short, lang), short, code };
}

/** Phrase of a plain DIALOGUE_LINE condition field: «said with a 50% chance». */
export function lineFieldPhrase(field: string, value: string, lang = 'en'): DialogPhrase {
  const code = `${field}: ${value}`;
  const help = LINE_FIELD_HELP[field];
  if (!help) return { text: code, short: code, code };
  const short = fillPhrase(uiText(help.phrase, lang), { vars: { n: value } });
  return { text: short, short, code };
}
