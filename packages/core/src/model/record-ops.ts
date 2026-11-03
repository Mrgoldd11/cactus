/**
 * Операции над записями как над слоями: наложить изменения мода на запись нижних слоёв
 * и, наоборот, получить изменения мода как разницу «итог минус нижние слои».
 *
 * Правила наложения (как в игре и FCS):
 * - запись с булевым `REMOVED = true` удаляет запись;
 * - имя берётся из последнего слоя, скалярные поля заменяются по ключу (новые ключи — в конец);
 * - ссылка со значениями `2147483647 ×3` удаляет ссылку на ту же цель в категории;
 * - ссылка на цель, которая уже есть в категории, заменяет её значения на месте, иначе добавляется в конец;
 * - размещённые объекты (instances) заменяются по ключу.
 */
import { bytesEqual } from '../text.ts';
import { emptyRecord, type GameRecord, type Instance, type Reference, type Vec3, type Vec4 } from '../format/types.ts';

/** Значение v0/v1/v2 «удалённой» ссылки. */
export const REMOVED_REF_VALUE = 2147483647;
/** Булево поле — признак удалённой записи. */
export const REMOVED_FIELD = 'REMOVED';

export type ScalarDict = 'bools' | 'floats' | 'ints' | 'vec3s' | 'vec4s' | 'strings' | 'files';
export const SCALAR_DICTS: readonly ScalarDict[] = ['bools', 'floats', 'ints', 'vec3s', 'vec4s', 'strings', 'files'];

export interface ScalarValueMap {
  bools: boolean;
  floats: number;
  ints: number;
  vec3s: Vec3;
  vec4s: Vec4;
  strings: Uint8Array;
  files: Uint8Array;
}
export type ScalarValue = ScalarValueMap[ScalarDict];

export function isRemovedRef(ref: Reference): boolean {
  return ref.v0 === REMOVED_REF_VALUE && ref.v1 === REMOVED_REF_VALUE && ref.v2 === REMOVED_REF_VALUE;
}

export function removedRef(target: string): Reference {
  return { target, v0: REMOVED_REF_VALUE, v1: REMOVED_REF_VALUE, v2: REMOVED_REF_VALUE };
}

export function isRemovalMarker(rec: GameRecord): boolean {
  return rec.bools.get(REMOVED_FIELD) === true;
}

/** Запись-маркер «удалить запись нижних слоёв». */
export function removalMarker(lower: GameRecord): GameRecord {
  const rec = emptyRecord(lower.type, lower.stringId, lower.name);
  rec.bools.set(REMOVED_FIELD, true);
  return rec;
}

function cloneInstance(i: Instance): Instance {
  return { target: i.target, position: [...i.position], rotation: [...i.rotation], states: [...i.states] };
}

/** Глубокая копия записи (байтовые значения не копируются: по соглашению их не изменяют). */
export function cloneRecord(rec: GameRecord): GameRecord {
  const out: GameRecord = {
    lead: rec.lead,
    type: rec.type,
    id: rec.id,
    name: rec.name,
    stringId: rec.stringId,
    changeFlags: rec.changeFlags,
    bools: new Map(rec.bools),
    floats: new Map(rec.floats),
    ints: new Map(rec.ints),
    vec3s: new Map([...rec.vec3s].map(([k, v]) => [k, [...v]])),
    vec4s: new Map([...rec.vec4s].map(([k, v]) => [k, [...v]])),
    strings: new Map(rec.strings),
    files: new Map(rec.files),
    refs: new Map([...rec.refs].map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
    instances: new Map([...rec.instances].map(([k, v]) => [k, cloneInstance(v)])),
  };
  if (rec.quirks) out.quirks = rec.quirks;
  return out;
}

export function scalarEqual(a: ScalarValue | undefined, b: ScalarValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a instanceof Uint8Array) return b instanceof Uint8Array && bytesEqual(a, b);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  return Object.is(a, b);
}

export function refValuesEqual(a: Reference, b: Reference): boolean {
  return a.v0 === b.v0 && a.v1 === b.v1 && a.v2 === b.v2;
}

export function instanceEqual(a: Instance, b: Instance): boolean {
  return (
    a.target === b.target &&
    scalarEqual(a.position, b.position) &&
    scalarEqual(a.rotation, b.rotation) &&
    a.states.length === b.states.length &&
    a.states.every((s, i) => bytesEqual(s, b.states[i]!))
  );
}

export function scalarMap(rec: GameRecord, dict: ScalarDict): Map<string, ScalarValue> {
  return rec[dict];
}

/** Наложить ссылки слоя на категорию (изменяет `list`). */
export function applyRefs(list: Reference[], layer: readonly Reference[]): void {
  for (const ref of layer) {
    const i = list.findIndex((r) => r.target === ref.target);
    if (isRemovedRef(ref)) {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) list[i] = { ...ref };
    else list.push({ ...ref });
  }
}

/**
 * Наложить слой на запись. `base` undefined — записи ещё нет (или она удалена ниже).
 * Возвращает undefined, если слой удаляет запись. `base` не изменяется.
 */
export function applyLayer(base: GameRecord | undefined, layer: GameRecord): GameRecord | undefined {
  if (isRemovalMarker(layer)) return undefined;
  if (!base) {
    // Слой создаёт запись; маркеры удаления ссылок в нём ничего не значат.
    const rec = cloneRecord(layer);
    for (const [cat, list] of rec.refs) rec.refs.set(cat, list.filter((r) => !isRemovedRef(r)));
    return rec;
  }
  const rec = cloneRecord(base);
  rec.type = layer.type;
  rec.name = layer.name;
  rec.changeFlags = layer.changeFlags;
  for (const dict of SCALAR_DICTS) {
    const into = scalarMap(rec, dict);
    for (const [k, v] of scalarMap(layer, dict)) into.set(k, v);
  }
  for (const [cat, list] of layer.refs) {
    let into = rec.refs.get(cat);
    if (!into) {
      into = [];
      rec.refs.set(cat, into);
    }
    applyRefs(into, list);
  }
  for (const [k, v] of layer.instances) rec.instances.set(k, cloneInstance(v));
  return rec;
}

export class LayerDiffError extends Error {
  override name = 'LayerDiffError';
}

/**
 * Изменения, которые надо записать в мод, чтобы поверх `lower` получилось `desired`.
 * `previous` — прежняя запись мода: порядок её ключей и категорий сохраняется, а не изменившиеся
 * категории берутся из неё как есть. Убрать скалярное поле или размещённый объект нижних слоёв
 * нельзя (в формате нет такого маркера) — это ошибка.
 * Возвращает undefined, если `desired` совпадает с `lower`.
 */
export function diffRecord(lower: GameRecord, desired: GameRecord, previous?: GameRecord): GameRecord | undefined {
  const out = emptyRecord(desired.type, desired.stringId, desired.name);
  let changed = desired.type !== lower.type || !bytesEqual(desired.name, lower.name);
  for (const dict of SCALAR_DICTS) {
    const lo = scalarMap(lower, dict);
    const want = scalarMap(desired, dict);
    for (const k of lo.keys()) {
      if (!want.has(k)) throw new LayerDiffError(`Поле ${dict}:${k} записи ${desired.stringId} есть в нижних слоях, его нельзя убрать`);
    }
    const keys = orderKeys(previous ? scalarMap(previous, dict).keys() : [], want.keys());
    const into = scalarMap(out, dict);
    for (const k of keys) {
      const v = want.get(k);
      if (v !== undefined && !scalarEqual(v, lo.get(k))) into.set(k, v);
    }
    if (into.size > 0) changed = true;
  }
  const cats = orderKeys(previous?.refs.keys() ?? [], [...desired.refs.keys(), ...lower.refs.keys()]);
  for (const cat of cats) {
    const entries = diffRefs(lower.refs.get(cat) ?? [], desired.refs.get(cat) ?? []);
    if (entries.length === 0) continue;
    const prev = previous?.refs.get(cat);
    out.refs.set(cat, prev && sameRefSet(prev, entries) ? prev.map((r) => ({ ...r })) : entries);
    changed = true;
  }
  for (const k of lower.instances.keys()) {
    if (!desired.instances.has(k)) throw new LayerDiffError(`Объект ${k} записи ${desired.stringId} есть в нижних слоях, его нельзя убрать`);
  }
  for (const k of orderKeys(previous?.instances.keys() ?? [], desired.instances.keys())) {
    const v = desired.instances.get(k);
    const lo = lower.instances.get(k);
    if (v && !(lo && instanceEqual(v, lo))) out.instances.set(k, cloneInstance(v));
  }
  if (out.instances.size > 0) changed = true;
  return changed ? out : undefined;
}

/** Ключи `wanted` (без повторов): сначала в порядке `first`, затем остальные по порядку. */
function orderKeys(first: Iterable<string>, wanted: Iterable<string>): string[] {
  const set = new Set(wanted);
  const out: string[] = [];
  for (const k of first) if (set.delete(k)) out.push(k);
  for (const k of set) out.push(k);
  return out;
}

/**
 * Записи категории: сначала удаления и замены значений у ссылок нижних слоёв (в их порядке),
 * затем новые ссылки в нужном порядке. Повторы одной цели в `desired` сводятся к одной ссылке:
 * поверх нижних слоёв повтор не выразить.
 */
function diffRefs(lower: readonly Reference[], desired: readonly Reference[]): Reference[] {
  const want = new Map<string, Reference>();
  for (const r of desired) if (!want.has(r.target)) want.set(r.target, r);
  const lowerTargets = new Set<string>();
  const out: Reference[] = [];
  for (const r of lower) {
    if (lowerTargets.has(r.target)) continue;
    lowerTargets.add(r.target);
    const w = want.get(r.target);
    if (!w) out.push(removedRef(r.target));
    else if (!refValuesEqual(w, r)) out.push({ ...w });
  }
  for (const w of want.values()) if (!lowerTargets.has(w.target)) out.push({ ...w });
  return out;
}

function sameRefSet(a: readonly Reference[], b: readonly Reference[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((r) => [r.target, r]));
  if (m.size !== a.length) return false;
  return b.every((r) => {
    const x = m.get(r.target);
    return x !== undefined && refValuesEqual(x, r);
  });
}

/** Сравнить две записи по содержимому (без lead/id/флагов; порядок ключей не важен, порядок ссылок важен). */
export function recordsEqual(a: GameRecord, b: GameRecord): boolean {
  if (a.type !== b.type || a.stringId !== b.stringId || !bytesEqual(a.name, b.name)) return false;
  for (const dict of SCALAR_DICTS) {
    const x = scalarMap(a, dict);
    const y = scalarMap(b, dict);
    if (x.size !== y.size) return false;
    for (const [k, v] of x) if (!scalarEqual(v, y.get(k))) return false;
  }
  const cats = new Set([...a.refs.keys(), ...b.refs.keys()]);
  for (const c of cats) {
    const x = a.refs.get(c) ?? [];
    const y = b.refs.get(c) ?? [];
    if (x.length !== y.length || x.some((r, i) => r.target !== y[i]!.target || !refValuesEqual(r, y[i]!))) return false;
  }
  if (a.instances.size !== b.instances.size) return false;
  for (const [k, v] of a.instances) {
    const w = b.instances.get(k);
    if (!w || !instanceEqual(v, w)) return false;
  }
  return true;
}
