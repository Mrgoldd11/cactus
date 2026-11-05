/**
 * Как игра выбирает диалог и реплику: по коду Kenshi 1.0.65 (Steam). Разобрано по exe:
 * `DialogLineData` (конструктор, `getScore`, `checkConditions`), `DialogChoiceList::add`,
 * `Dialogue::_chooseDialog`.
 *
 * 1. Очки записи считаются один раз, при загрузке: `score bonus` плюс надбавки за условия и
 *    поля ({@link dialogueScore}). Во время игры `getScore` добавляет ещё +2, если раса
 *    собеседника есть в `target race`.
 * 2. Список (диалоги события или реплики под узлом) отсортирован по убыванию ключа
 *    `очки + max(0, лучшие очки прямых реплик)`; при равных ключах порядок добавления.
 * 3. Игра идёт по списку один раз. Реплика с текстом, у которой очков меньше лучшего, обрывает
 *    проход. Запись, не прошедшая проверки (условия, шанс, нет говорящего), пропускается.
 *    Пустой узел (диалог, реплика без текста, узел вмешательства) выбирает реплику среди своих
 *    детей тем же способом; его итог — его очки плюс очки выбранной реплики.
 * 4. Запись попадает в розыгрыш, если её очки (итог) не меньше лучшего на этот момент; лучшее
 *    становится равным им. Попавшие раньше не выбывают.
 * 5. Из розыгрыша — случайно и поровну. Очки не дают «больше шансов».
 */
import type { GameRecord } from '../format/types.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { ModContext } from './context.ts';

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

/** Есть ли у реплики или диалога хоть одно условие (ссылки-условия, `target is type`, ограничение повтора). */
export function hasConditions(rec: GameRecord): boolean {
  if ((rec.ints.get('target is type') ?? 0) !== 0 || (rec.ints.get('repetition limit') ?? 0) !== 0) return true;
  return DIALOGUE_CONDITION_CATEGORIES.some((c) => (rec.refs.get(c)?.length ?? 0) > 0);
}

/** DialogConditionEnum.DC_HAS_TAG — за такое условие игра даёт ещё +1. */
const DC_HAS_TAG = 23;
/** Начальное «лучшее» в `_chooseDialog`: записи с очками ниже не выбираются никогда. */
export const CHOOSE_MIN_SCORE = -999;
/** Говорящие, которые в разговоре по клику есть всегда: я, собеседник, собеседник-игрок. */
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
  /** Сколько раз (условий, состояний мира). */
  count?: number;
}

export interface DialogueScore {
  total: number;
  parts: ScorePart[];
}

export const SCORE_PART_LABELS: Readonly<Record<ScorePartKey, string>> = {
  bonus: 'score bonus',
  conditions: 'условия',
  tag: 'условие «метка»',
  locked: 'locked',
  town: 'в городе фракции',
  'my-faction': 'моя фракция',
  'target-faction': 'фракция собеседника',
  'item-type': 'у собеседника предмет такого типа',
  item: 'у собеседника предмет',
  'world-state': 'состояние мира',
  race: 'раса собеседника',
  unique: 'unique',
  'chance-permanent': 'постоянный шанс ниже 99%',
  'target-type': 'тип собеседника',
  speaker: 'говорит не «я»',
  interjector: 'говорит вмешавшийся или весь отряд',
  interjection: 'узел вмешательства',
  'race-match': 'раса собеседника совпала (в игре)',
};

const count = (rec: GameRecord, cat: string): number => rec.refs.get(cat)?.length ?? 0;

/** Очки записи DIALOGUE / DIALOGUE_LINE так, как их считает игра при загрузке, с разбивкой. */
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

/** Разбивка очков текстом: «score bonus 5, условия ×2 +2, …». */
export function formatScoreParts(parts: readonly ScorePart[]): string {
  return parts.map((p) => (p.key === 'bonus' ? `score bonus ${String(p.value)}` : `${SCORE_PART_LABELS[p.key]}${p.count !== undefined ? ` ×${String(p.count)}` : ''} ${p.value > 0 ? '+' : ''}${String(p.value)}`)).join(', ');
}

/**
 * Запись проходит проверки игры при любом раскладе: без условий, без шанса ниже 99%, не
 * заблокирована, не `unique`, не узел вмешательства, говорит я или собеседник.
 */
export function alwaysPasses(rec: GameRecord): boolean {
  if (hasConditions(rec) || rec.bools.get('locked') || rec.bools.get('unique') || rec.bools.get('interjection')) return false;
  if ((rec.floats.get('chance temporary') ?? 100) < 99 || (rec.floats.get('chance permanent') ?? 100) < 99) return false;
  return SURE_SPEAKERS.has(rec.ints.get('speaker') ?? 0);
}

/** Пустой узел: игра не говорит его, а выбирает реплику среди его детей. */
export function isEmptyNode(rec: GameRecord): boolean {
  if (itemTypeName(rec.type) === 'DIALOGUE' || rec.bools.get('interjection')) return true;
  for (const [k, v] of rec.strings) if (/^text\d+$/.test(k) && v.length > 0) return false;
  return true;
}

export interface ChooseEnv {
  /** Пройдёт ли запись проверки игры в этом раскладе. */
  passes(sid: string, rec: GameRecord): boolean;
  /** Надбавка во время игры (+2, если раса собеседника есть в `target race`). */
  bonus?(sid: string, rec: GameRecord): number;
}

export interface ChooseResult {
  /** Вероятность, что выбор пришёл через этот элемент списка (0..1). */
  odds: Map<string, number>;
  /** Вероятность, что не выбрано ничего. */
  none: number;
}

interface Outcome {
  top: string;
  /** Очки выбранной реплики (её собственные) — их родитель прибавляет к своим. */
  leaf: number;
  p: number;
}

interface Dist {
  items: Outcome[];
  none: number;
}

/** Порядок списка, как у игры: по убыванию `очки + max(0, лучшие очки детей)`, при равных — как добавлены. */
export function chooseOrder(ctx: ModContext, list: readonly string[], scoreOf: (rec: GameRecord) => number = (r) => dialogueScore(ctx, r).total): string[] {
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
  return keyed.sort((a, b) => b.key - a.key || a.i - b.i).map((k) => k.sid);
}

/** Предел ветвлений: дальше берётся только самый вероятный исход пустого узла. */
const MAX_STEPS = 20000;

/**
 * Шансы выбора по правилу игры для списка `list` (диалоги события или реплики под узлом)
 * при раскладе `env`: какие записи проходят проверки. Повторяющиеся id считаются одним.
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

/** Записи под узлом (по `lines`), рекурсивно, с самим узлом. */
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
