/**
 * Правка диалогов командами ядра: каждая операция — одна транзакция (одна отмена), id новых
 * записей выдаёт `allocateStringId` (постоянные: сохранения игроков не ломаются).
 *
 * Как игра хранит диалог (проверено по ванили):
 *  - DIALOGUE и DIALOGUE_LINE ссылаются на следующие реплики категорией `lines`;
 *  - реплика: `speaker` (TalkerEnum: 0 — говорящий NPC, 1/2 — игрок выбирает), тексты
 *    `text0..N` (случайная формулировка), `score bonus`, `chance temporary`, `repetition limit`;
 *  - условие — своя запись DIALOG_ACTION (`condition name`, `who`, `compare by`, `tag`), а
 *    сравниваемое значение — v0 ссылки `conditions`;
 *  - действие — DIALOG_ACTION с `action name`, значения — v0..v2 ссылки `effects`.
 *
 * Мод может всё: менять тексты, условия и очки ванильных реплик, убирать их и связи, добавлять
 * свои. Одно ограничение формата: ссылки нижних слоёв остаются на своих местах (в файл мода
 * попадает только разница), поэтому переставить ванильную реплику можно только заменив её
 * копией — см. `setLineOrder`. «Как в игре» возвращают `revertLine` и `revertLinks`.
 */
import { decodeText, encodeText } from '../text.ts';
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import { EditError, type ModContext } from '../model/context.ts';
import { isRemovalMarker, isRemovedRef } from '../model/record-ops.ts';

/** Категории ссылок на DIALOG_ACTION, которые принадлежат реплике. */
export const OWNED_ACTION_CATEGORIES = ['conditions', 'effects'] as const;
export type ActionCategory = (typeof OWNED_ACTION_CATEGORIES)[number];

const LINE = 'DIALOGUE_LINE';
const ACTION = 'DIALOG_ACTION';
const PARENT_TYPES: ReadonlySet<string> = new Set(['DIALOGUE', LINE]);

function typeOf(ctx: ModContext, sid: string): string | undefined {
  const r = ctx.get(sid);
  return r ? itemTypeName(r.type) : undefined;
}

function need(ctx: ModContext, sid: string, types: ReadonlySet<string>, what: string): GameRecord {
  const r = ctx.get(sid);
  if (!r) throw new EditError(`Нет записи ${sid}`);
  if (!types.has(itemTypeName(r.type))) throw new EditError(`${sid} — не ${what}`);
  return r;
}

/** Номер из строкового id (`123-Мой.mod` → 123) для имён в духе FCS: `DIALOGUE_LINE123`. */
function numberOf(sid: string): string {
  return /^(\d+)-/.exec(sid)?.[1] ?? '';
}

function createNamed(ctx: ModContext, type: string): string {
  const sid = ctx.allocateStringId();
  return ctx.createRecord(itemTypeId(type)!, `${type}${numberOf(sid)}`, { stringId: sid });
}

export interface NewLine {
  /** TalkerEnum: 0 — говорит NPC, 1 — собеседник (игрок выбирает), 2 — собеседник, если игрок. */
  speaker: number;
  text?: string;
}

/** Создать реплику (без родителя). */
export function createLine(ctx: ModContext, line: NewLine): string {
  return ctx.transaction('новая реплика', () => {
    const sid = createNamed(ctx, LINE);
    ctx.editRecord(sid, (d) => {
      d.floats.set('chance permanent', 100);
      d.floats.set('chance temporary', 100);
      d.ints.set('repetition limit', 0);
      d.ints.set('score bonus', 0);
      d.ints.set('speaker', line.speaker);
      d.ints.set('target is type', 0);
      d.strings.set('text0', encodeText(line.text ?? ''));
    });
    return sid;
  });
}

/** Новая реплика в конце ветки `parent` (диалог или реплика). Возвращает её id. */
export function addLine(ctx: ModContext, parent: string, line: NewLine): string {
  need(ctx, parent, PARENT_TYPES, 'диалог или реплика');
  return ctx.transaction('новая реплика', () => {
    const sid = createLine(ctx, line);
    ctx.addReference(parent, 'lines', sid, ctx.refDefaults(parent, 'lines'));
    return sid;
  });
}

/** Связана ли реплика `child` с `parent` (ссылка `lines`). */
export function isLinked(ctx: ModContext, parent: string, child: string): boolean {
  return ctx.get(parent)?.refs.get('lines')?.some((r) => r.target === child) ?? false;
}

/** Почему связь нельзя сделать (или undefined — можно). */
export function linkProblem(ctx: ModContext, parent: string, child: string): string | undefined {
  const pt = typeOf(ctx, parent);
  if (pt === undefined || !PARENT_TYPES.has(pt)) return 'вести дальше может только диалог или реплика';
  if (typeOf(ctx, child) !== LINE) return 'вести можно только на реплику';
  if (parent === child) return 'реплика не может вести сама на себя';
  if (isLinked(ctx, parent, child)) return 'эта связь уже есть';
  return undefined;
}

/** Связать: после `parent` может идти уже существующая реплика `child` (петля, общий ответ). */
export function linkLine(ctx: ModContext, parent: string, child: string): void {
  const p = linkProblem(ctx, parent, child);
  if (p !== undefined) throw new EditError(p);
  ctx.addReference(parent, 'lines', child, ctx.refDefaults(parent, 'lines'));
}

/** Убрать связь (сама реплика остаётся). */
export function unlinkLine(ctx: ModContext, parent: string, child: string): void {
  if (!isLinked(ctx, parent, child)) throw new EditError('такой связи нет');
  ctx.removeReference(parent, 'lines', child);
}

/** Порядок ссылок `lines` нижних слоёв: цель → место. */
function lowerOrder(ctx: ModContext, parent: string): Map<string, number> {
  const m = new Map<string, number>();
  (ctx.lower(parent)?.refs.get('lines') ?? []).forEach((r, i) => {
    if (!m.has(r.target)) m.set(r.target, i);
  });
  return m;
}

/**
 * Какие реплики из игры придётся заменить копиями, чтобы получить порядок `order`. Мод не может
 * передвинуть ссылку нижнего слоя: она остаётся на своём месте, добавленные встают после.
 * Поэтому ванильные реплики, которые после перестановки нарушают ванильный порядок или стоят после
 * добавленных, редактор заменяет копиями (у копии новый id; перевод игры привязан к старому id,
 * поэтому в русской игре копия покажется на языке оригинала).
 */
export function orderCopies(ctx: ModContext, parent: string, order: readonly string[]): string[] {
  const low = lowerOrder(ctx, parent);
  const out: string[] = [];
  let last = -1;
  let prefix = true;
  for (const t of order) {
    const i = low.get(t);
    if (prefix && i !== undefined && i > last) last = i;
    else {
      prefix = false;
      if (i !== undefined) out.push(t);
    }
  }
  return out;
}

/**
 * Задать порядок реплик ветки (перестановка тех же целей). Реплики из игры, которые иначе не
 * передвинуть, заменяются копиями (`orderCopies`). Возвращает замены: оригинал → копия.
 */
export function setLineOrder(ctx: ModContext, parent: string, order: readonly string[]): Map<string, string> {
  const list = ctx.get(parent)?.refs.get('lines') ?? [];
  const byTarget = new Map(list.map((r) => [r.target, r]));
  if (order.length !== list.length || new Set(order).size !== byTarget.size || order.some((t) => !byTarget.has(t))) throw new EditError('новый порядок должен содержать те же реплики');
  const copies = new Set(orderCopies(ctx, parent, order));
  const replaced = new Map<string, string>();
  ctx.transaction('порядок реплик', () => {
    const next = order.map((t) => {
      const r = byTarget.get(t)!;
      if (!copies.has(t)) return { ...r };
      const c = duplicateLine(ctx, t);
      replaced.set(t, c);
      return { ...r, target: c };
    });
    ctx.setReferences(parent, 'lines', next);
  });
  return replaced;
}

function swapped(ctx: ModContext, parent: string, child: string, dir: -1 | 1): string[] | undefined {
  const order = (ctx.get(parent)?.refs.get('lines') ?? []).map((r) => r.target);
  const i = order.indexOf(child);
  if (i < 0 || i + dir < 0 || i + dir >= order.length) return undefined;
  [order[i], order[i + dir]] = [order[i + dir]!, order[i]!];
  return order;
}

/** Можно ли сдвинуть реплику на место вверх (-1) или вниз (1). */
export function canMoveLine(ctx: ModContext, parent: string, child: string, dir: -1 | 1): boolean {
  return swapped(ctx, parent, child, dir) !== undefined;
}

/** Какие реплики из игры заменятся копиями при таком сдвиге (пусто — без копий). */
export function moveCopies(ctx: ModContext, parent: string, child: string, dir: -1 | 1): string[] {
  const order = swapped(ctx, parent, child, dir);
  return order ? orderCopies(ctx, parent, order) : [];
}

/** Сдвинуть реплику на место вверх (-1) или вниз (1). Возвращает замены копиями. */
export function moveLine(ctx: ModContext, parent: string, child: string, dir: -1 | 1): Map<string, string> {
  const order = swapped(ctx, parent, child, dir);
  if (!order) throw new EditError('дальше двигать некуда');
  return setLineOrder(ctx, parent, order);
}

/** Связи ветки как в игре (ссылки `lines` нижних слоёв); у новой записи — пусто. */
export function revertLinks(ctx: ModContext, parent: string): void {
  ctx.setReferences(parent, 'lines', ctx.lower(parent)?.refs.get('lines') ?? []);
}

/** Кто ведёт на запись: родители по `lines` и пакеты по `dialogs`. */
export function lineParents(ctx: ModContext, sid: string): string[] {
  return [...new Set(ctx.referencesTo(sid).filter((e) => e.category === 'lines' || e.category === 'dialogs').map((e) => e.source))];
}

/** Действия и условия реплики, на которые больше никто не ссылается. */
function ownedActions(ctx: ModContext, sid: string): string[] {
  const rec = ctx.get(sid);
  if (!rec) return [];
  const out: string[] = [];
  for (const cat of OWNED_ACTION_CATEGORIES)
    for (const r of rec.refs.get(cat) ?? []) {
      if (typeOf(ctx, r.target) !== ACTION) continue;
      if (ctx.referencesTo(r.target).every((e) => e.source === sid)) out.push(r.target);
    }
  return [...new Set(out)];
}

/**
 * Копия реплики со своими копиями условий и действий; следующие реплики общие. С `parent` —
 * копия встаёт в ту же ветку последней.
 */
export function duplicateLine(ctx: ModContext, sid: string, parent?: string): string {
  need(ctx, sid, new Set([LINE]), 'реплика');
  return ctx.transaction('копия реплики', () => {
    const copySid = ctx.allocateStringId();
    ctx.duplicateRecord(sid, { stringId: copySid, name: `${LINE}${numberOf(copySid)}` });
    for (const cat of OWNED_ACTION_CATEGORIES) {
      const refs = ctx.get(copySid)!.refs.get(cat);
      if (!refs?.length) continue;
      const next = refs.map((r) => {
        if (typeOf(ctx, r.target) !== ACTION) return { ...r };
        const a = ctx.allocateStringId();
        ctx.duplicateRecord(r.target, { stringId: a, name: `${ACTION}${numberOf(a)}` });
        return { ...r, target: a };
      });
      ctx.setReferences(copySid, cat, next);
    }
    if (parent !== undefined) linkLine(ctx, parent, copySid);
    return copySid;
  });
}

/**
 * Удалить реплику: ссылки на неё убираются, её собственные условия и действия — тоже.
 * Реплика из игры помечается удалённой (мод её убирает); `lineParents` — кого это заденет.
 */
export function deleteLine(ctx: ModContext, sid: string): void {
  need(ctx, sid, new Set([LINE]), 'реплика');
  ctx.transaction('удалить реплику', () => {
    const owned = ownedActions(ctx, sid);
    ctx.deleteRecord(sid, { removeReferences: true });
    for (const a of owned) if (ctx.referencesTo(a).length === 0 && ctx.status(a) === 'new') ctx.deleteRecord(a);
  });
}

/**
 * Вставить новую реплику между `parent` и `child` (вместо связи `parent → child`:
 * `parent → новая → child`). Одна отмена. Возвращает id новой реплики.
 */
export function insertLineBetween(ctx: ModContext, parent: string, child: string, line: NewLine): string {
  if (!isLinked(ctx, parent, child)) throw new EditError('такой связи нет');
  return ctx.transaction('вставить реплику', () => {
    const sid = addLine(ctx, parent, line);
    linkLine(ctx, sid, child);
    unlinkLine(ctx, parent, child);
    return sid;
  });
}

/** Связь `lines` в графе: от `parent` к `child`. */
export interface LineLink {
  parent: string;
  child: string;
}

/**
 * Удалить выделенное в графе одной отменой: связи (только `lines`) и реплики (`deleteLine`).
 * Связи, которые уйдут вместе с удаляемыми репликами, и уже удалённые реплики пропускаются.
 */
export function deleteGraphItems(ctx: ModContext, items: { lines?: readonly string[]; links?: readonly LineLink[] }): void {
  const lines = [...new Set(items.lines ?? [])].filter((s) => ctx.get(s) !== undefined);
  for (const s of lines) need(ctx, s, new Set([LINE]), 'реплика');
  const gone = new Set(lines);
  const links = (items.links ?? []).filter((l) => !gone.has(l.parent) && !gone.has(l.child) && isLinked(ctx, l.parent, l.child));
  if (lines.length === 0 && links.length === 0) return;
  ctx.transaction(lines.length === 1 && links.length === 0 ? 'удалить реплику' : 'удалить выделенное', () => {
    for (const l of links) if (isLinked(ctx, l.parent, l.child)) unlinkLine(ctx, l.parent, l.child);
    for (const s of lines) if (ctx.get(s) !== undefined) deleteLine(ctx, s);
  });
}

/** Копии реплик (каждая — в ветку своего `parent`) одной отменой; id копий по порядку. */
export function duplicateLines(ctx: ModContext, items: readonly { sid: string; parent?: string | undefined }[]): string[] {
  for (const i of items) need(ctx, i.sid, new Set([LINE]), 'реплика');
  return ctx.transaction(items.length === 1 ? 'копия реплики' : 'копии реплик', () => items.map((i) => duplicateLine(ctx, i.sid, i.parent)));
}

/** Тексты реплики `text0..N` (пустые в конце не считаются). */
export function lineTexts(rec: GameRecord): string[] {
  const out: string[] = [];
  for (let i = 0; rec.strings.has(`text${i}`); i++) out.push(decodeText(rec.strings.get(`text${i}`)!));
  while (out.length > 1 && out.at(-1) === '') out.pop();
  return out;
}

/**
 * Задать тексты (случайные формулировки). Лишние тексты новой записи убираются; у записи из игры
 * поле удалить нельзя — оно становится пустым (игра пустые не говорит).
 */
export function setLineTexts(ctx: ModContext, sid: string, texts: readonly string[]): void {
  const lower = ctx.lower(sid);
  ctx.editRecord(
    sid,
    (d) => {
      let n = 0;
      while (d.strings.has(`text${n}`)) n++;
      const list = texts.length ? texts : [''];
      for (let i = 0; i < Math.max(n, list.length); i++) {
        const k = `text${i}`;
        if (i < list.length) d.strings.set(k, encodeText(list[i]!));
        else if (lower?.strings.has(k)) d.strings.set(k, encodeText(''));
        else d.strings.delete(k);
      }
    },
    `${sid}: текст`,
  );
}

/** Условие: DIALOG_ACTION + значение в ссылке. */
export interface ConditionSpec {
  /** DialogConditionEnum. */
  cond: number;
  /** TalkerEnum: 0 — говорящий, 1 — собеседник, ... */
  who: number;
  /** ComparisonEnum: 0 =, 1 <, 2 >. */
  cmp: number;
  value: number;
  /** Для условий с тегом (черта характера, ...); -1 — нет. */
  tag?: number;
}

/** Действие: DialogActionEnum и значения ссылки. */
export interface EffectSpec {
  action: number;
  values?: readonly number[];
}

export function conditionOf(ctx: ModContext, ref: Reference): ConditionSpec | undefined {
  const a = ctx.get(ref.target);
  if (!a || itemTypeName(a.type) !== ACTION) return undefined;
  const cond = a.ints.get('condition name');
  if (cond === undefined) return undefined;
  const tag = a.ints.get('tag');
  return { cond, who: a.ints.get('who') ?? 0, cmp: a.ints.get('compare by') ?? 0, value: ref.v0, ...(tag !== undefined && tag !== -1 ? { tag } : {}) };
}

export function effectOf(ctx: ModContext, ref: Reference): EffectSpec | undefined {
  const a = ctx.get(ref.target);
  if (!a || itemTypeName(a.type) !== ACTION) return undefined;
  const action = a.ints.get('action name');
  if (action === undefined) return undefined;
  return { action, values: [ref.v0, ref.v1, ref.v2] };
}

const OWNER_TYPES: ReadonlySet<string> = new Set(['DIALOGUE', LINE]);

/** Добавить условие реплике или диалогу. Возвращает id записи условия. */
export function addCondition(ctx: ModContext, owner: string, spec: ConditionSpec): string {
  need(ctx, owner, OWNER_TYPES, 'диалог или реплика');
  return ctx.transaction('новое условие', () => {
    const a = createNamed(ctx, ACTION);
    ctx.editRecord(a, (d) => {
      d.ints.set('compare by', spec.cmp);
      d.ints.set('condition name', spec.cond);
      d.ints.set('tag', spec.tag ?? -1);
      d.ints.set('who', spec.who);
      d.strings.set('stringvar', encodeText(''));
    });
    ctx.addReference(owner, 'conditions', a, [spec.value, 0, 0]);
    return a;
  });
}

/** Добавить действие реплике. Возвращает id записи действия. */
export function addEffect(ctx: ModContext, owner: string, spec: EffectSpec): string {
  need(ctx, owner, new Set([LINE]), 'реплика');
  return ctx.transaction('новое действие', () => {
    const a = createNamed(ctx, ACTION);
    ctx.editRecord(a, (d) => {
      d.ints.set('action name', spec.action);
    });
    const v = spec.values ?? [];
    ctx.addReference(owner, 'effects', a, [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
    return a;
  });
}

/**
 * Запись условия/действия, которую можно править только у этого владельца: если на неё ссылается
 * кто-то ещё, ссылка владельца переводится на копию (чужие реплики не меняются).
 */
function ownAction(ctx: ModContext, owner: string, cat: ActionCategory, action: string): string {
  const others = ctx.referencesTo(action).some((e) => e.source !== owner);
  if (!others) return action;
  const ref = ctx.get(owner)?.refs.get(cat)?.find((r) => r.target === action);
  if (!ref) throw new EditError(`у ${owner} нет ${action} в ${cat}`);
  const copy = ctx.allocateStringId();
  ctx.duplicateRecord(action, { stringId: copy, name: `${ACTION}${numberOf(copy)}` });
  const list = ctx.get(owner)!.refs.get(cat)!.map((r) => (r.target === action ? { ...r, target: copy } : { ...r }));
  ctx.setReferences(owner, cat, list);
  return copy;
}

function refOf(ctx: ModContext, owner: string, cat: ActionCategory, action: string): Reference {
  const ref = ctx.get(owner)?.refs.get(cat)?.find((r) => r.target === action);
  if (!ref) throw new EditError(`у ${owner} нет ${action} в ${cat}`);
  return ref;
}

/** Поменять условие. Возвращает id записи условия (мог стать копией). */
export function updateCondition(ctx: ModContext, owner: string, action: string, patch: Partial<ConditionSpec>): string {
  return ctx.transaction('условие', () => {
    const a = ownAction(ctx, owner, 'conditions', action);
    if (patch.cond !== undefined || patch.who !== undefined || patch.cmp !== undefined || 'tag' in patch)
      ctx.editRecord(a, (d) => {
        if (patch.cond !== undefined) d.ints.set('condition name', patch.cond);
        if (patch.who !== undefined) d.ints.set('who', patch.who);
        if (patch.cmp !== undefined) d.ints.set('compare by', patch.cmp);
        if ('tag' in patch) d.ints.set('tag', patch.tag ?? -1);
      });
    if (patch.value !== undefined) {
      const r = refOf(ctx, owner, 'conditions', a);
      ctx.addReference(owner, 'conditions', a, [patch.value, r.v1, r.v2]);
    }
    return a;
  });
}

/** Поменять действие. Возвращает id записи действия (мог стать копией). */
export function updateEffect(ctx: ModContext, owner: string, action: string, patch: Partial<EffectSpec>): string {
  return ctx.transaction('действие', () => {
    const a = ownAction(ctx, owner, 'effects', action);
    if (patch.action !== undefined) {
      const v = patch.action;
      ctx.editRecord(a, (d) => {
        d.ints.set('action name', v);
      });
    }
    if (patch.values !== undefined) {
      const v = patch.values;
      ctx.addReference(owner, 'effects', a, [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
    }
    return a;
  });
}

/** Убрать условие или действие; запись DIALOG_ACTION удаляется, если больше никому не нужна. */
export function removeAction(ctx: ModContext, owner: string, cat: ActionCategory, action: string): void {
  refOf(ctx, owner, cat, action);
  ctx.transaction(cat === 'conditions' ? 'убрать условие' : 'убрать действие', () => {
    ctx.removeReference(owner, cat, action);
    if (ctx.referencesTo(action).length === 0 && ctx.status(action) === 'new') ctx.deleteRecord(action);
  });
}

/** Сколько раз значения условий и действий встречаются в данных (ваниль, зависимости, мод). */
export interface DialogEnumUsage {
  conditions: Map<number, number>;
  actions: Map<number, number>;
}

/**
 * Какие условия (`condition name`) и действия (`action name`) реально используются в данных —
 * редактор показывает их первыми, а неиспользуемые помечает: игра их, возможно, не обрабатывает.
 */
export function dialogEnumUsage(ctx: ModContext): DialogEnumUsage {
  const out: DialogEnumUsage = { conditions: new Map(), actions: new Map() };
  const action = itemTypeId(ACTION);
  for (const r of ctx.records()) {
    if (r.type !== action) continue;
    const c = r.ints.get('condition name');
    if (c !== undefined && c !== 0) out.conditions.set(c, (out.conditions.get(c) ?? 0) + 1);
    const a = r.ints.get('action name');
    if (a !== undefined && a !== 0) out.actions.set(a, (out.actions.get(a) ?? 0) + 1);
  }
  return out;
}

/**
 * Вернуть реплику как в игре: убрать все правки мода (тексты, условия, связи дальше). Удалённую
 * модом — восстановить вместе со ссылками на неё, которые мод убрал у родителей (они встают на
 * свои места из игры). У новой записи «как в игре» нет — ошибка.
 */
export function revertLine(ctx: ModContext, sid: string): void {
  const st = ctx.status(sid);
  if (st === 'new' || st === undefined) throw new EditError('этой реплики нет в игре — возвращать не к чему');
  if (st === 'base') return;
  const mine = OWNED_ACTION_CATEGORIES.flatMap((c) => (ctx.get(sid)?.refs.get(c) ?? []).map((r) => r.target));
  ctx.transaction('как в игре', () => {
    if (st === 'deleted') {
      ctx.restoreRecord(sid);
      for (const d of ctx.modRecords()) {
        if (isRemovalMarker(d)) continue;
        for (const cat of ['lines', 'dialogs'])
          if ((d.refs.get(cat) ?? []).some((r) => r.target === sid && isRemovedRef(r))) {
            const lo = ctx.lower(d.stringId)?.refs.get(cat)?.find((r) => r.target === sid);
            if (lo) ctx.addReference(d.stringId, cat, sid, [lo.v0, lo.v1, lo.v2]);
          }
      }
    } else ctx.revertRecord(sid);
    // Условия и действия, которые мод добавил этой реплике и на которые больше никто не ссылается.
    for (const a of new Set(mine)) if (typeOf(ctx, a) === ACTION && ctx.status(a) === 'new' && ctx.referencesTo(a).length === 0) ctx.deleteRecord(a);
  });
}

/** Отличаются ли связи ветки от игры (убраны, добавлены, переставлены, другие значения). */
export function linksChanged(ctx: ModContext, parent: string): boolean {
  const a = ctx.get(parent)?.refs.get('lines') ?? [];
  const b = ctx.lower(parent)?.refs.get('lines') ?? [];
  return a.length !== b.length || a.some((r, i) => r.target !== b[i]!.target || r.v0 !== b[i]!.v0 || r.v1 !== b[i]!.v1 || r.v2 !== b[i]!.v2);
}

/** Реплики из игры, которые мод убрал из ветки (ссылки нижних слоёв, которых больше нет). */
export function removedLinks(ctx: ModContext, parent: string): string[] {
  const now = new Set((ctx.get(parent)?.refs.get('lines') ?? []).map((r) => r.target));
  return (ctx.lower(parent)?.refs.get('lines') ?? []).map((r) => r.target).filter((t) => !now.has(t));
}
