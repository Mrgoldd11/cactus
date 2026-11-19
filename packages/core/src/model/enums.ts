/**
 * Names of enum values: enum fields (from fcs.def and built into FCS), `DIALOG_ACTION.tag`,
 * reference values (the events in `DIALOGUE_PACKAGE.dialogs`). Common base for CLI, MCP and the editor.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import { decodeText } from '../text.ts';
import { quote, uiText } from '../ui-text.ts';
import {
  BUILTIN_ENUM_LABELS,
  BUILTIN_ENUM_LABELS_I18N,
  BUILTIN_ENUMS,
  BUILTIN_FIELD_ENUMS,
  BUILTIN_REF_VALUE_ENUMS,
  BUILTIN_REF_VALUE_LABELS,
  CONDITION_TAG_ENUMS,
  PACKAGE_EVENT_SKIP,
} from '../schema/builtin-enums.ts';
import { eventHelp } from '../schema/event-help.ts';
import type { EnumDef, EnumValue } from '../schema/fcs-enums.ts';
import { findField, type GameSchema } from '../schema/game-schema.ts';
import type { ModContext } from './context.ts';

let builtinDefs: Map<string, EnumDef> | undefined;

/** Built-in enums when there is no game schema (tests, context without fcs.def). */
function builtinEnumDefs(): Map<string, EnumDef> {
  if (!builtinDefs) {
    builtinDefs = new Map();
    for (const [name, names] of Object.entries(BUILTIN_ENUMS)) {
      const labels = BUILTIN_ENUM_LABELS[name] ?? {};
      const values = names.map((n, value): EnumValue => (labels[n] !== undefined ? { name: n, value, label: labels[n] } : { name: n, value }));
      builtinDefs.set(name, { name, shared: false, line: 0, builtin: true, values });
    }
  }
  return builtinDefs;
}

/** Enum by name: from the schema, otherwise built-in. */
export function getEnum(schema: GameSchema | undefined, name: string): EnumDef | undefined {
  return schema?.enums.get(name) ?? builtinEnumDefs().get(name);
}

export function enumValue(def: EnumDef, value: number): EnumValue | undefined {
  return def.values.find((v) => v.value === value);
}

/**
 * Enum of a record field. `rec` is needed for fields whose enum depends on other fields
 * (`DIALOG_ACTION.tag` depends on `condition name`).
 */
export function fieldEnum(schema: GameSchema | undefined, typeName: string, key: string, rec?: GameRecord): EnumDef | undefined {
  if (typeName === 'DIALOG_ACTION' && key === 'tag' && rec) {
    const cond = rec.ints.get('condition name');
    const condDef = getEnum(schema, 'DialogConditionEnum');
    const condName = cond !== undefined && condDef ? enumValue(condDef, cond)?.name : undefined;
    const tagEnum = condName !== undefined ? CONDITION_TAG_ENUMS[condName] : undefined;
    return tagEnum !== undefined ? getEnum(schema, tagEnum) : undefined;
  }
  const t = schema?.types.get(typeName);
  const f = t && findField(t, key);
  if (f?.kind === 'enum' && f.enumName !== undefined && !f.bitset) return getEnum(schema, f.enumName);
  const builtin = BUILTIN_FIELD_ENUMS[typeName]?.[key];
  return builtin !== undefined ? getEnum(schema, builtin) : undefined;
}

/** Enum of reference value `slot` (0..2) in category `category` of a record of type `typeName`. */
export function refValueEnum(schema: GameSchema | undefined, typeName: string, category: string, slot: number): EnumDef | undefined {
  const name = BUILTIN_REF_VALUE_ENUMS[`${typeName}.${category}`]?.[slot];
  return name !== undefined ? getEnum(schema, name) : undefined;
}

/** Labels of reference values v0..v2 (`event`, `value`) in the interface language, if known. */
export function refValueLabels(typeName: string, category: string, lang = 'en'): string[] | undefined {
  return BUILTIN_REF_VALUE_LABELS[`${typeName}.${category}`]?.map((t) => uiText(t, lang));
}

/**
 * Events of a `DIALOGUE_PACKAGE.dialogs` reference as the game reads them: every one of v0, v1, v2
 * except 0 (EV_NONE) and 100, without repeats, in slot order.
 */
export function packageRefEvents(ref: Pick<Reference, 'v0' | 'v1' | 'v2'>): number[] {
  const out: number[] = [];
  for (const v of [ref.v0, ref.v1, ref.v2]) if (!PACKAGE_EVENT_SKIP.includes(v) && !out.includes(v)) out.push(v);
  return out;
}

/** "Not in" of an unknown enum value, per interface language. */
const NOT_IN: Record<string, string> = { en: 'not in', ru: 'нет в', zh: '不在' };

/** Enum of package dialogue events (`DIALOGUE_PACKAGE.dialogs` v0..v2). */
export const EVENT_ENUM = 'EventTriggerEnum';

/** Short label of a value in the interface language (built-in enums only); Russian is the stored one. */
export function enumLabel(def: EnumDef, v: EnumValue, lang = 'en'): string | undefined {
  if (def.name === EVENT_ENUM) {
    const help = eventHelp(v.name);
    if (help) return uiText(help.label, lang);
  }
  if (v.label === undefined) return undefined;
  if (lang === 'ru') return v.label;
  return BUILTIN_ENUM_LABELS_I18N[lang]?.[def.name]?.[v.name] ?? BUILTIN_ENUM_LABELS_I18N.en![def.name]?.[v.name] ?? v.label;
}

/**
 * `DR_ONCE_ONLY "once only" (5)`; an unknown value gives `5 (not in DialogRepetitionEnum)`.
 * Events read the other way round, the human name first: `Acid rain · EV_ACID_RAIN (62)`.
 */
export function formatEnumValue(def: EnumDef, value: number, lang = 'en'): string {
  const v = enumValue(def, value);
  if (!v) return `${value} (${NOT_IN[lang] ?? NOT_IN.en!} ${def.name})`;
  const label = enumLabel(def, v, lang);
  if (def.name === EVENT_ENUM && label !== undefined) return `${label} · ${v.name} (${value})`;
  return `${v.name}${label !== undefined ? ` ${quote(label, lang)}` : ''} (${value})`;
}

/** Short value label: the Russian label, otherwise the name, otherwise the number. */
export function shortEnumLabel(def: EnumDef, value: number, lang = 'en'): string {
  const v = enumValue(def, value);
  return v ? (enumLabel(def, v, lang) ?? v.name) : String(value);
}

/**
 * Enum value from input: a number, a name (`DR_ONCE_ONLY`), a name without prefix (`ONCE_ONLY`) or
 * the Russian label. `undefined` if not found.
 */
export function parseEnumValue(def: EnumDef, input: string | number): number | undefined {
  if (typeof input === 'number') return Number.isInteger(input) ? input : undefined;
  const s = input.trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  const lower = s.toLowerCase();
  const hit =
    def.values.find((v) => v.name === s) ??
    def.values.find((v) => v.name.toLowerCase() === lower || v.name.toLowerCase().replace(/^[a-z]+_/, '') === lower) ??
    def.values.find((v) => v.label?.toLowerCase() === lower) ??
    (def.name === EVENT_ENUM ? def.values.find((v) => Object.values(eventHelp(v.name)?.label ?? {}).some((l) => l?.toLowerCase() === lower)) : undefined);
  return hit?.value;
}

/**
 * Whether an enum value matches a search: the number, the name (`EV_ACID_RAIN`, `acid_rain`,
 * `acid rain`) or the label in the interface language or in English. Every word must match.
 */
export function enumValueMatches(def: EnumDef, v: EnumValue, query: string, lang = 'en'): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (/^\d+$/.test(q)) return String(v.value) === q;
  const hay = [v.name, v.name.replace(/_/g, ' '), enumLabel(def, v, lang) ?? '', enumLabel(def, v, 'en') ?? '', v.label ?? ''].join(' | ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

const ACTION_WORDS: Record<string, { action: string; condition: string }> = {
  en: { action: 'action', condition: 'condition' },
  ru: { action: 'действие', condition: 'условие' },
  zh: { action: '动作', condition: '条件' },
};

/**
 * A dialogue condition or effect as one line: `target: DC_RELATIONS < 20`,
 * `DC_PERSONALITY_TAG PT_SMART = 1`, `DA_TRADE`. `ref` is the reference to DIALOG_ACTION from
 * `conditions` (the compared value is v0 of the reference) or `effects`.
 */
export function describeDialogAction(ctx: ModContext, ref: Reference, category: string, lang = 'en'): string | undefined {
  const w = ACTION_WORDS[lang] ?? ACTION_WORDS.en!;
  const a = ctx.get(ref.target);
  if (!a || itemTypeName(a.type) !== 'DIALOG_ACTION') return undefined;
  const schema = ctx.schema;
  const ints = a.ints;
  if (category === 'effects' || (!ints.has('condition name') && ints.has('action name'))) {
    const action = ints.get('action name');
    if (action === undefined) return undefined;
    const def = getEnum(schema, 'DialogActionEnum')!;
    const v = enumValue(def, action);
    const vals = ref.v0 || ref.v1 || ref.v2 ? ` ${ref.v0}/${ref.v1}/${ref.v2}` : '';
    return `${v?.name ?? `${w.action} ${action}`}${vals}`;
  }
  const cond = ints.get('condition name');
  if (cond === undefined) return undefined;
  const condDef = getEnum(schema, 'DialogConditionEnum')!;
  const parts: string[] = [];
  const who = ints.get('who');
  if (who !== undefined) parts.push(`${shortEnumLabel(getEnum(schema, 'TalkerEnum')!, who, lang)}:`);
  parts.push(enumValue(condDef, cond)?.name ?? `${w.condition} ${cond}`);
  const tag = ints.get('tag');
  const tagDef = fieldEnum(schema, 'DIALOG_ACTION', 'tag', a);
  if (tag !== undefined && tag !== -1) parts.push(tagDef ? (enumValue(tagDef, tag)?.name ?? `tag ${tag}`) : `tag ${tag}`);
  const sv = a.strings.get('stringvar');
  if (sv && sv.length > 0) parts.push(JSON.stringify(decodeText(sv)));
  const cmp = ints.get('compare by') ?? 0;
  parts.push(shortEnumLabel(getEnum(schema, 'ComparisonEnum')!, cmp), String(ref.v0));
  return parts.join(' ');
}

/**
 * Label of reference values for display: `event EV_LAUNCH_ATTACK "launching an attack" (16)`.
 * Slots after the first are shown only when set: `event EV_X (3), event 2 EV_Y (23)`.
 */
export function describeRefValues(schema: GameSchema | undefined, typeName: string, category: string, ref: Reference, lang = 'en'): string | undefined {
  if (!refValueEnum(schema, typeName, category, 0)) return undefined;
  const labels = refValueLabels(typeName, category, lang);
  const values = [ref.v0, ref.v1, ref.v2];
  const parts: string[] = [];
  values.forEach((v, i) => {
    const def = refValueEnum(schema, typeName, category, i);
    if (!def || (i > 0 && v === 0)) return;
    parts.push(`${labels?.[i] ?? `v${i}`} ${formatEnumValue(def, v, lang)}`);
  });
  return parts.join(', ');
}
