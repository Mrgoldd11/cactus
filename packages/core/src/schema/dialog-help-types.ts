/**
 * Types of the dialogue condition and effect help (`dialog-help.ts`, `condition-help.ts`,
 * `action-help.ts`). Kept apart so the data files and the lookup module do not import each other.
 */
import type { UiText } from '../ui-text.ts';

/** Help of one value of a dialogue enum (DC_, DA_, T_, CE_, DR_, OT_, PT_, LT_). */
export interface DialogValueHelp {
  /** Human name: «Starving», «Голодает». */
  label: UiText;
  /** What it means, one or two sentences. */
  desc: UiText;
  /** The meaning is not described by FCS or the game files; the explanation comes from the code name and vanilla use only. */
  undescribed?: true;
  /** No vanilla dialogue line uses it (gamedata.base, Newwworld, Dialogue, rebirth). */
  unused?: true;
}

/** Group of conditions in the condition picker. */
export type ConditionGroup = 'relations' | 'who' | 'state' | 'captivity' | 'place' | 'squad' | 'money' | 'service';

/** Group of effects in the effect picker. */
export type ActionGroup = 'trade' | 'squad' | 'fight' | 'law' | 'relations' | 'dialog' | 'service';

/**
 * Condition phrase templates, per language:
 * - `{s}` — who (I, the target…), `{o}` — whose (ru genitive «меня», en possessive «my»);
 * - `<first|third>` — verb form: the first for «I» (T_ME), the second for everyone else;
 * - `[yes|no]` — text when the condition must hold / must not hold;
 * - `{cmp}` and `{n}` — comparison words and the value (number conditions);
 * - `{tag}` — the trait or memory chosen in `tag`.
 */
export interface ConditionHelp extends DialogValueHelp {
  group: ConditionGroup;
  /** `bool`: the game compares 1 (true) / 0 (false) with the value; `number`: a real number. */
  kind: 'bool' | 'number';
  phrase: UiText;
}

/** Effect phrase template: `{v0}`, `{v1}`, `{v2}` — the reference values. */
export interface ActionHelp extends DialogValueHelp {
  group: ActionGroup;
  phrase: UiText;
  /** What v0..v2 mean, when known; absent — the game ignores them or it is not described. */
  values?: readonly UiText[];
}

export const t = (en: string, ru: string, zh: string): UiText => ({ en, ru, zh });
