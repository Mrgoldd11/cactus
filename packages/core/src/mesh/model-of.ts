/**
 * Which 3D model a record has and what to paint it with. In Kenshi the texture is set not by the model's `.material`,
 * but by game records:
 *  - weapon (WEAPON): the model is the `bare sword` field (blade without scabbard) or `mesh`; the texture is on
 *    the "weapon model" (MATERIAL_SPECS_WEAPON) of the manufacturer (WEAPON_MANUFACTURER) that
 *    lists this weapon in `weapon types`;
 *  - armour and clothing (ARMOUR): `mesh`, texture is `material` → MATERIAL_SPECS_CLOTHING;
 *  - building (BUILDING): parts `parts` (BUILDING_PART), each has `phs or mesh`, offset
 *    `offset X/Y/Z` and `material` → MATERIAL_SPEC; a part without material uses the building's material, without
 *    that the town material (we take the most common one among towns). From each part group (v0 > 0)
 *    the game takes one; we take the most likely;
 *  - building part (BUILDING_PART): itself;
 *  - other records: the first file field with `.mesh`.
 *
 * Paths are as in the record (`.\data\items\...`); `gamePath` turns them into `data/items/...`.
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference, Vec3 } from '../format/types.ts';
import type { ModContext } from '../model/context.ts';
import type { UiText } from '../ui-text.ts';

export interface ModelPiece {
  /** Path to the `.mesh` relative to the game folder (`data/items/weapons/mesh/katana05.mesh`). */
  mesh: string;
  /** Diffuse texture, if known. */
  texture?: string;
  normalMap?: string;
  /** Texture tiling (MATERIAL_SPEC `tile X/Y`). */
  tile?: [number, number];
  offset?: Vec3;
  /** Record that gave the model (a building part or the record itself). */
  source: string;
  /** Material record that gave the texture. */
  material?: string;
  /** Record field with the model (`mesh`, `bare sword`, `phs or mesh`). */
  field: string;
  /** Interior part of the building (`interior`), not exterior. */
  interior?: boolean;
  /** Alpha threshold 0..255 (foliage, plants): pixels with `alphaMap` alpha below it are not drawn. */
  alphaTest?: number;
  /**
   * Texture whose alpha is the transparency mask. In Kenshi this is the normal map, not the diffuse
   * texture: the game shader cuts by `normalTex.a` (`objects.hlsl`); the diffuse alpha is gloss.
   */
  alphaMap?: string;
  /**
   * TERRAIN material type: no own texture, the biome ground texture is laid on the model
   * (stones, rocks).
   */
  terrain?: boolean;
  /**
   * Material type TERRAIN on a record that still names its own texture. The game ignores that
   * texture (the terrain shader has no slot for it); the viewer keeps it for UV-mapped meshes
   * and falls back to the ground look for meshes without UVs.
   */
  terrainMode?: boolean;
  /**
   * Material type TRIPLANAR / DUAL_TRIPLANAR: the texture is projected along the world axes
   * (`triplanar.hlsl`: coord = world / 5000 * tile), mesh UVs are not used and often absent.
   */
  triplanar?: boolean;
  /** Second diffuse texture of DUAL_TEXTURE / DUAL_TRIPLANAR, blended in by vertex colour alpha. */
  texture2?: string;
}

export interface RecordModel {
  sid: string;
  type: string;
  pieces: ModelPiece[];
  /** Why something is missing: "part …: .phs is not shown" etc. */
  notes: UiText[];
}

/** `.\data\items\a.mesh` → `data/items/a.mesh`; empty → undefined. */
export function gamePath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  let s = p.trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '');
  return s === '' ? undefined : s;
}

function file(rec: GameRecord, key: string): string | undefined {
  const v = rec.files.get(key);
  return v ? gamePath(decodeText(v)) : undefined;
}

function isMesh(p: string | undefined): p is string {
  return p !== undefined && /\.mesh$/i.test(p);
}

function refs(rec: GameRecord, cat: string): readonly Reference[] {
  return rec.refs.get(cat) ?? [];
}

interface Material {
  sid: string;
  texture?: string;
  normalMap?: string;
  tile?: [number, number];
}

function materialOf(ctx: ModContext, sid: string | undefined): Material | undefined {
  if (!sid) return undefined;
  const m = ctx.get(sid);
  if (!m) return undefined;
  const out: Material = { sid };
  const tex = file(m, 'texture map');
  const nrm = file(m, 'normal map');
  if (tex) out.texture = tex;
  if (nrm) out.normalMap = nrm;
  const tx = m.floats.get('tile X');
  const ty = m.floats.get('tile Y');
  if ((tx !== undefined && tx !== 1) || (ty !== undefined && ty !== 1)) out.tile = [tx ?? 1, ty ?? 1];
  return out;
}

function withMaterial(piece: ModelPiece, mat: Material | undefined): ModelPiece {
  if (!mat) return piece;
  const p: ModelPiece = { ...piece, material: mat.sid };
  if (mat.texture) p.texture = mat.texture;
  if (mat.normalMap) p.normalMap = mat.normalMap;
  if (mat.tile) p.tile = mat.tile;
  return p;
}

const townMaterialCache = new WeakMap<ModContext, string | null>();

/** The most common town material (TOWN.material); the game paints buildings without their own material with it. */
function commonTownMaterial(ctx: ModContext): string | undefined {
  const hit = townMaterialCache.get(ctx);
  if (hit !== undefined) return hit ?? undefined;
  const counts = new Map<string, number>();
  for (const sid of ctx.allStringIds()) {
    const h = ctx.headline(sid);
    if (!h || itemTypeName(h.type) !== 'TOWN') continue;
    const t = ctx.get(sid)?.refs.get('material')?.[0]?.target;
    if (t && ctx.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | undefined;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  townMaterialCache.set(ctx, best ?? null);
  return best;
}

/** The manufacturer that has this weapon in `weapon types`, and its first "weapon model". */
function weaponMaterial(ctx: ModContext, sid: string): Material | undefined {
  for (const e of ctx.referencesTo(sid)) {
    if (e.category !== 'weapon types') continue;
    const maker = ctx.get(e.source);
    const models = maker ? [...refs(maker, 'weapon models')] : [];
    // The most common model: by chance (v1), on a tie the first one.
    models.sort((a, b) => b.v1 - a.v1);
    for (const m of models) {
      const mat = materialOf(ctx, m.target);
      if (mat?.texture) return mat;
    }
  }
  return undefined;
}

/** Pick building parts as the game does, but without randomness: group 0 = all, from others one each. */
function chooseParts(list: readonly Reference[]): Reference[] {
  const out: Reference[] = [];
  const groups = new Map<number, Reference>();
  for (const r of list) {
    if (r.v0 === 0) {
      if (r.v1 > 0) out.push(r);
      continue;
    }
    const best = groups.get(r.v0);
    if (!best || r.v1 > best.v1) groups.set(r.v0, r);
  }
  return [...out, ...groups.values()];
}

function buildingPieces(ctx: ModContext, rec: GameRecord, out: RecordModel, interior: boolean, seen: Set<string>): void {
  const base = materialOf(ctx, refs(rec, 'material')[0]?.target) ?? materialOf(ctx, commonTownMaterial(ctx));
  const cats = interior ? ['interior'] : ['parts'];
  for (const cat of cats)
    for (const r of chooseParts(refs(rec, cat))) partPieces(ctx, r.target, base, out, interior, seen);
}

function partPieces(ctx: ModContext, sid: string, base: Material | undefined, out: RecordModel, interior: boolean, seen: Set<string>): void {
  if (seen.has(sid)) return;
  seen.add(sid);
  const part = ctx.get(sid);
  if (!part) {
    out.notes.push({ en: `part ${sid}: no record`, ru: `часть ${sid}: записи нет`, zh: `部件 ${sid}：没有记录` });
    return;
  }
  const mesh = file(part, 'phs or mesh');
  const own = materialOf(ctx, refs(part, 'material')[0]?.target);
  if (mesh !== undefined && /\.mesh$/i.test(mesh)) {
    const marker = part.bools.get('is for position marker') === true;
    const ox = part.floats.get('offset X') ?? 0;
    const oy = part.floats.get('offset Y') ?? 0;
    const oz = part.floats.get('offset Z') ?? 0;
    const piece: ModelPiece = { mesh, source: sid, field: 'phs or mesh' };
    if (!marker && (ox !== 0 || oy !== 0 || oz !== 0)) piece.offset = [ox, oy, oz];
    if (interior) piece.interior = true;
    out.pieces.push(withMaterial(piece, own ?? base));
  } else if (mesh) {
    const name = ctx.name(sid) ?? sid;
    out.notes.push({ en: `part ${name}: ${mesh} is not a .mesh, not shown`, ru: `часть ${name}: ${mesh} — не .mesh, не показываем`, zh: `部件 ${name}：${mesh} 不是 .mesh，不显示` });
  }
  // Parts can have their own nested parts.
  for (const r of chooseParts(refs(part, 'parts'))) partPieces(ctx, r.target, own ?? base, out, interior, seen);
}

const MESH_FIELDS: Record<string, readonly string[]> = {
  WEAPON: ['bare sword', 'mesh', 'ground mesh'],
  CROSSBOW: ['mesh', 'ground mesh'],
  ARMOUR: ['mesh', 'ground mesh', 'mesh female'],
  ITEM: ['mesh', 'ground mesh'],
};

/** MapFeatureMode (fcs.def): TERRAIN = biome ground texture (if no own), FOLIAGE = alpha cut-outs. */
const MODE_TRIPLANAR = 1;
const MODE_TERRAIN = 2;
const MODE_DUAL_TEXTURE = 3;
const MODE_FOLIAGE = 4;
const MODE_DUAL_TRIPLANAR = 5;

/**
 * FOLIAGE_MESH: a model with the texture from the record itself and, for trees, foliage as a separate model.
 * The cut-out mask is the normal map alpha (for foliage `leaves normal`, without it `normal map`);
 * without a normal map the game takes a flat one (`flat.dds`, alpha 1), so there are no cut-outs.
 */
function foliagePieces(rec: GameRecord, sid: string, out: RecordModel, modeField = 'material type'): void {
  const mesh = file(rec, 'mesh');
  const mode = rec.ints.get(modeField) ?? 0;
  const normal = file(rec, 'normal map');
  if (mesh !== undefined && /\.mesh$/i.test(mesh)) {
    const piece: ModelPiece = { mesh, source: sid, field: 'mesh' };
    const tex = file(rec, 'texture map');
    // TERRAIN without its own texture: ground colour; with its own: like a normal model (otherwise stones look flat)
    if (mode === MODE_TERRAIN && !tex) piece.terrain = true;
    else {
      if (tex) piece.texture = tex;
      if (normal) piece.normalMap = normal;
      const tx = rec.floats.get('tile X') ?? 1;
      const ty = rec.floats.get('tile Y') ?? 1;
      if (tx !== 1 || ty !== 1) piece.tile = [tx, ty];
      if (mode === MODE_TERRAIN) piece.terrainMode = true;
      if (tex && (mode === MODE_TRIPLANAR || mode === MODE_DUAL_TRIPLANAR)) piece.triplanar = true;
      if (tex && (mode === MODE_DUAL_TEXTURE || mode === MODE_DUAL_TRIPLANAR)) {
        const tex2 = file(rec, 'texture map 2');
        if (tex2) piece.texture2 = tex2;
      }
      if (mode === MODE_FOLIAGE && normal) {
        piece.alphaMap = normal;
        piece.alphaTest = rec.ints.get('alpha threshold') ?? 128;
        // MAP_FEATURES: threshold 0 switches the cut-outs off.
        if (piece.alphaTest <= 0) {
          delete piece.alphaMap;
          delete piece.alphaTest;
        }
      }
    }
    out.pieces.push(piece);
  } else if (mesh) out.notes.push({ en: `${mesh} is not a .mesh, not shown`, ru: `${mesh} — не .mesh, не показываем`, zh: `${mesh} 不是 .mesh，不显示` });
  const leaves = file(rec, 'leaves mesh');
  if (isMesh(leaves)) {
    const piece: ModelPiece = { mesh: leaves, source: sid, field: 'leaves mesh' };
    const tex = file(rec, 'leaves texture');
    if (tex) piece.texture = tex;
    const mask = file(rec, 'leaves normal') ?? normal;
    if (mask) {
      piece.normalMap = mask;
      piece.alphaMap = mask;
      piece.alphaTest = rec.ints.get('leaves alpha threshold') ?? 80;
    }
    out.pieces.push(piece);
  }
}

/**
 * Record model. `interior: true`: for a building, interior parts instead of exterior ones.
 * Empty `pieces`: the record has no model (or it is in a `.phs`).
 */
/**
 * The FOLIAGE_MESH rock a foliage-spawned building (`is foliage`: iron, copper) sits on: the
 * first one (by string id, ore rocks first) whose `building type` points at the building.
 */
export function foliageRockOf(ctx: ModContext, building: GameRecord): GameRecord | undefined {
  if (building.bools.get('is foliage') !== true) return undefined;
  let best: GameRecord | undefined;
  let bestOre = false;
  for (const r of ctx.records()) {
    if (itemTypeName(r.type) !== 'FOLIAGE_MESH' || !isMesh(file(r, 'mesh'))) continue;
    if (!refs(r, 'building type').some((x) => x.target === building.stringId)) continue;
    // Plain boulders may name an ore too; the dedicated `ResourceRock` meshes win.
    const ore = /resourcerock/i.test(file(r, 'mesh') ?? '');
    if (!best || (ore && !bestOre) || (ore === bestOre && r.stringId.localeCompare(best.stringId, 'en', { numeric: true }) < 0)) {
      best = r;
      bestOre = ore;
    }
  }
  return best;
}

export function modelOfRecord(ctx: ModContext, sid: string, options: { interior?: boolean } = {}): RecordModel {
  const rec = ctx.get(sid);
  const type = rec ? itemTypeName(rec.type) : '';
  const out: RecordModel = { sid, type, pieces: [], notes: [] };
  if (!rec) {
    out.notes.push({ en: 'no record', ru: 'записи нет', zh: '没有记录' });
    return out;
  }
  if (type === 'BUILDING') {
    buildingPieces(ctx, rec, out, options.interior === true, new Set());
    // Ore deposits have no parts: the game spawns them on a foliage rock that names them.
    if (out.pieces.length === 0 && options.interior !== true) {
      const rock = foliageRockOf(ctx, rec);
      if (rock) foliagePieces(rock, rock.stringId, out);
    }
    return out;
  }
  if (type === 'BUILDING_PART') {
    partPieces(ctx, sid, materialOf(ctx, commonTownMaterial(ctx)), out, false, new Set());
    return out;
  }
  if (type === 'FOLIAGE_MESH') {
    foliagePieces(rec, sid, out);
    return out;
  }
  // MAP_FEATURES (huge scenery from features.dat): same material fields, the mode is `texture mode`.
  if (type === 'MAP_FEATURES') {
    if (rec.bools.get('hidden') !== true) foliagePieces(rec, sid, out, 'texture mode');
    return out;
  }
  const fields = MESH_FIELDS[type] ?? [...rec.files.keys()];
  const field = fields.find((f) => isMesh(file(rec, f)));
  if (!field) return out;
  const piece: ModelPiece = { mesh: file(rec, field)!, source: sid, field };
  let mat: Material | undefined;
  if (type === 'WEAPON') mat = weaponMaterial(ctx, sid);
  else if (type === 'ARMOUR') mat = materialOf(ctx, refs(rec, 'material')[0]?.target);
  else mat = materialOf(ctx, refs(rec, 'material')[0]?.target);
  out.pieces.push(withMaterial(piece, mat));
  return out;
}

/** Does the record have a model (for menus and buttons, without parsing files). */
export function hasModel(ctx: ModContext, sid: string): boolean {
  const rec = ctx.get(sid);
  if (!rec) return false;
  const type = itemTypeName(rec.type);
  if (type === 'BUILDING') return refs(rec, 'parts').length > 0 || refs(rec, 'interior').length > 0 || foliageRockOf(ctx, rec) !== undefined;
  if (type === 'BUILDING_PART') return isMesh(file(rec, 'phs or mesh'));
  for (const f of MESH_FIELDS[type] ?? [...rec.files.keys()]) if (isMesh(file(rec, f))) return true;
  return false;
}
