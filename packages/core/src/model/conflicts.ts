/**
 * Mod conflicts: which layers (mods) change the same record and the same field
 * with different values. The later layer (lower in `mods.cfg`) wins, as in the game.
 *
 * A "field" here is what is overlaid by key (see `record-ops.ts`):
 * - `record`: record deletion (boolean `REMOVED`);
 * - `name`: record name (taken from the last layer);
 * - `scalar`: scalar field `dict:key`;
 * - `ref`: reference to a target in a category (values or "delete");
 * - `instance`: placed object by key.
 *
 * Two mods adding different references to one category do not conflict: both references
 * stay. A conflict is when two layers set one field differently and only one wins.
 * If one mod deletes a record and another changes it, that is a record-level conflict.
 */
import { decodeText } from '../text.ts';
import type { GameRecord, Instance } from '../format/types.ts';
import { isVanillaLayer } from '../vanilla.ts';
import { applyLayer, isRemovalMarker, isRemovedRef, SCALAR_DICTS, scalarMap, type ScalarDict } from './record-ops.ts';
import { formatFloat, formatRefValues, formatScalar } from './present.ts';
import type { ModContext } from './context.ts';

/** Layer for conflict search: name and records (`Layer` fits). */
export interface ConflictLayer {
  name: string;
  file: { records: readonly GameRecord[] };
}

export type ConflictFieldKind = 'record' | 'name' | 'scalar' | 'ref' | 'instance';

/** Which field: the `id` key is unique within a record. */
export interface FieldRef {
  /** `record`, `name`, `floats:cut damage multiplier`, `ref:<category>:<target>`, `inst:<key>`. */
  id: string;
  kind: ConflictFieldKind;
  dict?: ScalarDict;
  key?: string;
  category?: string;
  target?: string;
}

/** A field the layer sets, and its value as text. */
export interface FieldTouch extends FieldRef {
  value: string;
}

/** What one layer does to the record. */
export interface LayerTouch {
  layer: string;
  /** The layer deletes the record. */
  removes: boolean;
  /** The record did not exist before this layer (the layer creates it). */
  creates: boolean;
  fields: FieldTouch[];
}

export interface FieldConflict extends FieldRef {
  /** Value in the base layers (vanilla); absent: vanilla has no such field. */
  base?: string;
  /** Values of the layers that set the field, in load order. */
  values: { layer: string; value: string }[];
  /** The layer whose value ends up in the game (the last one). */
  winner: string;
}

export interface RecordConflict {
  sid: string;
  type: number;
  name: string;
  /** Non-base layers that touch the record, in load order. */
  layers: string[];
  fields: FieldConflict[];
}

export interface ConflictOptions {
  /** Base layer (vanilla): its values do not count as a "change". Default: `isVanillaLayer`. */
  isBase?: (name: string) => boolean;
  /** Only conflicts this layer takes part in (name, case-insensitive). */
  only?: string;
}

// Value keys of conflicts stay Russian (the window maps them per language; see conflictValue).
const REMOVE_TEXT = 'удалить';
const CHANGE_TEXT = 'изменить';

function formatInstance(i: Instance): string {
  return `${i.target} (${i.position.map(formatFloat).join(', ')}) rot (${i.rotation.map(formatFloat).join(', ')})${i.states.length ? ` states ${i.states.length}` : ''}`;
}

/**
 * Fields that layer `rec` sets over record `below` (undefined: there is no record below).
 * Reference deletion markers for a non-existent record mean nothing and are not counted.
 */
export function layerFields(rec: GameRecord, below: GameRecord | undefined): FieldTouch[] {
  if (isRemovalMarker(rec)) return [{ id: 'record', kind: 'record', value: REMOVE_TEXT }];
  const out: FieldTouch[] = [];
  const name = decodeText(rec.name);
  if (!below || decodeText(below.name) !== name) out.push({ id: 'name', kind: 'name', value: JSON.stringify(name) });
  for (const dict of SCALAR_DICTS) {
    for (const [key, v] of scalarMap(rec, dict)) out.push({ id: `${dict}:${key}`, kind: 'scalar', dict, key, value: formatScalar(dict, v) });
  }
  for (const [category, list] of rec.refs) {
    for (const r of list) {
      if (isRemovedRef(r) && !below) continue;
      out.push({ id: `ref:${category}:${r.target}`, kind: 'ref', category, target: r.target, value: formatRefValues(r, 'ru') });
    }
  }
  for (const [key, inst] of rec.instances) out.push({ id: `inst:${key}`, kind: 'instance', key, value: formatInstance(inst) });
  return out;
}

/** Field value in the record as text; undefined: no field. */
export function fieldValue(rec: GameRecord | undefined, f: FieldRef): string | undefined {
  if (!rec) return f.kind === 'record' ? 'нет записи' : undefined;
  switch (f.kind) {
    case 'record':
      return 'есть';
    case 'name':
      return JSON.stringify(decodeText(rec.name));
    case 'scalar': {
      const v = scalarMap(rec, f.dict!).get(f.key!);
      return v === undefined ? undefined : formatScalar(f.dict!, v);
    }
    case 'ref': {
      const r = rec.refs.get(f.category!)?.find((x) => x.target === f.target);
      return r ? formatRefValues(r, 'ru') : undefined;
    }
    case 'instance': {
      const i = rec.instances.get(f.key!);
      return i ? formatInstance(i) : undefined;
    }
  }
}

function strip(f: FieldTouch): FieldRef {
  const ref: FieldRef = { id: f.id, kind: f.kind };
  if (f.dict !== undefined) ref.dict = f.dict;
  if (f.key !== undefined) ref.key = f.key;
  if (f.category !== undefined) ref.category = f.category;
  if (f.target !== undefined) ref.target = f.target;
  return ref;
}

interface Entry {
  layer: string;
  rec: GameRecord;
}

/** Lookup across several records: index of non-base and base records by sid. */
function indexLayers(layers: readonly ConflictLayer[], isBase: (name: string) => boolean, want?: ReadonlySet<string>): { base: Map<string, Entry[]>; mods: Map<string, Entry[]> } {
  const base = new Map<string, Entry[]>();
  const mods = new Map<string, Entry[]>();
  for (const layer of layers) {
    const into = isBase(layer.name) ? base : mods;
    for (const rec of layer.file.records) {
      if (want && !want.has(rec.stringId)) continue;
      let list = into.get(rec.stringId);
      if (!list) into.set(rec.stringId, (list = []));
      list.push({ layer: layer.name, rec });
    }
  }
  return { base, mods };
}

function fold(entries: readonly Entry[] | undefined): GameRecord | undefined {
  let acc: GameRecord | undefined;
  for (const e of entries ?? []) acc = applyLayer(acc, e.rec);
  return acc;
}

/** What each non-base layer does to the record. Each layer's `below` is the result of all layers below. */
function touchesOf(baseRec: GameRecord | undefined, mods: readonly Entry[]): LayerTouch[] {
  let acc = baseRec;
  return mods.map((e) => {
    const fields = layerFields(e.rec, acc);
    const t: LayerTouch = { layer: e.layer, removes: isRemovalMarker(e.rec), creates: acc === undefined && !isRemovalMarker(e.rec), fields };
    acc = applyLayer(acc, e.rec);
    return t;
  });
}

export interface TouchReport {
  sid: string;
  /** Record in the base layers (vanilla); absent: the record is created by mods. */
  base?: GameRecord;
  /** Non-base layers that set the record, in load order. */
  touches: LayerTouch[];
}

/** Who (which non-base layers) touches the record and what exactly they set. */
export function touchedBy(layers: readonly ConflictLayer[], sid: string, options: Pick<ConflictOptions, 'isBase'> = {}): TouchReport {
  const isBase = options.isBase ?? isVanillaLayer;
  const { base, mods } = indexLayers(layers, isBase, new Set([sid]));
  const baseRec = fold(base.get(sid));
  return { sid, ...(baseRec ? { base: baseRec } : {}), touches: touchesOf(baseRec, mods.get(sid) ?? []) };
}

/** Conflicts of one record from the `touchedBy` report; empty: no conflicts. */
export function recordConflicts(report: TouchReport): FieldConflict[] {
  const { touches, base } = report;
  if (touches.length < 2) return [];
  const out: FieldConflict[] = [];
  // Deletion versus change.
  if (touches.some((t) => t.removes) && touches.some((t) => !t.removes)) {
    const values = touches.map((t) => ({ layer: t.layer, value: t.removes ? REMOVE_TEXT : CHANGE_TEXT }));
    out.push({ id: 'record', kind: 'record', base: fieldValue(base, { id: 'record', kind: 'record' })!, values, winner: values.at(-1)!.layer });
  }
  const byField = new Map<string, { ref: FieldRef; values: { layer: string; value: string }[] }>();
  for (const t of touches) {
    for (const f of t.fields) {
      if (f.kind === 'record') continue;
      let g = byField.get(f.id);
      if (!g) byField.set(f.id, (g = { ref: strip(f), values: [] }));
      g.values.push({ layer: t.layer, value: f.value });
    }
  }
  for (const { ref, values } of byField.values()) {
    if (values.length < 2 || new Set(values.map((v) => v.value)).size < 2) continue;
    const b = fieldValue(base, ref);
    out.push({ ...ref, ...(b !== undefined ? { base: b } : {}), values, winner: values.at(-1)!.layer });
  }
  return out;
}

function headline(entries: readonly Entry[]): { type: number; name: string } {
  const live = [...entries].reverse().find((e) => !isRemovalMarker(e.rec)) ?? entries.at(-1)!;
  return { type: live.rec.type, name: decodeText(live.rec.name) };
}

/**
 * All conflicts between non-base layers. Order: by the first appearance of the record in mods.
 * With `only`: only records this layer touches, and only fields it sets.
 */
export function findConflicts(layers: readonly ConflictLayer[], options: ConflictOptions = {}): RecordConflict[] {
  const isBase = options.isBase ?? isVanillaLayer;
  const only = options.only?.toLowerCase();
  const { mods } = indexLayers(layers.filter((l) => !isBase(l.name)), () => false);
  const candidates = new Set<string>();
  for (const [sid, list] of mods) {
    if (list.length < 2) continue;
    if (only !== undefined && !list.some((e) => e.layer.toLowerCase() === only)) continue;
    candidates.add(sid);
  }
  if (candidates.size === 0) return [];
  const { base } = indexLayers(
    layers.filter((l) => isBase(l.name)),
    () => true,
    candidates,
  );
  const out: RecordConflict[] = [];
  for (const sid of candidates) {
    const entries = mods.get(sid)!;
    const baseRec = fold(base.get(sid));
    let fields = recordConflicts({ sid, ...(baseRec ? { base: baseRec } : {}), touches: touchesOf(baseRec, entries) });
    if (only !== undefined) fields = fields.filter((f) => f.values.some((v) => v.layer.toLowerCase() === only));
    if (fields.length === 0) continue;
    out.push({ sid, ...headline(entries), layers: entries.map((e) => e.layer), fields });
  }
  return out;
}

/** Context layers for conflict search: lower layers and the mod itself (its records as they are now). */
export function contextLayers(ctx: ModContext): ConflictLayer[] {
  const records = ctx.modRecords();
  return records.length > 0 ? [...ctx.layers, { name: ctx.modName, file: { records } }] : [...ctx.layers];
}

/** Words of the conflict texts in one interface language. */
interface ConflictWords {
  wholeRecord: string;
  name: string;
  object: (key: string) => string;
  mods: (n: number, list: string) => string;
  vanilla: (v: string) => string;
  wins: (layer: string) => string;
  removes: string;
  creates: string;
}

const CONFLICT_WORDS: Record<string, ConflictWords> = {
  en: { wholeRecord: 'whole record', name: 'name', object: (k) => `object ${k}`, mods: (n, l) => `mods: ${n} (${l})`, vanilla: (v) => ` (vanilla ${v})`, wins: (l) => `wins ${l}`, removes: ' — DELETES the record', creates: ' — creates the record' },
  ru: { wholeRecord: 'запись целиком', name: 'имя', object: (k) => `объект ${k}`, mods: (n, l) => `модов: ${n} (${l})`, vanilla: (v) => ` (ваниль ${v})`, wins: (l) => `победит ${l}`, removes: ' — УДАЛЯЕТ запись', creates: ' — создаёт запись' },
  zh: { wholeRecord: '整条记录', name: '名称', object: (k) => `对象 ${k}`, mods: (n, l) => `Mod：${n}（${l}）`, vanilla: (v) => `（原版 ${v}）`, wins: (l) => `生效：${l}`, removes: ' — 删除该记录', creates: ' — 创建该记录' },
};
const conflictWords = (lang: string): ConflictWords => CONFLICT_WORDS[lang] ?? CONFLICT_WORDS.en!;

/** Human-readable field label: `cut damage multiplier`, `<category> → <target>`, `object <key>`. */
export function fieldLabel(f: FieldRef, nameOf: (sid: string) => string = (s) => s, lang = 'en'): string {
  const w = conflictWords(lang);
  switch (f.kind) {
    case 'record':
      return w.wholeRecord;
    case 'name':
      return w.name;
    case 'scalar':
      return f.key!;
    case 'ref':
      return `${f.category} → ${nameOf(f.target!)}`;
    case 'instance':
      return w.object(f.key!);
  }
}

/** A record conflict as text for CLI/MCP. */
export function formatConflict(c: RecordConflict, nameOf?: (sid: string) => string, lang = 'en'): string[] {
  const w = conflictWords(lang);
  const lines = [`${c.sid} «${c.name}» — ${w.mods(c.layers.length, c.layers.join(', '))}`];
  for (const f of c.fields) {
    lines.push(`  ${fieldLabel(f, nameOf, lang)}${f.base !== undefined ? w.vanilla(f.base) : ''}: ${w.wins(f.winner)}`);
    for (const v of f.values) lines.push(`    ${v.layer === f.winner ? '→' : ' '} ${v.layer}: ${v.value}`);
  }
  return lines;
}

/** The `touchedBy` report as text for CLI/MCP. */
export function formatTouches(r: TouchReport, nameOf?: (sid: string) => string, lang = 'en'): string[] {
  const w = conflictWords(lang);
  const lines: string[] = [];
  for (const t of r.touches) {
    lines.push(`  ${t.layer}${t.removes ? w.removes : t.creates ? w.creates : ''}`);
    if (t.removes) continue;
    for (const f of t.fields) lines.push(`    ${fieldLabel(f, nameOf, lang)} = ${f.value}`);
  }
  return lines;
}
