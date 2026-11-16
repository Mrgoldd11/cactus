/**
 * "Where in game": a chain of back references from a record up to a place in the world.
 *
 * Example: katana ← stock "weapon vendor UC big city" (VENDOR_LIST.weapons) ← squad
 * "weapon vendor UC big" (SQUAD_TEMPLATE.vendors) ← the towns Heft and Heng (TOWN.residents) →
 * town coordinates from `leveldata.level`, the shop building from the zone.
 *
 * Only "upward" links from the `UP_EDGES` table are followed (who sells, who carries, where
 * the squad lives, which dialogue package…), otherwise back references lead into recipes, research
 * and other things unrelated to a place in the world. The result is a tree (each record
 * is expanded once, repeats are marked) and a summary: role (sold / carried / lives…),
 * carrier squad and places.
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Vec3 } from '../format/types.ts';
import type { ModContext } from '../model/context.ts';
import { formatPosition, type BuildingPlacement, type Placement, type TownPlacement, type WorldIndex, type ZoneCoord } from './world.ts';
import { UiTextError } from '../ui-text.ts';

export type WhereRole = 'placed' | 'sold' | 'carried' | 'lying' | 'loot' | 'member' | 'lives' | 'says' | 'related';

export interface WhereEdge {
  ru: string;
  en: string;
  zh?: string;
  /** Role, if this is the first step from the source record. */
  role?: WhereRole;
}

const sold: WhereEdge = { ru: 'в ассортименте', en: 'in vendor list', zh: '在商品列表中', role: 'sold' };
const gear: WhereEdge = { ru: 'снаряжение', en: 'equipment', zh: '装备', role: 'carried' };
const placed: WhereEdge = { ru: 'в группе предметов', en: 'in item placement group', zh: '在物品摆放组中', role: 'lying' };
const member: WhereEdge = { ru: 'в отряде', en: 'squad member', zh: '小队成员', role: 'member' };
const town: WhereEdge = { ru: 'живут в городе', en: 'town residents', zh: '城镇居民', role: 'lives' };
const faction: WhereEdge = { ru: 'отряды фракции', en: 'faction squads', zh: '派系小队', role: 'lives' };
const wild: WhereEdge = { ru: 'бродят в биоме', en: 'biome spawns', zh: '生物群系刷新', role: 'lives' };
const says: WhereEdge = { ru: 'диалог', en: 'dialogue', zh: '对话', role: 'says' };

/** `TYPE.category` (of the source record) → meaning of the link. `TYPE.*` — any category. */
export const UP_EDGES: Readonly<Record<string, WhereEdge>> = {
  'VENDOR_LIST.*': sold,
  'CHARACTER.weapons': gear,
  'CHARACTER.crossbows': gear,
  'CHARACTER.clothing': gear,
  'CHARACTER.inventory': { ru: 'в инвентаре', en: 'inventory', zh: '物品栏', role: 'carried' },
  'CHARACTER.vendors': { ru: 'торгует', en: 'trades from', zh: '出售来自' },
  'ANIMAL_CHARACTER.weapon': gear,
  'ITEM_PLACEMENT_GROUP.*': placed,
  'SQUAD_TEMPLATE.special items': { ru: 'особые предметы отряда', en: 'squad special items', zh: '小队特殊物品', role: 'carried' },
  'SQUAD_TEMPLATE.vendors': { ru: 'торговец отряда', en: 'squad vendor', zh: '小队商人' },
  'SQUAD_TEMPLATE.leader': { ru: 'лидер отряда', en: 'squad leader', zh: '小队首领', role: 'member' },
  'SQUAD_TEMPLATE.squad': member,
  'SQUAD_TEMPLATE.squad2': member,
  'SQUAD_TEMPLATE.choosefrom list': { ru: 'один из вариантов', en: 'choose-from list', zh: '候选列表', role: 'member' },
  'SQUAD_TEMPLATE.animals': { ru: 'животные отряда', en: 'squad animals', zh: '小队动物', role: 'member' },
  'SQUAD_TEMPLATE.animals2': { ru: 'животные отряда', en: 'squad animals', zh: '小队动物', role: 'member' },
  'SQUAD_TEMPLATE.housemates': { ru: 'соседи по дому', en: 'housemates', zh: '室友', role: 'lives' },
  'SQUAD_TEMPLATE.slaves': { ru: 'рабы отряда', en: 'slaves', zh: '小队奴隶', role: 'lives' },
  'SQUAD_TEMPLATE.prisoners': { ru: 'пленники отряда', en: 'prisoners', zh: '小队囚犯', role: 'lives' },
  'SQUAD_TEMPLATE.building': { ru: 'здание отряда', en: 'squad building', zh: '小队建筑', role: 'lives' },
  'SQUAD_TEMPLATE.dialog leader': { ru: 'диалог лидера', en: 'leader dialogue', zh: '首领对话', role: 'says' },
  'SQUAD_TEMPLATE.dialog squad': { ru: 'диалог отряда', en: 'squad dialogue', zh: '小队对话', role: 'says' },
  'SQUAD_TEMPLATE.dialog animal': { ru: 'диалог животных', en: 'animal dialogue', zh: '动物对话', role: 'says' },
  'UNIQUE_SQUAD_TEMPLATE.leader': { ru: 'лидер отряда', en: 'squad leader', zh: '小队首领', role: 'member' },
  'UNIQUE_SQUAD_TEMPLATE.squad': member,
  'TOWN.residents': town,
  'TOWN.default resident': { ru: 'жители по умолчанию', en: 'default residents', zh: '默认居民', role: 'lives' },
  'TOWN.bar squads': { ru: 'в баре города', en: 'bar squads', zh: '酒吧小队', role: 'lives' },
  'TOWN.roaming squads': { ru: 'бродят у города', en: 'roaming squads', zh: '城镇周边游荡小队', role: 'lives' },
  'TOWN.loot spawn': { ru: 'добыча в городе', en: 'loot spawn', zh: '战利品刷新', role: 'loot' },
  'TOWN.override town': { ru: 'вариант города', en: 'town override of', zh: '城镇变体' },
  'TOWN.debris building': { ru: 'обломки в городе', en: 'debris building', zh: '城镇废墟', role: 'lives' },
  'FACTION.residents': faction,
  'FACTION.default resident': faction,
  'FACTION.bar squads': faction,
  'FACTION.squads': faction,
  'FACTION.squad default': faction,
  'FACTION.roaming squads': faction,
  'FACTION.item spawns': { ru: 'добыча фракции', en: 'faction item spawns', zh: '派系物品刷新', role: 'loot' },
  'FACTION.dialog default': { ru: 'диалог фракции', en: 'faction dialogue', zh: '派系对话', role: 'says' },
  'FACTION_CAMPAIGN.squads to use': { ru: 'отряды набега', en: 'campaign squads', zh: '袭击小队', role: 'lives' },
  'FACTION_CAMPAIGN.special leader': { ru: 'лидер набега', en: 'campaign leader', zh: '袭击首领', role: 'member' },
  'SINGLE_DIPLOMATIC_ASSAULT.main squad': { ru: 'отряд набега', en: 'assault squad', zh: '袭击小队', role: 'lives' },
  'BIOME_GROUP.homeless spawns': wild,
  'BIOMES.homeless spawns': wild,
  'BIOME_GROUP.nests': { ru: 'гнездо в биоме', en: 'biome nest', zh: '生物群系巢穴', role: 'lives' },
  'BIOMES.nests': { ru: 'гнездо в биоме', en: 'biome nest', zh: '生物群系巢穴', role: 'lives' },
  'BUILDING.spawns': { ru: 'появляются у здания', en: 'building spawns', zh: '建筑刷新', role: 'lives' },
  'ROAD.spawns': { ru: 'на дорогах', en: 'road spawns', zh: '道路刷新', role: 'lives' },
  'NEW_GAME_STARTOFF.squad': { ru: 'старт игры', en: 'game start', zh: '游戏开局', role: 'member' },
  'NEW_GAME_STARTOFF.town': { ru: 'старт игры', en: 'game start', zh: '游戏开局', role: 'lives' },
  'DIALOGUE_LINE.lines': { ru: 'продолжение реплики', en: 'follows line', zh: '后续台词', role: 'says' },
  'DIALOGUE.lines': { ru: 'реплика диалога', en: 'dialogue line', zh: '对话台词', role: 'says' },
  'DIALOGUE_PACKAGE.dialogs': { ru: 'в пакете диалогов', en: 'in dialogue package', zh: '在对话包中', role: 'says' },
  'DIALOGUE_PACKAGE.inheritsFrom': { ru: 'наследуется пакетом', en: 'inherited by', zh: '被继承于', role: 'says' },
  'CHARACTER.dialogue': says,
  'CHARACTER.announcement dialogue': says,
  'CHARACTER.dialogue package': { ru: 'пакет диалогов персонажа', en: 'character dialogue package', zh: '角色对话包', role: 'says' },
};

/** Types that are a "place" by themselves: further up we follow only the table, but the place is recorded. */
const PLACE_KIND: Readonly<Record<string, WherePlace['kind']>> = {
  TOWN: 'town',
  FACTION: 'faction',
  BIOME_GROUP: 'biome',
  BIOMES: 'biome',
  ROAD: 'road',
  NEW_GAME_STARTOFF: 'start',
  FACTION_CAMPAIGN: 'campaign',
  SINGLE_DIPLOMATIC_ASSAULT: 'campaign',
};

export function upEdge(sourceType: string, category: string): WhereEdge | undefined {
  return UP_EDGES[`${sourceType}.${category}`] ?? UP_EDGES[`${sourceType}.*`];
}

export interface WhereRecordInfo {
  id: string;
  type: string;
  name: string;
  /** Russian name (from gamedata.po), if any. */
  localizedName?: string;
}

export interface SquadInfo {
  trader: boolean;
  leader: WhereRecordInfo[];
  members: WhereRecordInfo[];
  faction: WhereRecordInfo[];
  interior?: string;
  exterior?: string;
}

export interface WherePosition {
  position: Vec3;
  zone?: ZoneCoord;
  /** The town it belongs to (for buildings). */
  town?: WhereRecordInfo;
  /** Label (building name etc.). */
  label?: string;
}


/** Path step: record `id` references the previous path record via category `category`. */
export interface WhereStep extends WhereRecordInfo {
  category: string;
  ru: string;
  en: string;
}

export interface WherePlace extends WhereRecordInfo {
  kind: 'town' | 'faction' | 'biome' | 'road' | 'start' | 'campaign' | 'building';
  positions: WherePosition[];
  /** Path from the carrier (or the source record) to the place. Empty if the place is the carrier itself. */
  path: WhereStep[];
  /** The town got into the summary only through its variant (`override town`): destroyed, captured… */
  variant?: WhereRecordInfo;
}

export interface WhereNode extends WhereRecordInfo {
  /** Link: this record references the lower node via category `category`. */
  via?: { category: string; ru: string; en: string; zh?: string };
  /** Icon path (field `icon`, relative to the game folder), if any. */
  icon?: string;
  up: WhereNode[];
  /** The record is already expanded higher in the tree. */
  repeat?: boolean;
  /** How many links are not shown because of limits. */
  hidden?: number;
  squad?: SquadInfo;
  /** Coordinates: towns, squad buildings, record instances in zones. */
  towns?: TownPlacement[];
  buildings?: BuildingPlacement[];
  instances?: { count: number; sample: Placement[] };
}

export interface WhereFact {
  role: WhereRole;
  /** The squad (or character) through which the record gets into the world. */
  holder?: WhereRecordInfo & { squad?: SquadInfo };
  /** Path from the source record to the carrier (or to the place record if there is no carrier). */
  path: WhereStep[];
  places: WherePlace[];
}

export interface WhereResult {
  root: WhereNode;
  facts: WhereFact[];
  /** Whether there was a world (level files) — without it there are no coordinates. */
  hasWorld: boolean;
  /** The tree was cut by a limit. */
  truncated: boolean;
}

export interface WhereOptions {
  world?: WorldIndex;
  /** Maximum tree nodes (default 400). */
  maxNodes?: number;
  /** Maximum links shown per node (default 40). */
  maxChildren?: number;
  /** Maximum depth (default 10). */
  maxDepth?: number;
  /** How many zone instances to show per node (default 5). */
  instanceSample?: number;
}

/**
 * Translated name without the gender markup of the game's translations, masculine form:
 * ru `Оружейни/кца1/` → `Оружейник`, `Главн/аяый1/` → `Главный`; de `Bäcker/FEM-IN-ME/` →
 * `Bäcker`; pt `Bandid/OA3/` → `Bandido`.
 */
export function plainName(s: string): string {
  return s.replace(/\/([^/]*?)\d?\//g, (_, inner: string) => {
    for (const e of ['ец', 'ий', 'ый', 'ой', 'ин', 'к']) if (inner.startsWith(e) || inner.endsWith(e)) return e;
    // Upper-case pair of endings (pt `OA`): the first one is masculine.
    if (/^[A-Z]{2}$/.test(inner)) return inner[0]!.toLowerCase();
    // A tag that marks only the feminine form (de `FEM-IN-ME`): the masculine has no suffix.
    if (/^[A-Z]+(?:-[A-Z]+)+$/.test(inner)) return '';
    return inner;
  });
}

function info(ctx: ModContext, id: string, rec?: GameRecord): WhereRecordInfo {
  const r = rec ?? ctx.get(id);
  const out: WhereRecordInfo = { id, type: r ? ctx.typeName(r.type) : '?', name: r ? decodeText(r.name) : id };
  const ru = ctx.localizedName(id);
  if (ru) out.localizedName = ru;
  return out;
}

function squadInfo(ctx: ModContext, rec: GameRecord): SquadInfo {
  const refs = (cat: string): WhereRecordInfo[] => (rec.refs.get(cat) ?? []).map((r) => info(ctx, r.target));
  const s = (k: string): string | undefined => {
    const v = rec.strings.get(k);
    const t = v ? decodeText(v) : '';
    return t === '' ? undefined : t;
  };
  const out: SquadInfo = { trader: rec.bools.get('is trader') ?? false, leader: refs('leader'), members: refs('squad'), faction: refs('faction') };
  const interior = s('layout interior');
  const exterior = s('layout exterior');
  if (interior) out.interior = interior;
  if (exterior) out.exterior = exterior;
  return out;
}

export interface WhereParent {
  source: string;
  category: string;
  edge: WhereEdge;
}

/** Upward links of a record: who references it per the `UP_EDGES` table (no repeats). */
export function whereParents(ctx: ModContext, id: string): WhereParent[] {
  const seen = new Set<string>();
  const out: WhereParent[] = [];
  for (const e of ctx.referencesTo(id)) {
    if (e.source === id || e.category.startsWith('instance:')) continue;
    const src = ctx.get(e.source);
    if (!src) continue;
    const edge = upEdge(itemTypeName(src.type), e.category);
    if (!edge) continue;
    const k = `${e.source}\u0000${e.category}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ source: e.source, category: e.category, edge });
  }
  const name = (s: string): string => ctx.name(s) ?? s;
  return out.sort((a, b) => name(a.source).localeCompare(name(b.source)) || a.category.localeCompare(b.category));
}

const STEP_LIMIT = 200_000;

interface RawFact {
  role: WhereRole;
  holder?: string;
  path: WhereParent[];
  places: Map<string, WhereParent[]>;
}

class WhereWalker {
  private readonly parentsCache = new Map<string, WhereParent[]>();
  private readonly aboveCache = new Map<string, Map<string, WhereParent[]>>();
  private steps = 0;

  readonly ctx: ModContext;
  readonly world: WorldIndex | undefined;

  constructor(ctx: ModContext, world: WorldIndex | undefined) {
    this.ctx = ctx;
    this.world = world;
  }

  parents(s: string): WhereParent[] {
    let p = this.parentsCache.get(s);
    if (!p) this.parentsCache.set(s, (p = whereParents(this.ctx, s)));
    return p;
  }

  type(s: string): string {
    const r = this.ctx.get(s);
    return r ? this.ctx.typeName(r.type) : '?';
  }

  step(p: WhereParent): WhereStep {
    return { ...info(this.ctx, p.source), category: p.category, ru: p.edge.ru, en: p.edge.en, ...(p.edge.zh ? { zh: p.edge.zh } : {}) };
  }

  /**
   * A town variant (`Heng (override) …`) without its own place in the world: show the base town
   * that `override town` points to, not the variant.
   */
  private isTownVariant(s: string): boolean {
    if (this.world && this.world.towns(s).length > 0) return false;
    return this.parents(s).some((p) => p.category === 'override town');
  }

  /** Places above the record (towns, factions, biomes…) → path to them (links bottom-up). */
  placesAbove(s: string, stack = new Set<string>()): Map<string, WhereParent[]> {
    const cached = this.aboveCache.get(s);
    if (cached) return cached;
    const out = new Map<string, WhereParent[]>();
    if (stack.has(s) || ++this.steps > STEP_LIMIT) return out;
    const kind = PLACE_KIND[this.type(s)];
    if (kind && !this.isTownVariant(s)) out.set(s, []);
    stack.add(s);
    for (const p of this.parents(s)) {
      // Above a place we go only from a town variant to its base town (game starts, maps etc. are not "where").
      if (kind && p.category !== 'override town') continue;
      for (const [place, path] of this.placesAbove(p.source, stack)) {
        const prev = out.get(place);
        if (!prev || prev.length > path.length + 1) out.set(place, [p, ...path]);
      }
    }
    stack.delete(s);
    this.aboveCache.set(s, out);
    return out;
  }

  /** Walk from the source record to carriers (squads) and to places without a carrier. */
  facts(rootId: string): RawFact[] {
    const facts = new Map<string, RawFact>();
    const add = (role: WhereRole, holder: string | undefined, path: WhereParent[], places: Map<string, WhereParent[]>): void => {
      const k = `${role}\u0000${holder ?? ''}`;
      let f = facts.get(k);
      if (!f) {
        f = { role, ...(holder ? { holder } : {}), path, places: new Map() };
        facts.set(k, f);
      }
      // Without a carrier each place has its own path from the source record.
      for (const [pl, rest] of places) if (!f.places.has(pl)) f.places.set(pl, holder ? rest : [...path, ...rest]);
    };
    const walk = (s: string, role: WhereRole | undefined, character: string | undefined, path: WhereParent[], stack: Set<string>): void => {
      if (stack.has(s) || ++this.steps > STEP_LIMIT) return;
      const type = this.type(s);
      const r = role ?? (type === 'SQUAD_TEMPLATE' || type === 'UNIQUE_SQUAD_TEMPLATE' ? 'lives' : 'related');
      if (type === 'SQUAD_TEMPLATE' || type === 'UNIQUE_SQUAD_TEMPLATE') {
        add(r, s, path, this.placesAbove(s));
        return;
      }
      if (PLACE_KIND[type]) {
        if (character) add(r, character, path, this.placesAbove(s));
        else add(r, undefined, [], new Map([...this.placesAbove(s)].map(([k, v]) => [k, [...path, ...v]])));
        return;
      }
      const ps = this.parents(s);
      const ch = type === 'CHARACTER' || type === 'ANIMAL_CHARACTER' ? s : character;
      if (ps.length === 0 && s !== rootId && ch === s) add(r, s, path, new Map());
      stack.add(s);
      for (const p of ps) {
        // A vendor list given to a town or faction as loot is no longer "sold".
        const next = p.edge.role === 'loot' ? 'loot' : (role ?? p.edge.role ?? 'related');
        walk(p.source, next, ch, [...path, p], stack);
      }
      stack.delete(s);
    };
    walk(rootId, undefined, undefined, [], new Set());
    return [...facts.values()];
  }
}

const KIND_ORDER: WherePlace['kind'][] = ['town', 'building', 'faction', 'biome', 'road', 'campaign', 'start'];
const ROLE_ORDER: WhereRole[] = ['placed', 'sold', 'carried', 'lying', 'loot', 'member', 'lives', 'says', 'related'];

export function whereInGame(ctx: ModContext, id: string, options: WhereOptions = {}): WhereResult {
  const world = options.world;
  const maxNodes = options.maxNodes ?? 400;
  const maxChildren = options.maxChildren ?? 40;
  const maxDepth = options.maxDepth ?? 10;
  const sampleSize = options.instanceSample ?? 5;
  const rootRec = ctx.get(id);
  if (!rootRec) throw new UiTextError({ en: `No record “${id}”`, ru: `Нет записи «${id}»`, zh: `没有记录 “${id}”` });
  const w = new WhereWalker(ctx, world);

  const decorate = (node: WhereNode, rec: GameRecord): void => {
    const icon = rec.files.get('icon');
    const iconPath = icon ? decodeText(icon) : '';
    if (iconPath) node.icon = iconPath;
    if (node.type === 'SQUAD_TEMPLATE') node.squad = squadInfo(ctx, rec);
    if (!world) return;
    if (node.type === 'TOWN') {
      const t = world.towns(node.id);
      if (t.length) node.towns = [...t];
    }
    if (node.type === 'SQUAD_TEMPLATE') {
      const b = world.buildingsWithSquad(node.id);
      if (b.length) node.buildings = [...b];
    }
    if (node.type !== 'TOWN') {
      const inst = world.instancesOf(node.id);
      if (inst.length) node.instances = { count: inst.length, sample: inst.slice(0, sampleSize) };
    }
  };

  // Tree: breadth-first walk, each record is expanded once.
  const root: WhereNode = { ...info(ctx, id, rootRec), up: [] };
  decorate(root, rootRec);
  const expanded = new Set<string>([id]);
  let count = 1;
  let truncated = false;
  const queue: { node: WhereNode; depth: number }[] = [{ node: root, depth: 0 }];
  while (queue.length) {
    const { node, depth } = queue.shift()!;
    const ps = w.parents(node.id);
    const limit = depth >= maxDepth ? 0 : Math.min(ps.length, maxChildren, Math.max(0, maxNodes - count));
    for (const p of ps.slice(0, limit)) {
      const rec = ctx.get(p.source)!;
      const child: WhereNode = { ...info(ctx, p.source, rec), via: { category: p.category, ru: p.edge.ru, en: p.edge.en, ...(p.edge.zh ? { zh: p.edge.zh } : {}) }, up: [] };
      count++;
      node.up.push(child);
      if (expanded.has(p.source)) {
        child.repeat = true;
        continue;
      }
      expanded.add(p.source);
      decorate(child, rec);
      queue.push({ node: child, depth: depth + 1 });
    }
    if (ps.length > limit) {
      node.hidden = ps.length - limit;
      truncated = true;
    }
  }

  const facts: WhereFact[] = w.facts(id).map((f) => {
    const places: WherePlace[] = [];
    for (const [pid, path] of f.places) {
      const p = placeOf(ctx, pid, world, path.map((x) => w.step(x)));
      if (p) places.push(p);
    }
    const fact: WhereFact = { role: f.role, path: f.path.map((x) => w.step(x)), places };
    if (f.holder) {
      const rec = ctx.get(f.holder);
      const holder: WhereFact['holder'] = info(ctx, f.holder, rec);
      if (rec && itemTypeName(rec.type) === 'SQUAD_TEMPLATE') {
        holder.squad = squadInfo(ctx, rec);
        places.push(...buildingPlaces(ctx, f.holder, world));
      }
      fact.holder = holder;
    }
    places.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || displayName(a).localeCompare(displayName(b)));
    return fact;
  });
  // The record itself stands in zones (building, furniture, item group…).
  if (world) {
    const inst = world.instancesOf(id).filter((p) => p.holderType !== 'GAMESTATE_TOWN_INSTANCE_LIST');
    if (inst.length) facts.push({ role: 'placed', path: [], places: instancePlaces(ctx, world, inst) });
  }
  // Above — facts with places in ordinary towns; places only in variants (destroyed, captured) — below.
  const located = (f: WhereFact, plain: boolean): number =>
    f.places.filter((p) => p.positions.length > 0 && (!plain || (p.kind === 'town' && !p.variant))).length;
  facts.sort(
    (a, b) =>
      ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
      located(b, true) - located(a, true) ||
      located(b, false) - located(a, false) ||
      b.places.length - a.places.length ||
      (a.holder?.name ?? '').localeCompare(b.holder?.name ?? ''),
  );
  return { root, facts, hasWorld: world !== undefined, truncated };
}

function placeOf(ctx: ModContext, id: string, world: WorldIndex | undefined, path: WhereStep[]): WherePlace | undefined {
  const rec = ctx.get(id);
  if (!rec) return undefined;
  const kind = PLACE_KIND[itemTypeName(rec.type)];
  if (!kind) return undefined;
  const positions: WherePosition[] = [];
  if (kind === 'town' && world) for (const t of world.towns(id)) positions.push({ position: t.position, ...(t.zones[0] ? { zone: t.zones[0] } : {}) });
  const place: WherePlace = { ...info(ctx, id, rec), kind, positions, path };
  const o = path.findIndex((st) => st.category === 'override town');
  if (o > 0) place.variant = path[o - 1]!;
  return place;
}

/** Zone instances → places by town (nearest town) or "outside towns". */
function instancePlaces(ctx: ModContext, world: WorldIndex, inst: readonly Placement[]): WherePlace[] {
  const byTown = new Map<string, WherePlace>();
  for (const p of inst) {
    const t = world.townNear(p);
    const key = t?.target ?? '';
    let place = byTown.get(key);
    if (!place) {
      place = t
        ? { ...info(ctx, t.target), kind: 'town', positions: [], path: [] }
        : { id: '', type: 'WORLD', name: 'outside towns', localizedName: 'вне городов', kind: 'building', positions: [], path: [] };
      byTown.set(key, place);
    }
    place.positions.push({ position: p.position, ...(p.zone ? { zone: p.zone } : {}), ...(t ? { town: info(ctx, t.target) } : {}) });
  }
  return [...byTown.values()];
}

function buildingPlaces(ctx: ModContext, squadId: string, world: WorldIndex | undefined): WherePlace[] {
  if (!world) return [];
  const byTarget = new Map<string, WherePlace>();
  for (const b of world.buildingsWithSquad(squadId)) {
    let place = byTarget.get(b.target);
    if (!place) {
      place = { ...info(ctx, b.target), kind: 'building', positions: [], path: [] };
      byTarget.set(b.target, place);
    }
    place.positions.push({
      position: b.position,
      ...(b.zone ? { zone: b.zone } : {}),
      ...(b.town ? { town: info(ctx, b.town) } : {}),
      ...(b.name ? { label: b.name } : {}),
    });
  }
  return [...byTarget.values()];
}

/** Words of the text summary (CLI, MCP) in one interface language. */
interface WhereWords {
  roles: Readonly<Record<WhereRole, string>>;
  kinds: Readonly<Record<WherePlace['kind'], string>>;
  groups: Readonly<Record<'faction' | 'biome' | 'road' | 'campaign' | 'start', string>>;
  andMore: (n: number) => string;
  squadOfLeader: (squad: string) => string;
  ofSquad: (squad: string) => string;
  noPlace: string;
  variantNote: string;
  icon: string;
  noWorld: string;
  instances: string;
  nothing: string;
  path: string;
  trader: string;
  withHim: string;
  faction: string;
  interior: string;
  exterior: string;
  squad: string;
  morePlaces: (n: number) => string;
  moreFacts: (n: number, total: number) => string;
  tree: string;
  seeAbove: string;
  moreHidden: (n: number) => string;
}

const whereEn: WhereWords = {
  roles: {
    placed: 'Placed in the world',
    sold: 'Sold by',
    carried: 'Carried by',
    lying: 'Lies in the world',
    loot: 'Loot',
    member: 'Member of',
    lives: 'Lives',
    says: 'Says',
    related: 'Related to',
  },
  kinds: { town: 'town', building: 'building', faction: 'faction', biome: 'biome', road: 'roads', start: 'start', campaign: 'raid' },
  groups: { faction: 'factions', biome: 'biomes', road: 'roads', campaign: 'raids', start: 'game start' },
  andMore: (n) => ` and ${n} more`,
  squadOfLeader: (s) => `squad “${s}”`,
  ofSquad: (s) => `squad “${s}”`,
  noPlace: ' — no place in the world found',
  variantNote: ' (* — only in a town variant: destroyed, taken over…)',
  icon: 'icon',
  noWorld: '(level files not loaded — no coordinates)',
  instances: 'Instances in zones',
  nothing: 'Not found in the world: no upward links (vendors, carriers, squads, towns).',
  path: 'path',
  trader: 'trader',
  withHim: 'with',
  faction: 'faction',
  interior: 'interior',
  exterior: 'sign',
  squad: 'squad',
  morePlaces: (n) => `… ${n} more places with coordinates`,
  moreFacts: (n, total) => `… and ${n} more (${total} in total)`,
  tree: 'Links (tree):',
  seeAbove: '  (see above)',
  moreHidden: (n) => `… ${n} more`,
};

const whereRu: WhereWords = {
  roles: {
    placed: 'Размещено в мире',
    sold: 'Продаётся у',
    carried: 'Есть у',
    lying: 'Лежит в мире',
    loot: 'Добыча',
    member: 'Состоит в',
    lives: 'Живёт',
    says: 'Говорит',
    related: 'Связано с',
  },
  kinds: { town: 'город', building: 'здание', faction: 'фракция', biome: 'биом', road: 'дороги', start: 'старт', campaign: 'набег' },
  groups: { faction: 'фракции', biome: 'биомы', road: 'дороги', campaign: 'набеги', start: 'старт игры' },
  andMore: (n) => ` и ещё ${n}`,
  squadOfLeader: (s) => `отряд «${s}»`,
  ofSquad: (s) => `отряда «${s}»`,
  noPlace: ' — место в мире не найдено',
  variantNote: ' (* — только в варианте города: разрушен, захвачен…)',
  icon: 'иконка',
  noWorld: '(файлы уровня не загружены — без координат)',
  instances: 'Экземпляров в зонах',
  nothing: 'В мире не встречается: нет восходящих связей (продавцы, носители, отряды, города).',
  path: 'путь',
  trader: 'торговец',
  withHim: 'с ним',
  faction: 'фракция',
  interior: 'интерьер',
  exterior: 'вывеска',
  squad: 'отряд',
  morePlaces: (n) => `… мест с координатами ещё ${n}`,
  moreFacts: (n, total) => `… и ещё ${n} (всего ${total})`,
  tree: 'Связи (дерево):',
  seeAbove: '  (см. выше)',
  moreHidden: (n) => `… ещё ${n}`,
};

const whereZh: WhereWords = {
  roles: {
    placed: '放置在世界中',
    sold: '出售者',
    carried: '持有者',
    lying: '散落在世界中',
    loot: '战利品',
    member: '所属',
    lives: '居住',
    says: '对话',
    related: '关联',
  },
  kinds: { town: '城镇', building: '建筑', faction: '派系', biome: '生物群系', road: '道路', start: '开局', campaign: '袭击' },
  groups: { faction: '派系', biome: '生物群系', road: '道路', campaign: '袭击', start: '游戏开局' },
  andMore: (n) => ` 等另外 ${n} 个`,
  squadOfLeader: (s) => `小队 “${s}”`,
  ofSquad: (s) => `小队 “${s}”`,
  noPlace: ' — 未在世界中找到位置',
  variantNote: '（* — 仅在城镇变体中：被摧毁、被占领……）',
  icon: '图标',
  noWorld: '（未加载关卡文件 — 无坐标）',
  instances: '区域中的实例',
  nothing: '世界中没有出现：没有上游关联（商人、携带者、小队、城镇）。',
  path: '路径',
  trader: '商人',
  withHim: '同行',
  faction: '派系',
  interior: '室内',
  exterior: '招牌',
  squad: '小队',
  morePlaces: (n) => `… 另有 ${n} 个带坐标的地点`,
  moreFacts: (n, total) => `… 另有 ${n} 条（共 ${total} 条）`,
  tree: '关联（树）：',
  seeAbove: '  （见上文）',
  moreHidden: (n) => `… 另有 ${n} 个`,
};

/** Summary words per interface language; a language without an entry uses English. */
const WHERE_WORDS: Readonly<Record<string, WhereWords>> = { en: whereEn, ru: whereRu, zh: whereZh };

function whereWords(lang = 'en'): WhereWords {
  return WHERE_WORDS[lang] ?? whereEn;
}

/** Role titles in Russian (kept for callers that used them). */
export const WHERE_ROLE_RU: Readonly<Record<WhereRole, string>> = whereRu.roles;

/** Place kinds in Russian (kept for callers that used them). */
export const WHERE_KIND_RU: Readonly<Record<WherePlace['kind'], string>> = whereRu.kinds;

/** Role title in an interface language. */
export function whereRoleText(role: WhereRole, lang = 'en'): string {
  return whereWords(lang).roles[role];
}

/** Short name for humans: Russian (without gender markup), otherwise English. */
export function displayName(r: WhereRecordInfo): string {
  return r.localizedName ? plainName(r.localizedName) : r.name;
}

function nameList(names: string[], max: number, w: WhereWords): string {
  const u = [...new Set(names)];
  return u.length > max ? `${u.slice(0, max).join(', ')}${w.andMore(u.length - max)}` : u.join(', ');
}

/** Who the carrier is, for the summary line: `“Weaponsmith” (squad “weapon vendor UC big”)`. */
export function formatWhereHolder(f: WhereFact, lang = 'en'): string {
  const w = whereWords(lang);
  const h = f.holder;
  if (!h) return '';
  const leader = h.squad?.leader[0];
  if (leader) return `«${displayName(leader)}» (${w.squadOfLeader(h.name)})`;
  return h.type === 'SQUAD_TEMPLATE' ? w.ofSquad(h.name) : `«${displayName(h)}»`;
}

/** One summary line: "Sold by “Weaponsmith” (squad “weapon vendor UC big”): Heft, Heng". */
export function formatWhereFact(f: WhereFact, lang = 'en'): string {
  const w = whereWords(lang);
  const who = formatWhereHolder(f, lang);
  const groups: string[] = [];
  const of = (kind: WherePlace['kind']): string[] => f.places.filter((p) => p.kind === kind).map(displayName);
  const towns = f.places.filter((p) => p.kind === 'town').map((p) => `${displayName(p)}${p.variant ? '*' : ''}`);
  if (towns.length) groups.push(nameList(towns, 10, w));
  for (const kind of ['faction', 'biome', 'road', 'campaign', 'start'] as const) {
    const n = of(kind);
    if (n.length) groups.push(`${w.groups[kind]}: ${nameList(n, 6, w)}`);
  }
  const where = groups.length ? `: ${groups.join('; ')}` : f.places.length ? '' : w.noPlace;
  const note = f.places.some((p) => p.variant) ? w.variantNote : '';
  return `${w.roles[f.role]}${who ? ` ${who}` : ''}${where}${note}`;
}

function label(r: WhereRecordInfo): string {
  return `«${r.name}»${r.localizedName && r.localizedName !== r.name ? ` (${plainName(r.localizedName)})` : ''} [${r.id}]`;
}

/** Path in words: `← VENDOR_LIST “…” [id] (weapons) ← SQUAD_TEMPLATE “…” [id] (vendors)`. */
export function formatWherePath(path: readonly WhereStep[]): string {
  return path.map((s) => `← ${s.type} ${label(s)} (${s.category})`).join(' ');
}

export interface FormatWhereOptions {
  /** Show the link tree. No by default — every summary has a path. */
  tree?: boolean;
  /** How many summaries to show (default 20). */
  maxFacts?: number;
  /** How many places with coordinates per summary (default 8). */
  maxPlaces?: number;
  /** Interface language of the text (`en` by default; MCP stays English). */
  lang?: string;
}

/** Text for the CLI and MCP: summary with paths and coordinates, optionally the link tree. */
export function formatWhere(res: WhereResult, options: FormatWhereOptions = {}): string {
  const lang = options.lang ?? 'en';
  const w = whereWords(lang);
  const lines: string[] = [];
  const r = res.root;
  lines.push(`${r.type} ${label(r)}${r.icon ? `  ${w.icon} ${r.icon}` : ''}`);
  if (!res.hasWorld) lines.push(w.noWorld);
  const maxFacts = options.maxFacts ?? 20;
  const maxPlaces = options.maxPlaces ?? 8;
  if (r.instances) lines.push(`${w.instances}: ${r.instances.count}`);
  if (res.facts.length === 0) lines.push(w.nothing);
  for (const f of res.facts.slice(0, maxFacts)) {
    lines.push('');
    lines.push(formatWhereFact(f, lang));
    if (f.path.length) lines.push(`  ${w.path}: ${formatWherePath(f.path)}`);
    const sq = f.holder?.squad;
    if (sq) {
      const bits = [
        sq.trader ? w.trader : undefined,
        sq.members.length ? `${w.withHim} ${nameList(sq.members.map((x) => `«${x.name}»`), 4, w)}` : undefined,
        sq.faction.length ? `${w.faction} ${sq.faction.map((x) => `«${displayName(x)}»`).join(', ')}` : undefined,
        sq.interior ? `${w.interior} «${sq.interior}»` : undefined,
        sq.exterior ? `${w.exterior} «${sq.exterior}»` : undefined,
      ].filter(Boolean);
      if (bits.length) lines.push(`  ${w.squad}: ${bits.join('; ')}`);
    }
    const located = f.places.filter((x) => x.positions.length > 0);
    for (const p of located.slice(0, maxPlaces)) {
      const via = p.path.length ? `  ${formatWherePath(p.path)}` : '';
      for (const pos of p.positions.slice(0, 4))
        lines.push(
          `  ⌖ ${w.kinds[p.kind]} ${p.kind === 'building' ? `«${pos.label ?? p.name}»` : displayName(p)}  ${formatPosition(pos.position, pos.zone, lang)}${pos.town ? `, ${displayName(pos.town)}` : ''}${via}`,
        );
    }
    if (located.length > maxPlaces) lines.push(`  ${w.morePlaces(located.length - maxPlaces)}`);
  }
  if (res.facts.length > maxFacts) lines.push('', w.moreFacts(res.facts.length - maxFacts, res.facts.length));
  if (options.tree) {
    lines.push('', w.tree);
    const walk = (n: WhereNode, depth: number): void => {
      for (const c of n.up) {
        const pad = '  '.repeat(depth + 1);
        const via = c.via!;
        const edge = lang === 'ru' ? via.ru : lang === 'en' ? via.en : (via.zh ?? via.en);
        lines.push(`${pad}← ${c.type} ${label(c)}  ${via.category} — ${edge}${c.repeat ? w.seeAbove : ''}`);
        for (const t of c.towns ?? []) lines.push(`${pad}    ⌖ ${formatPosition(t.position, t.zones[0], lang)}`);
        walk(c, depth + 1);
      }
      if (n.hidden) lines.push(`${'  '.repeat(depth + 1)}${w.moreHidden(n.hidden)}`);
    };
    walk(r, 0);
  }
  return lines.join('\n');
}
