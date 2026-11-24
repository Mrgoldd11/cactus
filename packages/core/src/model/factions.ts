/**
 * Faction relations (stage 5, "relations matrix"). Where they are in the data (checked on vanilla):
 * - `FACTION.relations` → FACTION, value v0 is the relation from −100 to +100 (row = who
 *   relates, column = to whom). The relation is directed: the second faction has its own entry;
 * - not set: the row's `default relation` (int, default 0);
 * - the row's `enemy classification` (int, default −10): "this or lower is an enemy, attack
 *   at once";
 * - `coexistence` → FACTION: "we try to get along" (they may fight but attack less often).
 *
 * The "ally" threshold is not set in the data: we take ≥ 50 (arbitrary, only for colour).
 */
import { decodeText } from '../text.ts';
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import { isVanillaLayer } from '../vanilla.ts';
import { plainName } from '../world/where.ts';
import { EditError, type ModContext } from './context.ts';
import { contextLayers } from './conflicts.ts';
import { isRemovalMarker, isRemovedRef } from './record-ops.ts';

export const FACTION_TYPE = 'FACTION';
export const RELATIONS = 'relations';
export const COEXISTENCE = 'coexistence';
/** Arbitrary "ally" threshold (the game data has none). */
export const ALLY_THRESHOLD = 50;
const DEFAULT_ENEMY = -10;

export type RelationKind = 'enemy' | 'neutral' | 'ally';

export interface FactionInfo {
  sid: string;
  name: string;
  /** Name in the data language without gender markup, or undefined. */
  localized?: string;
  defaultRelation: number;
  enemyClassification: number;
  /** Number of explicitly set relations (without "remove" markers). */
  listed: number;
}

/** What one mod (layer) does to a relation: sets a value or removes the row. */
export interface RelationTouch {
  layer: string;
  /** undefined: the mod removes the relation from the list (so it is "default" again). */
  value?: number;
}

export interface RelationCell {
  value: number;
  /** Set in the `relations` list (rather than taken from `default relation`). */
  explicit: boolean;
  kind: RelationKind;
  coexist: boolean;
  /** Non-base layers that touch this relation, in load order (the mod itself last). */
  touches: RelationTouch[];
}

export interface FactionMatrix {
  factions: FactionInfo[];
  cell(from: string, to: string): RelationCell;
  /** Relation B → A, if it differs from A → B (otherwise undefined). */
  asymmetry(from: string, to: string): number | undefined;
  /** Layers that touch the faction's relations (for the "what the mod changed" filter). */
  layersOf(sid: string): string[];
  /** All non-base layers that change something in relations. */
  layers: string[];
}

function relationValue(r: Reference): number {
  return r.v0;
}

export function relationKind(value: number, enemyClassification = DEFAULT_ENEMY): RelationKind {
  if (value <= enemyClassification) return 'enemy';
  if (value >= ALLY_THRESHOLD) return 'ally';
  return 'neutral';
}

function info(ctx: ModContext, rec: GameRecord): FactionInfo {
  const loc = ctx.localizedName(rec.stringId);
  const plain = loc === undefined ? undefined : plainName(loc);
  return {
    sid: rec.stringId,
    name: decodeText(rec.name) || rec.stringId,
    ...(plain !== undefined && plain !== '' ? { localized: plain } : {}),
    defaultRelation: rec.ints.get('default relation') ?? 0,
    enemyClassification: rec.ints.get('enemy classification') ?? DEFAULT_ENEMY,
    listed: (rec.refs.get(RELATIONS) ?? []).filter((r) => !isRemovedRef(r)).length,
  };
}

/**
 * Relations matrix of all factions of the context (vanilla, dependencies, context mods, the mod itself).
 * Computed from the resulting records; "who changed it" by layers, without reading the disk.
 * `ids`: prebuilt list of faction ids (editor index), so not all records are scanned.
 */
export function factionMatrix(ctx: ModContext, options: { ids?: Iterable<string> } = {}): FactionMatrix {
  const type = itemTypeId(FACTION_TYPE)!;
  const factions: FactionInfo[] = [];
  const values = new Map<string, Map<string, number>>();
  const coexist = new Map<string, Set<string>>();
  for (const sid of options.ids ?? ctx.allStringIds()) {
    const rec = ctx.get(sid);
    if (!rec || rec.type !== type) continue;
    factions.push(info(ctx, rec));
    const m = new Map<string, number>();
    for (const r of rec.refs.get(RELATIONS) ?? []) if (!isRemovedRef(r) && !m.has(r.target)) m.set(r.target, relationValue(r));
    values.set(sid, m);
    coexist.set(sid, new Set((rec.refs.get(COEXISTENCE) ?? []).filter((r) => !isRemovedRef(r)).map((r) => r.target)));
  }
  const byId = new Map(factions.map((f) => [f.sid, f]));

  // Who touches it: non-base layers with FACTION records.
  const touches = new Map<string, RelationTouch[]>();
  const rowLayers = new Map<string, Set<string>>();
  const allLayers: string[] = [];
  // Running value of the relation across layers: a mod that sets the same value as before it
  // (e.g. restored the original value) changes nothing; it is not shown as "touched".
  const running = new Map<string, number | undefined>();
  const defaultOf = (sid: string): number => byId.get(sid)?.defaultRelation ?? 0;
  for (const layer of contextLayers(ctx)) {
    const vanilla = isVanillaLayer(layer.name);
    let any = false;
    for (const rec of layer.file.records) {
      if (rec.type !== type || isRemovalMarker(rec)) continue;
      for (const r of rec.refs.get(RELATIONS) ?? []) {
        const key = `${rec.stringId}\n${r.target}`;
        const next = isRemovedRef(r) ? undefined : relationValue(r);
        const before = running.get(key);
        running.set(key, next);
        if (vanilla) continue;
        if ((next ?? defaultOf(rec.stringId)) === (before ?? defaultOf(rec.stringId))) continue;
        let list = touches.get(key);
        if (!list) touches.set(key, (list = []));
        list.push(isRemovedRef(r) ? { layer: layer.name } : { layer: layer.name, value: relationValue(r) });
        let set = rowLayers.get(rec.stringId);
        if (!set) rowLayers.set(rec.stringId, (set = new Set()));
        set.add(layer.name);
        any = true;
      }
    }
    if (any) allLayers.push(layer.name);
  }

  const cell = (from: string, to: string): RelationCell => {
    const f = byId.get(from);
    const listed = values.get(from)?.get(to);
    const value = listed ?? f?.defaultRelation ?? 0;
    return {
      value,
      explicit: listed !== undefined,
      kind: relationKind(value, f?.enemyClassification),
      coexist: coexist.get(from)?.has(to) ?? false,
      touches: touches.get(`${from}\n${to}`) ?? [],
    };
  };
  return {
    factions,
    cell,
    asymmetry(from, to) {
      if (from === to) return undefined;
      const a = cell(from, to).value;
      const b = cell(to, from).value;
      return a === b ? undefined : b;
    },
    layersOf: (sid) => [...(rowLayers.get(sid) ?? [])],
    layers: allLayers,
  };
}

function factionName(ctx: ModContext, sid: string): string {
  return ctx.name(sid) ?? sid;
}

function requireFaction(ctx: ModContext, sid: string): void {
  const rec = ctx.get(sid);
  if (!rec) throw new EditError({ en: `No record ${sid}`, ru: `Записи ${sid} нет`, zh: `没有记录 ${sid}` });
  if (itemTypeName(rec.type) !== FACTION_TYPE) throw new EditError({ en: `${sid} is not a faction (${itemTypeName(rec.type)})`, ru: `${sid} — не фракция (${itemTypeName(rec.type)})`, zh: `${sid} 不是派系（${itemTypeName(rec.type)}）` });
}

export interface SetRelationOptions {
  /** Set the same value in the opposite direction too (B → A). */
  both?: boolean;
}

/** Step label (Russian, a step-title key), e.g. relation "A" → "B": 20 (or `… ⇄ …` for both sides, "reset" for default). */
export function relationLabel(ctx: ModContext, from: string, to: string, value: number | undefined, both = false): string {
  return `отношение «${factionName(ctx, from)}» ${both ? '⇄' : '→'} «${factionName(ctx, to)}»: ${value === undefined ? 'сброс' : value}`;
}

function putRelation(ctx: ModContext, from: string, to: string, value: number | undefined): void {
  ctx.editRecord(from, (d) => {
    const list = d.refs.get(RELATIONS) ?? [];
    const i = list.findIndex((r) => r.target === to && !isRemovedRef(r));
    if (value === undefined) {
      if (i >= 0) d.refs.set(RELATIONS, list.filter((r) => r.target !== to || isRemovedRef(r)));
      return;
    }
    if (i >= 0) list[i] = { ...list[i]!, v0: value };
    else list.push({ target: to, v0: value, v1: 0, v2: 0 });
    d.refs.set(RELATIONS, list);
  });
}

/**
 * Change the relation of faction `from` to `to` (−100…100) with one edit. `undefined` removes it
 * from the list (then `default relation` applies). `both`: the opposite relation too, in the same edit.
 */
export function setFactionRelation(ctx: ModContext, from: string, to: string, value: number | undefined, options: SetRelationOptions = {}): void {
  requireFaction(ctx, from);
  requireFaction(ctx, to);
  if (value !== undefined && (!Number.isInteger(value) || value < -100 || value > 100)) throw new EditError({ en: `A relation is an integer from −100 to 100, not ${value}`, ru: `Отношение — целое от −100 до 100, а не ${value}`, zh: `关系值应为 −100 到 100 的整数，而不是 ${value}` });
  const both = (options.both ?? false) && from !== to;
  ctx.transaction(relationLabel(ctx, from, to, value, both), () => {
    putRelation(ctx, from, to, value);
    if (both) putRelation(ctx, to, from, value);
  });
}
