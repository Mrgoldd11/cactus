/**
 * Симулятор разговора: какие диалоги есть у персонажа на событие (по клику — событие 1), откуда
 * они взялись и какой из них игра, скорее всего, выберет.
 *
 * Откуда игра берёт кандидатов (по данным ванили и проверкам мода Vanilla Talk):
 * - `CHARACTER.dialogue` — только событие 1;
 * - `CHARACTER.dialogue package` → `DIALOGUE_PACKAGE.dialogs` (v0 ссылки — событие),
 *   с пакетами из `inheritsFrom`;
 * - отряды персонажа (SQUAD_TEMPLATE `leader`, `squad`, `squad2`, `choosefrom list`): у лидера —
 *   `dialog leader`, у всех — `dialog squad`;
 * - фракция (своя или фракции отрядов): `dialog default`.
 *
 * Выбор — по правилу игры, разобранному по её коду (`model/dialogue-score.ts`): очки = `score bonus`
 * с надбавками за условия; из прошедших проверки игра берёт тех, у кого очков больше всех, а из
 * равных — случайно и поровну. Симулятор считает два расклада: «без условий» (проходят только
 * записи, которые проходят всегда) и для каждого диалога с условиями — «его условия выполнены,
 * остальные нет».
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

/** Событие «игрок заговорил со мной» (EV_PLAYER_TALK_TO_ME). */
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
  /** Запись, в которой стоит ссылка на диалог: персонаж или пакет. */
  holder: string;
  dialog: string;
}

/** Персонаж → отряды, в которых он есть (и лидер ли он там). */
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

/** Фракции персонажа: своя или (если её нет) фракции его отрядов. */
export function characterFactions(ctx: ModContext, c: GameRecord, sq: SquadIndex): string[] {
  const own = refs(c, 'faction').map((r) => r.target);
  if (own.length) return own;
  const out = new Set<string>();
  for (const { squad } of sq.get(c.stringId) ?? []) for (const r of refs(ctx.get(squad), 'faction')) out.add(r.target);
  return [...out];
}

/** Диалоги пакета с номерами событий, с учётом `inheritsFrom`. */
export function packageDialogs(ctx: ModContext, pkg: string, seen = new Set<string>()): { event: number; dialog: string; pkg: string }[] {
  if (seen.has(pkg)) return [];
  seen.add(pkg);
  const p = ctx.get(pkg);
  if (!p) return [];
  const out = refs(p, 'dialogs').map((r) => ({ event: r.v0, dialog: r.target, pkg }));
  for (const r of refs(p, 'inheritsFrom')) out.push(...packageDialogs(ctx, r.target, seen));
  return out;
}

/** Все диалоги персонажа на событие и откуда они взялись (в порядке источников). */
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

/** Действия диалога, которые важно не перебить своим диалогом. Значения — DialogActionEnum. */
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

/** Виды действий во всём дереве диалога (эффекты реплик → DIALOG_ACTION `action name`). */
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

/** `score bonus` как есть, без надбавок игры (очки, с которыми игра сравнивает, — {@link dialogueScore}). */
export const dialogScore = (rec: GameRecord | undefined): number => rec?.ints.get('score bonus') ?? 0;
const chanceOf = (rec: GameRecord | undefined): number => rec?.floats.get('chance temporary') ?? 100;

/** Диалог подходит всегда: сам проходит проверки при любом раскладе, и такая же у него корневая реплика. */
export function dialogAlwaysApplies(ctx: ModContext, dialog: string): boolean {
  const r = ctx.get(dialog);
  if (!r || !alwaysPasses(r)) return false;
  return refs(r, 'lines').some((x) => {
    const l = ctx.get(x.target);
    return l !== undefined && alwaysPasses(l);
  });
}

/** Лучшие очки, которые получит диалог в розыгрыше: его очки плюс очки лучшей реплики, с которой он начнётся. */
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

/** Ключ, по которому игра ставит диалог в список: его очки + max(0, лучшие очки корневых реплик). */
export function dialogSortKey(ctx: ModContext, dialog: string): number {
  const r = ctx.get(dialog);
  if (!r) return 0;
  const kids = refs(r, 'lines')
    .map((x) => ctx.get(x.target))
    .filter((x): x is GameRecord => x !== undefined);
  return dialogueScore(ctx, r).total + Math.max(0, ...kids.map((k) => dialogueScore(ctx, k).total));
}

/**
 * - `wins` — без всяких условий игра выберет именно его;
 * - `random` — без условий выпадет случайно, вместе с другими (`odds` — шанс);
 * - `if-conditions` — когда его условия выполнены, игра выберет его;
 * - `tie` — когда его условия выполнены, выпадет случайно, вместе с другими;
 * - `shadowed` — не прозвучит: даже при выполненных условиях игра выберет другой (`by`);
 * - `locked`, `empty`, `missing` — заблокирован, без реплик, записи нет.
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
  /** Все источники этого диалога (один диалог может прийти несколькими путями). */
  sources: TalkSource[];
  /** Очки, как их считает игра: `score bonus` с надбавками. */
  score: number;
  /** `score bonus` как есть. */
  bonus: number;
  scoreParts: ScorePart[];
  /** Лучшие очки в розыгрыше: очки диалога + очки первой реплики. */
  total?: number;
  chance: number;
  /** Условия самого диалога текстом. */
  conditions: string[];
  always: boolean;
  /** Слой, где диалог появился (`Dialogue.mod`, имя мода, ...). */
  origin?: string;
  actions: ActionKind[];
  verdict: TalkVerdict;
  /** Шанс, что выпадет именно он (0..1): без условий (`wins`, `random`) или при его условиях (`if-conditions`, `tie`). */
  odds?: number;
  /** Для `random` / `tie` — с кем вместе в розыгрыше. */
  with?: string[];
  /** Для `shadowed` — кто его перебивает. */
  by?: string;
}

export interface TalkLine {
  id: string;
  speakerLabel?: string;
  choice: boolean;
  /** Очки, как их считает игра. */
  score?: number;
  scoreParts?: ScorePart[];
  chance?: number;
  /** Шанс, что разговор начнётся с этой реплики (0..1), для корневых реплик NPC. */
  odds?: number;
  /** Для реплики с условиями — шанс, когда её условия выполнены. */
  oddsIf?: number;
  conditions: string[];
  effects: string[];
  texts: { en: string; localized?: string }[];
  /** Реплику перебивает соседняя (подходит всегда, раньше в списке, очков больше). */
  shadowedBy?: string;
  /** Варианты игрока после реплики NPC (один уровень). */
  choices: TalkLine[];
}

export interface TalkSimulation {
  character: string;
  name: string;
  localized?: string;
  event: number;
  eventLabel: string;
  /** В порядке, в котором их перебирает игра; заблокированные, пустые и без записи — в конце. */
  candidates: TalkCandidate[];
  /** Диалог, который без условий выберет игра наверняка. */
  winner?: string;
  /** Розыгрыш без условий: из них игра выберет случайно (у `winner` — он один). */
  pool: string[];
  /** Чьё начало разговора показано в `opening`. */
  openingOf?: string;
  /** Начало разговора: корневые реплики. */
  opening: TalkLine[];
}

export interface TalkOptions {
  translation?: TranslationIndex;
  /** Готовый индекс отрядов (для повторных вызовов). */
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
/** Расклад «без условий»: проходят только записи, которые проходят всегда. */
const SURE_ENV: ChooseEnv = { passes: (_sid, r) => alwaysPasses(r) };

/** Расклад «условия диалога выполнены»: всё его дерево проходит, раса собеседника совпала (+2). */
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
  // В порядке игры; заблокированные, пустые и без записи — в конце.
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

/** Правило выбора простыми словами (для CLI и MCP; в редакторе — та же подсказка с переводом). */
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

/** Отчёт симуляции текстом (для CLI и MCP). */
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
