/**
 * Dialogue graph for display: nodes are records (package, dialogue, lines), each once, edges are
 * `dialogs` / `lines` references, including back ones (menu loops). Line texts come with the game's
 * Russian translation (`ru_RU.translation`) if passed. Checks: missing record, dialogue without
 * lines, an NPC line that is never picked (a sibling line always fits, stands earlier in the
 * game's list and has a higher score), a branch cut off by the limit. Scores are as in the game
 * (`score bonus` with bonuses, see `dialogue-score.ts`).
 */
import { decodeText } from '../text.ts';
import type { UiText } from '../ui-text.ts';
import type { GameRecord } from '../format/types.ts';
import { translatedText, type TranslationIndex } from '../locale/translation.ts';
import type { ModContext } from './context.ts';
import { buildDialogueTree, type DialogueNode } from './dialogue.ts';
import { alwaysPasses, chooseOrder, DIALOGUE_CONDITION_CATEGORIES, dialogueScore, isEmptyNode, type ScorePart } from './dialogue-score.ts';
import { formatEnumValue, getEnum, refValueEnum, shortEnumLabel } from './enums.ts';

/**
 * Speakers T_TARGET and T_TARGET_IF_PLAYER: in a click conversation this is the player; their lines are
 * choice options, not a random pick of the game.
 */
export const CHOICE_SPEAKERS: ReadonlySet<number> = new Set([1, 2]);
export interface DialogueGraphText {
  en: string;
  localized?: string;
}

export type DialogueIssueKind = 'missing' | 'no-lines' | 'shadowed' | 'truncated';

export interface DialogueIssue {
  kind: DialogueIssueKind;
  node: string;
  /** For `shadowed`: the line that always wins. */
  by?: string;
  /** English text. */
  text: string;
  /** The text in every interface language. */
  texts: UiText;
}

export interface DialogueGraphNode {
  id: string;
  type: string;
  name: string;
  localized?: string;
  texts: DialogueGraphText[];
  speaker?: number;
  /** Speaker label: "me", "target", ... */
  speakerLabel?: string;
  /** A T_TARGET line (a player choice option). */
  choice: boolean;
  /** Score as the game computes it (`score bonus` with bonuses). */
  score?: number;
  /** What the score is made of. */
  scoreParts?: ScorePart[];
  /** `chance temporary`, %. */
  chance?: number;
  conditions: string[];
  effects: string[];
  /** Other condition references (`target race: Shek`, ...). */
  filters: string[];
  /** Package event (the first of `events`), if the node is a package dialogue. */
  event?: number;
  /** All package events of the reference (v0..v2, see `packageRefEvents`). */
  events?: number[];
  eventLabel?: string;
  depth: number;
  missing?: boolean;
  noLines?: boolean;
  truncated?: boolean;
  issues: DialogueIssue[];
}

export interface DialogueGraphEdge {
  id: string;
  source: string;
  target: string;
  category: 'dialogs' | 'lines';
  /** Reference order at the source (0, 1, ...). */
  order: number;
  /** Leads to a record already shown above (a loop or a shared node). */
  back: boolean;
}

export interface DialogueGraph {
  root: string;
  nodes: DialogueGraphNode[];
  edges: DialogueGraphEdge[];
  issues: DialogueIssue[];
}

export interface DialogueGraphOptions {
  maxNodes?: number;
  translation?: TranslationIndex;
  /** Interface language of speaker, event and condition labels (default English). */
  lang?: string;
}

function chance(rec: GameRecord): number {
  return rec.floats.get('chance temporary') ?? 100;
}

function shortName(ctx: ModContext, sid: string, translation?: TranslationIndex): string {
  const r = ctx.get(sid);
  const t = r?.strings.get('text0');
  const en = t ? decodeText(t) : undefined;
  const s = en !== undefined ? (translatedText(translation, sid, 'text0', en) ?? en) : r ? decodeText(r.name) : sid;
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * NPC lines under one node that the game never picks: earlier in the game's list there is
 * a sibling line with text that always fits (no conditions, chance, lock), and it has a
 * higher score. The game goes down the list from the top and stops at a line with a lower score.
 * Player lines (T_TARGET, T_TARGET_IF_PLAYER) are choice options and are not compared.
 */
export function shadowedLines(ctx: ModContext, parent: string): { line: string; by: string }[] {
  const rec = ctx.get(parent);
  if (!rec) return [];
  const npc = (rec.refs.get('lines') ?? []).map((r) => r.target).filter((sid) => {
    const r = ctx.get(sid);
    return r !== undefined && !CHOICE_SPEAKERS.has(r.ints.get('speaker') ?? 0);
  });
  const order = chooseOrder(ctx, [...new Set(npc)]);
  const out: { line: string; by: string }[] = [];
  let sure: { sid: string; score: number } | undefined;
  for (const sid of order) {
    const r = ctx.get(sid);
    if (!r) continue;
    const s = dialogueScore(ctx, r).total;
    if (sure && !isEmptyNode(r) && s < sure.score) out.push({ line: sid, by: sure.sid });
    if (alwaysPasses(r) && !isEmptyNode(r) && (!sure || s > sure.score)) sure = { sid, score: s };
  }
  return out;
}

export function buildDialogueGraph(ctx: ModContext, stringId: string, options: DialogueGraphOptions = {}): DialogueGraph {
  const lang = options.lang ?? 'en';
  const tree = buildDialogueTree(ctx, stringId, { maxNodes: options.maxNodes ?? 400, lang });
  const talker = getEnum(ctx.schema, 'TalkerEnum');
  const eventDef = refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
  const nodes: DialogueGraphNode[] = [];
  const byId = new Map<string, DialogueGraphNode>();
  const edges: DialogueGraphEdge[] = [];
  const issues: DialogueIssue[] = [];

  const toNode = (n: DialogueNode, depth: number): DialogueGraphNode => {
    const rec = ctx.get(n.stringId);
    const node: DialogueGraphNode = {
      id: n.stringId,
      type: n.type,
      name: n.name,
      texts: [],
      choice: n.speaker !== undefined && CHOICE_SPEAKERS.has(n.speaker),
      conditions: n.conditions.map((c) => c.text ?? c.name),
      effects: n.effects.map((e) => e.text ?? e.name),
      filters: n.refs.filter((r) => (DIALOGUE_CONDITION_CATEGORIES as readonly string[]).includes(r.category)).map((r) => `${r.category}: ${r.targets.join(', ')}`),
      depth,
      issues: [],
    };
    const loc = ctx.localizedName(n.stringId);
    if (loc !== undefined) node.localized = loc;
    if (rec) {
      for (const [k, v] of rec.strings) {
        if (!/^text\d+$/.test(k)) continue;
        const en = decodeText(v);
        if (en === '') continue;
        const t: DialogueGraphText = { en };
        const tr = translatedText(options.translation, n.stringId, k, en);
        if (tr !== undefined) t.localized = tr;
        node.texts.push(t);
      }
      if (n.type === 'DIALOGUE_LINE') {
        const sc = dialogueScore(ctx, rec);
        node.score = sc.total;
        node.scoreParts = sc.parts;
        node.chance = chance(rec);
      }
    }
    if (n.speaker !== undefined) {
      node.speaker = n.speaker;
      if (talker) node.speakerLabel = shortEnumLabel(talker, n.speaker, lang);
    }
    if (n.event !== undefined) {
      const evs = n.events ?? [n.event];
      node.event = n.event;
      node.events = evs;
      if (eventDef) node.eventLabel = evs.map((e) => formatEnumValue(eventDef, e, lang)).join(', ');
    }
    const issue = (kind: DialogueIssueKind, texts: UiText, by?: string): void => {
      const i: DialogueIssue = { kind, node: n.stringId, text: texts.en, texts, ...(by !== undefined ? { by } : {}) };
      node.issues.push(i);
      issues.push(i);
    };
    if (n.missing) {
      node.missing = true;
      issue('missing', { en: `record ${n.stringId} is missing`, ru: `нет записи ${n.stringId}`, zh: `没有记录 ${n.stringId}` });
    }
    if (n.noLines) {
      node.noLines = true;
      issue('no-lines', { en: 'dialogue without lines — says nothing in the game', ru: 'диалог без реплик — в игре ничего не скажет', zh: '对话没有台词 — 在游戏中不会说任何话' });
    }
    if (n.truncated) {
      node.truncated = true;
      issue('truncated', { en: 'not expanded further (node limit)', ru: 'дальше не развёрнуто (лимит узлов)', zh: '未继续展开（节点上限）' });
    }
    return node;
  };

  const walk = (n: DialogueNode, depth: number): void => {
    const node = toNode(n, depth);
    nodes.push(node);
    byId.set(node.id, node);
    const rec = ctx.get(n.stringId);
    const order = new Map<string, number>();
    for (const cat of ['dialogs', 'lines'] as const) (rec?.refs.get(cat) ?? []).forEach((r, i) => order.set(r.target, i));
    for (const c of n.children) {
      const cat = rec?.refs.get('dialogs')?.some((r) => r.target === c.stringId) ? 'dialogs' : 'lines';
      edges.push({ id: `${n.stringId}>${c.stringId}#${edges.length}`, source: n.stringId, target: c.stringId, category: cat, order: order.get(c.stringId) ?? 0, back: c.repeated === true });
      if (!c.repeated) walk(c, depth + 1);
    }
  };
  walk(tree, 0);

  for (const node of nodes) {
    for (const s of shadowedLines(ctx, node.id)) {
      const target = byId.get(s.line);
      if (!target || target.issues.some((i) => i.kind === 'shadowed')) continue;
      const by = shortName(ctx, s.by, options.translation);
      const texts: UiText = {
        en: `never chosen: sibling line “${by}” always fits, comes earlier and has a higher score`,
        ru: `не будет выбрана: соседняя реплика «${by}» подходит всегда, стоит раньше, и очков у неё больше`,
        zh: `永远不会被选中：同级台词 “${by}” 始终适用、排在前面且分数更高`,
      };
      const i: DialogueIssue = { kind: 'shadowed', node: s.line, by: s.by, text: texts.en, texts };
      target.issues.push(i);
      issues.push(i);
    }
  }
  return { root: stringId, nodes, edges, issues };
}
