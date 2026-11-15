/**
 * Граф диалога для показа: узлы — записи (пакет, диалог, реплики) по одному разу, рёбра —
 * ссылки `dialogs` / `lines`, в том числе обратные (петли меню). Тексты реплик — с русским
 * переводом игры (`ru_RU.translation`), если он передан. Проверки: нет записи, диалог без
 * реплик, реплика NPC, которую никогда не выберут (соседняя реплика подходит всегда, стоит в
 * списке игры раньше и очков у неё больше), ответвление обрезано лимитом. Очки — как у игры
 * (`score bonus` с надбавками, см. `dialogue-score.ts`).
 */
import { decodeText } from '../text.ts';
import type { GameRecord } from '../format/types.ts';
import { translatedText, type TranslationIndex } from '../locale/translation.ts';
import type { ModContext } from './context.ts';
import { buildDialogueTree, type DialogueNode } from './dialogue.ts';
import { alwaysPasses, chooseOrder, DIALOGUE_CONDITION_CATEGORIES, dialogueScore, isEmptyNode, type ScorePart } from './dialogue-score.ts';
import { formatEnumValue, getEnum, refValueEnum, shortEnumLabel } from './enums.ts';

/**
 * Говорящие T_TARGET и T_TARGET_IF_PLAYER: в разговоре по клику — игрок; его реплики —
 * варианты выбора, а не случайный выбор игры.
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
  /** Для `shadowed` — реплика, которая всегда побеждает. */
  by?: string;
  text: string;
}

export interface DialogueGraphNode {
  id: string;
  type: string;
  name: string;
  localized?: string;
  texts: DialogueGraphText[];
  speaker?: number;
  /** Подпись говорящего: «я», «собеседник», ... */
  speakerLabel?: string;
  /** Реплика T_TARGET (вариант выбора игрока). */
  choice: boolean;
  /** Очки, как их считает игра (`score bonus` с надбавками). */
  score?: number;
  /** Из чего сложились очки. */
  scoreParts?: ScorePart[];
  /** `chance temporary`, %. */
  chance?: number;
  conditions: string[];
  effects: string[];
  /** Прочие условия-ссылки (`target race: Шек`, ...). */
  filters: string[];
  /** Событие пакета, если узел — диалог пакета. */
  event?: number;
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
  /** Порядок ссылки у источника (0, 1, ...). */
  order: number;
  /** Ведёт к уже показанной выше записи (петля или общий узел). */
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
 * Реплики NPC под одним узлом, которых игра не выберет никогда: в списке игры раньше неё стоит
 * соседняя реплика с текстом, которая подходит всегда (без условий, шанса, блокировки), и очков у
 * неё больше. Игра идёт по списку сверху и на реплике с меньшими очками останавливается.
 * Реплики игрока (T_TARGET, T_TARGET_IF_PLAYER) — варианты выбора, их не сравниваем.
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
  const tree = buildDialogueTree(ctx, stringId, { maxNodes: options.maxNodes ?? 400 });
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
      if (talker) node.speakerLabel = shortEnumLabel(talker, n.speaker);
    }
    if (n.event !== undefined) {
      node.event = n.event;
      if (eventDef) node.eventLabel = formatEnumValue(eventDef, n.event);
    }
    const issue = (kind: DialogueIssueKind, text: string, by?: string): void => {
      const i: DialogueIssue = { kind, node: n.stringId, text, ...(by !== undefined ? { by } : {}) };
      node.issues.push(i);
      issues.push(i);
    };
    if (n.missing) {
      node.missing = true;
      issue('missing', `нет записи ${n.stringId}`);
    }
    if (n.noLines) {
      node.noLines = true;
      issue('no-lines', 'диалог без реплик — в игре ничего не скажет');
    }
    if (n.truncated) {
      node.truncated = true;
      issue('truncated', 'дальше не развёрнуто (лимит узлов)');
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
      const i: DialogueIssue = {
        kind: 'shadowed',
        node: s.line,
        by: s.by,
        text: `не будет выбрана: соседняя реплика «${shortName(ctx, s.by, options.translation)}» подходит всегда, стоит раньше, и очков у неё больше`,
      };
      target.issues.push(i);
      issues.push(i);
    }
  }
  return { root: stringId, nodes, edges, issues };
}
