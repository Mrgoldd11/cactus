/**
 * Dialogue editing via core commands: each operation is one transaction (one undo), ids of new
 * records come from `allocateStringId` (stable: player saves do not break).
 *
 * How the game stores a dialogue (checked against vanilla):
 *  - DIALOGUE and DIALOGUE_LINE reference the next lines with the `lines` category;
 *  - line: `speaker` (TalkerEnum: 0 = the NPC speaker, 1/2 = the player chooses), texts
 *    `text0..N` (random wording), `score bonus`, `chance temporary`, `repetition limit`;
 *  - a condition is its own DIALOG_ACTION record (`condition name`, `who`, `compare by`, `tag`), and
 *    the compared value is v0 of the `conditions` reference;
 *  - an effect is a DIALOG_ACTION with `action name`, the values are v0..v2 of the `effects` reference.
 *
 * A mod can do anything: change texts, conditions and scores of vanilla lines, remove them and links,
 * add its own. One format limitation: references of lower layers stay in place (only the difference
 * goes into the mod file), so a vanilla line can be reordered only by replacing it with a
 * copy (see `setLineOrder`). "As in game" is restored by `revertLine` and `revertLinks`.
 */
import { decodeText, encodeText } from '../text.ts';
import { uiText, type UiText } from '../ui-text.ts';
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import { EditError, type ModContext } from '../model/context.ts';
import { isRemovalMarker, isRemovedRef } from '../model/record-ops.ts';
import { LINE_REF_HELP } from '../schema/line-ref-help.ts';
import type { PhraseSource } from '../schema/dialog-help.ts';

/** Reference categories to DIALOG_ACTION that belong to a line. */
export const OWNED_ACTION_CATEGORIES = ['conditions', 'effects'] as const;
export type ActionCategory = (typeof OWNED_ACTION_CATEGORIES)[number];

const LINE = 'DIALOGUE_LINE';
const ACTION = 'DIALOG_ACTION';
const PARENT_TYPES: ReadonlySet<string> = new Set(['DIALOGUE', LINE]);
const DIALOGUE_OR_LINE: UiText = { en: 'dialogue or line', ru: 'диалог или реплика', zh: '对话或台词' };
const A_LINE: UiText = { en: 'line', ru: 'реплика', zh: '台词' };

function typeOf(ctx: ModContext, sid: string): string | undefined {
  const r = ctx.get(sid);
  return r ? itemTypeName(r.type) : undefined;
}

function need(ctx: ModContext, sid: string, types: ReadonlySet<string>, what: UiText): GameRecord {
  const r = ctx.get(sid);
  if (!r) throw new EditError({ en: `No record ${sid}`, ru: `Нет записи ${sid}`, zh: `没有记录 ${sid}` });
  if (!types.has(itemTypeName(r.type))) throw new EditError({ en: `${sid} is not a ${what.en}`, ru: `${sid} — не ${uiText(what, 'ru')}`, zh: `${sid} 不是${uiText(what, 'zh')}` });
  return r;
}

/** Number from a string id (`123-My.mod` → 123) for FCS-style names: `DIALOGUE_LINE123`. */
function numberOf(sid: string): string {
  return /^(\d+)-/.exec(sid)?.[1] ?? '';
}

function createNamed(ctx: ModContext, type: string): string {
  const sid = ctx.allocateStringId();
  return ctx.createRecord(itemTypeId(type)!, `${type}${numberOf(sid)}`, { stringId: sid });
}

export interface NewLine {
  /** TalkerEnum: 0 = the NPC speaks, 1 = the target (the player chooses), 2 = the target, if it is the player. */
  speaker: number;
  text?: string;
}

/** Create a line (without a parent). */
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

/** New line at the end of the `parent` branch (dialogue or line). Returns its id. */
export function addLine(ctx: ModContext, parent: string, line: NewLine): string {
  need(ctx, parent, PARENT_TYPES, DIALOGUE_OR_LINE);
  return ctx.transaction('новая реплика', () => {
    const sid = createLine(ctx, line);
    ctx.addReference(parent, 'lines', sid, ctx.refDefaults(parent, 'lines'));
    return sid;
  });
}

/** Is line `child` linked to `parent` (`lines` reference). */
export function isLinked(ctx: ModContext, parent: string, child: string): boolean {
  return ctx.get(parent)?.refs.get('lines')?.some((r) => r.target === child) ?? false;
}

/** Why the link cannot be made (or undefined if it can). */
export function linkProblem(ctx: ModContext, parent: string, child: string): UiText | undefined {
  const pt = typeOf(ctx, parent);
  if (pt === undefined || !PARENT_TYPES.has(pt)) return { en: 'only a dialogue or a line can lead on', ru: 'вести дальше может только диалог или реплика', zh: '只有对话或台词可以继续连接' };
  if (typeOf(ctx, child) !== LINE) return { en: 'a link can only lead to a line', ru: 'вести можно только на реплику', zh: '只能连接到台词' };
  if (parent === child) return { en: 'a line cannot lead to itself', ru: 'реплика не может вести сама на себя', zh: '台词不能连接到自身' };
  if (isLinked(ctx, parent, child)) return { en: 'this link already exists', ru: 'эта связь уже есть', zh: '该连接已存在' };
  return undefined;
}

/** Link: an existing line `child` may follow `parent` (a loop, a shared answer). */
export function linkLine(ctx: ModContext, parent: string, child: string): void {
  const p = linkProblem(ctx, parent, child);
  if (p !== undefined) throw new EditError(p);
  ctx.addReference(parent, 'lines', child, ctx.refDefaults(parent, 'lines'));
}

/** Remove the link (the line itself stays). */
export function unlinkLine(ctx: ModContext, parent: string, child: string): void {
  if (!isLinked(ctx, parent, child)) throw new EditError({ en: 'there is no such link', ru: 'такой связи нет', zh: '没有这个连接' });
  ctx.removeReference(parent, 'lines', child);
}

/** Order of lower-layer `lines` references: target → position. */
function lowerOrder(ctx: ModContext, parent: string): Map<string, number> {
  const m = new Map<string, number>();
  (ctx.lower(parent)?.refs.get('lines') ?? []).forEach((r, i) => {
    if (!m.has(r.target)) m.set(r.target, i);
  });
  return m;
}

/**
 * Which game lines have to be replaced with copies to get the order `order`. A mod cannot
 * move a lower-layer reference: it stays in place, added ones go after it.
 * So vanilla lines that after reordering break the vanilla order or stand after
 * added ones are replaced by the editor with copies (a copy has a new id; the game translation is bound
 * to the old id, so in the Russian game the copy shows in the original language).
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
 * Set the order of a branch's lines (a permutation of the same targets). Game lines that cannot be
 * moved otherwise are replaced with copies (`orderCopies`). Returns the replacements: original → copy.
 */
export function setLineOrder(ctx: ModContext, parent: string, order: readonly string[]): Map<string, string> {
  const list = ctx.get(parent)?.refs.get('lines') ?? [];
  const byTarget = new Map(list.map((r) => [r.target, r]));
  if (order.length !== list.length || new Set(order).size !== byTarget.size || order.some((t) => !byTarget.has(t))) throw new EditError({ en: 'the new order must contain the same lines', ru: 'новый порядок должен содержать те же реплики', zh: '新顺序必须包含相同的台词' });
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

/** Can the line be moved one place up (-1) or down (1). */
export function canMoveLine(ctx: ModContext, parent: string, child: string, dir: -1 | 1): boolean {
  return swapped(ctx, parent, child, dir) !== undefined;
}

/** Which game lines get replaced with copies by such a move (empty = no copies). */
export function moveCopies(ctx: ModContext, parent: string, child: string, dir: -1 | 1): string[] {
  const order = swapped(ctx, parent, child, dir);
  return order ? orderCopies(ctx, parent, order) : [];
}

/** Move the line one place up (-1) or down (1). Returns the copy replacements. */
export function moveLine(ctx: ModContext, parent: string, child: string, dir: -1 | 1): Map<string, string> {
  const order = swapped(ctx, parent, child, dir);
  if (!order) throw new EditError({ en: 'cannot move any further', ru: 'дальше двигать некуда', zh: '无法再移动' });
  return setLineOrder(ctx, parent, order);
}

/** Branch links as in the game (lower-layer `lines` references); empty for a new record. */
export function revertLinks(ctx: ModContext, parent: string): void {
  ctx.setReferences(parent, 'lines', ctx.lower(parent)?.refs.get('lines') ?? []);
}

/** Who leads to the record: parents via `lines` and packages via `dialogs`. */
export function lineParents(ctx: ModContext, sid: string): string[] {
  return [...new Set(ctx.referencesTo(sid).filter((e) => e.category === 'lines' || e.category === 'dialogs').map((e) => e.source))];
}

/** Effects and conditions of the line that nothing else references any more. */
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
 * Copy of a line with its own copies of conditions and effects; the next lines are shared. With `parent`,
 * the copy goes last into the same branch.
 */
export function duplicateLine(ctx: ModContext, sid: string, parent?: string): string {
  need(ctx, sid, new Set([LINE]), A_LINE);
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
 * Delete a line: references to it are removed, and so are its own conditions and effects.
 * A game line is marked deleted (the mod removes it); `lineParents` tells who is affected.
 */
export function deleteLine(ctx: ModContext, sid: string): void {
  need(ctx, sid, new Set([LINE]), A_LINE);
  ctx.transaction('удалить реплику', () => {
    const owned = ownedActions(ctx, sid);
    ctx.deleteRecord(sid, { removeReferences: true });
    for (const a of owned) if (ctx.referencesTo(a).length === 0 && ctx.status(a) === 'new') ctx.deleteRecord(a);
  });
}

/**
 * Insert a new line between `parent` and `child` (instead of the link `parent → child`:
 * `parent → new → child`). One undo. Returns the id of the new line.
 */
export function insertLineBetween(ctx: ModContext, parent: string, child: string, line: NewLine): string {
  if (!isLinked(ctx, parent, child)) throw new EditError({ en: 'there is no such link', ru: 'такой связи нет', zh: '没有这个连接' });
  return ctx.transaction('вставить реплику', () => {
    const sid = addLine(ctx, parent, line);
    linkLine(ctx, sid, child);
    unlinkLine(ctx, parent, child);
    return sid;
  });
}

/** A `lines` link in the graph: from `parent` to `child`. */
export interface LineLink {
  parent: string;
  child: string;
}

/**
 * Delete the graph selection with one undo: links (`lines` only) and lines (`deleteLine`).
 * Links that go away together with deleted lines, and lines already deleted, are skipped.
 */
export function deleteGraphItems(ctx: ModContext, items: { lines?: readonly string[]; links?: readonly LineLink[] }): void {
  const lines = [...new Set(items.lines ?? [])].filter((s) => ctx.get(s) !== undefined);
  for (const s of lines) need(ctx, s, new Set([LINE]), A_LINE);
  const gone = new Set(lines);
  const links = (items.links ?? []).filter((l) => !gone.has(l.parent) && !gone.has(l.child) && isLinked(ctx, l.parent, l.child));
  if (lines.length === 0 && links.length === 0) return;
  ctx.transaction(lines.length === 1 && links.length === 0 ? 'удалить реплику' : 'удалить выделенное', () => {
    for (const l of links) if (isLinked(ctx, l.parent, l.child)) unlinkLine(ctx, l.parent, l.child);
    for (const s of lines) if (ctx.get(s) !== undefined) deleteLine(ctx, s);
  });
}

/** Copies of lines (each into the branch of its `parent`) with one undo; copy ids in order. */
export function duplicateLines(ctx: ModContext, items: readonly { sid: string; parent?: string | undefined }[]): string[] {
  for (const i of items) need(ctx, i.sid, new Set([LINE]), A_LINE);
  return ctx.transaction(items.length === 1 ? 'копия реплики' : 'копии реплик', () => items.map((i) => duplicateLine(ctx, i.sid, i.parent)));
}

/** Line texts `text0..N` (trailing empty ones do not count). */
export function lineTexts(rec: GameRecord): string[] {
  const out: string[] = [];
  for (let i = 0; rec.strings.has(`text${i}`); i++) out.push(decodeText(rec.strings.get(`text${i}`)!));
  while (out.length > 1 && out.at(-1) === '') out.pop();
  return out;
}

/**
 * Set the texts (random wordings). Extra texts of a new record are removed; a game record's
 * field cannot be deleted, so it becomes empty (the game does not say empty ones).
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

/** Condition: DIALOG_ACTION + value in the reference. */
export interface ConditionSpec {
  /** DialogConditionEnum. */
  cond: number;
  /** TalkerEnum: 0 = speaker, 1 = target, ... */
  who: number;
  /** ComparisonEnum: 0 =, 1 <, 2 >. */
  cmp: number;
  value: number;
  /** For conditions with a tag (character trait, ...); -1 = none. */
  tag?: number;
}

/** Effect: DialogActionEnum and the reference values. */
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

/** Add a condition to a line or dialogue. Returns the id of the condition record. */
export function addCondition(ctx: ModContext, owner: string, spec: ConditionSpec): string {
  need(ctx, owner, OWNER_TYPES, DIALOGUE_OR_LINE);
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

/** Add an effect to a line. Returns the id of the effect record. */
export function addEffect(ctx: ModContext, owner: string, spec: EffectSpec): string {
  need(ctx, owner, new Set([LINE]), A_LINE);
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
 * A condition/effect record that may be edited only for this owner: if someone else references it,
 * the owner's reference is switched to a copy (other lines do not change).
 */
function ownAction(ctx: ModContext, owner: string, cat: ActionCategory, action: string): string {
  const others = ctx.referencesTo(action).some((e) => e.source !== owner);
  if (!others) return action;
  const ref = ctx.get(owner)?.refs.get(cat)?.find((r) => r.target === action);
  if (!ref) throw new EditError({ en: `${owner} has no ${action} in ${cat}`, ru: `у ${owner} нет ${action} в ${cat}`, zh: `${owner} 的 ${cat} 中没有 ${action}` });
  const copy = ctx.allocateStringId();
  ctx.duplicateRecord(action, { stringId: copy, name: `${ACTION}${numberOf(copy)}` });
  const list = ctx.get(owner)!.refs.get(cat)!.map((r) => (r.target === action ? { ...r, target: copy } : { ...r }));
  ctx.setReferences(owner, cat, list);
  return copy;
}

function refOf(ctx: ModContext, owner: string, cat: ActionCategory, action: string): Reference {
  const ref = ctx.get(owner)?.refs.get(cat)?.find((r) => r.target === action);
  if (!ref) throw new EditError({ en: `${owner} has no ${action} in ${cat}`, ru: `у ${owner} нет ${action} в ${cat}`, zh: `${owner} 的 ${cat} 中没有 ${action}` });
  return ref;
}

/** Change a condition. Returns the id of the condition record (may have become a copy). */
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

/** Change an effect. Returns the id of the effect record (may have become a copy). */
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

/** Remove a condition or effect; the DIALOG_ACTION record is deleted if nobody else needs it. */
export function removeAction(ctx: ModContext, owner: string, cat: ActionCategory, action: string): void {
  refOf(ctx, owner, cat, action);
  ctx.transaction(cat === 'conditions' ? 'убрать условие' : 'убрать действие', () => {
    ctx.removeReference(owner, cat, action);
    if (ctx.referencesTo(action).length === 0 && ctx.status(action) === 'new') ctx.deleteRecord(action);
  });
}

/**
 * Add a reference condition or effect to a line or dialogue: a reference category of the schema that
 * is a condition or effect by itself (`my race` → RACE, `target has item` → ITEM, `give item`,
 * `unlocks` → DIALOGUE…). The target must be of the type the schema requires. Values default to the
 * schema ones; an existing reference to the same target gets the new values. One undo step.
 */
export function addLineRef(ctx: ModContext, owner: string, category: string, target: string, values?: readonly number[]): void {
  const o = need(ctx, owner, OWNER_TYPES, DIALOGUE_OR_LINE);
  const ownerType = ctx.typeName(o.type);
  const def = ctx.schema?.types.get(ownerType)?.fields.get(category);
  if (!def || def.kind !== 'reference' || category === 'lines' || (OWNED_ACTION_CATEGORIES as readonly string[]).includes(category))
    throw new EditError({ en: `${ownerType} has no reference condition or effect «${category}»`, ru: `у ${ownerType} нет ссылочного условия или эффекта «${category}»`, zh: `${ownerType} 没有引用条件或效果「${category}」` });
  const t = ctx.get(target);
  if (!t) throw new EditError({ en: `No record ${target}`, ru: `Нет записи ${target}`, zh: `没有记录 ${target}` });
  const tt = ctx.typeName(t.type);
  if (def.targetType !== undefined && tt !== def.targetType)
    throw new EditError({ en: `«${category}» needs ${def.targetType}, not ${tt}`, ru: `«${category}» ждёт ${def.targetType}, а не ${tt}`, zh: `「${category}」需要 ${def.targetType}，而不是 ${tt}` });
  const effect = LINE_REF_HELP[category]?.kind === 'effect';
  ctx.transaction(effect ? 'новое действие' : 'новое условие', () => {
    ctx.addReference(owner, category, target, values ?? ctx.refDefaults(owner, category));
  });
}

/** Remove one target from a reference condition or effect of a line or dialogue. One undo step. */
export function removeLineRef(ctx: ModContext, owner: string, category: string, target: string): void {
  need(ctx, owner, OWNER_TYPES, DIALOGUE_OR_LINE);
  const effect = LINE_REF_HELP[category]?.kind === 'effect';
  ctx.transaction(effect ? 'убрать действие' : 'убрать условие', () => {
    ctx.removeReference(owner, category, target);
  });
}

/** Remove a whole reference condition or effect (all targets of `category`) of a line or dialogue. One undo step. */
export function clearLineRef(ctx: ModContext, owner: string, category: string): void {
  const o = need(ctx, owner, OWNER_TYPES, DIALOGUE_OR_LINE);
  const targets = [...new Set((o.refs.get(category) ?? []).map((r) => r.target))];
  if (targets.length === 0) return;
  const effect = LINE_REF_HELP[category]?.kind === 'effect';
  ctx.transaction(effect ? 'убрать действие' : 'убрать условие', () => {
    for (const t of targets) ctx.removeReference(owner, category, t);
  });
}

/** Remove what a graph phrase shows (its `source`): one DIALOG_ACTION or a whole reference category. One undo step. */
export function removePhrase(ctx: ModContext, owner: string, source: PhraseSource): void {
  if (source.target !== undefined && (source.category === 'conditions' || source.category === 'effects')) removeAction(ctx, owner, source.category, source.target);
  else clearLineRef(ctx, owner, source.category);
}

/** Change the value (v0) of one target of a reference condition or effect, keeping v1/v2. One undo step. */
export function setLineRefValue(ctx: ModContext, owner: string, category: string, target: string, value: number): void {
  const o = need(ctx, owner, OWNER_TYPES, DIALOGUE_OR_LINE);
  const ref = o.refs.get(category)?.find((r) => r.target === target);
  if (!ref) throw new EditError({ en: `${owner} has no ${category} → ${target}`, ru: `у ${owner} нет ${category} → ${target}`, zh: `${owner} 没有 ${category} → ${target}` });
  const effect = LINE_REF_HELP[category]?.kind === 'effect';
  ctx.transaction(effect ? 'действие' : 'условие', () => {
    ctx.addReference(owner, category, target, [value, ref.v1, ref.v2]);
  });
}

/** How often values of conditions and effects occur in the data (vanilla, dependencies, mod). */
export interface DialogEnumUsage {
  conditions: Map<number, number>;
  actions: Map<number, number>;
}

/**
 * Which conditions (`condition name`) and effects (`action name`) are actually used in the data:
 * the editor shows them first and marks unused ones (the game possibly does not handle them).
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
 * Return a line to its game state: drop all mod edits (texts, conditions, links onward). One deleted
 * by the mod is restored together with the references to it that the mod removed from parents (they go back to
 * their game places). A new record has no "as in game" state, so this is an error.
 */
export function revertLine(ctx: ModContext, sid: string): void {
  const st = ctx.status(sid);
  if (st === 'new' || st === undefined) throw new EditError({ en: 'this line is not in the game — nothing to revert to', ru: 'этой реплики нет в игре — возвращать не к чему', zh: '游戏中没有这条台词——无可恢复' });
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
    // Conditions and effects that the mod added to this line and that nothing else references.
    for (const a of new Set(mine)) if (typeOf(ctx, a) === ACTION && ctx.status(a) === 'new' && ctx.referencesTo(a).length === 0) ctx.deleteRecord(a);
  });
}

/** Do the branch links differ from the game (removed, added, reordered, other values). */
export function linksChanged(ctx: ModContext, parent: string): boolean {
  const a = ctx.get(parent)?.refs.get('lines') ?? [];
  const b = ctx.lower(parent)?.refs.get('lines') ?? [];
  return a.length !== b.length || a.some((r, i) => r.target !== b[i]!.target || r.v0 !== b[i]!.v0 || r.v1 !== b[i]!.v1 || r.v2 !== b[i]!.v2);
}

/** Game lines that the mod removed from the branch (lower-layer references that are gone). */
export function removedLinks(ctx: ModContext, parent: string): string[] {
  const now = new Set((ctx.get(parent)?.refs.get('lines') ?? []).map((r) => r.target));
  return (ctx.lower(parent)?.refs.get('lines') ?? []).map((r) => r.target).filter((t) => !now.has(t));
}
