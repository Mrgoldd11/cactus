/**
 * One list for «+ condition» / «+ effect» of a dialogue line (UI review G4): DialogConditionEnum /
 * DialogActionEnum values (stored as DIALOG_ACTION records) and the reference categories of the
 * line that work as conditions or effects themselves (`my race` → RACE, `give item` → ITEM…).
 * The modder does not need to know where the game keeps each one: both kinds sit in the same
 * groups, are searched the same way (translation, English name, code) and are added by `addDialogPick`.
 */
import { itemTypeId } from '../format/item-types.ts';
import { addCondition, addEffect, addLineRef, dialogEnumUsage, type DialogEnumUsage } from '../dialog/edit.ts';
import {
  ACTION_GROUP_LABELS,
  ACTION_GROUPS,
  ACTION_HELP,
  CONDITION_GROUP_LABELS,
  CONDITION_GROUPS,
  CONDITION_HELP,
  LINE_REF_HELP,
} from '../schema/dialog-help.ts';
import { uiText, type UiText } from '../ui-text.ts';
import type { ModContext } from './context.ts';
import { getEnum } from './enums.ts';

export type DialogPickKind = 'condition' | 'effect';

export interface DialogPickItem {
  /** `DC_STARVING` for an enum value, `ref:my race` for a reference category. */
  key: string;
  kind: DialogPickKind;
  source: 'enum' | 'ref';
  /** The code shown next to the name: the enum value name or the reference category. */
  code: string;
  /** Enum value (source `enum`). */
  value?: number;
  /** Reference category (source `ref`). */
  category?: string;
  /** Record type a reference points to (source `ref`): RACE, FACTION, ITEM… */
  targetType?: string;
  /** Picker group key. */
  group: string;
  /** Name in the interface language, and in English (searched too). */
  label: string;
  labelEn: string;
  desc: string;
  /** How many records of the loaded data use it (0 — the game possibly ignores it). */
  used: number;
  /** The meaning comes from the code name only. */
  undescribed?: boolean;
}

export interface DialogPickGroup {
  key: string;
  label: string;
  items: DialogPickItem[];
}

/** Usage of conditions, effects and reference categories in the loaded data. */
export interface DialogPickUsage extends DialogEnumUsage {
  /** Reference category → how many DIALOGUE / DIALOGUE_LINE records have it. */
  refs: Map<string, number>;
}

const tx = (en: string, ru: string, zh: string): UiText => ({ en, ru, zh });

/** Groups the picker adds to the condition / effect groups of `dialog-help.ts`. */
export const DIALOG_PICK_GROUP_LABELS: Readonly<Record<string, UiText>> = {
  common: tx('Often used', 'Часто нужные', '常用'),
  items: tx('Items', 'Предметы', '物品'),
  world: tx('World', 'Мир', '世界'),
  other: tx('Other', 'Прочие', '其他'),
};

/** Picker group of each reference category of DIALOGUE / DIALOGUE_LINE. */
const REF_GROUPS: Readonly<Record<string, string>> = {
  'has package': 'who',
  'in town of': 'place',
  'is character': 'who',
  'my faction': 'who',
  'my race': 'who',
  'my subrace': 'who',
  'no target race': 'who',
  'target carrying character': 'captivity',
  'target faction': 'who',
  'target has item': 'items',
  'target has item type': 'items',
  'target race': 'who',
  'world state': 'world',
  'change relations': 'relations',
  'crowd trigger': 'dialog',
  'give item': 'trade',
  locks: 'dialog',
  'unlock but keep me': 'dialog',
  unlocks: 'dialog',
  'AI contract': 'squad',
  'change AI': 'squad',
  interrupt: 'dialog',
  'trigger campaign': 'fight',
  'lock campaign': 'fight',
  'unlock campaign': 'fight',
};

/** Group order: conditions and effects; `service` and `other` stay last. */
const CONDITION_ORDER: readonly string[] = [...CONDITION_GROUPS.filter((g) => g !== 'service'), 'items', 'world', 'service', 'other'];
const EFFECT_ORDER: readonly string[] = [...ACTION_GROUPS.filter((g) => g !== 'service'), 'service', 'other'];

function groupLabel(kind: DialogPickKind, key: string, lang: string): string {
  const own = (kind === 'condition' ? CONDITION_GROUP_LABELS : ACTION_GROUP_LABELS) as Readonly<Record<string, UiText>>;
  const l = own[key] ?? DIALOG_PICK_GROUP_LABELS[key];
  return l ? uiText(l, lang) : key;
}

/** Usage of conditions, effects and reference categories, one pass over the data. */
export function dialogPickUsage(ctx: ModContext): DialogPickUsage {
  const refs = new Map<string, number>();
  const types = new Set([itemTypeId('DIALOGUE'), itemTypeId('DIALOGUE_LINE')]);
  for (const r of ctx.records()) {
    if (!types.has(r.type)) continue;
    for (const [c, list] of r.refs) if (c in LINE_REF_HELP && list.length > 0) refs.set(c, (refs.get(c) ?? 0) + 1);
  }
  return { ...dialogEnumUsage(ctx), refs };
}

/**
 * Everything «+ condition» (`kind` condition) or «+ effect» can add to a record of `ownerType`
 * (DIALOGUE or DIALOGUE_LINE). Reference categories come only when the schema has them on that type.
 */
export function dialogPickItems(ctx: ModContext, ownerType: string, kind: DialogPickKind, lang = 'en', usage: DialogPickUsage = dialogPickUsage(ctx)): DialogPickItem[] {
  const out: DialogPickItem[] = [];
  const fields = ctx.schema?.types.get(ownerType)?.fields;
  const isCond = kind === 'condition';
  // Effects as DIALOG_ACTION records exist only on lines (`effects` is not a DIALOGUE field).
  if (isCond ? fields?.has('conditions') !== false : fields?.has('effects') === true) {
    const def = getEnum(ctx.schema, isCond ? 'DialogConditionEnum' : 'DialogActionEnum');
    const counts = isCond ? usage.conditions : usage.actions;
    for (const v of def?.values ?? []) {
      if (v.name.endsWith('_END') || v.name === 'DC_NONE' || v.name === 'DA_NONE') continue;
      const h = isCond ? CONDITION_HELP[v.name] : ACTION_HELP[v.name];
      out.push({
        key: v.name,
        kind,
        source: 'enum',
        code: v.name,
        value: v.value,
        group: h?.group ?? 'other',
        label: h ? uiText(h.label, lang) : (v.description ?? v.name),
        labelEn: h ? h.label.en : (v.description ?? v.name),
        desc: h ? uiText(h.desc, lang) : '',
        used: counts.get(v.value) ?? 0,
        ...(h?.undescribed ? { undescribed: true } : {}),
      });
    }
  }
  for (const [category, h] of Object.entries(LINE_REF_HELP)) {
    if (h.kind !== kind) continue;
    const f = fields?.get(category);
    if (!f || f.kind !== 'reference') continue;
    out.push({
      key: `ref:${category}`,
      kind,
      source: 'ref',
      code: category,
      category,
      ...(f.targetType !== undefined ? { targetType: f.targetType } : {}),
      group: REF_GROUPS[category] ?? 'other',
      label: uiText(h.label, lang),
      labelEn: h.label.en,
      desc: uiText(h.desc, lang),
      used: usage.refs.get(category) ?? 0,
    });
  }
  return out;
}

const fold = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

/**
 * Words a modder may search with that are not in the names: word stems in en / ru / zh → the items
 * (keys) or picker groups they mean. «предмет» finds «Give item», «здоров» the health group.
 */
const SYNONYMS: readonly { words: readonly string[]; keys?: readonly string[]; groups?: readonly string[] }[] = [
  { words: ['item', 'thing', 'предмет', 'вещ', 'дать', 'дает', 'подар', '物品', '东西', '给'], keys: ['ref:give item', 'ref:target has item', 'ref:target has item type'] },
  { words: ['health', 'hurt', 'injur', 'wound', 'здоров', 'ранен', 'рана', 'болен', 'голод', '健康', '受伤', '饥饿'], groups: ['state'] },
  { words: ['money', 'cats', 'pay', 'cash', 'деньг', 'кат', 'плат', 'монет', '钱', '金钱', '付'], groups: ['money', 'trade'] },
  { words: ['shop', 'buy', 'sell', 'торг', 'куп', 'прода', 'магаз', '买', '卖', '商店'], keys: ['DA_TRADE'], groups: ['trade'] },
  { words: ['fight', 'attack', 'kill', 'enemy', 'бой', 'драк', 'атак', 'напа', 'убит', 'враг', '战斗', '攻击', '敌'], groups: ['fight'] },
  { words: ['join', 'recruit', 'hire', 'follow', 'вступ', 'присоедин', 'наня', 'нанят', 'завербов', 'спутник', '加入', '招募', '雇'], groups: ['squad'] },
  { words: ['race', 'раса', 'расы', 'расе', '种族'], keys: ['ref:my race', 'ref:target race', 'ref:no target race', 'ref:my subrace'] },
  { words: ['faction', 'фракц', '派系', '阵营'], keys: ['ref:my faction', 'ref:target faction'] },
  { words: ['friend', 'relation', 'remember', 'memory', 'отношен', 'друж', 'друг', 'помн', 'памят', '关系', '朋友', '记'], groups: ['relations'] },
  { words: ['prison', 'jail', 'slave', 'law', 'arrest', 'тюрьм', 'плен', 'раб', 'закон', 'арест', '监狱', '奴隶', '法律'], groups: ['captivity', 'law'] },
  { words: ['town', 'city', 'place', 'город', 'место', 'дом', '城', '地点'], groups: ['place'] },
  { words: ['talk', 'conversation', 'разговор', 'беседа', 'реплик', '对话'], groups: ['dialog'] },
];

/** Labels of every picker group in every language, searched together with the item names. */
const GROUP_WORDS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const labels of [CONDITION_GROUP_LABELS, ACTION_GROUP_LABELS, DIALOG_PICK_GROUP_LABELS] as readonly Readonly<Record<string, UiText>>[])
    for (const [k, l] of Object.entries(labels)) out[k] = `${out[k] ?? ''} | ${l.en} | ${l.ru ?? ''} | ${l.zh ?? ''}`;
  return out;
})();

function synonymOf(item: DialogPickItem, w: string): boolean {
  // Short Latin / Cyrillic words are too vague for stems; Chinese ones are short by nature.
  if (w.length < 3 && !/[\u4e00-\u9fff]/.test(w)) return false;
  return SYNONYMS.some((s) => (s.keys?.includes(item.key) || s.groups?.includes(item.group)) && s.words.some((x) => x.startsWith(w) || w.startsWith(x)));
}

function hayOf(item: DialogPickItem): string {
  return fold([item.code, item.code.replace(/_/g, ' '), item.label, item.labelEn, GROUP_WORDS[item.group] ?? ''].join(' | '));
}

/**
 * Whether an item matches a search: code (`DC_STARV`, `my race`), name in the interface language
 * or English, its group's name, or a synonym (`SYNONYMS`). Every word of the query must match.
 */
export function dialogPickMatches(item: DialogPickItem, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const hay = hayOf(item);
  return q.split(/\s+/).every((w) => hay.includes(w) || synonymOf(item, w));
}

/**
 * «Maybe: …» when nothing matches: items whose name, description or group shares the start of any
 * word of the query (the first four letters), most used first.
 */
export function dialogPickMaybe(items: readonly DialogPickItem[], query: string, n = 5): DialogPickItem[] {
  const words = fold(query.trim())
    .split(/\s+/)
    .filter((w) => w.length >= 3 || /[\u4e00-\u9fff]/.test(w))
    .map((w) => w.slice(0, 4));
  if (!words.length) return [];
  return items
    .filter((i) => {
      const hay = `${hayOf(i)} | ${fold(i.desc)}`;
      return words.some((w) => hay.includes(w));
    })
    .sort((a, b) => b.used - a.used)
    .slice(0, n);
}

/** Effects that start a fight or a chase: «Often used» lists the peaceful ones first. */
const HOSTILE = /^DA_(ATTACK|DECLARE_WAR|MATES_KILL_ME|KNOCKOUT|FLAG_TEMP_ENEMY|CRIME_ALARM|MASSIVE_ALARM|ARREST|ASSAULT_PHASE|THUG_HUNTER)/;
const hostile = (i: DialogPickItem): boolean => i.group === 'fight' || HOSTILE.test(i.code);

/**
 * The picker list: items matching `query` by group. Without a query a group of the `common` most
 * used ones goes first (they stay in their own groups too). Within a group used ones go first.
 */
export function dialogPickGroups(items: readonly DialogPickItem[], kind: DialogPickKind, query: string, lang = 'en', common = 6): DialogPickGroup[] {
  const shown = items.filter((i) => dialogPickMatches(i, query));
  const order = kind === 'condition' ? CONDITION_ORDER : EFFECT_ORDER;
  const byGroup = new Map<string, DialogPickItem[]>();
  for (const i of shown) {
    const g = order.includes(i.group) ? i.group : 'other';
    byGroup.set(g, [...(byGroup.get(g) ?? []), i]);
  }
  const out: DialogPickGroup[] = [];
  if (query.trim() === '' && common > 0) {
    // By how often the loaded data (vanilla first of all) uses them; peaceful ones before fights.
    const top = [...shown]
      .filter((i) => i.used > 0)
      .sort((a, b) => Number(hostile(a)) - Number(hostile(b)) || b.used - a.used)
      .slice(0, common);
    if (top.length) out.push({ key: 'common', label: groupLabel(kind, 'common', lang), items: top });
  }
  for (const g of order) {
    const list = byGroup.get(g);
    if (!list) continue;
    // Stable: used ones first, in enum / schema order.
    const sorted = [...list.filter((i) => i.used > 0), ...list.filter((i) => i.used === 0)];
    out.push({ key: g, label: groupLabel(kind, g, lang), items: sorted });
  }
  return out;
}

/**
 * Add a picked item to `owner`: a DIALOG_ACTION condition / effect with plain defaults («who: I»,
 * «= 1» for yes/no conditions, «> 0» for numbers), or a reference to `target` in the item's category.
 * One undo step. Returns the new DIALOG_ACTION id, or the target for a reference.
 */
export function addDialogPick(ctx: ModContext, owner: string, item: DialogPickItem, target?: string): string {
  if (item.source === 'ref') {
    if (target === undefined || item.category === undefined) throw new Error(`${item.key}: no target record`);
    addLineRef(ctx, owner, item.category, target);
    return target;
  }
  const value = item.value ?? 0;
  if (item.kind === 'condition') {
    const number = CONDITION_HELP[item.code]?.kind === 'number';
    const more = getEnum(ctx.schema, 'ComparisonEnum')?.values.find((v) => v.name === 'CE_MORE_THAN')?.value ?? 2;
    return addCondition(ctx, owner, { cond: value, who: 0, cmp: number ? more : 0, value: number ? 0 : 1 });
  }
  return addEffect(ctx, owner, { action: value });
}
