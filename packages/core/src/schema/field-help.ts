/**
 * Human help for game fields in the interface languages: a short name shown next to the field
 * name, a translated description of the fcs.def text, and what an empty value means
 * («races: empty — all races»).
 *
 * The field names themselves stay as in fcs.def (modders search for them in FCS and on forums);
 * this only explains them. The dictionaries cover the common types (FIELD_HELP_TYPES). For other
 * types nothing is returned and the editor shows the English description from fcs.def.
 *
 * Keys: the fcs.def field name (`weight kg`), or `TYPE:field` where one field means different
 * things in different types (`CHARACTER:mesh`). A `TYPE:field` entry wins over the plain one.
 * English has no short names (the field name is English already) and no translated descriptions
 * (the fcs.def text is the description); it has only the «empty» texts.
 */
import { FIELD_HELP_EN } from './field-help-en.ts';
import { FIELD_HELP_RU } from './field-help-ru.ts';
import { FIELD_HELP_ZH } from './field-help-zh.ts';

/** Dictionary of one language: maps by field key or `TYPE:field`. */
export interface FieldHelpDict {
  readonly labels?: Readonly<Record<string, string>>;
  readonly descriptions?: Readonly<Record<string, string>>;
  readonly empty?: Readonly<Record<string, string>>;
}

export interface FieldHelp {
  /** Short name in the interface language («цена», «кто может носить»). */
  label?: string;
  /** Translation of the fcs.def description. */
  description?: string;
  /** What an empty value or an empty list means («пусто — все расы»). */
  empty?: string;
}

/** Record types the dictionaries cover. */
export const FIELD_HELP_TYPES: ReadonlySet<string> = new Set(['ITEM', 'WEAPON', 'ARMOUR', 'CHARACTER', 'RACE', 'SQUAD_TEMPLATE', 'BUILDING']);

/** Dictionaries by interface language; a new language adds its own. */
export const FIELD_HELP: Readonly<Record<string, FieldHelpDict>> = { en: FIELD_HELP_EN, ru: FIELD_HELP_RU, zh: FIELD_HELP_ZH };

function pick(map: Readonly<Record<string, string>> | undefined, type: string, field: string): string | undefined {
  if (!map) return undefined;
  return map[`${type}:${field}`] ?? map[field];
}

/**
 * Help for the field `field` (the fcs.def name; `text0` for repeating fields) of the type `type`
 * in the language `lang`. Empty for a type the dictionaries do not cover; a language without a
 * dictionary gets the English «empty» texts.
 */
export function fieldHelp(type: string, field: string, lang = 'en'): FieldHelp {
  if (!FIELD_HELP_TYPES.has(type)) return {};
  const dict = FIELD_HELP[lang];
  const out: FieldHelp = {};
  const label = pick(dict?.labels, type, field);
  if (label) out.label = label;
  const description = pick(dict?.descriptions, type, field);
  if (description) out.description = description;
  const empty = pick(dict?.empty, type, field) ?? pick(FIELD_HELP_EN.empty, type, field);
  if (empty) out.empty = empty;
  return out;
}
