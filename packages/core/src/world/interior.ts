/**
 * Building interiors: layouts of furniture and item points in `interiors.level`.
 *
 * How it works in the game files (vanilla: 4 layers, 410 layouts):
 *  - a layout is an INSTANCE_COLLECTION record with id `<building>-<Name>` (`727-gamedata.base-Noble House`);
 *    field `associated building` — the building record (BUILDING), `is exterior` — outside (signs,
 *    flags; id `EXT-<building>-<Name>`), flags `is shop`, `is bar`, `is recruitment`, `flophouse`;
 *  - a building has many layouts; which one to use is given by the building's state in the world
 *    (`interior layout name`), and where there is no name the game chooses by itself;
 *  - layout instances are furniture (BUILDING: walls, beds, chests) and item points
 *    (ITEM_PLACEMENT_GROUP); position and quaternion are relative to the building model's origin;
 *  - every instance has a state: furniture has GAMESTATE_BUILDING `<key>-S23` (name, owner
 *    faction, `floornum`, lock, use points), an item point has an
 *    ITEM_PLACEMENT_GROUP record with its own id (`base data sid` — what lies there, `floornum`);
 *  - residents, guards and goods are not in the layout: the game places them from building and town templates.
 *
 * Mods put changed layout instances (with the layout's fields) and states as full copies into
 * their own `interiors.level`; new keys are `<n>-<mod>-INGAME`. The module has no disk access.
 */
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import { emptyRecord, type GameRecord, type Instance, type Vec3, type Vec4 } from '../format/types.ts';
import { cloneRecord } from '../model/record-ops.ts';
import { decodeText, encodeText } from '../text.ts';
import type { WorldEdits } from './edit.ts';
import type { BuildingPlacement, WorldIndex } from './world.ts';
import { UiTextError } from '../ui-text.ts';

export const INTERIORS = 'interiors.level';

/** What can be placed inside: furniture and item points. */
export const INTERIOR_TYPES = ['BUILDING', 'ITEM_PLACEMENT_GROUP'] as const;

export interface InteriorLayout {
  /** Layout id (`727-gamedata.base-Noble House`). */
  sid: string;
  name: string;
  /** Building (BUILDING). */
  building: string;
  /** Outside the building (signs, flags). */
  exterior: boolean;
  shop: boolean;
  bar: boolean;
  recruitment: boolean;
  flophouse: boolean;
  /** Number of objects (excluding removed). */
  objects: number;
}

export type InteriorKind = 'furniture' | 'items' | 'other';

export interface InteriorObject {
  /** Instance key in the layout. */
  key: string;
  target: string;
  kind: InteriorKind;
  /** Relative to the building model's origin. */
  position: Vec3;
  rotation: Vec4;
  /** Floor (`floornum` of the state), if any. */
  floor?: number;
  /** State record id. */
  state?: string;
  /** For furniture: locked, lock level. */
  locked?: boolean;
  lockLevel?: number;
  /** For an item point: what lies there (`base data sid`). */
  items?: string;
}

/** Where to get a record's type by id (ModContext.get / headline). */
export interface RecordTypes {
  headline(sid: string): Pick<GameRecord, 'type' | 'name'> | undefined;
}

const str = (r: GameRecord | undefined, k: string): string => decodeText(r?.strings.get(k) ?? new Uint8Array());

function layoutOf(sid: string, rec: GameRecord): InteriorLayout {
  let objects = 0;
  for (const i of rec.instances.values()) if (i.target !== '') objects++;
  return {
    sid,
    name: decodeText(rec.name),
    building: str(rec, 'associated building'),
    exterior: rec.bools.get('is exterior') === true || sid.startsWith('EXT-'),
    shop: rec.bools.get('is shop') === true,
    bar: rec.bools.get('is bar') === true,
    recruitment: rec.bools.get('is recruitment') === true,
    flophouse: rec.bools.get('flophouse') === true,
    objects,
  };
}

function requireLoaded(edits: WorldEdits): void {
  if (!edits.isLoaded(INTERIORS)) throw new UiTextError({ en: 'Interiors are not read yet', ru: 'Интерьеры ещё не прочитаны', zh: '内部布局尚未读取' });
}

/** Layouts of a building (or all, without `building`): interior ones first, by name. */
export function interiorLayouts(edits: WorldEdits, building?: string): InteriorLayout[] {
  requireLoaded(edits);
  const out: InteriorLayout[] = [];
  for (const sid of edits.holders(INTERIORS)) {
    const rec = edits.record(INTERIORS, sid);
    if (!rec) continue;
    if (building !== undefined && str(rec, 'associated building') !== building) continue;
    out.push(layoutOf(sid, rec));
  }
  return out.sort((a, b) => Number(a.exterior) - Number(b.exterior) || a.name.localeCompare(b.name));
}

/** One layout; undefined — none. */
export function interiorLayout(edits: WorldEdits, sid: string): InteriorLayout | undefined {
  requireLoaded(edits);
  const rec = edits.record(INTERIORS, sid);
  return rec && itemTypeName(rec.type) === 'INSTANCE_COLLECTION' ? layoutOf(sid, rec) : undefined;
}

function kindOf(types: RecordTypes, target: string): InteriorKind {
  const t = itemTypeName(types.headline(target)?.type ?? -1);
  return t === 'BUILDING' ? 'furniture' : t === 'ITEM_PLACEMENT_GROUP' ? 'items' : 'other';
}

function objectOf(edits: WorldEdits, types: RecordTypes, key: string, inst: Instance): InteriorObject {
  const o: InteriorObject = { key, target: inst.target, kind: kindOf(types, inst.target), position: [...inst.position], rotation: [...inst.rotation] };
  const sid = inst.states[0] ? decodeText(inst.states[0]) : undefined;
  const st = sid !== undefined ? edits.record(INTERIORS, sid) : undefined;
  if (sid !== undefined) o.state = sid;
  if (st) {
    const f = st.ints.get('floornum');
    if (f !== undefined) o.floor = f;
    if (st.bools.has('locked')) o.locked = st.bools.get('locked') === true;
    const lock = st.ints.get('lock lvl') ?? st.floats.get('lock lvl');
    if (lock !== undefined) o.lockLevel = lock;
    const items = str(st, 'base data sid');
    if (items) o.items = items;
  }
  return o;
}

/** Layout objects (excluding removed). */
export function layoutObjects(edits: WorldEdits, types: RecordTypes, layout: string): InteriorObject[] {
  requireLoaded(edits);
  const rec = edits.record(INTERIORS, layout);
  if (!rec) throw new UiTextError({ en: `No layout ${layout}`, ru: `Нет раскладки ${layout}`, zh: `没有布局 ${layout}` });
  const out: InteriorObject[] = [];
  for (const [key, inst] of rec.instances) if (inst.target !== '') out.push(objectOf(edits, types, key, inst));
  return out;
}

/** One layout object; undefined — absent or removed. */
export function layoutObject(edits: WorldEdits, types: RecordTypes, layout: string, key: string): InteriorObject | undefined {
  requireLoaded(edits);
  const inst = edits.instance(INTERIORS, layout, key);
  return inst ? objectOf(edits, types, key, inst) : undefined;
}

/** Floor by height: same as the object with a floor nearest in height (default 0). */
export function floorAt(objects: readonly InteriorObject[], y: number, except?: string): number {
  let best: InteriorObject | undefined;
  for (const o of objects) {
    if (o.floor === undefined || o.key === except) continue;
    if (!best || Math.abs(o.position[1] - y) < Math.abs(best.position[1] - y)) best = o;
  }
  return best?.floor ?? 0;
}

/**
 * Objects far from the rest: a layout with coordinates of the world instead of the building's
 * (rebirth.mod has spotlights in the Metal Warehouse 120 000 units away). The game puts them that
 * far from the building, so inside they are not seen; the view leaves them out of the frame.
 * Rule: farther than `radius` (horizontally or vertically) from the median of all objects.
 */
export function strayObjects(objects: readonly Pick<InteriorObject, 'key' | 'position'>[], radius = 2000): Set<string> {
  const out = new Set<string>();
  if (objects.length < 2) return out;
  const median = (i: number): number => {
    const v = objects.map((o) => o.position[i] ?? 0).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)]!;
  };
  const m = [median(0), median(1), median(2)];
  for (const o of objects) {
    const dx = o.position[0] - m[0]!;
    const dz = o.position[2] - m[2]!;
    if (Math.hypot(dx, dz) > radius || Math.abs(o.position[1] - m[1]!) > radius) out.add(o.key);
  }
  return out;
}

/** A floor of the interior: number as in the game (`floornum`, `building floor`) and its height. */
export interface InteriorFloor {
  floor: number;
  /** Height of the floor surface in the building's coordinates. */
  level: number;
}

/** What a building piece tells about floors (a ModelPiece plus its mesh bounds, if known). */
export interface FloorPiece {
  floor?: number;
  interior?: boolean;
  /** Lowest point of the mesh. */
  minY?: number;
}

/**
 * Floors of an interior. Numbers: the `floornum` of the objects and the `building floor` of the
 * interior parts (exterior parts are not used: roofs have floors of their own). Height: the lowest
 * object of that floor (furniture stands on the floor), otherwise the lowest point of the floor's
 * interior parts, otherwise above the floor below. Stray objects do not count.
 */
export function interiorFloors(objects: readonly InteriorObject[], pieces: readonly FloorPiece[] = [], stray: ReadonlySet<string> = new Set()): InteriorFloor[] {
  const byObjects = new Map<number, number>();
  for (const o of objects) {
    if (o.floor === undefined || stray.has(o.key)) continue;
    byObjects.set(o.floor, Math.min(byObjects.get(o.floor) ?? Infinity, o.position[1]));
  }
  const byPieces = new Map<number, number>();
  for (const p of pieces) {
    if (!p.interior || p.floor === undefined) continue;
    byPieces.set(p.floor, Math.min(byPieces.get(p.floor) ?? Infinity, p.minY ?? Infinity));
  }
  const nums = [...new Set([...byObjects.keys(), ...byPieces.keys()])].sort((a, b) => a - b);
  if (nums.length === 0) {
    // No floor numbers at all: one floor where the objects stand.
    let low = Infinity;
    for (const o of objects) if (!stray.has(o.key)) low = Math.min(low, o.position[1]);
    return [{ floor: 0, level: Number.isFinite(low) ? low : 0 }];
  }
  const out: InteriorFloor[] = [];
  for (const floor of nums) {
    let level = byObjects.get(floor) ?? byPieces.get(floor) ?? Infinity;
    if (!Number.isFinite(level)) level = (out.at(-1)?.level ?? 0) + 50;
    out.push({ floor, level });
  }
  // Heights only grow with the floor number.
  for (let i = 1; i < out.length; i++) if (out[i]!.level < out[i - 1]!.level) out[i]!.level = out[i - 1]!.level;
  return out;
}

/** The floor an object is on: its `floornum`, otherwise the highest floor at or below it. */
export function objectFloor(o: Pick<InteriorObject, 'floor' | 'position'>, floors: readonly InteriorFloor[]): number {
  if (o.floor !== undefined) return o.floor;
  let best = floors[0]?.floor ?? 0;
  for (const f of floors) if (f.level <= o.position[1] + 1) best = f.floor;
  return best;
}

/**
 * Cut height for looking at `floor` from above: just under the next floor, so its slab and
 * everything over it is cut away. undefined — the top floor (nothing to cut, roofs are hidden).
 */
export function floorCut(floors: readonly InteriorFloor[], floor: number): number | undefined {
  const next = floors.find((f) => f.floor > floor);
  return next ? next.level - 2 : undefined;
}

/** State template: the same object in any layout (this one first). */
function templateOf(edits: WorldEdits, layout: string, target: string, type: string): { inst: Instance; state: GameRecord } | undefined {
  const order = [layout, ...edits.holders(INTERIORS).filter((h) => h !== layout)];
  for (const h of order) {
    const rec = edits.record(INTERIORS, h);
    if (!rec) continue;
    for (const inst of rec.instances.values()) {
      if (inst.target !== target || !inst.states[0]) continue;
      const st = edits.record(INTERIORS, decodeText(inst.states[0]));
      if (st && itemTypeName(st.type) === type) return { inst, state: st };
    }
  }
  return undefined;
}

/** Owner faction of the layout's furniture (taken from neighbours). */
function ownerOf(edits: WorldEdits, layout: string): string | undefined {
  const rec = edits.record(INTERIORS, layout);
  for (const inst of rec?.instances.values() ?? []) {
    const st = inst.states[0] ? edits.record(INTERIORS, decodeText(inst.states[0])) : undefined;
    const f = str(st, 'owner faction ID');
    if (f) return f;
  }
  return undefined;
}

function shiftY(st: GameRecord, dy: number): void {
  for (const k of ['player furniture Y offset', 'world Y pos']) {
    const v = st.floats.get(k);
    if (v !== undefined) st.floats.set(k, v + dy);
  }
}

export interface InteriorPlaceResult {
  key: string;
  state: string;
  floor: number;
  /** The state was copied from the same object (undefined — built from scratch). */
  template?: string;
}

/**
 * Place furniture or an item point in a layout. The state is a copy of the state of the same
 * object (lock, use points), the floor matches the neighbour nearest in height, the faction
 * matches the layout's furniture.
 */
export function placeInterior(
  edits: WorldEdits,
  types: RecordTypes,
  layout: string,
  target: string,
  position: Vec3,
  rotation: Vec4,
  label = 'New object in an interior',
): InteriorPlaceResult {
  requireLoaded(edits);
  if (!interiorLayout(edits, layout)) throw new UiTextError({ en: `No layout ${layout}`, ru: `Нет раскладки ${layout}`, zh: `没有布局 ${layout}` });
  const head = types.headline(target);
  const type = itemTypeName(head?.type ?? -1);
  if (type !== 'BUILDING' && type !== 'ITEM_PLACEMENT_GROUP') throw new UiTextError({ en: `${target}: inside go furniture (BUILDING) and item points (ITEM_PLACEMENT_GROUP), and this is ${type || 'an unknown record'}`, ru: `${target}: внутрь ставят мебель (BUILDING) и точки предметов (ITEM_PLACEMENT_GROUP), а это ${type || 'неизвестная запись'}`, zh: `${target}：内部只能放置家具（BUILDING）和物品点（ITEM_PLACEMENT_GROUP），而这是 ${type || '未知记录'}` });
  const floor = floorAt(layoutObjects(edits, types, layout), position[1]);
  const tpl = templateOf(edits, layout, target, type === 'BUILDING' ? 'GAMESTATE_BUILDING' : 'ITEM_PLACEMENT_GROUP');
  const owner = ownerOf(edits, layout);
  let stateId = '';
  const key = edits.place(
    INTERIORS,
    layout,
    target,
    position,
    rotation,
    {
      states: (k, newId) => {
        stateId = type === 'BUILDING' ? `${k}-S23` : newId();
        let st: GameRecord;
        if (tpl) {
          st = cloneRecord(tpl.state);
          st.stringId = stateId;
          shiftY(st, position[1] - tpl.inst.position[1]);
        } else if (type === 'BUILDING') {
          st = emptyRecord(itemTypeId('GAMESTATE_BUILDING') ?? 0, stateId, encodeText('0'));
          st.strings.set('name', head?.name ?? encodeText(''));
          st.ints.set('version', 270);
          st.floats.set('construction progress', 1);
          st.bools.set('is inside building', true);
          st.bools.set('is complete', true);
        } else {
          st = emptyRecord(itemTypeId('ITEM_PLACEMENT_GROUP') ?? 0, stateId, encodeText('0'));
          st.floats.set('respawn time', 0);
          st.bools.set('is inside building', true);
        }
        st.ints.set('floornum', floor);
        if (type === 'BUILDING' && owner) st.strings.set('owner faction ID', encodeText(owner));
        if (type === 'ITEM_PLACEMENT_GROUP') st.strings.set('base data sid', encodeText(target));
        return [st];
      },
    },
    label,
  );
  const out: InteriorPlaceResult = { key, state: stateId, floor };
  if (tpl) out.template = tpl.state.stringId;
  return out;
}

/** Move / rotate a layout object; if the height changed, the floor and height in the state follow. */
export function moveInterior(edits: WorldEdits, types: RecordTypes, layout: string, key: string, position: Vec3, rotation: Vec4, label = 'Move object in an interior'): void {
  requireLoaded(edits);
  const cur = layoutObject(edits, types, layout, key);
  if (!cur) throw new UiTextError({ en: `No object ${key} in layout ${layout}`, ru: `Нет объекта ${key} в раскладке ${layout}`, zh: `布局 ${layout} 中没有对象 ${key}` });
  const dy = position[1] - cur.position[1];
  const floor = cur.floor === undefined ? undefined : floorAt(layoutObjects(edits, types, layout), position[1], key);
  edits.transaction(label, () => {
    edits.move(INTERIORS, layout, key, position, rotation, {}, label);
    const sid = cur.state;
    if (sid === undefined || !edits.record(INTERIORS, sid)) return;
    if (Math.abs(dy) < 1e-4 && (floor === undefined || floor === cur.floor)) return;
    edits.editState(INTERIORS, sid, (st) => {
      shiftY(st, dy);
      if (floor !== undefined) st.ints.set('floornum', floor);
    });
  });
}

/** Remove an object from a layout. */
export function removeInterior(edits: WorldEdits, layout: string, key: string, label = 'Remove object from an interior'): void {
  requireLoaded(edits);
  edits.remove(INTERIORS, layout, key, label);
}

export interface LayoutUsage {
  /** Buildings in the world with this layout by name (`interior layout name`). */
  named: BuildingPlacement[];
  /** Buildings of the same type without a layout name: the game decides which one to use. */
  unnamed: BuildingPlacement[];
  /** Total buildings of this type in the world. */
  total: number;
}

/** Where in the world the buildings with this layout stand. */
export function layoutUsage(world: WorldIndex, layout: InteriorLayout): LayoutUsage {
  const out: LayoutUsage = { named: [], unnamed: [], total: 0 };
  const name = layout.name.toLowerCase();
  for (const b of world.buildings()) {
    if (b.target !== layout.building) continue;
    out.total++;
    const l = (layout.exterior ? b.exterior : b.interior) ?? '';
    if (!l) out.unnamed.push(b);
    else if (l.toLowerCase() === name) out.named.push(b);
  }
  return out;
}

/** A world building's layout by the name from its state (undefined — the game chooses, or no such layout). */
export function layoutOfBuilding(edits: WorldEdits, b: Pick<BuildingPlacement, 'target' | 'interior' | 'exterior'>, exterior = false): InteriorLayout | undefined {
  requireLoaded(edits);
  const name = (exterior ? b.exterior : b.interior)?.toLowerCase();
  if (!name) return undefined;
  return interiorLayouts(edits, b.target).find((l) => l.exterior === exterior && l.name.toLowerCase() === name);
}
