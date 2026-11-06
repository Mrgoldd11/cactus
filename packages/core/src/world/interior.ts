/**
 * Интерьеры зданий: раскладки мебели и точек предметов в `interiors.level`.
 *
 * Как это устроено в файлах игры (ваниль: 4 слоя, 410 раскладок):
 *  - раскладка — запись INSTANCE_COLLECTION с id `<здание>-<Имя>` (`727-gamedata.base-Noble House`);
 *    поле `associated building` — запись здания (BUILDING), `is exterior` — снаружи (вывески,
 *    флаги; id `EXT-<здание>-<Имя>`), флаги `is shop`, `is bar`, `is recruitment`, `flophouse`;
 *  - у здания много раскладок; какую взять, говорит состояние здания в мире
 *    (`interior layout name`), а где имени нет — игра выбирает сама;
 *  - экземпляры раскладки — мебель (BUILDING: стены, кровати, сундуки) и точки предметов
 *    (ITEM_PLACEMENT_GROUP); позиция и кватернион — от начала координат модели здания;
 *  - у каждого экземпляра состояние: у мебели GAMESTATE_BUILDING `<ключ>-S23` (имя, фракция
 *    владельца, `floornum`, замок, точки использования), у точки предметов — запись
 *    ITEM_PLACEMENT_GROUP со своим id (`base data sid` — что лежит, `floornum`);
 *  - жильцов, охрану и товар в раскладке нет: их ставит игра по шаблонам здания и города.
 *
 * Моды кладут в свой `interiors.level` изменённые экземпляры раскладки (с её полями) и состояния
 * полными копиями; новые ключи — `<n>-<мод>-INGAME`. Модуль без доступа к диску.
 */
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import { emptyRecord, type GameRecord, type Instance, type Vec3, type Vec4 } from '../format/types.ts';
import { cloneRecord } from '../model/record-ops.ts';
import { decodeText, encodeText } from '../text.ts';
import type { WorldEdits } from './edit.ts';
import type { BuildingPlacement, WorldIndex } from './world.ts';

export const INTERIORS = 'interiors.level';

/** Что можно ставить внутрь: мебель и точки предметов. */
export const INTERIOR_TYPES = ['BUILDING', 'ITEM_PLACEMENT_GROUP'] as const;

export interface InteriorLayout {
  /** Id раскладки (`727-gamedata.base-Noble House`). */
  sid: string;
  name: string;
  /** Здание (BUILDING). */
  building: string;
  /** Снаружи здания (вывески, флаги). */
  exterior: boolean;
  shop: boolean;
  bar: boolean;
  recruitment: boolean;
  flophouse: boolean;
  /** Сколько объектов (без удалённых). */
  objects: number;
}

export type InteriorKind = 'furniture' | 'items' | 'other';

export interface InteriorObject {
  /** Ключ экземпляра в раскладке. */
  key: string;
  target: string;
  kind: InteriorKind;
  /** От начала координат модели здания. */
  position: Vec3;
  rotation: Vec4;
  /** Этаж (`floornum` состояния), если есть. */
  floor?: number;
  /** Id записи состояния. */
  state?: string;
  /** У мебели: заперт, уровень замка. */
  locked?: boolean;
  lockLevel?: number;
  /** У точки предметов: что лежит (`base data sid`). */
  items?: string;
}

/** Где взять тип записи по id (ModContext.get / headline). */
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
  if (!edits.isLoaded(INTERIORS)) throw new Error('Интерьеры ещё не прочитаны');
}

/** Раскладки здания (или все, без `building`): сначала внутренние, по имени. */
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

/** Одна раскладка; undefined — нет. */
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

/** Объекты раскладки (без удалённых). */
export function layoutObjects(edits: WorldEdits, types: RecordTypes, layout: string): InteriorObject[] {
  requireLoaded(edits);
  const rec = edits.record(INTERIORS, layout);
  if (!rec) throw new Error(`Нет раскладки ${layout}`);
  const out: InteriorObject[] = [];
  for (const [key, inst] of rec.instances) if (inst.target !== '') out.push(objectOf(edits, types, key, inst));
  return out;
}

/** Один объект раскладки; undefined — нет или удалён. */
export function layoutObject(edits: WorldEdits, types: RecordTypes, layout: string, key: string): InteriorObject | undefined {
  requireLoaded(edits);
  const inst = edits.instance(INTERIORS, layout, key);
  return inst ? objectOf(edits, types, key, inst) : undefined;
}

/** Этаж по высоте: как у ближайшего по высоте объекта с этажом (по умолчанию 0). */
export function floorAt(objects: readonly InteriorObject[], y: number, except?: string): number {
  let best: InteriorObject | undefined;
  for (const o of objects) {
    if (o.floor === undefined || o.key === except) continue;
    if (!best || Math.abs(o.position[1] - y) < Math.abs(best.position[1] - y)) best = o;
  }
  return best?.floor ?? 0;
}

/** Образец состояния: такой же объект в любой раскладке (сначала в этой). */
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

/** Фракция-владелец мебели раскладки (у соседей). */
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
  /** Состояние скопировано с такого же объекта (undefined — собрано заново). */
  template?: string;
}

/**
 * Поставить мебель или точку предметов в раскладку. Состояние — копия состояния такого же
 * объекта (замок, точки использования), этаж — как у ближайшего по высоте соседа, фракция —
 * как у мебели раскладки.
 */
export function placeInterior(
  edits: WorldEdits,
  types: RecordTypes,
  layout: string,
  target: string,
  position: Vec3,
  rotation: Vec4,
  label = 'Новый объект в интерьере',
): InteriorPlaceResult {
  requireLoaded(edits);
  if (!interiorLayout(edits, layout)) throw new Error(`Нет раскладки ${layout}`);
  const head = types.headline(target);
  const type = itemTypeName(head?.type ?? -1);
  if (type !== 'BUILDING' && type !== 'ITEM_PLACEMENT_GROUP') throw new Error(`${target}: внутрь ставят мебель (BUILDING) и точки предметов (ITEM_PLACEMENT_GROUP), а это ${type || 'неизвестная запись'}`);
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

/** Сдвинуть / повернуть объект раскладки; сменил высоту — этаж и высота в состоянии следом. */
export function moveInterior(edits: WorldEdits, types: RecordTypes, layout: string, key: string, position: Vec3, rotation: Vec4, label = 'Сдвиг объекта в интерьере'): void {
  requireLoaded(edits);
  const cur = layoutObject(edits, types, layout, key);
  if (!cur) throw new Error(`Нет объекта ${key} в раскладке ${layout}`);
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

/** Убрать объект из раскладки. */
export function removeInterior(edits: WorldEdits, layout: string, key: string, label = 'Удаление объекта из интерьера'): void {
  requireLoaded(edits);
  edits.remove(INTERIORS, layout, key, label);
}

export interface LayoutUsage {
  /** Здания в мире с этой раскладкой по имени (`interior layout name`). */
  named: BuildingPlacement[];
  /** Здания того же типа без имени раскладки: какую взять, игра решает сама. */
  unnamed: BuildingPlacement[];
  /** Всего зданий этого типа в мире. */
  total: number;
}

/** Где в мире стоят здания с этой раскладкой. */
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

/** Раскладка здания в мире по имени из его состояния (undefined — игра выбирает сама или нет такой). */
export function layoutOfBuilding(edits: WorldEdits, b: Pick<BuildingPlacement, 'target' | 'interior' | 'exterior'>, exterior = false): InteriorLayout | undefined {
  requireLoaded(edits);
  const name = (exterior ? b.exterior : b.interior)?.toLowerCase();
  if (!name) return undefined;
  return interiorLayouts(edits, b.target).find((l) => l.exterior === exterior && l.name.toLowerCase() === name);
}
