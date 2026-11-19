/**
 * What a node of the «line = node» dialogue graph shows besides the text (UI review G2):
 * - who speaks: NPC, the player (a choice option) or an interjection (another character);
 * - for NPC lines with NPC siblings: the order in which the game tries them (①②) and ties;
 * - conditions («if …») and effects («→ …») as ready phrases with the FCS code;
 * - badges for properties that differ from the defaults (locked, chance, «once per 6 h»…).
 * Reads the records of a built `DialogueGraph`; does not change anything.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import type { DialogPhrase } from '../schema/dialog-help.ts';
import { uiText, type UiText } from '../ui-text.ts';
import type { ModContext } from './context.ts';
import { recordPhrases } from './dialog-phrase.ts';
import type { DialogueGraph } from './dialogue-graph.ts';
import { CHOICE_SPEAKERS } from './dialogue-graph.ts';
import { chooseRanking } from './dialogue-score.ts';
import { enumValue, fieldEnum, getEnum, shortEnumLabel } from './enums.ts';

/** `head` — a dialogue or a package; `missing` — no record. */
export type LineKind = 'npc' | 'player' | 'inter' | 'head' | 'missing';

/** Speakers of interjection lines: T_INTERJECTOR1..3 and T_WHOLE_SQUAD. */
export const INTERJECTION_SPEAKERS: ReadonlySet<number> = new Set([3, 4, 5, 6]);

export interface LineBadge {
  /** Field the badge comes from (`locked`, `chance temporary`…). */
  field: string;
  /** Label in the interface language: «locked», «chance 30%», «once per 6 h». */
  label: string;
  /** FCS form: `locked=true`, `repetition limit=DR_MEDIUM_6`. */
  code: string;
}

export interface LineView {
  kind: LineKind;
  /** FCS speaker code of a line (`T_ME`, `T_TARGET`…). */
  speakerCode?: string;
  /** Position (1, 2, …) among the NPC lines under the tree parent, in the game's checking order. */
  order?: number;
  /** Another NPC sibling has the same sort key: the list position decides. */
  tie?: boolean;
  conditions: DialogPhrase[];
  effects: DialogPhrase[];
  badges: LineBadge[];
}

const t = (en: string, ru: string, zh: string): UiText => ({ en, ru, zh });

const LABELS = {
  locked: t('locked', 'заперт', '已锁定'),
  onceOnly: t('once only', 'один раз', '仅一次'),
  forEnemies: t('for enemies', 'для врагов', '对敌人'),
  notMonologue: t('not a monologue', 'не монолог', '非独白'),
  oneAtATime: t('one at a time', 'по одному', '一次一个'),
  unique: t('unique', 'уникальная', '唯一'),
  chance: t('chance {n}%', 'шанс {n}%', '几率 {n}%'),
  chancePermanent: t('has it: {n}%', 'есть у {n}%', '拥有几率 {n}%'),
  repetition: t('limit: {v}', 'не чаще: {v}', '限制：{v}'),
  score: t('score {n}', 'очки {n}', '分数 {n}'),
  targetType: t('only for: {v}', 'только для: {v}', '仅限：{v}'),
};

const fill = (text: UiText, lang: string, k: string, v: string): string => uiText(text, lang).replace(`{${k}}`, v);

/** Kind of a line record by its speaker and the `interjection` flag. */
export function lineKind(rec: GameRecord | undefined): LineKind {
  if (!rec) return 'missing';
  if (itemTypeName(rec.type) !== 'DIALOGUE_LINE') return 'head';
  const sp = rec.ints.get('speaker') ?? 0;
  if (rec.bools.get('interjection') || INTERJECTION_SPEAKERS.has(sp)) return 'inter';
  return CHOICE_SPEAKERS.has(sp) ? 'player' : 'npc';
}

/** Badges of the properties that differ from the defaults, in a fixed order. */
export function lineBadges(ctx: ModContext, rec: GameRecord, lang = 'en'): LineBadge[] {
  const out: LineBadge[] = [];
  const typeName = itemTypeName(rec.type);
  const flag = (field: string, on: boolean, label: UiText, code: string): void => {
    if (on) out.push({ field, label: uiText(label, lang), code });
  };
  if (typeName === 'DIALOGUE') {
    flag('locked', rec.bools.get('locked') === true, LABELS.locked, 'locked=true');
    flag('once only', rec.bools.get('once only') === true, LABELS.onceOnly, 'once only=true');
    flag('for enemies', rec.bools.get('for enemies') === true, LABELS.forEnemies, 'for enemies=true');
    // monologue is true by default (fcs.def).
    flag('monologue', rec.bools.get('monologue') === false, LABELS.notMonologue, 'monologue=false');
    flag('one at a time', rec.bools.get('one at a time') === true, LABELS.oneAtATime, 'one at a time=true');
  }
  flag('unique', rec.bools.get('unique') === true, LABELS.unique, 'unique=true');
  const ct = rec.floats.get('chance temporary') ?? 100;
  if (ct < 100) out.push({ field: 'chance temporary', label: fill(LABELS.chance, lang, 'n', String(ct)), code: `chance temporary=${ct}` });
  const cp = rec.floats.get('chance permanent') ?? 100;
  if (cp < 100) out.push({ field: 'chance permanent', label: fill(LABELS.chancePermanent, lang, 'n', String(cp)), code: `chance permanent=${cp}` });
  const enumBadge = (field: string, fallbackEnum: string, label: UiText): void => {
    const n = rec.ints.get(field) ?? 0;
    if (n === 0) return;
    const def = fieldEnum(ctx.schema, typeName, field, rec) ?? getEnum(ctx.schema, fallbackEnum);
    const name = def ? (enumValue(def, n)?.name ?? String(n)) : String(n);
    out.push({ field, label: fill(label, lang, 'v', def ? shortEnumLabel(def, n, lang) : String(n)), code: `${field}=${name}` });
  };
  enumBadge('repetition limit', 'DialogRepetitionEnum', LABELS.repetition);
  enumBadge('target is type', 'CharacterTypeEnum', LABELS.targetType);
  const bonus = rec.ints.get('score bonus') ?? 0;
  if (bonus !== 0) out.push({ field: 'score bonus', label: fill(LABELS.score, lang, 'n', bonus > 0 ? `+${bonus}` : String(bonus)), code: `score bonus=${bonus}` });
  return out;
}

/** Views of all nodes of `graph` (by node id). */
export function dialogueLineViews(ctx: ModContext, graph: DialogueGraph, lang = 'en'): Map<string, LineView> {
  const out = new Map<string, LineView>();
  const talker = getEnum(ctx.schema, 'TalkerEnum');
  for (const n of graph.nodes) {
    const rec = n.missing ? undefined : ctx.get(n.id);
    const kind = lineKind(rec);
    const view: LineView = { kind, conditions: [], effects: [], badges: [] };
    if (rec && kind !== 'head' && talker) {
      const sp = rec.ints.get('speaker') ?? 0;
      view.speakerCode = enumValue(talker, sp)?.name ?? String(sp);
    }
    if (rec && (kind !== 'head' || itemTypeName(rec.type) === 'DIALOGUE')) {
      const p = recordPhrases(ctx, rec, lang, kind === 'head' ? 'dialogue' : 'line', false);
      view.conditions = p.conditions;
      view.effects = p.effects;
      view.badges = lineBadges(ctx, rec, lang);
    }
    out.set(n.id, view);
  }
  // Checking order: NPC lines (not player options) under the same tree parent, as the game sorts them.
  const kids = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.back || e.category !== 'lines') continue;
    const k = out.get(e.target)?.kind;
    if (k !== 'npc' && k !== 'inter') continue;
    const list = kids.get(e.source) ?? [];
    if (!list.includes(e.target)) list.push(e.target);
    kids.set(e.source, list);
  }
  for (const [parent, list] of kids) {
    if (list.length < 2) continue;
    // The game sorts all lines of the parent, in the record's order.
    const all = (ctx.get(parent)?.refs.get('lines') ?? []).map((r) => r.target).filter((s) => list.includes(s));
    const ranked = chooseRanking(ctx, [...new Set(all)]);
    ranked.forEach((r, i) => {
      const v = out.get(r.sid);
      if (!v) return;
      v.order = i + 1;
      if (ranked.some((o, j) => j !== i && o.key === r.key)) v.tie = true;
    });
  }
  return out;
}
