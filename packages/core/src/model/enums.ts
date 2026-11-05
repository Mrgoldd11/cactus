/**
 * Имена значений перечислений: поля-enum (из fcs.def и встроенные в FCS), `DIALOG_ACTION.tag`,
 * значения ссылок (событие в `DIALOGUE_PACKAGE.dialogs`). Общая основа для CLI, MCP и редактора.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import { decodeText } from '../text.ts';
import {
  BUILTIN_ENUM_LABELS,
  BUILTIN_ENUMS,
  BUILTIN_FIELD_ENUMS,
  BUILTIN_REF_VALUE_ENUMS,
  BUILTIN_REF_VALUE_LABELS,
  CONDITION_TAG_ENUMS,
} from '../schema/builtin-enums.ts';
import type { EnumDef, EnumValue } from '../schema/fcs-enums.ts';
import { findField, type GameSchema } from '../schema/game-schema.ts';
import type { ModContext } from './context.ts';

let builtinDefs: Map<string, EnumDef> | undefined;

/** Встроенные перечисления, когда схемы игры нет (тесты, контекст без fcs.def). */
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

/** Enum по имени: из схемы, иначе встроенный. */
export function getEnum(schema: GameSchema | undefined, name: string): EnumDef | undefined {
  return schema?.enums.get(name) ?? builtinEnumDefs().get(name);
}

export function enumValue(def: EnumDef, value: number): EnumValue | undefined {
  return def.values.find((v) => v.value === value);
}

/**
 * Enum поля записи. `rec` нужен для полей, чей enum зависит от других полей
 * (`DIALOG_ACTION.tag` — по `condition name`).
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

/** Enum значения ссылки `slot` (0..2) в категории `category` записи типа `typeName`. */
export function refValueEnum(schema: GameSchema | undefined, typeName: string, category: string, slot: number): EnumDef | undefined {
  const name = BUILTIN_REF_VALUE_ENUMS[`${typeName}.${category}`]?.[slot];
  return name !== undefined ? getEnum(schema, name) : undefined;
}

/** Подписи значений ссылки v0..v2 (`событие`, `значение`), если известны. */
export function refValueLabels(typeName: string, category: string): readonly string[] | undefined {
  return BUILTIN_REF_VALUE_LABELS[`${typeName}.${category}`];
}

/** `DR_ONCE_ONLY «один раз» (5)`; неизвестное значение — `5 (нет в DialogRepetitionEnum)`. */
export function formatEnumValue(def: EnumDef, value: number): string {
  const v = enumValue(def, value);
  if (!v) return `${value} (нет в ${def.name})`;
  return `${v.name}${v.label !== undefined ? ` «${v.label}»` : ''} (${value})`;
}

/** Короткая подпись значения: русская подпись, иначе имя, иначе число. */
export function shortEnumLabel(def: EnumDef, value: number): string {
  const v = enumValue(def, value);
  return v ? (v.label ?? v.name) : String(value);
}

/**
 * Значение enum из ввода: число, имя (`DR_ONCE_ONLY`), имя без префикса (`ONCE_ONLY`) или
 * русская подпись. `undefined` — не найдено.
 */
export function parseEnumValue(def: EnumDef, input: string | number): number | undefined {
  if (typeof input === 'number') return Number.isInteger(input) ? input : undefined;
  const s = input.trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  const lower = s.toLowerCase();
  const hit =
    def.values.find((v) => v.name === s) ??
    def.values.find((v) => v.name.toLowerCase() === lower || v.name.toLowerCase().replace(/^[a-z]+_/, '') === lower) ??
    def.values.find((v) => v.label?.toLowerCase() === lower);
  return hit?.value;
}

/**
 * Условие или действие диалога одной строкой: `собеседник: DC_RELATIONS < 20`,
 * `DC_PERSONALITY_TAG PT_SMART = 1`, `DA_TRADE`. `ref` — ссылка на DIALOG_ACTION из
 * `conditions` (сравниваемое значение — v0 ссылки) или `effects`.
 */
export function describeDialogAction(ctx: ModContext, ref: Reference, category: string): string | undefined {
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
    return `${v?.name ?? `действие ${action}`}${vals}`;
  }
  const cond = ints.get('condition name');
  if (cond === undefined) return undefined;
  const condDef = getEnum(schema, 'DialogConditionEnum')!;
  const parts: string[] = [];
  const who = ints.get('who');
  if (who !== undefined) parts.push(`${shortEnumLabel(getEnum(schema, 'TalkerEnum')!, who)}:`);
  parts.push(enumValue(condDef, cond)?.name ?? `условие ${cond}`);
  const tag = ints.get('tag');
  const tagDef = fieldEnum(schema, 'DIALOG_ACTION', 'tag', a);
  if (tag !== undefined && tag !== -1) parts.push(tagDef ? (enumValue(tagDef, tag)?.name ?? `tag ${tag}`) : `tag ${tag}`);
  const sv = a.strings.get('stringvar');
  if (sv && sv.length > 0) parts.push(JSON.stringify(decodeText(sv)));
  const cmp = ints.get('compare by') ?? 0;
  parts.push(shortEnumLabel(getEnum(schema, 'ComparisonEnum')!, cmp), String(ref.v0));
  return parts.join(' ');
}

/** Подпись значений ссылки для показа: `событие EV_LAUNCH_ATTACK «начинаю атаку» (16)`. */
export function describeRefValues(schema: GameSchema | undefined, typeName: string, category: string, ref: Reference): string | undefined {
  const def = refValueEnum(schema, typeName, category, 0);
  if (!def) return undefined;
  const label = refValueLabels(typeName, category)?.[0] ?? 'v0';
  return `${label} ${formatEnumValue(def, ref.v0)}`;
}
