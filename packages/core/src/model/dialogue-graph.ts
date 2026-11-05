/**
 * Граф диалога для показа: узлы — записи (пакет, диалог, реплики) по одному разу, рёбра —
 * ссылки `dialogs` / `lines`, в том числе обратные (петли меню). Тексты реплик — с русским
 * переводом игры (`ru_RU.translation`), если он передан. Проверки: нет записи, диалог без
 * реплик, реплика NPC, которую никогда не выберут (соседняя реплика того же говорящего без
 * условий, со 100% шансом и бо́льшими очками всегда побеждает), ответвление обрезано лимитом.
 */
import { decodeText } from '../text.ts';
import type { GameRecord } from '../format/types.ts';
import { translatedText, type TranslationIndex } from '../locale/translation.ts';
import type { ModContext } from './context.ts';
import { buildDialogueTree, type DialogueNode } from './dialogue.ts';
import { formatEnumValue, getEnum, refValueEnum, shortEnumLabel } from './enums.ts';

/**
 * Говорящие T_TARGET и T_TARGET_IF_PLAYER: в разговоре по клику — игрок; его реплики —
 * варианты выбора, а не случайный выбор игры.
 */
export const CHOICE_SPEAKERS: ReadonlySet<number> = new Set([1, 2]);
/** T_TARGET_WITH_RACE — говорит, только если есть собеседник нужной расы (условие). */
const SPEAKER_TARGET_WITH_RACE = 7;

/** Ссылки реплики/диалога, которые работают как условия (кроме `conditions`). */
export const DIALOGUE_CONDITION_CATEGORIES = [
  'conditions',
  'target race',
  'no target race',
  'world state',
  'in town of',
  'my faction',
  'target faction',
  'is character',
  'has package',
  'my race',
  'my subrace',
  'target has item',
  'target has item type',
  'target carrying character',
] as const;

export interface DialogueGraphText {
  en: string;
  ru?: string;
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
  ru?: string;
  texts: DialogueGraphText[];
  speaker?: number;
  /** Подпись говорящего: «я», «собеседник», ... */
  speakerLabel?: string;
  /** Реплика T_TARGET (вариант выбора игрока). */
  choice: boolean;
  score?: number;
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

/** Есть ли у реплики или диалога хоть одно условие (ссылки-условия, `target is type`, ограничение повтора). */
export function hasConditions(rec: GameRecord): boolean {
  if ((rec.ints.get('target is type') ?? 0) !== 0 || (rec.ints.get('repetition limit') ?? 0) !== 0) return true;
  return DIALOGUE_CONDITION_CATEGORIES.some((c) => (rec.refs.get(c)?.length ?? 0) > 0);
}

function score(rec: GameRecord): number {
  return rec.ints.get('score bonus') ?? 0;
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
 * Реплики NPC под одним узлом, которых игра не выберет: среди соседей с тем же говорящим
 * есть реплика без условий со 100% шансом и строго большими очками (`score bonus`).
 * Реплики игрока (T_TARGET, T_TARGET_IF_PLAYER) — варианты выбора, их не сравниваем.
 */
export function shadowedLines(ctx: ModContext, parent: string): { line: string; by: string }[] {
  const rec = ctx.get(parent);
  if (!rec) return [];
  const kids = (rec.refs.get('lines') ?? []).map((r) => ({ sid: r.target, rec: ctx.get(r.target) })).filter((k): k is { sid: string; rec: GameRecord } => k.rec !== undefined);
  const out: { line: string; by: string }[] = [];
  for (const k of kids) {
    const sp = k.rec.ints.get('speaker') ?? 0;
    if (CHOICE_SPEAKERS.has(sp) || sp === SPEAKER_TARGET_WITH_RACE) continue;
    const winner = kids.find((o) => o !== k && (o.rec.ints.get('speaker') ?? 0) === sp && !hasConditions(o.rec) && chance(o.rec) >= 100 && score(o.rec) > score(k.rec));
    if (winner) out.push({ line: k.sid, by: winner.sid });
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
    const ru = ctx.localizedName(n.stringId);
    if (ru !== undefined) node.ru = ru;
    if (rec) {
      for (const [k, v] of rec.strings) {
        if (!/^text\d+$/.test(k)) continue;
        const en = decodeText(v);
        if (en === '') continue;
        const t: DialogueGraphText = { en };
        const tr = translatedText(options.translation, n.stringId, k, en);
        if (tr !== undefined) t.ru = tr;
        node.texts.push(t);
      }
      if (n.type === 'DIALOGUE_LINE') {
        node.score = score(rec);
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
        text: `не будет выбрана: соседняя реплика «${shortName(ctx, s.by, options.translation)}» без условий, шанс 100%, очков больше`,
      };
      target.issues.push(i);
      issues.push(i);
    }
  }
  return { root: stringId, nodes, edges, issues };
}
