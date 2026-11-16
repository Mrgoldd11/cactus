/**
 * Conversation player: step by step, the way the game runs a conversation with a character.
 *
 * - Start: all of the character's dialogues for the event (`talkSources`); the game picks one by its rule
 *   (`chooseOdds`), then the first line inside it by the same rule; the game does not say empty nodes
 *   (without text) but picks among their children right away.
 * - After an NPC line: if player answers follow (the target speaks, `CHOICE_SPEAKERS`), they
 *   are shown as a list; an answer with unmet conditions is hidden. Otherwise the game itself picks
 *   the next NPC line. Mixed branches (answers and NPC lines together, 57 nodes in vanilla) are not
 *   decoded from the game; the player shows the answers and a separate move "NPC continues on its own".
 * - "As if": mode `met` (default) treats conditions and chances as met, only
 *   locked ones as locked; mode `none` lets through only records that always pass.
 *   `assume` overrides the mode for single records: met (true) or not (false). The target's
 *   race from `target race` with met conditions gives the game's +2, as in the game.
 * - If several fit with equal scores, the game picks randomly; the player takes
 *   the first one in game order until the user picks another (`prefer`).
 */
import type { GameRecord } from '../format/types.ts';
import { itemTypeName } from '../format/item-types.ts';
import { decodeText } from '../text.ts';
import { translatedText, type TranslationIndex } from '../locale/translation.ts';
import type { ModContext } from '../model/context.ts';
import { CHOICE_SPEAKERS } from '../model/dialogue-graph.ts';
import { alwaysPasses, chooseOdds, chooseOrder, dialogueScore, isEmptyNode, type ChooseEnv } from '../model/dialogue-score.ts';
import { EVENT_TALK, squadIndex, talkSources, type SquadIndex, type TalkSource } from './talk.ts';
import { UiTextError } from '../ui-text.ts';

/** Why a variant is picked or not. */
export type PlayWhy =
  /** Picked: fits and has the highest score. */
  | 'chosen'
  /** Picked randomly among equals (others have a chance too). */
  | 'chosen-random'
  /** Could have come up randomly, but another one did. */
  | 'random'
  /** Fits, but the picked one has a higher score (or is earlier in the game's list). */
  | 'outscored'
  /** Does not fit: conditions, chance, locked or unique are not met in this setup. */
  | 'fails'
  /** Empty node without continuation: the game has nothing to say. */
  | 'empty'
  /** The record does not exist. */
  | 'missing';

export interface PlayOption {
  sid: string;
  why: PlayWhy;
  /** Chance that the game picks it in this setup (0..1). */
  odds: number;
  /** Record score as the game computes it (without the race bonus). */
  score: number;
  /** Does it pass the checks in this setup. */
  passes: boolean;
  /** Always passes: it needs no "as if" toggle. */
  always: boolean;
  /** For opening dialogues: where it came from (character, packages, squad, faction). */
  sources?: TalkSource[];
}

export interface PlayLevel {
  node: string;
  options: PlayOption[];
}

export interface PlayAnswer {
  sid: string;
  /** Shown to the player (conditions met in this setup). */
  shown: boolean;
  always: boolean;
}

export interface PlayStep {
  /** What the pick was made from: '' = start (event dialogues), otherwise the id of the previous line. */
  from: string;
  /** What the game picked the NPC line from (empty if player answers come right here). */
  options: PlayOption[];
  /** Empty nodes the pick went through (dialogue root etc.), with the pick inside each. */
  path: PlayLevel[];
  /** What was said (an NPC line or an answer said without a choice). */
  said?: string;
  /** Player answer options after `said` (or after the answer of the previous step). */
  answers: PlayAnswer[];
  /** NPC lines are present along with answers: the move "NPC continues on its own" (`PLAY_NPC`). */
  npcToo: boolean;
  /** What the player chose (answer id or `PLAY_NPC`). */
  answered?: string;
  /** The conversation ended here: nothing follows / nothing fit. */
  end?: 'nothing-next' | 'nothing-fits';
}

/** The move "NPC continues on its own" in a mixed branch. */
export const PLAY_NPC = '@npc';

/** Default setup: `met` = conditions met (except locked), `none` = only records without conditions pass. */
export type PlayMode = 'met' | 'none';

export interface PlayInput {
  /** Event (click = 1). */
  event?: number;
  mode?: PlayMode;
  /** "As if": id → treat conditions as met (true) or not (false). */
  assume?: ReadonlyMap<string, boolean>;
  /** Player answers in order. */
  answers?: readonly string[];
  /** Pick among equals: step id (`from`) → which variant to take. */
  prefer?: ReadonlyMap<string, string>;
  squads?: SquadIndex;
  /** Step limit (loops in dialogues). */
  limit?: number;
}

export interface PlayResult {
  character: string;
  event: number;
  steps: PlayStep[];
  /** Waits for a player answer at the last step. */
  waiting: boolean;
}

const EPS = 1e-9;

export const isChoiceRecord = (r: GameRecord | undefined): boolean => r !== undefined && CHOICE_SPEAKERS.has(r.ints.get('speaker') ?? 0);

/** Game setup under "as if": what passes the checks and the +2 bonus for the target's race. */
export function playEnv(assume: ReadonlyMap<string, boolean> = new Map(), mode: PlayMode = 'met'): ChooseEnv {
  const passes = (sid: string, r: GameRecord): boolean => assume.get(sid) ?? (mode === 'met' ? !r.bools.get('locked') : alwaysPasses(r));
  return {
    passes,
    bonus: (sid, r) => ((r.refs.get('target race')?.length ?? 0) > 0 && passes(sid, r) ? 2 : 0),
  };
}

const kidsOf = (ctx: ModContext, sid: string): string[] => (ctx.get(sid)?.refs.get('lines') ?? []).map((r) => r.target);

/**
 * The game's pick among `ids` in setup `env`: variants with reasons and the picked one (`prefer` if it
 * has a chance, otherwise the most likely; among equals, the first in game order).
 */
export function playPick(ctx: ModContext, ids: readonly string[], env: ChooseEnv, prefer?: string): { options: PlayOption[]; chosen?: string } {
  const uniq = [...new Set(ids)];
  const { odds } = chooseOdds(ctx, uniq, env);
  const order = chooseOrder(ctx, uniq);
  const rank = new Map(order.map((s, i) => [s, i]));
  const options: PlayOption[] = uniq.map((sid) => {
    const rec = ctx.get(sid);
    if (!rec) return { sid, why: 'missing', odds: 0, score: 0, passes: false, always: false };
    const passes = env.passes(sid, rec);
    const kids = isEmptyNode(rec) ? kidsOf(ctx, sid) : [];
    // The empty node fits, but nothing inside passes: the game skips it (rather than "overridden").
    const empty = isEmptyNode(rec) && (kids.length === 0 || (passes && (odds.get(sid) ?? 0) <= EPS && ![...chooseOdds(ctx, kids, env).odds.values()].some((q) => q > EPS)));
    return { sid, why: empty ? 'empty' : passes ? 'outscored' : 'fails', odds: odds.get(sid) ?? 0, score: dialogueScore(ctx, rec).total, passes, always: alwaysPasses(rec) };
  });
  const live = options.filter((o) => o.odds > EPS);
  let chosen: string | undefined;
  if (prefer !== undefined && live.some((o) => o.sid === prefer)) chosen = prefer;
  else chosen = live.sort((a, b) => b.odds - a.odds || (rank.get(a.sid) ?? 0) - (rank.get(b.sid) ?? 0))[0]?.sid;
  for (const o of options) {
    if (o.odds <= EPS) continue;
    if (o.sid === chosen) o.why = o.odds > 1 - EPS ? 'chosen' : 'chosen-random';
    else o.why = 'random';
  }
  options.sort((a, b) => (rank.get(a.sid) ?? 1e9) - (rank.get(b.sid) ?? 1e9));
  return chosen !== undefined ? { options, chosen } : { options };
}

/** Descend from the picked empty node to the line the game will say. */
function descend(ctx: ModContext, sid: string, env: ChooseEnv, prefer: ReadonlyMap<string, string>, path: PlayLevel[]): string | undefined {
  const seen = new Set<string>();
  let cur: string | undefined = sid;
  while (cur !== undefined) {
    const rec = ctx.get(cur);
    if (!rec || !isEmptyNode(rec) || seen.has(cur)) return cur;
    seen.add(cur);
    const pick = playPick(ctx, kidsOf(ctx, cur), env, prefer.get(cur));
    path.push({ node: cur, options: pick.options });
    cur = pick.chosen;
  }
  return undefined;
}

function answersAfter(ctx: ModContext, sid: string, env: ChooseEnv): { answers: PlayAnswer[]; npc: string[] } {
  const answers: PlayAnswer[] = [];
  const npc: string[] = [];
  for (const k of kidsOf(ctx, sid)) {
    const r = ctx.get(k);
    if (r && isChoiceRecord(r)) answers.push({ sid: k, shown: env.passes(k, r), always: alwaysPasses(r) });
    else npc.push(k);
  }
  return { answers, npc };
}

/** The character's dialogues for the event (no duplicates) with sources. */
export function playStartList(ctx: ModContext, character: string, event = EVENT_TALK, squads?: SquadIndex): Map<string, TalkSource[]> {
  const c = ctx.get(character);
  if (!c) throw new UiTextError({ en: `no record ${character}`, ru: `нет записи ${character}`, zh: `没有记录 ${character}` });
  if (itemTypeName(c.type) !== 'CHARACTER') throw new UiTextError({ en: `${character} is not a character (${itemTypeName(c.type)})`, ru: `${character} — не персонаж (${itemTypeName(c.type)})`, zh: `${character} 不是角色（${itemTypeName(c.type)}）` });
  const out = new Map<string, TalkSource[]>();
  for (const s of talkSources(ctx, c, event, squads ?? squadIndex(ctx))) {
    const had = out.get(s.dialog);
    if (had) had.push(s);
    else out.set(s.dialog, [s]);
  }
  return out;
}

/** Play a conversation with a character: step by step, with player answers `input.answers`. */
export function playConversation(ctx: ModContext, character: string, input: PlayInput = {}): PlayResult {
  const event = input.event ?? EVENT_TALK;
  const env = playEnv(input.assume, input.mode);
  const prefer = input.prefer ?? new Map<string, string>();
  const given = input.answers ?? [];
  const limit = input.limit ?? 40;
  const start = playStartList(ctx, character, event, input.squads);
  const steps: PlayStep[] = [];
  let next = 0;
  let from = '';
  let ids: string[] | undefined = [...start.keys()];
  let pending: { answers: PlayAnswer[]; npc: string[] } | undefined;
  let waiting = false;

  while (steps.length < limit) {
    const step: PlayStep = { from, options: [], path: [], answers: [], npcToo: false };
    steps.push(step);
    if (ids !== undefined) {
      const pick = playPick(ctx, ids, env, prefer.get(from));
      step.options = pick.options;
      if (from === '') for (const o of step.options) o.sources = start.get(o.sid) ?? [];
      const said = pick.chosen !== undefined ? descend(ctx, pick.chosen, env, prefer, step.path) : undefined;
      if (said === undefined) {
        step.end = 'nothing-fits';
        break;
      }
      step.said = said;
      pending = answersAfter(ctx, said, env);
    }
    const cont = pending ?? { answers: [], npc: [] };
    if (cont.answers.length === 0) {
      if (cont.npc.length === 0) {
        step.end = 'nothing-next';
        break;
      }
      from = step.said ?? from;
      ids = cont.npc;
      pending = undefined;
      continue;
    }
    step.answers = cont.answers;
    step.npcToo = cont.npc.length > 0;
    const a = given[next];
    const ok = a !== undefined && (a === PLAY_NPC ? step.npcToo : cont.answers.some((x) => x.sid === a && x.shown));
    if (!ok) {
      waiting = cont.answers.some((x) => x.shown) || step.npcToo;
      if (!waiting) step.end = 'nothing-fits';
      break;
    }
    next++;
    step.answered = a;
    if (a === PLAY_NPC) {
      from = step.said ?? from;
      ids = cont.npc;
      pending = undefined;
      continue;
    }
    // The answer is said; its continuation follows.
    const after = answersAfter(ctx, a, env);
    from = a;
    if (after.npc.length > 0 && after.answers.length === 0) {
      ids = after.npc;
      pending = undefined;
    } else {
      ids = undefined;
      pending = after;
    }
  }
  return { character, event, steps, waiting };
}

/** Words of the play report (MCP, CLI) in one interface language. */
interface PlayWords {
  why: Readonly<Record<PlayWhy, string>>;
  empty: string;
  player: string;
  head: (name: string, character: string, event: string, mode: string) => string;
  onlyAlways: string;
  conditionsMet: string;
  step: (n: number, from: string) => string;
  start: string;
  after: (from: string) => string;
  score: string;
  chance: string;
  inNode: (node: string, chosen: string, n: number) => string;
  answers: string;
  hidden: string;
  npcGoesOn: (id: string) => string;
  endNothingNext: string;
  endNothingFits: string;
  waiting: string;
}

const playEn: PlayWords = {
  why: {
    chosen: 'chosen',
    'chosen-random': 'chosen at random among equals',
    random: 'could have come up at random',
    outscored: 'outscored (lower score or later in the game list)',
    fails: 'does not fit in this setup (conditions, chance, locked)',
    empty: 'empty node without continuation',
    missing: 'record is missing',
  },
  empty: '(empty)',
  player: 'player',
  head: (n, c, e, m) => `${n} (${c}), event ${e}; setup: ${m}`,
  onlyAlways: 'only without conditions',
  conditionsMet: 'conditions met',
  step: (n, f) => `step ${String(n)}${f}:`,
  start: ' (start)',
  after: (f) => ` (after ${f})`,
  score: 'score',
  chance: 'chance',
  inNode: (node, ch, n) => `in ${node}: ${ch} of ${String(n)}`,
  answers: 'player answers:',
  hidden: ' — hidden (conditions not met)',
  npcGoesOn: (id) => `NPC goes on by itself (${id})`,
  endNothingNext: 'end: nothing comes next',
  endNothingFits: 'end: nothing fits',
  waiting: 'waiting for the player answer: pass the answer id (or @npc) in answers',
};

const playRu: PlayWords = {
  why: {
    chosen: 'выбран',
    'chosen-random': 'выбран случайно среди равных',
    random: 'мог выпасть случайно',
    outscored: 'перебит (очков меньше или позже в списке игры)',
    fails: 'не подходит в этом раскладе (условия, шанс, locked)',
    empty: 'пустой узел без продолжения',
    missing: 'записи нет',
  },
  empty: '(пусто)',
  player: 'игрок',
  head: (n, c, e, m) => `${n} (${c}), событие ${e}; расклад: ${m}`,
  onlyAlways: 'только без условий',
  conditionsMet: 'условия выполнены',
  step: (n, f) => `шаг ${String(n)}${f}:`,
  start: ' (начало)',
  after: (f) => ` (после ${f})`,
  score: 'очки',
  chance: 'шанс',
  inNode: (node, ch, n) => `в ${node}: ${ch} из ${String(n)}`,
  answers: 'ответы игрока:',
  hidden: ' — скрыт (условия не выполнены)',
  npcGoesOn: (id) => `NPC продолжает сам (${id})`,
  endNothingNext: 'конец: дальше ничего нет',
  endNothingFits: 'конец: ничего не подходит',
  waiting: 'ждёт ответа игрока: передайте id ответа (или @npc) в answers',
};

const playZh: PlayWords = {
  why: {
    chosen: '已选中',
    'chosen-random': '在同分中随机选中',
    random: '可能随机出现',
    outscored: '被压过（分数更低或在游戏列表中更靠后）',
    fails: '在此设定下不适用（条件、几率、locked）',
    empty: '没有后续的空节点',
    missing: '没有记录',
  },
  empty: '（空）',
  player: '玩家',
  head: (n, c, e, m) => `${n}（${c}），事件 ${e}；设定：${m}`,
  onlyAlways: '仅无条件',
  conditionsMet: '条件已满足',
  step: (n, f) => `第 ${String(n)} 步${f}：`,
  start: '（开始）',
  after: (f) => `（在 ${f} 之后）`,
  score: '分数',
  chance: '几率',
  inNode: (node, ch, n) => `在 ${node}：${ch}，共 ${String(n)} 个`,
  answers: '玩家回答：',
  hidden: ' — 已隐藏（条件未满足）',
  npcGoesOn: (id) => `NPC 自行继续（${id}）`,
  endNothingNext: '结束：后面没有内容',
  endNothingFits: '结束：没有适用的内容',
  waiting: '等待玩家回答：在 answers 中传入回答 id（或 @npc）',
};

const PLAY_WORDS: Readonly<Record<string, PlayWords>> = { en: playEn, ru: playRu, zh: playZh };

const pctOf = (x: number): string => `${String(Math.round(x * 100))}%`;

/**
 * The conversation from `playConversation` as text (MCP, CLI): step by step, what the game picked from and why,
 * what was said, player answers with ids (they are passed in `answers` of the next call).
 */
export function formatPlay(ctx: ModContext, res: PlayResult, options: { translation?: TranslationIndex; mode?: PlayMode; lang?: string } = {}): string[] {
  const w = PLAY_WORDS[options.lang ?? 'en'] ?? playEn;
  const tr = options.translation;
  const label = (sid: string): string => {
    const rec = ctx.get(sid);
    if (!rec) return sid;
    if (itemTypeName(rec.type) !== 'DIALOGUE_LINE') return `«${ctx.localizedName(sid) ?? decodeText(rec.name)}» (${sid})`;
    const raw = rec.strings.get('text0');
    const en = raw !== undefined ? decodeText(raw) : '';
    const text = translatedText(tr, sid, 'text0', en) ?? en;
    return `«${text.replace(/\s+/g, ' ').trim() || w.empty}» (${sid})`;
  };
  const who = (sid: string): string => (isChoiceRecord(ctx.get(sid)) ? w.player : 'NPC');
  const c = ctx.get(res.character);
  const out = [
    w.head(ctx.localizedName(res.character) ?? (c ? decodeText(c.name) : res.character), res.character, String(res.event), options.mode === 'none' ? w.onlyAlways : w.conditionsMet),
  ];
  res.steps.forEach((s, i) => {
    out.push(w.step(i + 1, s.from === '' ? w.start : w.after(s.from)));
    const shown = s.options.filter((o) => o.why !== 'missing');
    if (shown.length > 1 || (shown.length === 1 && shown[0]!.why !== 'chosen')) {
      for (const o of shown) out.push(`  ${o.why.startsWith('chosen') ? '▶' : '·'} ${label(o.sid)} — ${w.why[o.why]}, ${w.score} ${String(o.score)}${o.odds > 0 && o.odds < 1 ? `, ${w.chance} ${pctOf(o.odds)}` : ''}`);
    }
    for (const lv of s.path) {
      const ch = lv.options.find((o) => o.why.startsWith('chosen'));
      if (ch && lv.options.length > 1) out.push(`  ${w.inNode(lv.node, label(ch.sid), lv.options.length)}`);
    }
    if (s.said !== undefined) out.push(`  ${who(s.said)}: ${label(s.said)}`);
    if (s.answers.length) {
      out.push(`  ${w.answers}`);
      for (const a of s.answers) out.push(`    ${a.sid === s.answered ? '▶' : '-'} ${label(a.sid)}${a.shown ? '' : w.hidden}`);
      if (s.npcToo) out.push(`    ${s.answered === PLAY_NPC ? '▶' : '-'} ${w.npcGoesOn(PLAY_NPC)}`);
    }
    if (s.end === 'nothing-next') out.push(`  ${w.endNothingNext}`);
    else if (s.end === 'nothing-fits') out.push(`  ${w.endNothingFits}`);
  });
  if (res.waiting) out.push(w.waiting);
  return out;
}
