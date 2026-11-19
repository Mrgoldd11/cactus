/**
 * How the game picks a dialogue and a line: from the Kenshi 1.0.65 (Steam) code. Decoded from the exe:
 * `DialogLineData` (constructor, `getScore`, `checkConditions`), `DialogChoiceList::add`,
 * `Dialogue::_chooseDialog`.
 *
 * 1. A record's score is computed once, at load: `score bonus` plus bonuses for conditions and
 *    fields ({@link dialogueScore}). During play `getScore` adds another +2 if the target's
 *    race is in `target race`.
 * 2. The list (event dialogues or lines under a node) is sorted by descending key
 *    `score + max(0, best score of direct lines)`; with equal keys, in insertion order.
 * 3. The game goes through the list once. A line with text whose score is below the best one stops
 *    the pass. A record that failed the checks (conditions, chance, no speaker) is skipped.
 *    An empty node (dialogue, line without text, interjection node) picks a line among its
 *    children the same way; its result is its score plus the score of the picked line.
 * 4. A record enters the draw if its score (result) is not below the best so far; the best
 *    becomes equal to it. Those that entered earlier do not drop out.
 * 5. From the draw: randomly with equal odds. Score gives no "better chance".
 */
import type { GameRecord } from '../format/types.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { ModContext } from './context.ts';
import { uiText, type UiText } from '../ui-text.ts';

/** References of a line/dialogue that work as conditions (besides `conditions`). */
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

/** Does the line or dialogue have at least one condition (condition references, `target is type`, repeat limit). */
export function hasConditions(rec: GameRecord): boolean {
  if ((rec.ints.get('target is type') ?? 0) !== 0 || (rec.ints.get('repetition limit') ?? 0) !== 0) return true;
  return DIALOGUE_CONDITION_CATEGORIES.some((c) => (rec.refs.get(c)?.length ?? 0) > 0);
}

/** DialogConditionEnum.DC_HAS_TAG: for such a condition the game gives another +1. */
const DC_HAS_TAG = 23;
/** Initial "best" in `_chooseDialog`: records with a lower score are never picked. */
export const CHOOSE_MIN_SCORE = -999;
/** Speakers that are always present in a click conversation: me, target, target-player. */
const SURE_SPEAKERS: ReadonlySet<number> = new Set([0, 1, 2]);

export type ScorePartKey =
  | 'bonus'
  | 'conditions'
  | 'tag'
  | 'locked'
  | 'town'
  | 'my-faction'
  | 'target-faction'
  | 'item-type'
  | 'item'
  | 'world-state'
  | 'race'
  | 'unique'
  | 'chance-permanent'
  | 'target-type'
  | 'speaker'
  | 'interjector'
  | 'interjection'
  | 'race-match';

export interface ScorePart {
  key: ScorePartKey;
  value: number;
  /** How many times (conditions, world states). */
  count?: number;
}

export interface DialogueScore {
  total: number;
  parts: ScorePart[];
}

/** Names of the score parts in the interface languages. */
export const SCORE_PART_LABELS: Readonly<Record<ScorePartKey, UiText>> = {
  bonus: { en: 'score bonus' },
  conditions: { en: 'conditions', ru: 'условия', zh: '条件' },
  tag: { en: 'condition “tag”', ru: 'условие «метка»', zh: '条件“标签”' },
  locked: { en: 'locked' },
  town: { en: 'in a town of the faction', ru: 'в городе фракции', zh: '在派系城镇中' },
  'my-faction': { en: 'my faction', ru: 'моя фракция', zh: '我的派系' },
  'target-faction': { en: 'target faction', ru: 'фракция собеседника', zh: '对方派系' },
  'item-type': { en: 'target has an item of this type', ru: 'у собеседника предмет такого типа', zh: '对方持有此类物品' },
  item: { en: 'target has the item', ru: 'у собеседника предмет', zh: '对方持有物品' },
  'world-state': { en: 'world state', ru: 'состояние мира', zh: '世界状态' },
  race: { en: 'target race', ru: 'раса собеседника', zh: '对方种族' },
  unique: { en: 'unique' },
  'chance-permanent': { en: 'chance permanent below 99%', ru: 'постоянный шанс ниже 99%', zh: '永久几率低于 99%' },
  'target-type': { en: 'target type', ru: 'тип собеседника', zh: '对方类型' },
  speaker: { en: 'speaker is not “me”', ru: 'говорит не «я»', zh: '说话者不是“我”' },
  interjector: { en: 'interjector or the whole squad speaks', ru: 'говорит вмешавшийся или весь отряд', zh: '插话者或整个小队发言' },
  interjection: { en: 'interjection node', ru: 'узел вмешательства', zh: '插话节点' },
  'race-match': { en: 'target race matched (in game)', ru: 'раса собеседника совпала (в игре)', zh: '对方种族匹配（游戏中）' },
};

const count = (rec: GameRecord, cat: string): number => rec.refs.get(cat)?.length ?? 0;

/** Score of a DIALOGUE / DIALOGUE_LINE record as the game computes it at load, with a breakdown. */
export function dialogueScore(ctx: ModContext, rec: GameRecord): DialogueScore {
  const parts: ScorePart[] = [];
  const add = (key: ScorePartKey, value: number, n?: number): void => {
    if (value !== 0) parts.push(n !== undefined && n > 1 ? { key, value, count: n } : { key, value });
  };
  add('bonus', rec.ints.get('score bonus') ?? 0);
  const conds = rec.refs.get('conditions') ?? [];
  add('conditions', conds.length, conds.length);
  const tags = conds.filter((c) => ctx.get(c.target)?.ints.get('condition name') === DC_HAS_TAG).length;
  add('tag', tags, tags);
  if (rec.bools.get('locked')) add('locked', 2);
  if (count(rec, 'in town of')) add('town', 2);
  if (count(rec, 'my faction')) add('my-faction', 2);
  if (count(rec, 'target faction')) add('target-faction', 2);
  if (count(rec, 'target has item type')) add('item-type', 2);
  if (count(rec, 'target has item')) add('item', 2);
  const ws = count(rec, 'world state');
  add('world-state', 2 * ws, ws);
  if (count(rec, 'target race')) add('race', 2);
  if (rec.bools.get('unique')) add('unique', 1);
  if ((rec.floats.get('chance permanent') ?? 100) < 99) add('chance-permanent', 1);
  if ((rec.ints.get('target is type') ?? 0) > 0) add('target-type', 1);
  const sp = rec.ints.get('speaker') ?? 0;
  if (sp !== 0) add('speaker', 1);
  if (sp >= 3 && sp <= 6) add('interjector', 1);
  if (rec.bools.get('interjection')) add('interjection', 2);
  return { total: parts.reduce((s, p) => s + p.value, 0), parts };
}

/** Score breakdown as text: "score bonus 5, conditions ×2 +2, …". */
export function formatScoreParts(parts: readonly ScorePart[], lang = 'en'): string {
  return parts.map((p) => (p.key === 'bonus' ? `score bonus ${String(p.value)}` : `${uiText(SCORE_PART_LABELS[p.key], lang)}${p.count !== undefined ? ` ×${String(p.count)}` : ''} ${p.value > 0 ? '+' : ''}${String(p.value)}`)).join(', ');
}

/**
 * The record passes the game checks in any setup: no conditions, no chance below 99%, not
 * locked, not `unique`, not an interjection node, the speaker is me or the target.
 */
export function alwaysPasses(rec: GameRecord): boolean {
  if (hasConditions(rec) || rec.bools.get('locked') || rec.bools.get('unique') || rec.bools.get('interjection')) return false;
  if ((rec.floats.get('chance temporary') ?? 100) < 99 || (rec.floats.get('chance permanent') ?? 100) < 99) return false;
  return SURE_SPEAKERS.has(rec.ints.get('speaker') ?? 0);
}

/** Empty node: the game does not say it but picks a line among its children. */
export function isEmptyNode(rec: GameRecord): boolean {
  if (itemTypeName(rec.type) === 'DIALOGUE' || rec.bools.get('interjection')) return true;
  for (const [k, v] of rec.strings) if (/^text\d+$/.test(k) && v.length > 0) return false;
  return true;
}

export interface ChooseEnv {
  /** Will the record pass the game checks in this setup. */
  passes(sid: string, rec: GameRecord): boolean;
  /** Bonus during play (+2 if the target's race is in `target race`). */
  bonus?(sid: string, rec: GameRecord): number;
}

export interface ChooseResult {
  /** Probability that the pick came through this list element (0..1). */
  odds: Map<string, number>;
  /** Probability that nothing is picked. */
  none: number;
}

interface Outcome {
  top: string;
  /** Score of the picked line (its own); the parent adds it to its own. */
  leaf: number;
  p: number;
}

interface Dist {
  items: Outcome[];
  none: number;
}

/** List order as in the game: descending `score + max(0, best score of children)`, on ties as added. */
export function chooseOrder(ctx: ModContext, list: readonly string[], scoreOf: (rec: GameRecord) => number = (r) => dialogueScore(ctx, r).total): string[] {
  return chooseRanking(ctx, list, scoreOf).map((k) => k.sid);
}

/** `chooseOrder` with the sort key of each element (equal keys are ties: the list position decides). */
export function chooseRanking(ctx: ModContext, list: readonly string[], scoreOf: (rec: GameRecord) => number = (r) => dialogueScore(ctx, r).total): { sid: string; key: number }[] {
  const keyed = list.flatMap((sid, i) => {
    const rec = ctx.get(sid);
    if (!rec) return [];
    let best = 0;
    for (const c of rec.refs.get('lines') ?? []) {
      const r = ctx.get(c.target);
      if (r) best = Math.max(best, scoreOf(r));
    }
    return [{ sid, i, key: scoreOf(rec) + best }];
  });
  return keyed.sort((a, b) => b.key - a.key || a.i - b.i).map((k) => ({ sid: k.sid, key: k.key }));
}

/** Branching limit: beyond it only the most likely outcome of an empty node is taken. */
const MAX_STEPS = 20000;

/**
 * Pick odds by the game rule for list `list` (event dialogues or lines under a node)
 * in setup `env`: which records pass the checks. Repeated ids count as one.
 */
export function chooseOdds(ctx: ModContext, list: readonly string[], env: ChooseEnv): ChooseResult {
  const scores = new Map<GameRecord, number>();
  const base = (r: GameRecord): number => {
    let s = scores.get(r);
    if (s === undefined) scores.set(r, (s = dialogueScore(ctx, r).total));
    return s;
  };
  const memo = new Map<string, Dist>();
  let steps = 0;

  const choose = (ids: readonly string[], stack: ReadonlySet<string>): Dist => {
    const order = chooseOrder(ctx, [...new Set(ids)], base);
    const acc = new Map<string, Outcome>();
    let none = 0;
    const finish = (cands: readonly { top: string; leaf: number }[], p: number): void => {
      if (!cands.length) {
        none += p;
        return;
      }
      for (const c of cands) {
        const k = `${c.top}|${c.leaf}`;
        const had = acc.get(k);
        if (had) had.p += p / cands.length;
        else acc.set(k, { top: c.top, leaf: c.leaf, p: p / cands.length });
      }
    };
    const step = (i: number, best: number, cands: readonly { top: string; leaf: number }[], p: number): void => {
      steps++;
      const sid = order[i];
      const rec = sid !== undefined ? ctx.get(sid) : undefined;
      if (sid === undefined || !rec) {
        finish(cands, p);
        return;
      }
      const s = base(rec) + (env.bonus?.(sid, rec) ?? 0);
      const empty = isEmptyNode(rec);
      if (s < best && (!empty || rec.bools.get('interjection'))) {
        finish(cands, p);
        return;
      }
      if (!env.passes(sid, rec)) {
        step(i + 1, best, cands, p);
        return;
      }
      if (!empty) {
        step(i + 1, s, [...cands, { top: sid, leaf: s }], p);
        return;
      }
      const kids = (rec.refs.get('lines') ?? []).map((r) => r.target);
      if (!kids.length || stack.has(sid)) {
        step(i + 1, best, cands, p);
        return;
      }
      let sub = memo.get(sid);
      if (!sub) memo.set(sid, (sub = choose(kids, new Set([...stack, sid]))));
      if (sub.none > 0) step(i + 1, best, cands, p * sub.none);
      const byLeaf = new Map<number, number>();
      for (const o of sub.items) byLeaf.set(o.leaf, (byLeaf.get(o.leaf) ?? 0) + o.p);
      let groups = [...byLeaf];
      if (steps > MAX_STEPS && groups.length > 1) {
        const top = groups.reduce((a, b) => (b[1] > a[1] ? b : a));
        groups = [[top[0], groups.reduce((t, g) => t + g[1], 0)]];
      }
      for (const [leaf, q] of groups) {
        const total = s + leaf;
        if (total >= best) step(i + 1, total, [...cands, { top: sid, leaf }], p * q);
        else step(i + 1, best, cands, p * q);
      }
    };
    step(0, CHOOSE_MIN_SCORE, [], 1);
    return { items: [...acc.values()], none };
  };

  const d = choose(list, new Set());
  const odds = new Map<string, number>();
  for (const o of d.items) odds.set(o.top, (odds.get(o.top) ?? 0) + o.p);
  return { odds, none: d.none };
}

/** Records under the node (via `lines`), recursively, including the node itself. */
export function dialogueTreeIds(ctx: ModContext, root: string): Set<string> {
  const seen = new Set<string>();
  const walk = (sid: string): void => {
    if (seen.has(sid)) return;
    seen.add(sid);
    for (const r of ctx.get(sid)?.refs.get('lines') ?? []) walk(r.target);
  };
  walk(root);
  return seen;
}
