/**
 * Conversation simulator: which dialogues a character has for an event (click = event 1), where
 * they came from and which of them the game will most likely pick.
 *
 * Where the game takes candidates from (from vanilla data and checks with the Vanilla Talk mod):
 * - `CHARACTER.dialogue`: event 1 only;
 * - `CHARACTER.dialogue package` → `DIALOGUE_PACKAGE.dialogs` (v0 of the reference = event),
 *   with packages from `inheritsFrom`;
 * - the character's squads (SQUAD_TEMPLATE `leader`, `squad`, `squad2`, `choosefrom list`): for the leader
 *   `dialog leader`, for everyone `dialog squad`;
 * - faction (own or the squads' factions): `dialog default`.
 *
 * The pick follows the game's rule decoded from its code (`model/dialogue-score.ts`): score = `score bonus`
 * with bonuses for conditions; of those that passed the checks the game takes the ones with the highest score, and among
 * equals picks randomly with equal odds. The simulator computes two setups: "no conditions" (only
 * records that always pass get through) and, for each dialogue with conditions, "its conditions are met,
 * the others are not".
 */
import type { GameRecord } from '../format/types.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { TranslationIndex } from '../locale/translation.ts';
import type { ModContext } from '../model/context.ts';
import { buildDialogueGraph, type DialogueGraphNode } from '../model/dialogue-graph.ts';
import {
  alwaysPasses,
  chooseOdds,
  chooseOrder,
  dialogueScore,
  dialogueTreeIds,
  formatScoreParts,
  isEmptyNode,
  type ChooseEnv,
  type ScorePart,
} from '../model/dialogue-score.ts';
import { formatEnumValue, refValueEnum } from '../model/enums.ts';
import { uiText, UiTextError, type UiText } from '../ui-text.ts';

/** Event "the player talked to me" (EV_PLAYER_TALK_TO_ME). */
export const EVENT_TALK = 1;

export type TalkVia = 'character' | 'character-package' | 'squad-leader' | 'squad' | 'faction';

export const TALK_VIA_LABELS: Readonly<Record<TalkVia, UiText>> = {
  character: { en: 'character (dialogue)', ru: 'персонаж (dialogue)', zh: '角色（dialogue）' },
  'character-package': { en: 'character package', ru: 'пакет персонажа', zh: '角色对话包' },
  'squad-leader': { en: 'squad leader package', ru: 'пакет лидера отряда', zh: '小队首领对话包' },
  squad: { en: 'squad package', ru: 'пакет отряда', zh: '小队对话包' },
  faction: { en: 'faction package', ru: 'пакет фракции', zh: '派系对话包' },
};

export interface TalkSource {
  via: TalkVia;
  /** The record that holds the reference to the dialogue: a character or a package. */
  holder: string;
  dialog: string;
}

/** Character → squads it is in (and whether it is the leader there). */
export type SquadIndex = ReadonlyMap<string, readonly { squad: string; leader: boolean }[]>;

const refs = (r: GameRecord | undefined, cat: string): readonly { target: string; v0: number }[] => r?.refs.get(cat) ?? [];

export function squadIndex(ctx: ModContext): SquadIndex {
  const idx = new Map<string, { squad: string; leader: boolean }[]>();
  const add = (c: string, squad: string, leader: boolean): void => {
    let l = idx.get(c);
    if (!l) idx.set(c, (l = []));
    l.push({ squad, leader });
  };
  for (const s of ctx.records()) {
    if (itemTypeName(s.type) !== 'SQUAD_TEMPLATE') continue;
    for (const r of refs(s, 'leader')) add(r.target, s.stringId, true);
    for (const k of ['squad', 'squad2', 'choosefrom list']) for (const r of refs(s, k)) add(r.target, s.stringId, false);
  }
  return idx;
}

/** The character's factions: its own or (if none) the factions of its squads. */
export function characterFactions(ctx: ModContext, c: GameRecord, sq: SquadIndex): string[] {
  const own = refs(c, 'faction').map((r) => r.target);
  if (own.length) return own;
  const out = new Set<string>();
  for (const { squad } of sq.get(c.stringId) ?? []) for (const r of refs(ctx.get(squad), 'faction')) out.add(r.target);
  return [...out];
}

/** Package dialogues with event numbers, including `inheritsFrom`. */
export function packageDialogs(ctx: ModContext, pkg: string, seen = new Set<string>()): { event: number; dialog: string; pkg: string }[] {
  if (seen.has(pkg)) return [];
  seen.add(pkg);
  const p = ctx.get(pkg);
  if (!p) return [];
  const out = refs(p, 'dialogs').map((r) => ({ event: r.v0, dialog: r.target, pkg }));
  for (const r of refs(p, 'inheritsFrom')) out.push(...packageDialogs(ctx, r.target, seen));
  return out;
}

/** All of the character's dialogues for the event and where they came from (in source order). */
export function talkSources(ctx: ModContext, c: GameRecord, event: number, sq: SquadIndex = squadIndex(ctx)): TalkSource[] {
  const out: TalkSource[] = [];
  if (event === EVENT_TALK) for (const r of refs(c, 'dialogue')) out.push({ via: 'character', holder: c.stringId, dialog: r.target });
  const pk = (via: TalkVia, pkg: string): void => {
    for (const d of packageDialogs(ctx, pkg)) if (d.event === event) out.push({ via, holder: d.pkg, dialog: d.dialog });
  };
  for (const r of refs(c, 'dialogue package')) pk('character-package', r.target);
  for (const { squad, leader } of sq.get(c.stringId) ?? []) {
    const s = ctx.get(squad);
    if (leader) for (const r of refs(s, 'dialog leader')) pk('squad-leader', r.target);
    for (const r of refs(s, 'dialog squad')) pk('squad', r.target);
  }
  for (const f of characterFactions(ctx, c, sq)) for (const r of refs(ctx.get(f), 'dialog default')) pk('faction', r.target);
  return out;
}

/** Dialogue effects that matter not to override with your own dialogue. Values are DialogActionEnum. */
export type ActionKind = 'arrest' | 'attack' | 'trade' | 'recruit';

export const ACTION_KINDS: Readonly<Record<ActionKind, readonly number[]>> = {
  // TAG_ESCAPED_SLAVE, ARREST_TARGET, ARREST_TARGETS_CARRIED_PERSON, ENSLAVE_TARGETS_CARRIED_PERSON
  arrest: [25, 29, 30, 40],
  // ATTACK_CHASE_FOREVER, DECLARE_WAR, ATTACK_TOWN, ATTACK_STAY_NEAR_HOME, ATTACK_IF_NO_COEXIST, KNOCKOUT
  attack: [6, 13, 31, 55, 57, 58],
  // DA_TRADE, CHOOSE_SLAVES_SELLING / BUYING, CHOOSE_ANIMALS_BUYING, PLAYER_SELL_PRISONERS
  trade: [1, 41, 42, 48, 50],
  // JOIN_SQUAD_WITH_EDIT, JOIN_SQUAD_FAST, CHOOSE_CONSCRIPTION, CHOOSE_RECRUITING, CHOOSE_HIRING_CONTRACT
  recruit: [3, 18, 44, 45, 46],
};

export const ACTION_KIND_LABELS: Readonly<Record<ActionKind, UiText>> = {
  arrest: { en: 'arrest', ru: 'арест', zh: '逮捕' },
  attack: { en: 'attack', ru: 'атака', zh: '攻击' },
  trade: { en: 'trade', ru: 'торговля', zh: '交易' },
  recruit: { en: 'recruit', ru: 'найм', zh: '招募' },
};

const KIND_OF = new Map<number, ActionKind>(Object.entries(ACTION_KINDS).flatMap(([k, vs]) => vs.map((v) => [v, k as ActionKind] as const)));

/** Kinds of effects in the whole dialogue tree (line effects → DIALOG_ACTION `action name`). */
export function dialogActionKinds(ctx: ModContext, dialog: string): ActionKind[] {
  const found = new Set<ActionKind>();
  const seen = new Set<string>();
  const walk = (sid: string): void => {
    if (seen.has(sid)) return;
    seen.add(sid);
    const r = ctx.get(sid);
    if (!r) return;
    for (const e of refs(r, 'effects')) {
      const k = KIND_OF.get(ctx.get(e.target)?.ints.get('action name') ?? -1);
      if (k) found.add(k);
    }
    for (const x of refs(r, 'lines')) walk(x.target);
  };
  walk(dialog);
  return (Object.keys(ACTION_KINDS) as ActionKind[]).filter((k) => found.has(k));
}

/** `score bonus` as is, without the game's bonuses (the score the game compares by is {@link dialogueScore}). */
export const dialogScore = (rec: GameRecord | undefined): number => rec?.ints.get('score bonus') ?? 0;
const chanceOf = (rec: GameRecord | undefined): number => rec?.floats.get('chance temporary') ?? 100;

/** The dialogue always fits: it passes the checks in any setup itself, and so does its root line. */
export function dialogAlwaysApplies(ctx: ModContext, dialog: string): boolean {
  const r = ctx.get(dialog);
  if (!r || !alwaysPasses(r)) return false;
  return refs(r, 'lines').some((x) => {
    const l = ctx.get(x.target);
    return l !== undefined && alwaysPasses(l);
  });
}

/** Best score the dialogue gets in the draw: its score plus the score of the best line it starts with. */
export function dialogBestTotal(ctx: ModContext, dialog: string): number | undefined {
  const leaf = (sid: string, seen: ReadonlySet<string>): number | undefined => {
    const r = ctx.get(sid);
    if (!r || seen.has(sid)) return undefined;
    if (!isEmptyNode(r)) return dialogueScore(ctx, r).total;
    const next = new Set([...seen, sid]);
    const kids = refs(r, 'lines')
      .map((x) => leaf(x.target, next))
      .filter((x): x is number => x !== undefined);
    return kids.length ? Math.max(...kids) : undefined;
  };
  const r = ctx.get(dialog);
  if (!r) return undefined;
  const l = leaf(dialog, new Set());
  return l === undefined ? undefined : dialogueScore(ctx, r).total + l;
}

/** Key by which the game places the dialogue in the list: its score + max(0, best score of the root lines). */
export function dialogSortKey(ctx: ModContext, dialog: string): number {
  const r = ctx.get(dialog);
  if (!r) return 0;
  const kids = refs(r, 'lines')
    .map((x) => ctx.get(x.target))
    .filter((x): x is GameRecord => x !== undefined);
  return dialogueScore(ctx, r).total + Math.max(0, ...kids.map((k) => dialogueScore(ctx, k).total));
}

/**
 * - `wins`: without any conditions the game picks exactly this one;
 * - `random`: without conditions it comes up randomly, together with others (`odds` = chance);
 * - `if-conditions`: when its conditions are met, the game picks it;
 * - `tie`: when its conditions are met, it comes up randomly, together with others;
 * - `shadowed`: never plays: even with met conditions the game picks another one (`by`);
 * - `locked`, `empty`, `missing`: locked, no lines, no record.
 */
export type TalkVerdict = 'wins' | 'random' | 'if-conditions' | 'tie' | 'shadowed' | 'locked' | 'empty' | 'missing';

export const TALK_VERDICT_LABELS: Readonly<Record<TalkVerdict, UiText>> = {
  wins: { en: 'the game picks it', ru: 'выберет игра', zh: '游戏会选择' },
  random: { en: 'comes up at random', ru: 'выпадет случайно', zh: '随机出现' },
  'if-conditions': { en: 'fires when conditions are met', ru: 'сработает при условиях', zh: '条件满足时触发' },
  tie: { en: 'when conditions are met — at random', ru: 'при условиях — случайно', zh: '条件满足时随机' },
  shadowed: { en: 'will not be said', ru: 'не прозвучит', zh: '不会出现' },
  locked: { en: 'locked', ru: 'заблокирован (locked)', zh: '已锁定（locked）' },
  empty: { en: 'no lines', ru: 'без реплик', zh: '没有台词' },
  missing: { en: 'no record', ru: 'нет записи', zh: '没有记录' },
};

export interface TalkCandidate {
  dialog: string;
  name: string;
  localized?: string;
  /** All sources of this dialogue (one dialogue can come by several paths). */
  sources: TalkSource[];
  /** Score as the game computes it: `score bonus` with bonuses. */
  score: number;
  /** `score bonus` as is. */
  bonus: number;
  scoreParts: ScorePart[];
  /** Best score in the draw: dialogue score + score of the first line. */
  total?: number;
  chance: number;
  /** Conditions of the dialogue itself as text. */
  conditions: string[];
  always: boolean;
  /** Layer where the dialogue appeared (`Dialogue.mod`, mod name, ...). */
  origin?: string;
  actions: ActionKind[];
  verdict: TalkVerdict;
  /** Chance that exactly this one comes up (0..1): without conditions (`wins`, `random`) or with its conditions (`if-conditions`, `tie`). */
  odds?: number;
  /** For `random` / `tie`: who else is in the draw. */
  with?: string[];
  /** For `shadowed`: who overrides it. */
  by?: string;
}

export interface TalkLine {
  id: string;
  speakerLabel?: string;
  choice: boolean;
  /** Score as the game computes it. */
  score?: number;
  scoreParts?: ScorePart[];
  chance?: number;
  /** Chance that the conversation starts with this line (0..1), for root NPC lines. */
  odds?: number;
  /** For a line with conditions: the chance when its conditions are met. */
  oddsIf?: number;
  conditions: string[];
  effects: string[];
  texts: { en: string; localized?: string }[];
  /** The line is overridden by a sibling (always fits, earlier in the list, higher score). */
  shadowedBy?: string;
  /** Player options after the NPC line (one level). */
  choices: TalkLine[];
}

export interface TalkSimulation {
  character: string;
  name: string;
  localized?: string;
  event: number;
  eventLabel: string;
  /** In the order the game goes through them; locked, empty and missing ones at the end. */
  candidates: TalkCandidate[];
  /** The dialogue the game surely picks without conditions. */
  winner?: string;
  /** Draw without conditions: the game picks randomly from these (`winner` has only one). */
  pool: string[];
  /** Whose conversation opening is shown in `opening`. */
  openingOf?: string;
  /** Conversation opening: root lines. */
  opening: TalkLine[];
}

export interface TalkOptions {
  translation?: TranslationIndex;
  /** Prebuilt squad index (for repeated calls). */
  squads?: SquadIndex;
  /** Interface language of the event label (default English). */
  lang?: string;
}

function eventLabelOf(ctx: ModContext, event: number, lang: string): string {
  const def = refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
  return def ? formatEnumValue(def, event, lang) : String(event);
}

function dialogConditions(rec: GameRecord, root: DialogueGraphNode | undefined): string[] {
  const out = [...(root?.conditions ?? []), ...(root?.filters ?? [])];
  const rep = rec.ints.get('repetition limit') ?? 0;
  if (rep !== 0) out.push(`repetition limit: ${rep}`);
  const tt = rec.ints.get('target is type') ?? 0;
  if (tt !== 0) out.push(`target is type: ${tt}`);
  const ch = chanceOf(rec);
  if (ch < 100) out.push(`chance ${ch}%`);
  const cp = rec.floats.get('chance permanent') ?? 100;
  if (cp < 100) out.push(`chance permanent ${cp}%`);
  if (rec.bools.get('unique')) out.push('unique');
  return out;
}

const toLine = (n: DialogueGraphNode): TalkLine => {
  const l: TalkLine = { id: n.id, choice: n.choice, conditions: [...n.conditions, ...n.filters], effects: n.effects, texts: n.texts, choices: [] };
  if (n.speakerLabel !== undefined) l.speakerLabel = n.speakerLabel;
  if (n.score !== undefined) l.score = n.score;
  if (n.scoreParts?.length) l.scoreParts = n.scoreParts;
  if (n.chance !== undefined) l.chance = n.chance;
  const sh = n.issues.find((i) => i.kind === 'shadowed');
  if (sh?.by !== undefined) l.shadowedBy = sh.by;
  return l;
};

const EPS = 1e-9;
/** "No conditions" setup: only records that always pass get through. */
const SURE_ENV: ChooseEnv = { passes: (_sid, r) => alwaysPasses(r) };

/** "Dialogue conditions met" setup: its whole tree passes, the target's race matched (+2). */
function ifEnv(ctx: ModContext, dialog: string): ChooseEnv {
  const tree = dialogueTreeIds(ctx, dialog);
  return {
    passes: (sid, r) => alwaysPasses(r) || tree.has(sid),
    bonus: (sid, r) => (tree.has(sid) && refs(r, 'target race').length > 0 ? 2 : 0),
  };
}

const others = (odds: ReadonlyMap<string, number>, me: string): string[] =>
  [...odds]
    .filter(([d, p]) => d !== me && p > EPS)
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d);

export function simulateTalk(ctx: ModContext, character: string, event = EVENT_TALK, options: TalkOptions = {}): TalkSimulation {
  const c = ctx.get(character);
  if (!c) throw new UiTextError({ en: `no record ${character}`, ru: `нет записи ${character}`, zh: `没有记录 ${character}` });
  if (itemTypeName(c.type) !== 'CHARACTER') throw new UiTextError({ en: `${character} is not a character (${itemTypeName(c.type)})`, ru: `${character} — не персонаж (${itemTypeName(c.type)})`, zh: `${character} 不是角色（${itemTypeName(c.type)}）` });
  const sq = options.squads ?? squadIndex(ctx);
  const byDialog = new Map<string, TalkCandidate>();
  for (const s of talkSources(ctx, c, event, sq)) {
    const had = byDialog.get(s.dialog);
    if (had) {
      had.sources.push(s);
      continue;
    }
    const rec = ctx.get(s.dialog);
    const sc = rec ? dialogueScore(ctx, rec) : { total: 0, parts: [] };
    const cand: TalkCandidate = {
      dialog: s.dialog,
      name: ctx.name(s.dialog) ?? s.dialog,
      sources: [s],
      score: sc.total,
      bonus: dialogScore(rec),
      scoreParts: sc.parts,
      chance: chanceOf(rec),
      conditions: [],
      always: false,
      actions: [],
      verdict: 'missing',
    };
    const loc = ctx.localizedName(s.dialog);
    if (loc !== undefined) cand.localized = loc;
    const o = ctx.origin(s.dialog);
    if (o) cand.origin = o.origin;
    if (rec) {
      const g = buildDialogueGraph(ctx, s.dialog, { maxNodes: 2 });
      cand.conditions = dialogConditions(rec, g.nodes[0]);
      cand.always = dialogAlwaysApplies(ctx, s.dialog);
      cand.actions = dialogActionKinds(ctx, s.dialog);
      const total = dialogBestTotal(ctx, s.dialog);
      if (total !== undefined) cand.total = total;
      cand.verdict = rec.bools.get('locked') ? 'locked' : refs(rec, 'lines').length === 0 ? 'empty' : 'if-conditions';
    }
    byDialog.set(s.dialog, cand);
  }
  const list = [...byDialog.keys()];
  const sure = chooseOdds(ctx, list, SURE_ENV);
  const pool = others(sure.odds, '');
  for (const x of byDialog.values()) {
    if (x.verdict !== 'if-conditions') continue;
    const p0 = sure.odds.get(x.dialog) ?? 0;
    if (p0 > 1 - EPS) {
      x.verdict = 'wins';
      x.odds = 1;
    } else if (p0 > EPS) {
      x.verdict = 'random';
      x.odds = p0;
      x.with = pool.filter((d) => d !== x.dialog);
    } else {
      const res = chooseOdds(ctx, list, ifEnv(ctx, x.dialog));
      const p = res.odds.get(x.dialog) ?? 0;
      if (p > 1 - EPS) x.odds = 1;
      else if (p > EPS) {
        x.verdict = 'tie';
        x.odds = p;
        x.with = others(res.odds, x.dialog);
      } else {
        x.verdict = 'shadowed';
        const by = others(res.odds, x.dialog)[0];
        if (by !== undefined) x.by = by;
      }
    }
  }
  // In game order; locked, empty and missing ones at the end.
  const rank = new Map(chooseOrder(ctx, list).map((d, i) => [d, i]));
  const live = (x: TalkCandidate): number => (x.verdict === 'locked' || x.verdict === 'empty' || x.verdict === 'missing' ? 1 : 0);
  const candidates = [...byDialog.values()].sort((a, b) => live(a) - live(b) || (rank.get(a.dialog) ?? 0) - (rank.get(b.dialog) ?? 0));
  const sim: TalkSimulation = { character, name: ctx.name(character) ?? character, event, eventLabel: eventLabelOf(ctx, event, options.lang ?? 'en'), candidates, pool, opening: [] };
  const loc = ctx.localizedName(character);
  if (loc !== undefined) sim.localized = loc;
  const winner = candidates.find((x) => x.verdict === 'wins');
  if (winner) sim.winner = winner.dialog;
  const of = winner?.dialog ?? pool[0];
  if (of !== undefined) {
    sim.openingOf = of;
    const graph = buildDialogueGraph(ctx, of, { maxNodes: 80, ...(options.translation ? { translation: options.translation } : {}) });
    const node = new Map(graph.nodes.map((n) => [n.id, n]));
    const kids = (id: string): DialogueGraphNode[] =>
      graph.edges
        .filter((e) => e.source === id && e.category === 'lines')
        .sort((a, b) => a.order - b.order)
        .map((e) => node.get(e.target))
        .filter((n): n is DialogueGraphNode => n !== undefined);
    const roots = kids(of);
    const lineOdds = chooseOdds(
      ctx,
      roots.map((n) => n.id),
      SURE_ENV,
    ).odds;
    for (const n of roots) {
      const l = toLine(n);
      if (!l.choice) {
        l.choices = kids(n.id)
          .filter((k) => k.choice)
          .map(toLine);
        l.odds = lineOdds.get(n.id) ?? 0;
        const r = ctx.get(n.id);
        if (l.odds < EPS && r && !alwaysPasses(r)) {
          const ids = roots.map((k) => k.id);
          l.oddsIf = chooseOdds(ctx, ids, ifEnv(ctx, n.id)).odds.get(n.id) ?? 0;
          delete l.odds;
        }
      }
      sim.opening.push(l);
    }
  }
  return sim;
}

const pct = (p: number): string => `${String(Math.round(p * 100))}%`;

/** Words of the talk report (CLI, MCP) in one interface language. */
interface TalkWords {
  noText: string;
  variants: (n: number) => string;
  rules: readonly string[];
  wins: string;
  random: (odds: string, withNames: string) => string;
  ifConditions: string;
  tie: (odds: string, withNames: string) => string;
  shadowedBy: (names: string) => string;
  shadowed: string;
  head: (name: string, character: string, event: string) => string;
  noDialogs: string;
  winner: (name: string) => string;
  pool: (n: number, list: string) => string;
  none: string;
  overrideNote: string;
  score: (n: number) => string;
  withOpening: (n: number) => string;
  always: string;
  conditions: string;
  lineConditions: string;
  actions: string;
  from: string;
  layer: string;
  opening: (name: string) => string;
  chance: string;
  chanceIf: string;
  player: string;
  notChosen: (by: string) => string;
  howTitle: string;
}

const talkEn: TalkWords = {
  noText: '(no text)',
  variants: (n) => ` (+${n} variants)`,
  rules: [
    'The game collects all dialogues of the character for the event: its own, from its packages, from the squad and faction packages.',
    'It drops those that do not fit right now: conditions not met, the chance failed or the dialogue is locked.',
    'Of the rest it takes those with the highest score. If there are several, one at random with equal odds: score does not give “better chances”.',
    'Score = score bonus plus extras: +1 for each condition, +2 for faction, town, race, item, world state and so on. That is why a dialogue with met conditions usually beats a plain one.',
    'The score of the first line is added to the dialogue score; the first line is picked by the same rule.',
    'A subtlety: the game walks the list top to bottom and does not drop those already taken, so sometimes dialogues with a lower score get into the draw too.',
    'A dialogue with a score below −999 is never chosen.',
  ],
  wins: 'always fits and has the highest score',
  random: (o, w) => `without conditions comes up at random, chance ${o}${w ? `; together with ${w}` : ''}`,
  ifConditions: 'when its conditions are met, the game picks it',
  tie: (o, w) => `when its conditions are met — at random, chance ${o}; together with ${w}`,
  shadowedBy: (n) => `even with its conditions met the game picks ${n}`,
  shadowed: 'the game will not pick it',
  head: (n, c, e) => `${n} (${c}), event ${e}`,
  noDialogs: 'no dialogues for this event',
  winner: (n) => `result: without any conditions the game picks “${n}”`,
  pool: (n, l) => `result: without conditions the game picks one of ${String(n)} at random: ${l}`,
  none: 'result: no dialogue fits without conditions — what is said depends on conditions',
  overrideNote: 'dialogues that “fire when conditions are met” override this when their conditions are met',
  score: (n) => `score ${String(n)}`,
  withOpening: (n) => `, with the first line — up to ${String(n)}`,
  always: 'no conditions',
  conditions: 'conditions',
  lineConditions: 'conditions on lines',
  actions: 'actions',
  from: 'from',
  layer: 'layer',
  opening: (n) => `start of conversation “${n}”:`,
  chance: 'chance',
  chanceIf: 'chance if conditions met',
  player: 'player',
  notChosen: (b) => ` — will not be chosen (${b})`,
  howTitle: 'how the game chooses (from its code):',
};

const talkRu: TalkWords = {
  noText: '(без текста)',
  variants: (n) => ` (+${n} вариантов)`,
  rules: [
    'Игра собирает все диалоги персонажа на событие: свои, из его пакетов, из пакетов отряда и фракции.',
    'Убирает те, что сейчас не подходят: не выполнены условия, не повезло с шансом или диалог заблокирован.',
    'Из оставшихся берёт те, у которых больше всего очков. Если таких несколько — случайно, всем поровну: очки не дают «больше шансов».',
    'Очки = score bonus плюс надбавки: +1 за каждое условие, +2 за фракцию, город, расу, предмет, состояние мира и т. п. Поэтому диалог с выполненными условиями обычно перебивает обычный.',
    'К очкам диалога прибавляются очки его первой реплики; первая реплика выбирается по тому же правилу.',
    'Тонкость: игра идёт по списку сверху вниз и не выкидывает уже взятых, поэтому иногда в розыгрыш попадают и диалоги с меньшими очками.',
    'Диалог с очками ниже −999 не выбирается никогда.',
  ],
  wins: 'подходит всегда, и очков у него больше всех',
  random: (o, w) => `без условий выпадет случайно, шанс ${o}${w ? `; вместе с ${w}` : ''}`,
  ifConditions: 'когда условия выполнены, игра выберет его',
  tie: (o, w) => `когда условия выполнены — случайно, шанс ${o}; вместе с ${w}`,
  shadowedBy: (n) => `даже при выполненных условиях игра выберет ${n}`,
  shadowed: 'игра его не выберет',
  head: (n, c, e) => `${n} (${c}), событие ${e}`,
  noDialogs: 'диалогов на это событие нет',
  winner: (n) => `итог: без всяких условий игра выберет «${n}»`,
  pool: (n, l) => `итог: без условий игра выберет случайно один из ${String(n)}: ${l}`,
  none: 'итог: без условий не подходит ни один диалог — что прозвучит, зависит от условий',
  overrideNote: 'диалоги «сработает при условиях» перебьют это, когда их условия выполнены',
  score: (n) => `очки ${String(n)}`,
  withOpening: (n) => `, с первой репликой — до ${String(n)}`,
  always: 'без условий',
  conditions: 'условия',
  lineConditions: 'условия у реплик',
  actions: 'действия',
  from: 'откуда',
  layer: 'слой',
  opening: (n) => `начало разговора «${n}»:`,
  chance: 'шанс',
  chanceIf: 'при условиях шанс',
  player: 'игрок',
  notChosen: (b) => ` — не будет выбрана (${b})`,
  howTitle: 'как выбирает игра (по её коду):',
};

const talkZh: TalkWords = {
  noText: '（无文本）',
  variants: (n) => `（+${n} 个变体）`,
  rules: [
    '游戏会收集角色在该事件上的所有对话：自己的、来自其对话包的、来自小队和派系对话包的。',
    '去掉当前不适用的：条件未满足、几率未命中或对话被锁定。',
    '在剩下的对话中取分数最高的。若有多个，则随机选一个，几率均等：分数不会带来“更大几率”。',
    '分数 = score bonus 加上加成：每个条件 +1，派系、城镇、种族、物品、世界状态等 +2。因此条件满足的对话通常会压过普通对话。',
    '对话分数还会加上其第一句台词的分数；第一句台词按同样规则选择。',
    '细节：游戏从上到下遍历列表，不会剔除已选中的，因此有时分数较低的对话也会进入抽选。',
    '分数低于 −999 的对话永远不会被选中。',
  ],
  wins: '始终适用，且分数最高',
  random: (o, w) => `无条件时随机出现，几率 ${o}${w ? `；与 ${w} 一起` : ''}`,
  ifConditions: '条件满足时，游戏会选择它',
  tie: (o, w) => `条件满足时随机，几率 ${o}；与 ${w} 一起`,
  shadowedBy: (n) => `即使条件满足，游戏也会选择 ${n}`,
  shadowed: '游戏不会选择它',
  head: (n, c, e) => `${n}（${c}），事件 ${e}`,
  noDialogs: '该事件没有对话',
  winner: (n) => `结果：无需任何条件，游戏会选择 “${n}”`,
  pool: (n, l) => `结果：无条件时游戏会从 ${String(n)} 个中随机选一个：${l}`,
  none: '结果：无条件时没有适用的对话 — 说什么取决于条件',
  overrideNote: '“条件满足时触发”的对话在条件满足时会覆盖此结果',
  score: (n) => `分数 ${String(n)}`,
  withOpening: (n) => `，加上第一句台词 — 最多 ${String(n)}`,
  always: '无条件',
  conditions: '条件',
  lineConditions: '条件在台词上',
  actions: '动作',
  from: '来源',
  layer: '图层',
  opening: (n) => `对话开头 “${n}”：`,
  chance: '几率',
  chanceIf: '条件满足时几率',
  player: '玩家',
  notChosen: (b) => ` — 不会被选中（${b}）`,
  howTitle: '游戏如何选择（依据其代码）：',
};

const TALK_WORDS: Readonly<Record<string, TalkWords>> = { en: talkEn, ru: talkRu, zh: talkZh };

const talkWords = (lang = 'en'): TalkWords => TALK_WORDS[lang] ?? talkEn;

const textOf = (l: TalkLine, w: TalkWords): string => {
  const t = l.texts[0];
  if (!t) return w.noText;
  return `«${t.localized ?? t.en}»${l.texts.length > 1 ? w.variants(l.texts.length - 1) : ''}`;
};

/** The pick rule in plain words (for CLI and MCP; the editor shows the same hint, translated). */
export const TALK_RULES: readonly string[] = talkEn.rules;

/** The choice rule in an interface language. */
export function talkRules(lang = 'en'): readonly string[] {
  return talkWords(lang).rules;
}

function reason(x: TalkCandidate, nameOf: (d: string) => string, w: TalkWords): string | undefined {
  const names = (ds: readonly string[] | undefined): string => (ds ?? []).map((d) => `«${nameOf(d)}»`).join(', ');
  switch (x.verdict) {
    case 'wins':
      return w.wins;
    case 'random':
      return w.random(pct(x.odds ?? 0), names(x.with));
    case 'if-conditions':
      return w.ifConditions;
    case 'tie':
      return w.tie(pct(x.odds ?? 0), names(x.with));
    case 'shadowed':
      return x.by !== undefined ? w.shadowedBy(names([x.by])) : w.shadowed;
    default:
      return undefined;
  }
}

/** Simulation report as text (for CLI and MCP). */
export function formatTalk(sim: TalkSimulation, lang = 'en'): string[] {
  const w = talkWords(lang);
  const out = [w.head(sim.localized ?? sim.name, sim.character, sim.eventLabel)];
  if (!sim.candidates.length) {
    out.push(`  ${w.noDialogs}`);
    return out;
  }
  const byId = new Map(sim.candidates.map((x) => [x.dialog, x]));
  const nameOf = (d: string): string => {
    const x = byId.get(d);
    return x ? (x.localized ?? x.name) : d;
  };
  if (sim.winner !== undefined) out.push(`  ${w.winner(nameOf(sim.winner))}`);
  else if (sim.pool.length) out.push(`  ${w.pool(sim.pool.length, sim.pool.map((d) => `«${nameOf(d)}» (${pct(byId.get(d)?.odds ?? 0)})`).join(', '))}`);
  else out.push(`  ${w.none}`);
  if (sim.candidates.some((x) => x.verdict === 'if-conditions' || x.verdict === 'tie')) out.push(`  ${w.overrideNote}`);
  const viaText = (v: TalkVia): string => uiText(TALK_VIA_LABELS[v], lang);
  for (const x of sim.candidates) {
    const via = [...new Set(x.sources.map((s) => (s.via === 'character' ? viaText(s.via) : `${viaText(s.via)} ${s.holder}`)))].join('; ');
    const why = reason(x, nameOf, w);
    out.push(`  ${x.verdict === 'wins' ? '▶' : '·'} ${x.localized ?? x.name} (${x.dialog}) — ${uiText(TALK_VERDICT_LABELS[x.verdict], lang)}${why ? `: ${why}` : ''}`);
    const parts = x.scoreParts.some((p) => p.key !== 'bonus') ? ` (${formatScoreParts(x.scoreParts, lang)})` : '';
    out.push(`      ${w.score(x.score)}${parts}${x.total !== undefined && x.total !== x.score ? w.withOpening(x.total) : ''}`);
    out.push(
      `      ${x.always ? w.always : x.conditions.length ? `${w.conditions}: ${x.conditions.join('; ')}` : w.lineConditions}${x.actions.length ? `; ${w.actions}: ${x.actions.map((a) => uiText(ACTION_KIND_LABELS[a], lang)).join(', ')}` : ''}`,
    );
    out.push(`      ${w.from}: ${via}${x.origin ? `; ${w.layer} ${x.origin}` : ''}`);
  }
  if (sim.openingOf !== undefined) {
    out.push(`  ${w.opening(nameOf(sim.openingOf))}`);
    for (const l of sim.opening) {
      const meta = [
        w.score(l.score ?? 0),
        ...(l.odds !== undefined && l.odds < 1 - EPS ? [`${w.chance} ${pct(l.odds)}`] : []),
        ...(l.oddsIf !== undefined ? [`${w.chanceIf} ${pct(l.oddsIf)}`] : []),
        ...(l.chance !== undefined && l.chance < 100 ? [`chance ${String(l.chance)}%`] : []),
        ...(l.conditions.length ? [`${w.conditions}: ${l.conditions.join('; ')}`] : []),
      ];
      out.push(`    ${l.speakerLabel ?? (l.choice ? w.player : 'NPC')}: ${textOf(l, w)} [${meta.join(', ')}]${l.shadowedBy ? w.notChosen(l.shadowedBy) : ''}`);
      for (const ch of l.choices) out.push(`      → ${textOf(ch, w)}${ch.effects.length ? ` [${ch.effects.join('; ')}]` : ''}`);
    }
  }
  out.push(`  ${w.howTitle}`);
  for (const r of w.rules) out.push(`    - ${r}`);
  return out;
}
