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
import { UiTextError } from '../ui-text.ts';

/** Событие «игрок заговорил со мной» (EV_PLAYER_TALK_TO_ME). */
export const EVENT_TALK = 1;

export type TalkVia = 'character' | 'character-package' | 'squad-leader' | 'squad' | 'faction';

export const TALK_VIA_LABELS: Readonly<Record<TalkVia, string>> = {
  character: 'персонаж (dialogue)',
  'character-package': 'пакет персонажа',
  'squad-leader': 'пакет лидера отряда',
  squad: 'пакет отряда',
  faction: 'пакет фракции',
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

export const ACTION_KIND_LABELS: Readonly<Record<ActionKind, string>> = { arrest: 'арест', attack: 'атака', trade: 'торговля', recruit: 'найм' };

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

export const TALK_VERDICT_LABELS: Readonly<Record<TalkVerdict, string>> = {
  wins: 'выберет игра',
  random: 'выпадет случайно',
  'if-conditions': 'сработает при условиях',
  tie: 'при условиях — случайно',
  shadowed: 'не прозвучит',
  locked: 'заблокирован (locked)',
  empty: 'без реплик',
  missing: 'нет записи',
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
}

function eventLabelOf(ctx: ModContext, event: number): string {
  const def = refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
  return def ? formatEnumValue(def, event) : String(event);
}

function dialogConditions(rec: GameRecord, root: DialogueGraphNode | undefined): string[] {
  const out = [...(root?.conditions ?? []), ...(root?.filters ?? [])];
  const rep = rec.ints.get('repetition limit') ?? 0;
  if (rep !== 0) out.push(`повтор не чаще: ${rep}`);
  const tt = rec.ints.get('target is type') ?? 0;
  if (tt !== 0) out.push(`target is type: ${tt}`);
  const ch = chanceOf(rec);
  if (ch < 100) out.push(`шанс ${ch}%`);
  const cp = rec.floats.get('chance permanent') ?? 100;
  if (cp < 100) out.push(`постоянный шанс ${cp}%`);
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
  const sim: TalkSimulation = { character, name: ctx.name(character) ?? character, event, eventLabel: eventLabelOf(ctx, event), candidates, pool, opening: [] };
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

const textOf = (l: TalkLine): string => {
  const t = l.texts[0];
  if (!t) return '(без текста)';
  return `«${t.localized ?? t.en}»${l.texts.length > 1 ? ` (+${l.texts.length - 1} вариантов)` : ''}`;
};

const pct = (p: number): string => `${String(Math.round(p * 100))}%`;

/** Правило выбора простыми словами (для CLI и MCP; в редакторе — та же подсказка с переводом). */
export const TALK_RULES: readonly string[] = [
  'Игра собирает все диалоги персонажа на событие: свои, из его пакетов, из пакетов отряда и фракции.',
  'Убирает те, что сейчас не подходят: не выполнены условия, не повезло с шансом или диалог заблокирован.',
  'Из оставшихся берёт те, у которых больше всего очков. Если таких несколько — случайно, всем поровну: очки не дают «больше шансов».',
  'Очки = score bonus плюс надбавки: +1 за каждое условие, +2 за фракцию, город, расу, предмет, состояние мира и т. п. Поэтому диалог с выполненными условиями обычно перебивает обычный.',
  'К очкам диалога прибавляются очки его первой реплики; первая реплика выбирается по тому же правилу.',
  'Тонкость: игра идёт по списку сверху вниз и не выкидывает уже взятых, поэтому иногда в розыгрыш попадают и диалоги с меньшими очками.',
  'Диалог с очками ниже −999 не выбирается никогда.',
];

function reason(x: TalkCandidate, nameOf: (d: string) => string): string | undefined {
  const names = (ds: readonly string[] | undefined): string => (ds ?? []).map((d) => `«${nameOf(d)}»`).join(', ');
  switch (x.verdict) {
    case 'wins':
      return 'подходит всегда, и очков у него больше всех';
    case 'random':
      return `без условий выпадет случайно, шанс ${pct(x.odds ?? 0)}${x.with?.length ? `; вместе с ${names(x.with)}` : ''}`;
    case 'if-conditions':
      return 'когда условия выполнены, игра выберет его';
    case 'tie':
      return `когда условия выполнены — случайно, шанс ${pct(x.odds ?? 0)}; вместе с ${names(x.with)}`;
    case 'shadowed':
      return x.by !== undefined ? `даже при выполненных условиях игра выберет ${names([x.by])}` : 'игра его не выберет';
    default:
      return undefined;
  }
}

/** Отчёт симуляции текстом (для CLI и MCP). */
export function formatTalk(sim: TalkSimulation): string[] {
  const out = [`${sim.localized ?? sim.name} (${sim.character}), событие ${sim.eventLabel}`];
  if (!sim.candidates.length) {
    out.push('  диалогов на это событие нет');
    return out;
  }
  const byId = new Map(sim.candidates.map((x) => [x.dialog, x]));
  const nameOf = (d: string): string => {
    const x = byId.get(d);
    return x ? (x.localized ?? x.name) : d;
  };
  if (sim.winner !== undefined) out.push(`  итог: без всяких условий игра выберет «${nameOf(sim.winner)}»`);
  else if (sim.pool.length) out.push(`  итог: без условий игра выберет случайно один из ${String(sim.pool.length)}: ${sim.pool.map((d) => `«${nameOf(d)}» (${pct(byId.get(d)?.odds ?? 0)})`).join(', ')}`);
  else out.push('  итог: без условий не подходит ни один диалог — что прозвучит, зависит от условий');
  if (sim.candidates.some((x) => x.verdict === 'if-conditions' || x.verdict === 'tie')) out.push('  диалоги «сработает при условиях» перебьют это, когда их условия выполнены');
  for (const x of sim.candidates) {
    const via = [...new Set(x.sources.map((s) => (s.via === 'character' ? TALK_VIA_LABELS[s.via] : `${TALK_VIA_LABELS[s.via]} ${s.holder}`)))].join('; ');
    const why = reason(x, nameOf);
    out.push(`  ${x.verdict === 'wins' ? '▶' : '·'} ${x.localized ?? x.name} (${x.dialog}) — ${TALK_VERDICT_LABELS[x.verdict]}${why ? `: ${why}` : ''}`);
    const parts = x.scoreParts.some((p) => p.key !== 'bonus') ? ` (${formatScoreParts(x.scoreParts)})` : '';
    out.push(`      очки ${String(x.score)}${parts}${x.total !== undefined && x.total !== x.score ? `, с первой репликой — до ${String(x.total)}` : ''}`);
    out.push(`      ${x.always ? 'без условий' : x.conditions.length ? `условия: ${x.conditions.join('; ')}` : 'условия у реплик'}${x.actions.length ? `; действия: ${x.actions.map((a) => ACTION_KIND_LABELS[a]).join(', ')}` : ''}`);
    out.push(`      откуда: ${via}${x.origin ? `; слой ${x.origin}` : ''}`);
  }
  if (sim.openingOf !== undefined) {
    out.push(`  начало разговора «${nameOf(sim.openingOf)}»:`);
    for (const l of sim.opening) {
      const meta = [
        `очки ${String(l.score ?? 0)}`,
        ...(l.odds !== undefined && l.odds < 1 - EPS ? [`шанс ${pct(l.odds)}`] : []),
        ...(l.oddsIf !== undefined ? [`при условиях шанс ${pct(l.oddsIf)}`] : []),
        ...(l.chance !== undefined && l.chance < 100 ? [`chance ${String(l.chance)}%`] : []),
        ...(l.conditions.length ? [`условия: ${l.conditions.join('; ')}`] : []),
      ];
      out.push(`    ${l.speakerLabel ?? (l.choice ? 'игрок' : 'NPC')}: ${textOf(l)} [${meta.join(', ')}]${l.shadowedBy ? ` — не будет выбрана (${l.shadowedBy})` : ''}`);
      for (const ch of l.choices) out.push(`      → ${textOf(ch)}${ch.effects.length ? ` [${ch.effects.join('; ')}]` : ''}`);
    }
  }
  out.push('  как выбирает игра (по её коду):');
  for (const r of TALK_RULES) out.push(`    - ${r}`);
  return out;
}

