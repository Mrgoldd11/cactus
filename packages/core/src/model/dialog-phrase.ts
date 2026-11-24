/**
 * Ready phrases for the conditions and effects of a dialogue line, read from the mod:
 * DIALOG_ACTION references (`conditions`, `effects`) and the reference categories of
 * DIALOGUE_LINE / DIALOGUE (`my race`, `target faction`, `give item`…). Wording is in
 * `schema/dialog-help.ts`; this module only reads records.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import { conditionPhrase, effectPhrase, LINE_REF_HELP, lineFieldPhrase, lineRefPhrase, type DialogPhrase } from '../schema/dialog-help.ts';
import type { ModContext } from './context.ts';
import { describeDialogAction, enumValue, fieldEnum, getEnum, shortEnumLabel } from './enums.ts';

/**
 * Phrase of one DIALOG_ACTION reference: «Say only if I am starving», «Then: the trade window opens».
 * `undefined` when the target is not a DIALOG_ACTION or has neither a condition nor an action.
 */
export function dialogActionPhrase(
  ctx: ModContext,
  ref: Reference,
  category: string,
  lang = 'en',
  on: 'line' | 'dialogue' = 'line',
): DialogPhrase | undefined {
  const a = ctx.get(ref.target);
  if (!a || itemTypeName(a.type) !== 'DIALOG_ACTION') return undefined;
  const schema = ctx.schema;
  const ints = a.ints;
  if (category === 'effects' || (!ints.has('condition name') && ints.has('action name'))) {
    const action = ints.get('action name');
    if (action === undefined) return undefined;
    const v = enumValue(getEnum(schema, 'DialogActionEnum')!, action);
    return effectPhrase({ action: v?.name ?? String(action), values: [ref.v0, ref.v1, ref.v2] }, lang);
  }
  const cond = ints.get('condition name');
  if (cond === undefined) return undefined;
  const cv = enumValue(getEnum(schema, 'DialogConditionEnum')!, cond);
  const tag = ints.get('tag');
  const tagDef = fieldEnum(schema, 'DIALOG_ACTION', 'tag', a);
  const tagName = tag !== undefined && tag !== -1 ? (tagDef ? enumValue(tagDef, tag)?.name : undefined) ?? `tag ${tag}` : undefined;
  return conditionPhrase(
    {
      cond: cv?.name ?? String(cond),
      ...(ints.has('who') ? { who: ints.get('who')! } : {}),
      cmp: ints.get('compare by') ?? 0,
      value: ref.v0,
      ...(tagName !== undefined ? { tag: tagName } : {}),
      ...(cv?.description ? { fallbackLabel: cv.description } : {}),
    },
    lang,
    on,
  );
}

/** Name of a reference target for a phrase: the translated name, the name, or the id. */
function targetName(ctx: ModContext, ref: Reference, withValue: boolean): string {
  const name = ctx.localizedName(ref.target) ?? ctx.name(ref.target) ?? ref.target;
  return withValue ? `${name} (${ref.v0})` : name;
}

/** Phrases of the reference categories of a line (conditions first, then effects), in schema order. */
export function lineRefPhrases(
  ctx: ModContext,
  rec: GameRecord,
  lang = 'en',
  on: 'line' | 'dialogue' = 'line',
): { category: string; kind: 'condition' | 'effect'; phrase: DialogPhrase }[] {
  const out: { category: string; kind: 'condition' | 'effect'; phrase: DialogPhrase }[] = [];
  for (const kind of ['condition', 'effect'] as const) {
    for (const [category, help] of Object.entries(LINE_REF_HELP)) {
      if (help.kind !== kind) continue;
      const refs = rec.refs.get(category) ?? [];
      if (refs.length === 0) continue;
      const names = refs.map((r) => targetName(ctx, r, help.value !== undefined));
      out.push({ category, kind, phrase: { ...lineRefPhrase(category, names, lang, on), source: { category } } });
    }
  }
  // A reference category without help (a field from a newer schema or an FCS Extended file) is still
  // shown — as its code — so that a node never hides what is on the record.
  for (const [category, refs] of rec.refs) {
    if (OWN_REF_CATEGORIES.has(category) || category in LINE_REF_HELP || refs.length === 0) continue;
    const names = refs.map((r) => targetName(ctx, r, false));
    out.push({ category, kind: 'effect', phrase: { ...lineRefPhrase(category, names, lang, on), source: { category } } });
  }
  return out;
}

/** Reference categories of DIALOGUE / DIALOGUE_LINE that are not phrases: the lines and the DIALOG_ACTION lists. */
const OWN_REF_CATEGORIES: ReadonlySet<string> = new Set(['lines', 'conditions', 'effects']);

/** Enum of a plain DIALOGUE_LINE field, from the schema or the built-in table. */
const FIELD_ENUMS: Readonly<Record<string, string>> = { 'repetition limit': 'DialogRepetitionEnum', 'target is type': 'CharacterTypeEnum' };

/**
 * All phrases of a DIALOGUE / DIALOGUE_LINE record: conditions (DIALOG_ACTION `conditions`, reference
 * filters, repetition limit, target type, chances) and effects (DIALOG_ACTION `effects`, reference effects).
 * A DIALOG_ACTION that cannot be read keeps its one-line code form. `fields: false` leaves out the plain
 * fields (for views that show the chance and repetition themselves).
 */
export function recordPhrases(
  ctx: ModContext,
  rec: GameRecord,
  lang = 'en',
  on: 'line' | 'dialogue' = 'line',
  fields = true,
): { conditions: DialogPhrase[]; effects: DialogPhrase[] } {
  const action = (category: string): DialogPhrase[] =>
    (rec.refs.get(category) ?? []).map((r) => {
      const source = { category, target: r.target };
      const p = dialogActionPhrase(ctx, r, category, lang, on);
      if (p) return { ...p, source };
      const code = describeDialogAction(ctx, r, category, lang) ?? r.target;
      return { text: code, short: code, code, source };
    });
  const refs = lineRefPhrases(ctx, rec, lang, on);
  const conditions = [...action('conditions'), ...refs.filter((x) => x.kind === 'condition').map((x) => x.phrase)];
  const typeName = itemTypeName(rec.type);
  for (const field of fields ? ['repetition limit', 'target is type'] : []) {
    const n = rec.ints.get(field) ?? 0;
    if (n === 0) continue;
    const def = fieldEnum(ctx.schema, typeName, field, rec) ?? getEnum(ctx.schema, FIELD_ENUMS[field]!);
    const value = def ? shortEnumLabel(def, n, lang) : String(n);
    const code = `${field}: ${def ? (enumValue(def, n)?.name ?? n) : n}`;
    conditions.push({ ...lineFieldPhrase(field, value, lang), code });
  }
  for (const field of fields ? ['chance temporary', 'chance permanent'] : []) {
    const n = rec.floats.get(field) ?? 100;
    if (n < 100) conditions.push(lineFieldPhrase(field, String(n), lang));
  }
  const effects = [...action('effects'), ...refs.filter((x) => x.kind === 'effect').map((x) => x.phrase)];
  return { conditions, effects };
}
