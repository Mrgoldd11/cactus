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
 * Выбор: побеждают очки диалога (`score bonus`); диалог без условий со 100% шансом, у которого есть
 * корневая реплика без условий и со 100% шансом, подходит всегда — он и «победитель», если очков
 * больше ни у кого без условий нет. Кандидаты с условиями и бо́льшими очками перебивают его, когда
 * условия выполнены. Точная формула игры неизвестна: это оценка, а не гарантия.
 */
import type { GameRecord } from '../format/types.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { TranslationIndex } from '../locale/translation.ts';
import type { ModContext } from '../model/context.ts';
import { buildDialogueGraph, hasConditions, type DialogueGraphNode } from '../model/dialogue-graph.ts';
import { formatEnumValue, refValueEnum } from '../model/enums.ts';

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

export const dialogScore = (rec: GameRecord | undefined): number => rec?.ints.get('score bonus') ?? 0;
const chanceOf = (rec: GameRecord | undefined): number => rec?.floats.get('chance temporary') ?? 100;

/**
 * Диалог подходит всегда: сам без условий со 100% шансом, и есть корневая реплика без условий
 * со 100% шансом.
 */
export function dialogAlwaysApplies(ctx: ModContext, dialog: string): boolean {
  const r = ctx.get(dialog);
  if (!r || hasConditions(r) || chanceOf(r) < 100) return false;
  return refs(r, 'lines').some((x) => {
    const l = ctx.get(x.target);
    return l !== undefined && !hasConditions(l) && chanceOf(l) >= 100;
  });
}

/**
 * - `wins` — выберет игра (без условий, очков больше всех таких же);
 * - `if-conditions` — сработает, когда выполнены условия (очков больше, чем у победителя, или победителя нет);
 * - `tie` — очков столько же, сколько у победителя: кто из них, неизвестно;
 * - `shadowed` — очков меньше, чем у победителя: не прозвучит;
 * - `locked`, `empty`, `missing` — заблокирован, без реплик, записи нет.
 */
export type TalkVerdict = 'wins' | 'if-conditions' | 'tie' | 'shadowed' | 'locked' | 'empty' | 'missing';

export const TALK_VERDICT_LABELS: Readonly<Record<TalkVerdict, string>> = {
  wins: 'выберет игра',
  'if-conditions': 'сработает при условиях',
  tie: 'ничья с победителем',
  shadowed: 'не прозвучит',
  locked: 'заблокирован (locked)',
  empty: 'без реплик',
  missing: 'нет записи',
};

export interface TalkCandidate {
  dialog: string;
  name: string;
  ru?: string;
  /** Все источники этого диалога (один диалог может прийти несколькими путями). */
  sources: TalkSource[];
  score: number;
  chance: number;
  /** Условия самого диалога текстом. */
  conditions: string[];
  always: boolean;
  /** Слой, где диалог появился (`Dialogue.mod`, имя мода, ...). */
  origin?: string;
  actions: ActionKind[];
  verdict: TalkVerdict;
  /** Для `shadowed` / `tie` — победитель. */
  by?: string;
}

export interface TalkLine {
  id: string;
  speakerLabel?: string;
  choice: boolean;
  score?: number;
  chance?: number;
  conditions: string[];
  effects: string[];
  texts: { en: string; ru?: string }[];
  /** Реплику перебивает соседняя (без условий, 100%, очков больше). */
  shadowedBy?: string;
  /** Варианты игрока после реплики NPC (один уровень). */
  choices: TalkLine[];
}

export interface TalkSimulation {
  character: string;
  name: string;
  ru?: string;
  event: number;
  eventLabel: string;
  candidates: TalkCandidate[];
  winner?: string;
  /** Начало разговора победителя: корневые реплики. */
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
  return out;
}

const toLine = (n: DialogueGraphNode): TalkLine => {
  const l: TalkLine = { id: n.id, choice: n.choice, conditions: [...n.conditions, ...n.filters], effects: n.effects, texts: n.texts, choices: [] };
  if (n.speakerLabel !== undefined) l.speakerLabel = n.speakerLabel;
  if (n.score !== undefined) l.score = n.score;
  if (n.chance !== undefined) l.chance = n.chance;
  const sh = n.issues.find((i) => i.kind === 'shadowed');
  if (sh?.by !== undefined) l.shadowedBy = sh.by;
  return l;
};

export function simulateTalk(ctx: ModContext, character: string, event = EVENT_TALK, options: TalkOptions = {}): TalkSimulation {
  const c = ctx.get(character);
  if (!c) throw new Error(`нет записи ${character}`);
  if (itemTypeName(c.type) !== 'CHARACTER') throw new Error(`${character} — не персонаж (${itemTypeName(c.type)})`);
  const sq = options.squads ?? squadIndex(ctx);
  const byDialog = new Map<string, TalkCandidate>();
  for (const s of talkSources(ctx, c, event, sq)) {
    const had = byDialog.get(s.dialog);
    if (had) {
      had.sources.push(s);
      continue;
    }
    const rec = ctx.get(s.dialog);
    const cand: TalkCandidate = {
      dialog: s.dialog,
      name: ctx.name(s.dialog) ?? s.dialog,
      sources: [s],
      score: dialogScore(rec),
      chance: chanceOf(rec),
      conditions: [],
      always: false,
      actions: [],
      verdict: 'missing',
    };
    const ru = ctx.localizedName(s.dialog);
    if (ru !== undefined) cand.ru = ru;
    const o = ctx.origin(s.dialog);
    if (o) cand.origin = o.origin;
    if (rec) {
      const g = buildDialogueGraph(ctx, s.dialog, { maxNodes: 2 });
      cand.conditions = dialogConditions(rec, g.nodes[0]);
      cand.always = dialogAlwaysApplies(ctx, s.dialog);
      cand.actions = dialogActionKinds(ctx, s.dialog);
      cand.verdict = rec.bools.get('locked') ? 'locked' : refs(rec, 'lines').length === 0 ? 'empty' : 'if-conditions';
    }
    byDialog.set(s.dialog, cand);
  }
  // По очкам (сверху — кто выигрывает при выполненных условиях); заблокированные и пустые — в конце.
  const blocked = (x: TalkCandidate): number => (x.verdict === 'if-conditions' ? 0 : 1);
  const candidates = [...byDialog.values()].sort((a, b) => blocked(a) - blocked(b) || b.score - a.score);
  const live = candidates.filter((x) => x.verdict === 'if-conditions');
  // Победитель: больше всех очков среди «всегда»; при равных — первый по порядку источников.
  const winner = live.filter((x) => x.always).reduce<TalkCandidate | undefined>((best, x) => (!best || x.score > best.score ? x : best), undefined);
  if (winner) {
    for (const x of live) {
      if (x === winner) x.verdict = 'wins';
      else if (x.score === winner.score) {
        x.verdict = 'tie';
        x.by = winner.dialog;
      } else if (x.score < winner.score) {
        x.verdict = 'shadowed';
        x.by = winner.dialog;
      }
    }
  }
  const sim: TalkSimulation = { character, name: ctx.name(character) ?? character, event, eventLabel: eventLabelOf(ctx, event), candidates, opening: [] };
  const ru = ctx.localizedName(character);
  if (ru !== undefined) sim.ru = ru;
  if (winner) {
    sim.winner = winner.dialog;
    const graph = buildDialogueGraph(ctx, winner.dialog, { maxNodes: 80, ...(options.translation ? { translation: options.translation } : {}) });
    const node = new Map(graph.nodes.map((n) => [n.id, n]));
    const kids = (id: string): DialogueGraphNode[] =>
      graph.edges
        .filter((e) => e.source === id && e.category === 'lines')
        .sort((a, b) => a.order - b.order)
        .map((e) => node.get(e.target))
        .filter((n): n is DialogueGraphNode => n !== undefined);
    for (const n of kids(winner.dialog)) {
      const l = toLine(n);
      if (!l.choice) l.choices = kids(n.id).filter((k) => k.choice).map(toLine);
      sim.opening.push(l);
    }
  }
  return sim;
}

const textOf = (l: TalkLine): string => {
  const t = l.texts[0];
  if (!t) return '(без текста)';
  return `«${t.ru ?? t.en}»${l.texts.length > 1 ? ` (+${l.texts.length - 1} вариантов)` : ''}`;
};

/** Отчёт симуляции текстом (для CLI и MCP). */
export function formatTalk(sim: TalkSimulation): string[] {
  const out = [`${sim.ru ?? sim.name} (${sim.character}), событие ${sim.eventLabel}`];
  if (!sim.candidates.length) {
    out.push('  диалогов на это событие нет');
    return out;
  }
  for (const x of sim.candidates) {
    const via = [...new Set(x.sources.map((s) => (s.via === 'character' ? TALK_VIA_LABELS[s.via] : `${TALK_VIA_LABELS[s.via]} ${s.holder}`)))].join('; ');
    out.push(`  ${x.verdict === 'wins' ? '▶' : '·'} ${x.ru ?? x.name} (${x.dialog}) — ${TALK_VERDICT_LABELS[x.verdict]}${x.by ? ` (${x.by})` : ''}`);
    out.push(`      очки ${x.score}, ${x.always ? 'без условий' : x.conditions.length ? `условия: ${x.conditions.join('; ')}` : 'условия у реплик'}${x.actions.length ? `, действия: ${x.actions.map((a) => ACTION_KIND_LABELS[a]).join(', ')}` : ''}`);
    out.push(`      откуда: ${via}${x.origin ? `; слой ${x.origin}` : ''}`);
  }
  out.push('  из подходящих по условиям игра берёт диалог с бо́льшими очками (оценка: точная формула игры неизвестна)');
  if (!sim.winner) out.push('  без условий не подходит ни один — что прозвучит, зависит от условий');
  else {
    out.push('  начало разговора:');
    for (const l of sim.opening) {
      const meta = [`очки ${l.score ?? 0}`, ...(l.chance !== undefined && l.chance < 100 ? [`шанс ${l.chance}%`] : []), ...(l.conditions.length ? [`условия: ${l.conditions.join('; ')}`] : [])];
      out.push(`    ${l.speakerLabel ?? (l.choice ? 'игрок' : 'NPC')}: ${textOf(l)} [${meta.join(', ')}]${l.shadowedBy ? ` — не будет выбрана (${l.shadowedBy})` : ''}`);
      for (const ch of l.choices) out.push(`      → ${textOf(ch)}${ch.effects.length ? ` [${ch.effects.join('; ')}]` : ''}`);
    }
  }
  return out;
}

