/**
 * «Где в игре»: цепочка обратных ссылок от записи вверх до места в мире.
 *
 * Пример: катана ← ассортимент «weapon vendor UC big city» (VENDOR_LIST.weapons) ← отряд
 * «weapon vendor UC big» (SQUAD_TEMPLATE.vendors) ← города Груз и Хэн (TOWN.residents) →
 * координаты города из `leveldata.level`, здание магазина из зоны.
 *
 * Идём только по «восходящим» связям из таблицы `UP_EDGES` (кто продаёт, кто носит, где
 * живёт отряд, какой пакет диалогов…), иначе обратные ссылки уводят в рецепты, исследования
 * и прочее, что к месту в мире отношения не имеет. Результат — дерево (каждая запись
 * раскрывается один раз, повторы помечены) и итог: роль (продаётся / носят / живёт…),
 * отряд-носитель и места.
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Vec3 } from '../format/types.ts';
import type { ModContext } from '../model/context.ts';
import { formatPosition, type BuildingPlacement, type Placement, type TownPlacement, type WorldIndex, type ZoneCoord } from './world.ts';

export type WhereRole = 'placed' | 'sold' | 'carried' | 'lying' | 'loot' | 'member' | 'lives' | 'says' | 'related';

export interface WhereEdge {
  ru: string;
  en: string;
  /** Роль, если это первый шаг от исходной записи. */
  role?: WhereRole;
}

const sold: WhereEdge = { ru: 'в ассортименте', en: 'in vendor list', role: 'sold' };
const gear: WhereEdge = { ru: 'снаряжение', en: 'equipment', role: 'carried' };
const placed: WhereEdge = { ru: 'в группе предметов', en: 'in item placement group', role: 'lying' };
const member: WhereEdge = { ru: 'в отряде', en: 'squad member', role: 'member' };
const town: WhereEdge = { ru: 'живут в городе', en: 'town residents', role: 'lives' };
const faction: WhereEdge = { ru: 'отряды фракции', en: 'faction squads', role: 'lives' };
const wild: WhereEdge = { ru: 'бродят в биоме', en: 'biome spawns', role: 'lives' };
const says: WhereEdge = { ru: 'диалог', en: 'dialogue', role: 'says' };

/** `ТИП.категория` (у записи-источника) → смысл связи. `ТИП.*` — любая категория. */
export const UP_EDGES: Readonly<Record<string, WhereEdge>> = {
  'VENDOR_LIST.*': sold,
  'CHARACTER.weapons': gear,
  'CHARACTER.crossbows': gear,
  'CHARACTER.clothing': gear,
  'CHARACTER.inventory': { ru: 'в инвентаре', en: 'inventory', role: 'carried' },
  'CHARACTER.vendors': { ru: 'торгует', en: 'trades from' },
  'ANIMAL_CHARACTER.weapon': gear,
  'ITEM_PLACEMENT_GROUP.*': placed,
  'SQUAD_TEMPLATE.special items': { ru: 'особые предметы отряда', en: 'squad special items', role: 'carried' },
  'SQUAD_TEMPLATE.vendors': { ru: 'торговец отряда', en: 'squad vendor' },
  'SQUAD_TEMPLATE.leader': { ru: 'лидер отряда', en: 'squad leader', role: 'member' },
  'SQUAD_TEMPLATE.squad': member,
  'SQUAD_TEMPLATE.squad2': member,
  'SQUAD_TEMPLATE.choosefrom list': { ru: 'один из вариантов', en: 'choose-from list', role: 'member' },
  'SQUAD_TEMPLATE.animals': { ru: 'животные отряда', en: 'squad animals', role: 'member' },
  'SQUAD_TEMPLATE.animals2': { ru: 'животные отряда', en: 'squad animals', role: 'member' },
  'SQUAD_TEMPLATE.housemates': { ru: 'соседи по дому', en: 'housemates', role: 'lives' },
  'SQUAD_TEMPLATE.slaves': { ru: 'рабы отряда', en: 'slaves', role: 'lives' },
  'SQUAD_TEMPLATE.prisoners': { ru: 'пленники отряда', en: 'prisoners', role: 'lives' },
  'SQUAD_TEMPLATE.building': { ru: 'здание отряда', en: 'squad building', role: 'lives' },
  'SQUAD_TEMPLATE.dialog leader': { ru: 'диалог лидера', en: 'leader dialogue', role: 'says' },
  'SQUAD_TEMPLATE.dialog squad': { ru: 'диалог отряда', en: 'squad dialogue', role: 'says' },
  'SQUAD_TEMPLATE.dialog animal': { ru: 'диалог животных', en: 'animal dialogue', role: 'says' },
  'UNIQUE_SQUAD_TEMPLATE.leader': { ru: 'лидер отряда', en: 'squad leader', role: 'member' },
  'UNIQUE_SQUAD_TEMPLATE.squad': member,
  'TOWN.residents': town,
  'TOWN.default resident': { ru: 'жители по умолчанию', en: 'default residents', role: 'lives' },
  'TOWN.bar squads': { ru: 'в баре города', en: 'bar squads', role: 'lives' },
  'TOWN.roaming squads': { ru: 'бродят у города', en: 'roaming squads', role: 'lives' },
  'TOWN.loot spawn': { ru: 'добыча в городе', en: 'loot spawn', role: 'loot' },
  'TOWN.override town': { ru: 'вариант города', en: 'town override of' },
  'TOWN.debris building': { ru: 'обломки в городе', en: 'debris building', role: 'lives' },
  'FACTION.residents': faction,
  'FACTION.default resident': faction,
  'FACTION.bar squads': faction,
  'FACTION.squads': faction,
  'FACTION.squad default': faction,
  'FACTION.roaming squads': faction,
  'FACTION.item spawns': { ru: 'добыча фракции', en: 'faction item spawns', role: 'loot' },
  'FACTION.dialog default': { ru: 'диалог фракции', en: 'faction dialogue', role: 'says' },
  'FACTION_CAMPAIGN.squads to use': { ru: 'отряды набега', en: 'campaign squads', role: 'lives' },
  'FACTION_CAMPAIGN.special leader': { ru: 'лидер набега', en: 'campaign leader', role: 'member' },
  'SINGLE_DIPLOMATIC_ASSAULT.main squad': { ru: 'отряд набега', en: 'assault squad', role: 'lives' },
  'BIOME_GROUP.homeless spawns': wild,
  'BIOMES.homeless spawns': wild,
  'BIOME_GROUP.nests': { ru: 'гнездо в биоме', en: 'biome nest', role: 'lives' },
  'BIOMES.nests': { ru: 'гнездо в биоме', en: 'biome nest', role: 'lives' },
  'BUILDING.spawns': { ru: 'появляются у здания', en: 'building spawns', role: 'lives' },
  'ROAD.spawns': { ru: 'на дорогах', en: 'road spawns', role: 'lives' },
  'NEW_GAME_STARTOFF.squad': { ru: 'старт игры', en: 'game start', role: 'member' },
  'NEW_GAME_STARTOFF.town': { ru: 'старт игры', en: 'game start', role: 'lives' },
  'DIALOGUE_LINE.lines': { ru: 'продолжение реплики', en: 'follows line', role: 'says' },
  'DIALOGUE.lines': { ru: 'реплика диалога', en: 'dialogue line', role: 'says' },
  'DIALOGUE_PACKAGE.dialogs': { ru: 'в пакете диалогов', en: 'in dialogue package', role: 'says' },
  'DIALOGUE_PACKAGE.inheritsFrom': { ru: 'наследуется пакетом', en: 'inherited by', role: 'says' },
  'CHARACTER.dialogue': says,
  'CHARACTER.announcement dialogue': says,
  'CHARACTER.dialogue package': { ru: 'пакет диалогов персонажа', en: 'character dialogue package', role: 'says' },
};

/** Типы, которые сами по себе «место»: дальше вверх идём только по таблице, но место фиксируем. */
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
  /** Русское имя (из gamedata.po), если есть. */
  nameRu?: string;
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
  /** Город, к которому относится (для зданий). */
  town?: WhereRecordInfo;
  /** Подпись (имя здания и т. п.). */
  label?: string;
}


/** Шаг пути: запись `id` ссылается на предыдущую запись пути категорией `category`. */
export interface WhereStep extends WhereRecordInfo {
  category: string;
  ru: string;
  en: string;
}

export interface WherePlace extends WhereRecordInfo {
  kind: 'town' | 'faction' | 'biome' | 'road' | 'start' | 'campaign' | 'building';
  positions: WherePosition[];
  /** Путь от носителя (или исходной записи) до места. Пусто, если место — сам носитель. */
  path: WhereStep[];
  /** Город попал в итог только через свой вариант (`override town`): разрушенный, захваченный… */
  variant?: WhereRecordInfo;
}

export interface WhereNode extends WhereRecordInfo {
  /** Связь: эта запись ссылается на нижний узел категорией `category`. */
  via?: { category: string; ru: string; en: string };
  /** Путь к иконке (поле `icon`, относительно папки игры), если есть. */
  icon?: string;
  up: WhereNode[];
  /** Запись уже раскрыта выше в дереве. */
  repeat?: boolean;
  /** Сколько связей не показано из-за лимитов. */
  hidden?: number;
  squad?: SquadInfo;
  /** Координаты: города, здания отряда, экземпляры записи в зонах. */
  towns?: TownPlacement[];
  buildings?: BuildingPlacement[];
  instances?: { count: number; sample: Placement[] };
}

export interface WhereFact {
  role: WhereRole;
  /** Отряд (или персонаж), через которого запись попадает в мир. */
  holder?: WhereRecordInfo & { squad?: SquadInfo };
  /** Путь от исходной записи до носителя (или до записи-места, если носителя нет). */
  path: WhereStep[];
  places: WherePlace[];
}

export interface WhereResult {
  root: WhereNode;
  facts: WhereFact[];
  /** Был ли мир (файлы уровня) — без него координат нет. */
  hasWorld: boolean;
  /** Дерево обрезано лимитом. */
  truncated: boolean;
}

export interface WhereOptions {
  world?: WorldIndex;
  /** Максимум узлов дерева (по умолчанию 400). */
  maxNodes?: number;
  /** Максимум показанных связей у одного узла (по умолчанию 40). */
  maxChildren?: number;
  /** Максимальная глубина (по умолчанию 10). */
  maxDepth?: number;
  /** Сколько экземпляров в зонах показывать на узел (по умолчанию 5). */
  instanceSample?: number;
}

/**
 * Русское имя без разметки рода: `Оружейни/кца1/` → `Оружейник`, `Главн/аяый1/` → `Главный`
 * (берём мужскую форму).
 */
export function plainRuName(s: string): string {
  return s.replace(/\/([^/]*?)\d?\//g, (_, inner: string) => {
    for (const e of ['ец', 'ий', 'ый', 'ой', 'ин', 'к']) if (inner.startsWith(e) || inner.endsWith(e)) return e;
    return inner;
  });
}

function info(ctx: ModContext, id: string, rec?: GameRecord): WhereRecordInfo {
  const r = rec ?? ctx.get(id);
  const out: WhereRecordInfo = { id, type: r ? ctx.typeName(r.type) : '?', name: r ? decodeText(r.name) : id };
  const ru = ctx.localizedName(id);
  if (ru) out.nameRu = ru;
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

/** Восходящие связи записи: кто на неё ссылается по таблице `UP_EDGES` (без повторов). */
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
    return { ...info(this.ctx, p.source), category: p.category, ru: p.edge.ru, en: p.edge.en };
  }

  /**
   * Вариант города (`Heng (override) …`) без своего места в мире: показываем базовый город, на
   * который ведёт `override town`, а не вариант.
   */
  private isTownVariant(s: string): boolean {
    if (this.world && this.world.towns(s).length > 0) return false;
    return this.parents(s).some((p) => p.category === 'override town');
  }

  /** Места выше записи (города, фракции, биомы…) → путь до них (связи снизу вверх). */
  placesAbove(s: string, stack = new Set<string>()): Map<string, WhereParent[]> {
    const cached = this.aboveCache.get(s);
    if (cached) return cached;
    const out = new Map<string, WhereParent[]>();
    if (stack.has(s) || ++this.steps > STEP_LIMIT) return out;
    const kind = PLACE_KIND[this.type(s)];
    if (kind && !this.isTownVariant(s)) out.set(s, []);
    stack.add(s);
    for (const p of this.parents(s)) {
      // Выше места идём только от варианта города к базовому (старты игры, карты и т. п. — не «где»).
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

  /** Обход от исходной записи до носителей (отрядов) и до мест без носителя. */
  facts(rootId: string): RawFact[] {
    const facts = new Map<string, RawFact>();
    const add = (role: WhereRole, holder: string | undefined, path: WhereParent[], places: Map<string, WhereParent[]>): void => {
      const k = `${role}\u0000${holder ?? ''}`;
      let f = facts.get(k);
      if (!f) {
        f = { role, ...(holder ? { holder } : {}), path, places: new Map() };
        facts.set(k, f);
      }
      // Без носителя у каждого места свой путь от исходной записи.
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
        // Список торговца, выданный городу или фракции как добыча, — уже не «продаётся».
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
  if (!rootRec) throw new Error(`Нет записи «${id}»`);
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

  // Дерево: обход в ширину, каждая запись раскрывается один раз.
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
      const child: WhereNode = { ...info(ctx, p.source, rec), via: { category: p.category, ru: p.edge.ru, en: p.edge.en }, up: [] };
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
  // Сама запись стоит в зонах (здание, мебель, группа предметов…).
  if (world) {
    const inst = world.instancesOf(id).filter((p) => p.holderType !== 'GAMESTATE_TOWN_INSTANCE_LIST');
    if (inst.length) facts.push({ role: 'placed', path: [], places: instancePlaces(ctx, world, inst) });
  }
  // Выше — факты с местами в обычных городах; места только в вариантах (разрушен, захвачен) — ниже.
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

/** Экземпляры в зонах → места по городам (ближайший город) или «вне городов». */
function instancePlaces(ctx: ModContext, world: WorldIndex, inst: readonly Placement[]): WherePlace[] {
  const byTown = new Map<string, WherePlace>();
  for (const p of inst) {
    const t = world.townNear(p);
    const key = t?.target ?? '';
    let place = byTown.get(key);
    if (!place) {
      place = t
        ? { ...info(ctx, t.target), kind: 'town', positions: [], path: [] }
        : { id: '', type: 'WORLD', name: 'вне городов', nameRu: 'вне городов', kind: 'building', positions: [], path: [] };
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

export const WHERE_ROLE_RU: Readonly<Record<WhereRole, string>> = {
  placed: 'Размещено в мире',
  sold: 'Продаётся у',
  carried: 'Есть у',
  lying: 'Лежит в мире',
  loot: 'Добыча',
  member: 'Состоит в',
  lives: 'Живёт',
  says: 'Говорит',
  related: 'Связано с',
};

export const WHERE_KIND_RU: Readonly<Record<WherePlace['kind'], string>> = {
  town: 'город',
  building: 'здание',
  faction: 'фракция',
  biome: 'биом',
  road: 'дороги',
  start: 'старт',
  campaign: 'набег',
};

/** Короткое имя для людей: русское (без разметки рода), иначе английское. */
export function displayName(r: WhereRecordInfo): string {
  return r.nameRu ? plainRuName(r.nameRu) : r.name;
}

function nameList(names: string[], max = 10): string {
  const u = [...new Set(names)];
  return u.length > max ? `${u.slice(0, max).join(', ')} и ещё ${u.length - max}` : u.join(', ');
}

/** Кто носитель, для строки итога: `«Оружейник» (отряд «weapon vendor UC big»)`. */
export function formatWhereHolder(f: WhereFact): string {
  const h = f.holder;
  if (!h) return '';
  const leader = h.squad?.leader[0];
  if (leader) return `«${displayName(leader)}» (отряд «${h.name}»)`;
  return h.type === 'SQUAD_TEMPLATE' ? `отряда «${h.name}»` : `«${displayName(h)}»`;
}

/** Одна строка итога: «Продаётся у «Оружейник» (отряд «weapon vendor UC big»): Груз, Хэн». */
export function formatWhereFact(f: WhereFact): string {
  const who = formatWhereHolder(f);
  const groups: string[] = [];
  const of = (kind: WherePlace['kind']): string[] => f.places.filter((p) => p.kind === kind).map(displayName);
  const towns = f.places.filter((p) => p.kind === 'town').map((p) => `${displayName(p)}${p.variant ? '*' : ''}`);
  if (towns.length) groups.push(nameList(towns));
  for (const [kind, title] of [
    ['faction', 'фракции'],
    ['biome', 'биомы'],
    ['road', 'дороги'],
    ['campaign', 'набеги'],
    ['start', 'старт игры'],
  ] as const) {
    const n = of(kind);
    if (n.length) groups.push(`${title}: ${nameList(n, 6)}`);
  }
  const where = groups.length ? `: ${groups.join('; ')}` : f.places.length ? '' : ' — место в мире не найдено';
  const note = f.places.some((p) => p.variant) ? ' (* — только в варианте города: разрушен, захвачен…)' : '';
  return `${WHERE_ROLE_RU[f.role]}${who ? ` ${who}` : ''}${where}${note}`;
}

function label(r: WhereRecordInfo): string {
  return `«${r.name}»${r.nameRu && r.nameRu !== r.name ? ` (${plainRuName(r.nameRu)})` : ''} [${r.id}]`;
}

/** Путь словами: `← VENDOR_LIST «…» [id] (weapons) ← SQUAD_TEMPLATE «…» [id] (vendors)`. */
export function formatWherePath(path: readonly WhereStep[]): string {
  return path.map((s) => `← ${s.type} ${label(s)} (${s.category})`).join(' ');
}

export interface FormatWhereOptions {
  /** Показывать дерево связей. По умолчанию нет — путь есть у каждого итога. */
  tree?: boolean;
  /** Сколько итогов показать (по умолчанию 20). */
  maxFacts?: number;
  /** Сколько мест с координатами на итог (по умолчанию 8). */
  maxPlaces?: number;
}

/** Текст для CLI и MCP: итог с путями и координатами, по желанию — дерево связей. */
export function formatWhere(res: WhereResult, options: FormatWhereOptions = {}): string {
  const lines: string[] = [];
  const r = res.root;
  lines.push(`${r.type} ${label(r)}${r.icon ? `  иконка ${r.icon}` : ''}`);
  if (!res.hasWorld) lines.push('(файлы уровня не загружены — без координат)');
  const maxFacts = options.maxFacts ?? 20;
  const maxPlaces = options.maxPlaces ?? 8;
  if (r.instances) lines.push(`Экземпляров в зонах: ${r.instances.count}`);
  if (res.facts.length === 0) lines.push('В мире не встречается: нет восходящих связей (продавцы, носители, отряды, города).');
  for (const f of res.facts.slice(0, maxFacts)) {
    lines.push('');
    lines.push(formatWhereFact(f));
    if (f.path.length) lines.push(`  путь: ${formatWherePath(f.path)}`);
    const sq = f.holder?.squad;
    if (sq) {
      const bits = [
        sq.trader ? 'торговец' : undefined,
        sq.members.length ? `с ним ${nameList(sq.members.map((x) => `«${x.name}»`), 4)}` : undefined,
        sq.faction.length ? `фракция ${sq.faction.map((x) => `«${displayName(x)}»`).join(', ')}` : undefined,
        sq.interior ? `интерьер «${sq.interior}»` : undefined,
        sq.exterior ? `вывеска «${sq.exterior}»` : undefined,
      ].filter(Boolean);
      if (bits.length) lines.push(`  отряд: ${bits.join('; ')}`);
    }
    const located = f.places.filter((x) => x.positions.length > 0);
    for (const p of located.slice(0, maxPlaces)) {
      const via = p.path.length ? `  ${formatWherePath(p.path)}` : '';
      for (const pos of p.positions.slice(0, 4))
        lines.push(
          `  ⌖ ${WHERE_KIND_RU[p.kind]} ${p.kind === 'building' ? `«${pos.label ?? p.name}»` : displayName(p)}  ${formatPosition(pos.position, pos.zone)}${pos.town ? `, ${displayName(pos.town)}` : ''}${via}`,
        );
    }
    if (located.length > maxPlaces) lines.push(`  … мест с координатами ещё ${located.length - maxPlaces}`);
  }
  if (res.facts.length > maxFacts) lines.push('', `… и ещё ${res.facts.length - maxFacts} (всего ${res.facts.length})`);
  if (options.tree) {
    lines.push('', 'Связи (дерево):');
    const walk = (n: WhereNode, depth: number): void => {
      for (const c of n.up) {
        const pad = '  '.repeat(depth + 1);
        lines.push(`${pad}← ${c.type} ${label(c)}  ${c.via!.category} — ${c.via!.ru}${c.repeat ? '  (см. выше)' : ''}`);
        for (const t of c.towns ?? []) lines.push(`${pad}    ⌖ ${formatPosition(t.position, t.zones[0])}`);
        walk(c, depth + 1);
      }
      if (n.hidden) lines.push(`${'  '.repeat(depth + 1)}… ещё ${n.hidden}`);
    };
    walk(r, 0);
  }
  return lines.join('\n');
}
