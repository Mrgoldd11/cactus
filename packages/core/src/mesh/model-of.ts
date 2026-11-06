/**
 * Какая 3D-модель у записи и чем её красить. В Kenshi текстуру задаёт не `.material` модели,
 * а записи игры:
 *  - оружие (WEAPON): модель — поле `bare sword` (клинок без ножен) или `mesh`; текстура — у
 *    «модели оружия» (MATERIAL_SPECS_WEAPON) производителя (WEAPON_MANUFACTURER), который
 *    перечисляет это оружие в `weapon types`;
 *  - броня и одежда (ARMOUR): `mesh`, текстура — `material` → MATERIAL_SPECS_CLOTHING;
 *  - здание (BUILDING): части `parts` (BUILDING_PART) — у каждой `phs or mesh`, сдвиг
 *    `offset X/Y/Z` и `material` → MATERIAL_SPEC; без материала у части — материал здания, без
 *    него — материал города (берём самый частый у городов). Из каждой группы частей (v0 > 0)
 *    игра берёт одну — берём самую вероятную;
 *  - часть здания (BUILDING_PART) — она сама;
 *  - прочие записи — первое файловое поле с `.mesh`.
 *
 * Пути — как в записи (`.\data\items\...`); `gamePath` приводит их к виду `data/items/...`.
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord, Reference, Vec3 } from '../format/types.ts';
import type { ModContext } from '../model/context.ts';

export interface ModelPiece {
  /** Путь к `.mesh` относительно папки игры (`data/items/weapons/mesh/katana05.mesh`). */
  mesh: string;
  /** Диффузная текстура, если известна. */
  texture?: string;
  normalMap?: string;
  /** Повтор текстуры (MATERIAL_SPEC `tile X/Y`). */
  tile?: [number, number];
  offset?: Vec3;
  /** Запись, давшая модель (часть здания или сама запись). */
  source: string;
  /** Запись материала, давшая текстуру. */
  material?: string;
  /** Поле записи с моделью (`mesh`, `bare sword`, `phs or mesh`). */
  field: string;
  /** Внутренняя часть здания (`interior`), не наружная. */
  interior?: boolean;
}

export interface RecordModel {
  sid: string;
  type: string;
  pieces: ModelPiece[];
  /** Почему чего-то нет: «часть …: .phs не показываем» и т. п. */
  notes: string[];
}

/** `.\data\items\a.mesh` → `data/items/a.mesh`; пустое → undefined. */
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

/** Самый частый материал городов (TOWN.material) — им игра красит здания без своего материала. */
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

/** Производитель, у которого это оружие в `weapon types`, и его первая «модель оружия». */
function weaponMaterial(ctx: ModContext, sid: string): Material | undefined {
  for (const e of ctx.referencesTo(sid)) {
    if (e.category !== 'weapon types') continue;
    const maker = ctx.get(e.source);
    const models = maker ? [...refs(maker, 'weapon models')] : [];
    // Самая ходовая модель: по шансу (v1), при равенстве — первая.
    models.sort((a, b) => b.v1 - a.v1);
    for (const m of models) {
      const mat = materialOf(ctx, m.target);
      if (mat?.texture) return mat;
    }
  }
  return undefined;
}

/** Выбор частей здания как в игре, но без случайности: группа 0 — все, из других — по одной. */
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
    out.notes.push(`часть ${sid}: записи нет`);
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
  } else if (mesh) out.notes.push(`часть ${ctx.name(sid) ?? sid}: ${mesh} — не .mesh, не показываем`);
  // У частей бывают свои вложенные части.
  for (const r of chooseParts(refs(part, 'parts'))) partPieces(ctx, r.target, own ?? base, out, interior, seen);
}

const MESH_FIELDS: Record<string, readonly string[]> = {
  WEAPON: ['bare sword', 'mesh', 'ground mesh'],
  CROSSBOW: ['mesh', 'ground mesh'],
  ARMOUR: ['mesh', 'ground mesh', 'mesh female'],
  ITEM: ['mesh', 'ground mesh'],
};

/**
 * Модель записи. `interior: true` — для здания внутренние части вместо наружных.
 * Пустой `pieces` — у записи нет модели (или она в `.phs`).
 */
export function modelOfRecord(ctx: ModContext, sid: string, options: { interior?: boolean } = {}): RecordModel {
  const rec = ctx.get(sid);
  const type = rec ? itemTypeName(rec.type) : '';
  const out: RecordModel = { sid, type, pieces: [], notes: [] };
  if (!rec) {
    out.notes.push('записи нет');
    return out;
  }
  if (type === 'BUILDING') {
    buildingPieces(ctx, rec, out, options.interior === true, new Set());
    return out;
  }
  if (type === 'BUILDING_PART') {
    partPieces(ctx, sid, materialOf(ctx, commonTownMaterial(ctx)), out, false, new Set());
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

/** Есть ли у записи модель (для меню и кнопок, без разбора файлов). */
export function hasModel(ctx: ModContext, sid: string): boolean {
  const rec = ctx.get(sid);
  if (!rec) return false;
  const type = itemTypeName(rec.type);
  if (type === 'BUILDING') return refs(rec, 'parts').length > 0 || refs(rec, 'interior').length > 0;
  if (type === 'BUILDING_PART') return isMesh(file(rec, 'phs or mesh'));
  for (const f of MESH_FIELDS[type] ?? [...rec.files.keys()]) if (isMesh(file(rec, f))) return true;
  return false;
}
