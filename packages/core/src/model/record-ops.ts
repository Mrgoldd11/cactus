/**
 * Operations on records as layers: overlay mod changes onto the lower-layer record
 * and, conversely, get mod changes as the diff "result minus lower layers".
 *
 * Overlay rules (as in the game and FCS):
 * - a record with boolean `REMOVED = true` deletes the record;
 * - the name comes from the last layer, scalar fields are replaced by key (new keys go at the end);
 * - a reference with values `2147483647 ×3` deletes the reference to the same target in the category;
 * - a reference to a target already in the category replaces its values in place, otherwise it is appended;
 * - placed objects (instances) are replaced by key.
 */
import { bytesEqual } from '../text.ts';
import { UiTextError } from '../ui-text.ts';

import { emptyRecord, type GameRecord, type Instance, type Reference, type Vec3, type Vec4 } from '../format/types.ts';

/** v0/v1/v2 value of a "deleted" reference. */
export const REMOVED_REF_VALUE = 2147483647;
/** Boolean field marking a deleted record. */
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

/** Marker record "delete the lower-layer record". */
export function removalMarker(lower: GameRecord): GameRecord {
  const rec = emptyRecord(lower.type, lower.stringId, lower.name);
  rec.bools.set(REMOVED_FIELD, true);
  return rec;
}

function cloneInstance(i: Instance): Instance {
  return { target: i.target, position: [...i.position], rotation: [...i.rotation], states: [...i.states] };
}

/** Deep copy of a record (byte values are not copied: by convention they are never mutated). */
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

/** Overlay a layer's references onto a category (mutates `list`). */
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
 * Overlay a layer onto a record. `base` undefined — the record does not exist yet (or was deleted below).
 * Returns undefined if the layer deletes the record. `base` is not mutated.
 */
export function applyLayer(base: GameRecord | undefined, layer: GameRecord): GameRecord | undefined {
  if (isRemovalMarker(layer)) return undefined;
  if (!base) {
    // The layer creates the record; reference-deletion markers in it mean nothing.
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

export class LayerDiffError extends UiTextError {
  override name = 'LayerDiffError';
}

/**
 * Changes to write into the mod so that `desired` results on top of `lower`.
 * `previous` is the mod's former record: its key and category order is kept, and unchanged
 * categories are taken from it as is. Removing a scalar field or placed object of the lower layers
 * is impossible (the format has no such marker) — that is an error.
 * Returns undefined if `desired` equals `lower`.
 */
export function diffRecord(lower: GameRecord, desired: GameRecord, previous?: GameRecord): GameRecord | undefined {
  const out = emptyRecord(desired.type, desired.stringId, desired.name);
  let changed = desired.type !== lower.type || !bytesEqual(desired.name, lower.name);
  for (const dict of SCALAR_DICTS) {
    const lo = scalarMap(lower, dict);
    const want = scalarMap(desired, dict);
    for (const k of lo.keys()) {
      if (!want.has(k)) throw new LayerDiffError({
          en: `Field ${dict}:${k} of record ${desired.stringId} is in the lower layers and cannot be removed`,
          ru: `Поле ${dict}:${k} записи ${desired.stringId} есть в нижних слоях, его нельзя убрать`,
          zh: `记录 ${desired.stringId} 的字段 ${dict}:${k} 在下层中存在，无法删除`,
        });
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
    // The mod record's previous order is kept until the user reorders the added references.
    const keep = prev !== undefined && sameRefSet(prev, entries) && sameAddedOrder(prev, entries, lower.refs.get(cat) ?? []);
    out.refs.set(cat, keep ? prev.map((r) => ({ ...r })) : entries);
    changed = true;
  }
  for (const k of lower.instances.keys()) {
    if (!desired.instances.has(k)) throw new LayerDiffError({
        en: `Object ${k} of record ${desired.stringId} is in the lower layers and cannot be removed`,
        ru: `Объект ${k} записи ${desired.stringId} есть в нижних слоях, его нельзя убрать`,
        zh: `记录 ${desired.stringId} 的对象 ${k} 在下层中存在，无法删除`,
      });
  }
  for (const k of orderKeys(previous?.instances.keys() ?? [], desired.instances.keys())) {
    const v = desired.instances.get(k);
    const lo = lower.instances.get(k);
    if (v && !(lo && instanceEqual(v, lo))) out.instances.set(k, cloneInstance(v));
  }
  if (out.instances.size > 0) changed = true;
  return changed ? out : undefined;
}

/** Keys of `wanted` (no repeats): first in the order of `first`, then the rest in order. */
function orderKeys(first: Iterable<string>, wanted: Iterable<string>): string[] {
  const set = new Set(wanted);
  const out: string[] = [];
  for (const k of first) if (set.delete(k)) out.push(k);
  for (const k of set) out.push(k);
  return out;
}

/**
 * Category entries: first deletions and value replacements of lower-layer references (in their order),
 * then new references in the desired order. Repeats of one target in `desired` collapse to one reference:
 * a repeat cannot be expressed on top of lower layers.
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

/** References added by the mod (absent in lower layers) come in the same order. */
function sameAddedOrder(a: readonly Reference[], b: readonly Reference[], lower: readonly Reference[]): boolean {
  const low = new Set(lower.map((r) => r.target));
  const x = a.filter((r) => !isRemovedRef(r) && !low.has(r.target)).map((r) => r.target);
  const y = b.filter((r) => !isRemovedRef(r) && !low.has(r.target)).map((r) => r.target);
  return x.every((t, i) => t === y[i]);
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

/** Compare two records by content (ignoring lead/id/flags; key order does not matter, reference order does). */
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
