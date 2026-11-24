/**
 * Link graphs (stage 5): research tree (what unlocks what, blueprints, cost), crafting
 * (workbench → what it makes → from what) and composition of squads and towns (who, how many, probability,
 * traders). Read-only over resulting records; the edit is the values of one reference (`setLinkValues`),
 * with one undo. Works on any set of mods: broken references are marked `missing`.
 */
import { decodeText } from '../text.ts';
import { itemTypeId } from '../format/item-types.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import { plainName } from '../world/where.ts';
import { EditError, type ModContext, type RecordStatus } from './context.ts';

/** A record in the graph: name, Russian name, state in the mod. */
export interface GraphRef {
  sid: string;
  type: string;
  name: string;
  localized?: string;
  status?: RecordStatus;
  /** The reference exists but the record does not (deleted or from a missing mod). */
  missing?: boolean;
}

/** Reference `from.category → target` and its values (their meaning comes from the schema field). */
export interface GraphLink {
  from: string;
  category: string;
  target: string;
  values: [number, number, number];
  /** How many values the field has by schema (0 = values are not used). */
  arity: number;
}

/** Prebuilt id lists by type (editor index); without it records are scanned. */
export type TypeIndex = ReadonlyMap<string, readonly string[]>;

export interface GraphOptions {
  index?: TypeIndex;
}

function idsOf(ctx: ModContext, type: string, index: TypeIndex | undefined): readonly string[] {
  const got = index?.get(type);
  if (got) return got;
  const t = ctx.typeId(type);
  const out: string[] = [];
  for (const r of ctx.records()) if (r.type === t) out.push(r.stringId);
  return out;
}

export function graphRef(ctx: ModContext, sid: string): GraphRef {
  const rec = ctx.get(sid);
  const loc = ctx.localizedName(sid);
  const out: GraphRef = { sid, type: rec ? ctx.typeName(rec.type) : '?', name: rec ? decodeText(rec.name) : sid };
  if (loc !== undefined) out.localized = plainName(loc);
  const status = ctx.status(sid);
  if (status !== undefined) out.status = status;
  if (!rec) out.missing = true;
  return out;
}

function arityOf(ctx: ModContext, rec: GameRecord, category: string): number {
  return ctx.schema?.types.get(ctx.typeName(rec.type))?.fields.get(category)?.refDefaults?.length ?? 3;
}

function link(ctx: ModContext, rec: GameRecord, category: string, r: Reference): GraphLink {
  return { from: rec.stringId, category, target: r.target, values: [r.v0, r.v1, r.v2], arity: arityOf(ctx, rec, category) };
}

function refs(rec: GameRecord | undefined, category: string): readonly Reference[] {
  return rec?.refs.get(category) ?? [];
}

const int = (rec: GameRecord, key: string, def = 0): number => rec.ints.get(key) ?? def;
const num = (rec: GameRecord, key: string, def = 0): number => rec.floats.get(key) ?? def;
const bool = (rec: GameRecord, key: string): boolean => rec.bools.get(key) ?? false;
const str = (rec: GameRecord, key: string): string => {
  const v = rec.strings.get(key);
  return v ? decodeText(v) : '';
};

// ── Research ─────────────────────────────────────────────────────────────────

export const RESEARCH_TYPE = 'RESEARCH';
/** Fields of what a research "unlocks". */
export const RESEARCH_UNLOCKS = ['enable buildings', 'enable item', 'enable weapon type', 'enable weapon model', 'enable armour', 'enable crossbow', 'enable backpack', 'enable robotics', 'improve buildings'] as const;

export interface ResearchUnlock extends GraphRef {
  field: string;
  link: GraphLink;
}

export interface ResearchCost extends GraphRef {
  amount: number;
  link: GraphLink;
}

export interface ResearchNode extends GraphRef {
  category: string;
  level: number;
  time: number;
  money: number;
  repeats: number;
  blueprintOnly: boolean;
  levelUpgrade: boolean;
  cost: ResearchCost[];
  /** Blueprint item. */
  blueprint?: GraphRef;
  /** Trader lists where the blueprint is sold (VENDOR_LIST.blueprints). */
  soldBy: GraphRef[];
  /** What must be researched first. */
  requires: GraphLink[];
  unlocks: ResearchUnlock[];
}

export interface ResearchGraph {
  nodes: ResearchNode[];
  categories: string[];
}

export function researchGraph(ctx: ModContext, options: GraphOptions = {}): ResearchGraph {
  const soldBy = new Map<string, GraphRef[]>();
  for (const v of idsOf(ctx, 'VENDOR_LIST', options.index)) {
    const rec = ctx.get(v);
    for (const r of refs(rec, 'blueprints')) {
      let list = soldBy.get(r.target);
      if (!list) soldBy.set(r.target, (list = []));
      if (!list.some((x) => x.sid === v)) list.push(graphRef(ctx, v));
    }
  }
  const nodes: ResearchNode[] = [];
  const categories = new Set<string>();
  for (const sid of idsOf(ctx, RESEARCH_TYPE, options.index)) {
    const rec = ctx.get(sid);
    if (!rec) continue;
    const category = str(rec, 'category') || 'Core';
    categories.add(category);
    const node: ResearchNode = {
      ...graphRef(ctx, sid),
      category,
      level: int(rec, 'level', 1),
      time: int(rec, 'time', 12),
      money: int(rec, 'money'),
      repeats: int(rec, 'repeats'),
      blueprintOnly: bool(rec, 'blueprint only'),
      levelUpgrade: bool(rec, 'is level upgrade'),
      cost: refs(rec, 'cost').map((r) => ({ ...graphRef(ctx, r.target), amount: r.v0, link: link(ctx, rec, 'cost', r) })),
      soldBy: soldBy.get(sid) ?? [],
      requires: refs(rec, 'requirements').map((r) => link(ctx, rec, 'requirements', r)),
      unlocks: RESEARCH_UNLOCKS.flatMap((field) => refs(rec, field).map((r) => ({ ...graphRef(ctx, r.target), field, link: link(ctx, rec, field, r) }))),
    };
    const bp = refs(rec, 'blueprint item')[0];
    if (bp) node.blueprint = graphRef(ctx, bp.target);
    nodes.push(node);
  }
  return { nodes, categories: [...categories].sort() };
}

// ── Crafting ─────────────────────────────────────────────────────────────────

/** BUILDING_FUNCTIONALITY fields: what the workbench makes. */
export const CRAFT_FIELDS = ['item crafts', 'weapon crafts', 'armour crafts', 'crossbow crafts', 'backpack crafts', 'robotics crafts', 'produces'] as const;

export interface CraftInput extends GraphRef {
  /** How many units per one item (value / 100). */
  amount: number;
  link: GraphLink;
}

export interface CraftProduct extends GraphRef {
  field: string;
  link: GraphLink;
  /** From what (the item's ingredients; for a workbench with "overrides ingredients", what it consumes). */
  inputs: CraftInput[];
  /** Hours per unit (the item's production time). */
  hours?: number;
}

export interface CraftStation extends GraphRef {
  functionality: GraphRef;
  techLevel: number;
  productionMult: number;
  overrides: boolean;
  consumes: CraftInput[];
  products: CraftProduct[];
}

/** Ingredients of an item (ITEM, CROSSBOW, LIMB_REPLACEMENT). */
export function ingredientsOf(ctx: ModContext, sid: string): CraftInput[] {
  const rec = ctx.get(sid);
  if (!rec) return [];
  return refs(rec, 'ingredients').map((r) => ({ ...graphRef(ctx, r.target), amount: r.v0 / 100, link: link(ctx, rec, 'ingredients', r) }));
}

/** Workbenches: buildings whose function makes or produces something. */
export function craftingStations(ctx: ModContext, options: GraphOptions = {}): CraftStation[] {
  const byFunc = new Map<string, Omit<CraftStation, keyof GraphRef | 'functionality'> | null>();
  const describe = (fsid: string): Omit<CraftStation, keyof GraphRef | 'functionality'> | null => {
    if (byFunc.has(fsid)) return byFunc.get(fsid)!;
    const f = ctx.get(fsid);
    let out: Omit<CraftStation, keyof GraphRef | 'functionality'> | null = null;
    if (f && CRAFT_FIELDS.some((k) => refs(f, k).length > 0)) {
      const overrides = bool(f, 'overrides ingredients');
      const consumes = refs(f, 'consumes').map((r) => ({ ...graphRef(ctx, r.target), amount: r.v1 / 100, link: link(ctx, f, 'consumes', r) }));
      const products = CRAFT_FIELDS.flatMap((field) =>
        refs(f, field).map((r): CraftProduct => {
          const own = ingredientsOf(ctx, r.target);
          const p: CraftProduct = { ...graphRef(ctx, r.target), field, link: link(ctx, f, field, r), inputs: overrides || own.length === 0 ? consumes : own };
          const item = ctx.get(r.target);
          const hours = item?.ints.get('production time');
          if (hours !== undefined) p.hours = hours;
          return p;
        }),
      );
      out = { techLevel: int(f, 'tech level'), productionMult: num(f, 'production mult', 1), overrides, consumes, products };
    }
    byFunc.set(fsid, out);
    return out;
  };
  const stations: CraftStation[] = [];
  for (const sid of idsOf(ctx, 'BUILDING', options.index)) {
    const rec = ctx.get(sid);
    const fref = refs(rec, 'functionality')[0];
    if (!rec || !fref) continue;
    const d = describe(fref.target);
    if (d) stations.push({ ...graphRef(ctx, sid), functionality: graphRef(ctx, fref.target), ...d });
  }
  return stations;
}

// ── Squads and towns ─────────────────────────────────────────────────────────

/** Squad fields with characters. */
export const SQUAD_MEMBER_FIELDS = ['leader', 'squad', 'squad2', 'choosefrom list', 'animals', 'animals2'] as const;
/** Squad fields with other squads. */
export const SQUAD_SQUAD_FIELDS = ['housemates', 'slaves', 'prisoners'] as const;

export interface SquadMember extends GraphRef {
  field: string;
  min: number;
  max: number;
  /** For `choosefrom list`: the chance (weight). */
  chance?: number;
  link: GraphLink;
}

export interface SquadVendor extends GraphRef {
  percent: number;
  link: GraphLink;
}

export interface SquadComposition extends GraphRef {
  faction?: GraphRef;
  trader: boolean;
  members: SquadMember[];
  /** How many random ones from `choosefrom list` (min, max). */
  randomChars: [number, number];
  vendors: SquadVendor[];
  /** Housemates, slaves, prisoners. */
  squads: SquadMember[];
}

/** Min/max from the reference values of a squad field. */
function counts(field: string, r: Reference): { min: number; max: number; chance?: number } {
  if (field === 'leader') return { min: r.v0, max: r.v0 };
  if (field === 'choosefrom list') return { min: 0, max: 1, chance: r.v0 };
  if (field === 'slaves' || field === 'prisoners') return { min: 1, max: 1 };
  // squad, squad2, housemates, animals: v0 = min, v1 = max (0 = no spread).
  return { min: r.v0, max: Math.max(r.v0, r.v1) };
}

export function squadComposition(ctx: ModContext, sid: string): SquadComposition | undefined {
  const rec = ctx.get(sid);
  if (!rec || rec.type !== itemTypeId('SQUAD_TEMPLATE')) return undefined;
  const member = (field: string, r: Reference): SquadMember => ({ ...graphRef(ctx, r.target), field, ...counts(field, r), link: link(ctx, rec, field, r) });
  const vendors = refs(rec, 'vendors').map((r) => ({ ...graphRef(ctx, r.target), percent: r.v0, link: link(ctx, rec, 'vendors', r) }));
  const out: SquadComposition = {
    ...graphRef(ctx, sid),
    trader: bool(rec, 'is trader'),
    members: SQUAD_MEMBER_FIELDS.flatMap((f) => refs(rec, f).map((r) => member(f, r))),
    randomChars: [int(rec, 'num random chars'), int(rec, 'num random chars max')],
    vendors,
    squads: SQUAD_SQUAD_FIELDS.flatMap((f) => refs(rec, f).map((r) => member(f, r))),
  };
  const fac = refs(rec, 'faction')[0];
  if (fac) out.faction = graphRef(ctx, fac.target);
  return out;
}

export interface TownSquad extends GraphRef {
  /** residents, bar squads, roaming squads, default resident or faction residents (default residents from the faction). */
  field: string;
  count: number;
  priority?: number;
  /** Spawn chance, % (for bar squads). */
  chance?: number;
  /** The reference can be edited (`default resident` has no values). */
  link: GraphLink;
}

export interface TownComposition extends GraphRef {
  faction?: GraphRef;
  townType: number;
  squads: TownSquad[];
  /** The town inherits the faction's residents (it has none of its own, or "residents override" is off). */
  usesFaction: boolean;
  /** Town replacements (by world state). */
  overrides: GraphRef[];
}

export function townComposition(ctx: ModContext, sid: string): TownComposition | undefined {
  const rec = ctx.get(sid);
  if (!rec || rec.type !== itemTypeId('TOWN')) return undefined;
  const squads: TownSquad[] = [];
  const add = (owner: GameRecord, field: string, as = field): void => {
    for (const r of refs(owner, field)) {
      const s: TownSquad = { ...graphRef(ctx, r.target), field: as, count: r.v0, link: link(ctx, owner, field, r) };
      if (field === 'residents') s.priority = r.v1;
      if (field === 'bar squads') s.chance = r.v1;
      squads.push(s);
    }
  };
  add(rec, 'residents');
  const facRef = refs(rec, 'faction')[0];
  const fac = facRef ? ctx.get(facRef.target) : undefined;
  const own = refs(rec, 'residents').length;
  const usesFaction = fac !== undefined && refs(fac, 'residents').length > 0 && (own === 0 || !bool(rec, 'residents override'));
  if (usesFaction) add(fac, 'residents', 'faction residents');
  add(rec, 'bar squads');
  add(rec, 'roaming squads');
  add(rec, 'default resident');
  const out: TownComposition = { ...graphRef(ctx, sid), townType: int(rec, 'type'), squads, usesFaction, overrides: refs(rec, 'override town').map((r) => graphRef(ctx, r.target)) };
  if (facRef) out.faction = graphRef(ctx, facRef.target);
  return out;
}

// ── Editing ──────────────────────────────────────────────────────────────────

/**
 * Change the values of reference `from.category → target` (one undo). The reference must be in the
 * resulting record; its place in the list is preserved.
 */
export function setLinkValues(ctx: ModContext, l: Pick<GraphLink, 'from' | 'category' | 'target'>, values: readonly number[]): void {
  const rec = ctx.get(l.from);
  if (!rec) throw new EditError({ en: `No record ${l.from}`, ru: `Нет записи ${l.from}`, zh: `没有记录 ${l.from}` });
  const cur = refs(rec, l.category).find((r) => r.target === l.target);
  if (!cur) throw new EditError({ en: `${l.from} has no reference ${l.category} → ${l.target}`, ru: `У ${l.from} нет ссылки ${l.category} → ${l.target}`, zh: `${l.from} 没有引用 ${l.category} → ${l.target}` });
  for (const v of values) if (!Number.isInteger(v)) throw new EditError({ en: `A reference value is an integer, not ${v}`, ru: `Значение ссылки — целое число, а не ${v}`, zh: `引用值应为整数，而不是 ${v}` });
  const next = [values[0] ?? cur.v0, values[1] ?? cur.v1, values[2] ?? cur.v2];
  if (next[0] === cur.v0 && next[1] === cur.v1 && next[2] === cur.v2) return;
  ctx.addReference(l.from, l.category, l.target, next);
}
