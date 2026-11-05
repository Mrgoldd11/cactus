/**
 * Проигрыватель разговора: шаг за шагом, как игра ведёт беседу с персонажем.
 *
 * - Начало: все диалоги персонажа на событие (`talkSources`) — игра выбирает один по своему правилу
 *   (`chooseOdds`), затем внутри него первую реплику по тому же правилу; пустые узлы (без текста)
 *   игра не говорит, а сразу выбирает среди их детей.
 * - После реплики NPC: если дальше ответы игрока (говорит собеседник — `CHOICE_SPEAKERS`), они
 *   показываются списком; ответ с невыполненными условиями скрыт. Иначе игра сама выбирает
 *   следующую реплику NPC. Смешанные ветки (ответы и реплики NPC вместе, в ванили 57 узлов) игрой
 *   не разобраны — проигрыватель показывает ответы и отдельный ход «NPC продолжает сам».
 * - «Как будто»: режим `met` (по умолчанию) считает условия и шансы выполненными, только
 *   запертые (locked) — запертыми; режим `none` пропускает лишь записи, которые проходят всегда.
 *   `assume` для отдельных записей перекрывает режим: выполнены (true) или нет (false). Раса
 *   собеседника из `target race` при выполненных условиях даёт игровые +2, как в игре.
 * - Если подходящих несколько с равными очками, игра выбирает случайно; проигрыватель берёт
 *   первую в порядке игры, пока пользователь не выберет другую (`prefer`).
 */
import type { GameRecord } from '../format/types.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { ModContext } from '../model/context.ts';
import { CHOICE_SPEAKERS } from '../model/dialogue-graph.ts';
import { alwaysPasses, chooseOdds, chooseOrder, dialogueScore, isEmptyNode, type ChooseEnv } from '../model/dialogue-score.ts';
import { EVENT_TALK, squadIndex, talkSources, type SquadIndex, type TalkSource } from './talk.ts';

/** Почему вариант выбран или нет. */
export type PlayWhy =
  /** Выбран: подходит и очков больше всех. */
  | 'chosen'
  /** Выбран случайно среди равных (есть и другие с шансом). */
  | 'chosen-random'
  /** Мог выпасть случайно, но выпал другой. */
  | 'random'
  /** Подходит, но у выбранного очков больше (или раньше в списке игры). */
  | 'outscored'
  /** Не подходит: условия, шанс, locked или unique — не выполнены в этом раскладе. */
  | 'fails'
  /** Пустой узел без продолжения: игре нечего сказать. */
  | 'empty'
  /** Записи нет. */
  | 'missing';

export interface PlayOption {
  sid: string;
  why: PlayWhy;
  /** Шанс, что игра выберет его в этом раскладе (0..1). */
  odds: number;
  /** Очки записи, как их считает игра (без надбавки за расу). */
  score: number;
  /** Проходит ли проверки в этом раскладе. */
  passes: boolean;
  /** Проходит всегда — переключатель «как будто» ему не нужен. */
  always: boolean;
  /** Для диалогов начала: откуда взялся (персонаж, пакеты, отряд, фракция). */
  sources?: TalkSource[];
}

export interface PlayLevel {
  node: string;
  options: PlayOption[];
}

export interface PlayAnswer {
  sid: string;
  /** Показан игроку (условия выполнены в этом раскладе). */
  shown: boolean;
  always: boolean;
}

export interface PlayStep {
  /** Откуда выбирали: '' — начало (диалоги события), иначе id предыдущей реплики. */
  from: string;
  /** Из чего игра выбирала реплику NPC (пусто, если здесь сразу ответы игрока). */
  options: PlayOption[];
  /** Пустые узлы, через которые прошёл выбор (корень диалога и т. п.), с выбором внутри каждого. */
  path: PlayLevel[];
  /** Что прозвучало (реплика NPC или ответ, сказанный без выбора). */
  said?: string;
  /** Варианты ответа игрока после `said` (или после ответа на прошлом шаге). */
  answers: PlayAnswer[];
  /** Есть и реплики NPC вместе с ответами — ход «NPC продолжает сам» (`PLAY_NPC`). */
  npcToo: boolean;
  /** Что выбрал игрок (id ответа или `PLAY_NPC`). */
  answered?: string;
  /** Разговор здесь кончился: дальше ничего нет / ничего не подошло. */
  end?: 'nothing-next' | 'nothing-fits';
}

/** Ход «NPC продолжает сам» в смешанной ветке. */
export const PLAY_NPC = '@npc';

/** Расклад по умолчанию: `met` — условия выполнены (кроме locked), `none` — проходят только записи без условий. */
export type PlayMode = 'met' | 'none';

export interface PlayInput {
  /** Событие (по клику — 1). */
  event?: number;
  mode?: PlayMode;
  /** «Как будто»: id → считать условия выполненными (true) или нет (false). */
  assume?: ReadonlyMap<string, boolean>;
  /** Ответы игрока по порядку. */
  answers?: readonly string[];
  /** Выбор среди равных: id шага (`from`) → какой вариант взять. */
  prefer?: ReadonlyMap<string, string>;
  squads?: SquadIndex;
  /** Предел шагов (петли в диалогах). */
  limit?: number;
}

export interface PlayResult {
  character: string;
  event: number;
  steps: PlayStep[];
  /** Ждёт ответа игрока на последнем шаге. */
  waiting: boolean;
}

const EPS = 1e-9;

export const isChoiceRecord = (r: GameRecord | undefined): boolean => r !== undefined && CHOICE_SPEAKERS.has(r.ints.get('speaker') ?? 0);

/** Расклад игры при «как будто»: что проходит проверки и надбавка +2 за расу собеседника. */
export function playEnv(assume: ReadonlyMap<string, boolean> = new Map(), mode: PlayMode = 'met'): ChooseEnv {
  const passes = (sid: string, r: GameRecord): boolean => assume.get(sid) ?? (mode === 'met' ? !r.bools.get('locked') : alwaysPasses(r));
  return {
    passes,
    bonus: (sid, r) => ((r.refs.get('target race')?.length ?? 0) > 0 && passes(sid, r) ? 2 : 0),
  };
}

const kidsOf = (ctx: ModContext, sid: string): string[] => (ctx.get(sid)?.refs.get('lines') ?? []).map((r) => r.target);

/**
 * Выбор игры среди `ids` в раскладе `env`: варианты с причинами и выбранный (`prefer`, если у него
 * есть шанс, иначе самый вероятный; при равных — первый в порядке игры).
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
    // Пустой узел подходит, но внутри ничего не проходит — игра его пропускает (а не «перебита»).
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

/** Спуститься от выбранного пустого узла к реплике, которую игра скажет. */
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

/** Диалоги персонажа на событие (без повторов) с источниками. */
export function playStartList(ctx: ModContext, character: string, event = EVENT_TALK, squads?: SquadIndex): Map<string, TalkSource[]> {
  const c = ctx.get(character);
  if (!c) throw new Error(`нет записи ${character}`);
  if (itemTypeName(c.type) !== 'CHARACTER') throw new Error(`${character} — не персонаж (${itemTypeName(c.type)})`);
  const out = new Map<string, TalkSource[]>();
  for (const s of talkSources(ctx, c, event, squads ?? squadIndex(ctx))) {
    const had = out.get(s.dialog);
    if (had) had.push(s);
    else out.set(s.dialog, [s]);
  }
  return out;
}

/** Проиграть разговор с персонажем: по шагам, с ответами игрока `input.answers`. */
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
    // Ответ сказан; дальше — его продолжение.
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
