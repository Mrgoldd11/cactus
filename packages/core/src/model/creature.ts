/**
 * «Own creature» workshop: a new animal from the modder's own model (Blender → Kenshi IO Tools:
 * `.mesh` + `.skeleton` with clips), with the behaviour of a vanilla animal.
 *
 * How the game finds an animal's pieces (fcs.def + vanilla data):
 *  - ANIMAL_CHARACTER `race` → RACE: body `male/female mesh` (its `.skeleton` is linked by name and
 *    lies next to it), `body texture`, `nm` (normal map), `male/female ragdoll` (`.phs`);
 *  - clips are found by name in that skeleton: ANIMAL_CHARACTER `animations` / `strafe anim` →
 *    ANIMAL_ANIMATION `anim name`, attacks → COMBAT_TECHNIQUE with `animal` = `attack type`,
 *    `anim name`. A clip that is not there leaves the animal frozen in that action;
 *  - the ragdoll (`.phs`) binds its bodies to skeleton bones by name. Kenshi IO Tools cannot export
 *    one, so a new animal borrows a vanilla ragdoll; its bones must exist in the new skeleton;
 *  - the sample race's `hairs` (ATTACHMENT) are meshes skinned to the sample skeleton (goat fur):
 *    they are cleared for an own model;
 *  - animal traders: SQUAD_TEMPLATE with `is trader` and a non-empty `animals` list; the trader's
 *    «Show me your animals» line (CHOOSE_ANIMALS_BUYING) sells what that list holds;
 *  - a new-game start with the animal: NEW_GAME_STARTOFF `squad` → SQUAD_TEMPLATE `animals`.
 *
 * No disk access here: files come parsed, paths come as the records will hold them.
 */
import { decodeText, encodeText } from '../text.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import type { OgreMesh } from '../mesh/ogre-mesh.ts';
import type { OgreSkeleton } from '../mesh/ogre-skeleton.ts';
import type { UiText } from '../ui-text.ts';
import { EditError, type ModContext } from './context.ts';

const ANIMAL = 'ANIMAL_CHARACTER';
const RACE = 'RACE';
const SQUAD = 'SQUAD_TEMPLATE';
const START = 'NEW_GAME_STARTOFF';

const str = (rec: GameRecord | undefined, key: string): string => {
  const v = rec?.strings.get(key);
  return v ? decodeText(v) : '';
};
const fileField = (rec: GameRecord | undefined, key: string): string => {
  const v = rec?.files.get(key);
  return v ? decodeText(v) : '';
};

// ---------------------------------------------------------------------------------------------
// Ragdoll (.phs) bone names

/**
 * Bone names a ragdoll `.phs` binds to. The file is PhysX data with length-prefixed strings
 * (u32 length + ASCII): the bone names, an actor name and the path of the mesh it was made for.
 * We read those strings and keep the ones that are not paths; the binary layout around them is
 * not decoded.
 */
export function phsBoneNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i + 4 < bytes.length) {
    const len = view.getUint32(i, true);
    if (len >= 1 && len <= 64 && i + 4 + len <= bytes.length && isNameStart(bytes[i + 4]!)) {
      let ok = true;
      for (let j = i + 4; j < i + 4 + len; j++) {
        const c = bytes[j]!;
        if (c < 0x20 || c > 0x7e) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const s = String.fromCharCode(...bytes.subarray(i + 4, i + 4 + len));
        if (!/[\\/.]/.test(s) && s !== 'Actor' && !seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
        i += 4 + len;
        continue;
      }
    }
    i++;
  }
  return out;
}

function isNameStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Ragdoll bones the skeleton lacks (by exact name). */
export function ragdollMissingBones(ragdollBones: readonly string[], skeleton: OgreSkeleton): string[] {
  const have = new Set(skeleton.bones.map((b) => b.name));
  return ragdollBones.filter((b) => !have.has(b));
}

/** A ragdoll file vanilla races use, with the races that use it. */
export interface RagdollUse {
  /** Path as records hold it (`.\data\animal\ragdoll\bull.phs`). */
  path: string;
  races: string[];
}

/** Ragdolls of animal races (the race of some ANIMAL_CHARACTER), most used first. */
export function animalRagdolls(ctx: ModContext): RagdollUse[] {
  const byPath = new Map<string, RagdollUse>();
  for (const race of animalRaces(ctx)) {
    const rec = ctx.get(race);
    for (const key of ['male ragdoll', 'female ragdoll']) {
      const p = fileField(rec, key).trim();
      if (p === '') continue;
      const k = p.toLowerCase();
      const use = byPath.get(k) ?? { path: p, races: [] };
      if (!use.races.includes(race)) use.races.push(race);
      byPath.set(k, use);
    }
  }
  return [...byPath.values()].sort((a, b) => b.races.length - a.races.length || a.path.localeCompare(b.path));
}

function animalRaces(ctx: ModContext): string[] {
  const animal = ctx.typeId(ANIMAL);
  const out = new Set<string>();
  for (const sid of ctx.allStringIds()) {
    if (ctx.headline(sid)?.type !== animal || ctx.status(sid) === 'deleted') continue;
    for (const r of ctx.get(sid)?.refs.get('race') ?? []) out.add(r.target);
  }
  return [...out];
}

/**
 * The ragdoll that fits a skeleton best: fewest missing bones, then `prefer` (the sample's own
 * ragdoll: made for that behaviour), then most bones bound (a ragdoll with more bodies follows the
 * model better). `bones` holds the parsed names per path.
 */
export function bestRagdoll(
  skeleton: OgreSkeleton,
  bones: ReadonlyMap<string, readonly string[]>,
  prefer?: string,
): { path: string; missing: string[] } | undefined {
  const preferred = (path: string): boolean => prefer !== undefined && path.toLowerCase() === prefer.toLowerCase();
  let best: { path: string; missing: string[]; bound: number } | undefined;
  for (const [path, names] of bones) {
    if (names.length === 0) continue;
    const missing = ragdollMissingBones(names, skeleton);
    const bound = names.length - missing.length;
    const better =
      !best ||
      missing.length < best.missing.length ||
      (missing.length === best.missing.length &&
        (preferred(path) !== preferred(best.path) ? preferred(path) : bound > best.bound));
    if (better) best = { path, missing, bound };
  }
  return best && { path: best.path, missing: best.missing };
}

// ---------------------------------------------------------------------------------------------
// Clips the game asks for

export type ClipNeedKind = 'move' | 'strafe' | 'attack';

export interface ClipNeed {
  /** Clip name the game looks up in the skeleton. */
  clip: string;
  kind: ClipNeedKind;
  /** Records that ask for it (ANIMAL_ANIMATION, COMBAT_TECHNIQUE). */
  sources: string[];
}

/** Every clip the animal's records name: its animations, strafe and attacks (in that order). */
export function creatureClipNeeds(ctx: ModContext, animal: string): ClipNeed[] {
  const rec = ctx.get(animal);
  if (!rec) return [];
  const out: ClipNeed[] = [];
  const add = (clip: string, kind: ClipNeedKind, source: string): void => {
    if (clip === '') return;
    const have = out.find((n) => n.clip === clip);
    if (have) {
      if (!have.sources.includes(source)) have.sources.push(source);
      return;
    }
    out.push({ clip, kind, sources: [source] });
  };
  for (const r of rec.refs.get('animations') ?? []) add(str(ctx.get(r.target), 'anim name'), 'move', r.target);
  for (const r of rec.refs.get('strafe anim') ?? []) add(str(ctx.get(r.target), 'anim name'), 'strafe', r.target);
  const attack = rec.ints.get('attack type');
  if (attack !== undefined) for (const t of attackTechniques(ctx, attack)) add(str(ctx.get(t), 'anim name'), 'attack', t);
  return out;
}

/** COMBAT_TECHNIQUE records of an animal attack type (`animal` = the type). */
export function attackTechniques(ctx: ModContext, attackType: number): string[] {
  const type = ctx.typeId('COMBAT_TECHNIQUE');
  const out: string[] = [];
  for (const sid of ctx.allStringIds()) {
    if (ctx.headline(sid)?.type !== type || ctx.status(sid) === 'deleted') continue;
    const rec = ctx.get(sid);
    if (rec && rec.ints.get('animal') === attackType && rec.bools.get('disabled') !== true) out.push(sid);
  }
  return out;
}

export interface CreatureCheck {
  /** Clips the records ask for, and whether the skeleton has them. */
  clips: (ClipNeed & { present: boolean })[];
  /** Clips the sample's own skeleton has that the new one lacks (sleep, get up… — used by AI tasks). */
  sampleOnly: string[];
  /** Ragdoll bones the skeleton lacks; undefined — no ragdoll was checked. */
  ragdollMissing?: string[];
  /** The skeleton has no clips at all (exported without animations). */
  noClips: boolean;
}

export function checkCreature(needs: readonly ClipNeed[], skeleton: OgreSkeleton, options: { sampleClips?: readonly string[]; ragdollBones?: readonly string[] } = {}): CreatureCheck {
  const have = new Set(skeleton.animations.map((a) => a.name));
  const asked = new Set(needs.map((n) => n.clip));
  const out: CreatureCheck = {
    clips: needs.map((n) => ({ ...n, present: have.has(n.clip) })),
    sampleOnly: (options.sampleClips ?? []).filter((c) => !have.has(c) && !asked.has(c)),
    noClips: skeleton.animations.length === 0,
  };
  if (options.ragdollBones) out.ragdollMissing = ragdollMissingBones(options.ragdollBones, skeleton);
  return out;
}

export type CreatureVerdict = 'ok' | 'warn' | 'error';

export interface CreatureProblem {
  level: 'warn' | 'error';
  text: UiText;
}

/** What the game will not find, in words; empty — nothing. */
export function creatureProblems(check: CreatureCheck): CreatureProblem[] {
  const out: CreatureProblem[] = [];
  if (check.noClips)
    out.push({
      level: 'error',
      text: {
        en: 'The .skeleton has no animations: export it with «Export animation» on',
        ru: 'В файле .skeleton нет анимаций: экспортируйте с включённым «Export animation»',
        zh: '.skeleton 文件中没有动画：导出时请勾选「Export animation」',
      },
    });
  const missing = check.clips.filter((c) => !c.present).map((c) => c.clip);
  if (missing.length > 0 && !check.noClips)
    out.push({
      level: 'error',
      text: {
        en: `The game asks for animations the file lacks: ${missing.join(', ')} — the animal freezes in these actions`,
        ru: `Игра ищет анимации, которых нет в файле: ${missing.join(', ')} — в этих действиях животное замрёт`,
        zh: `游戏需要文件中没有的动画：${missing.join('、')} —— 动物在这些动作中会僵住`,
      },
    });
  if (check.ragdollMissing && check.ragdollMissing.length > 0) {
    const list = check.ragdollMissing.slice(0, 6).join(', ') + (check.ragdollMissing.length > 6 ? ` +${check.ragdollMissing.length - 6}` : '');
    out.push({
      level: 'error',
      text: {
        en: `The ragdoll binds to bones the skeleton lacks: ${list} — the game may crash when the animal falls`,
        ru: `Рэгдолл цепляется к костям, которых нет в скелете: ${list} — игра может упасть, когда животное упадёт`,
        zh: `布娃娃绑定的骨骼在骨架中不存在：${list} —— 动物倒下时游戏可能崩溃`,
      },
    });
  }
  if (check.sampleOnly.length > 0)
    out.push({
      level: 'warn',
      text: {
        en: `The sample animal also has: ${check.sampleOnly.join(', ')} (sleep, eating and the like) — without them those moments stay still`,
        ru: `У образца есть ещё: ${check.sampleOnly.join(', ')} (сон, еда и т. п.) — без них в эти моменты животное стоит`,
        zh: `样板动物还有：${check.sampleOnly.join('、')}（睡觉、进食等）—— 缺少时这些时刻动物不动`,
      },
    });
  return out;
}

export function creatureVerdict(problems: readonly CreatureProblem[]): CreatureVerdict {
  if (problems.some((p) => p.level === 'error')) return 'error';
  return problems.length > 0 ? 'warn' : 'ok';
}

// ---------------------------------------------------------------------------------------------
// Animal traders and starts

export interface AnimalTrader {
  sid: string;
  /** Animals the trader holds now (ANIMAL_CHARACTER, v0..v2 = min, max, age). */
  animals: Reference[];
  /** Towns that list the trader (TOWN records referring to the squad). */
  towns: string[];
}

/** SQUAD_TEMPLATE traders with animals; the ones in most towns first. */
export function animalTraders(ctx: ModContext): AnimalTrader[] {
  const squad = ctx.typeId(SQUAD);
  const town = ctx.typeId('TOWN');
  const out: AnimalTrader[] = [];
  for (const sid of ctx.allStringIds()) {
    if (ctx.headline(sid)?.type !== squad || ctx.status(sid) === 'deleted') continue;
    const rec = ctx.get(sid);
    const animals = rec?.refs.get('animals') ?? [];
    if (!rec || rec.bools.get('is trader') !== true || animals.length === 0) continue;
    const towns: string[] = [];
    for (const e of ctx.referencesTo(sid)) if (ctx.headline(e.source)?.type === town && !towns.includes(e.source)) towns.push(e.source);
    out.push({ sid, animals: [...animals], towns });
  }
  return out.sort((a, b) => b.towns.length - a.towns.length || a.sid.localeCompare(b.sid));
}

/** Traders that already sell the animal. */
export function tradersSelling(ctx: ModContext, animal: string): string[] {
  return animalTraders(ctx)
    .filter((t) => t.animals.some((a) => a.target === animal))
    .map((t) => t.sid);
}

/** Starts (NEW_GAME_STARTOFF) whose squad comes with animals: samples for a start with a new animal. */
export function animalStarts(ctx: ModContext): string[] {
  const start = ctx.typeId(START);
  const out: string[] = [];
  for (const sid of ctx.allStringIds()) {
    if (ctx.headline(sid)?.type !== start || ctx.status(sid) === 'deleted') continue;
    const squads = ctx.get(sid)?.refs.get('squad') ?? [];
    if (squads.some((s) => (ctx.get(s.target)?.refs.get('animals') ?? []).length > 0)) out.push(sid);
  }
  return out;
}

/** Starts of the mod whose squad holds the animal. */
export function startsWith(ctx: ModContext, animal: string): string[] {
  const start = ctx.typeId(START);
  const out: string[] = [];
  for (const sid of ctx.allStringIds()) {
    if (ctx.headline(sid)?.type !== start || ctx.status(sid) === 'deleted') continue;
    const squads = ctx.get(sid)?.refs.get('squad') ?? [];
    if (squads.some((s) => (ctx.get(s.target)?.refs.get('animals') ?? []).some((a) => a.target === animal))) out.push(sid);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Creating

/** ANIMAL_CHARACTER records that can be a sample (they have a race with a body mesh). */
export function creatureSamples(ctx: ModContext): string[] {
  const animal = ctx.typeId(ANIMAL);
  const out: string[] = [];
  for (const sid of ctx.allStringIds()) {
    if (ctx.headline(sid)?.type !== animal || ctx.status(sid) === 'deleted') continue;
    const race = ctx.get(ctx.get(sid)?.refs.get('race')?.[0]?.target ?? '');
    if (race && /\.mesh$/i.test(fileField(race, 'male mesh') || fileField(race, 'female mesh'))) out.push(sid);
  }
  return out;
}

export function newCreatureNameProblem(ctx: ModContext, name: string): UiText | undefined {
  const want = name.trim().toLowerCase();
  if (want === '') return { en: 'Enter a name for the animal', ru: 'Введите имя животного', zh: '请输入动物名称' };
  for (const type of [ctx.typeId(ANIMAL), ctx.typeId(RACE)]) {
    for (const sid of ctx.allStringIds()) {
      const h = ctx.headline(sid);
      if (!h || h.type !== type || ctx.status(sid) === 'deleted') continue;
      if (decodeText(h.name).trim().toLowerCase() === want)
        return { en: `This name is taken (${sid})`, ru: `Это имя уже занято (${sid})`, zh: `此名称已被使用（${sid}）` };
    }
  }
  return undefined;
}

/**
 * Suggested `scale` of a new body: its height (Y extent of the bounds) over the sample body's, to two
 * decimals; undefined when a height is zero.
 */
export function creatureScale(mesh: Pick<OgreMesh, 'bounds'>, sampleMesh: Pick<OgreMesh, 'bounds'>): number | undefined {
  const h = (m: Pick<OgreMesh, 'bounds'>): number => m.bounds.max[1] - m.bounds.min[1];
  const own = h(mesh);
  const base = h(sampleMesh);
  if (!(own > 0) || !(base > 0)) return undefined;
  return Math.round((own / base) * 100) / 100;
}

export interface CreatureSpec {
  /** ANIMAL_CHARACTER whose behaviour (animations, attacks, stats, drops) is copied. */
  sample: string;
  name: string;
  /** Body `.mesh` as records hold it (`.\mods\My Mod\donkey.mesh`); its `.skeleton` lies next to it. */
  mesh: string;
  texture?: string;
  normalMap?: string;
  /** Ragdoll `.phs`; empty — the sample race's one. */
  ragdoll?: string;
  /**
   * Size of the new body relative to the sample's (height ratio): hull, footprint and portrait
   * distance are scaled by it so the animal does not walk through walls or float in its picture.
   */
  scale?: number;
  /** Traders that will sell it: min, max on sale and age (as in `animals`). */
  traders?: { sid: string; min: number; max: number; age?: number }[];
  /** Also a new-game start: a copy of this start (its squad's animals replaced by the new animal). */
  startFrom?: string;
  /** Start name (default: «<start> — <animal>»). */
  startName?: string;
}

export interface CreatureResult {
  race: string;
  animal: string;
  start?: string;
  squad?: string;
}

const SCALED_FLOATS = ['hull size X', 'hull size Y', 'hull size Z', 'pathfind footprint radius', 'portrait distance', 'portrait offset y', 'portrait offset z', 'swim offset'];

/** History label (step-title.ts turns it into words). */
export function creatureLabel(name: string, sampleName: string): string {
  return `новое существо «${name}» на основе «${sampleName}»`;
}

/**
 * New animal of the mod as one undo step: a copy of the sample's race with the own model, a copy of
 * the sample animal on that race, the traders' `animals` lists, and optionally a start.
 */
export function createCreature(ctx: ModContext, spec: CreatureSpec): CreatureResult {
  const sample = ctx.get(spec.sample);
  if (!sample || ctx.typeName(sample.type) !== ANIMAL || ctx.status(spec.sample) === 'deleted')
    throw new EditError({ en: `${spec.sample} is not an animal`, ru: `${spec.sample} — не животное`, zh: `${spec.sample} 不是动物` });
  const sampleRace = sample.refs.get('race')?.[0]?.target;
  if (!sampleRace || !ctx.get(sampleRace))
    throw new EditError({ en: 'The sample animal has no race', ru: 'У животного-образца нет расы', zh: '样板动物没有种族' });
  const problem = newCreatureNameProblem(ctx, spec.name);
  if (problem) throw new EditError(problem);
  if (!/\.mesh$/i.test(spec.mesh.trim())) throw new EditError({ en: 'Choose a .mesh file', ru: 'Выберите файл .mesh', zh: '请选择 .mesh 文件' });
  const name = spec.name.trim();
  return ctx.transaction(creatureLabel(name, decodeText(sample.name)), () => {
    const race = ctx.duplicateRecord(sampleRace, { name });
    ctx.editRecord(race, (r) => {
      const set = (key: string, v: string | undefined): void => {
        r.files.set(key, encodeText(v ?? ''));
      };
      for (const g of ['male', 'female']) {
        set(`${g} mesh`, spec.mesh.trim());
        set(`body texture ${g}`, spec.texture);
        set(`nm ${g}`, spec.normalMap);
        for (const k of [`nm ${g} skinny`, `nm ${g} strong`, `body mask ${g}`, `part map ${g}`, `flayed texture ${g}`, `flayed normal ${g}`])
          if (r.files.has(k)) set(k, '');
        if (spec.ragdoll !== undefined && spec.ragdoll.trim() !== '') set(`${g} ragdoll`, spec.ragdoll.trim());
      }
      // Fur and similar attachments are skinned to the sample's skeleton.
      r.refs.delete('hairs');
      r.refs.delete('hair colors');
      if (spec.scale !== undefined && spec.scale > 0 && Number.isFinite(spec.scale))
        for (const k of SCALED_FLOATS) {
          const v = r.floats.get(k);
          if (v !== undefined) r.floats.set(k, Math.round(v * spec.scale * 100) / 100);
        }
    });
    const animal = ctx.duplicateRecord(spec.sample, { name });
    ctx.setReferences(animal, 'race', [{ ...(sample.refs.get('race')![0]!), target: race }]);
    for (const t of spec.traders ?? []) {
      const sq = ctx.get(t.sid);
      if (!sq || ctx.typeName(sq.type) !== SQUAD) continue;
      ctx.addReference(t.sid, 'animals', animal, [t.min, t.max, t.age ?? 0]);
    }
    const out: CreatureResult = { race, animal };
    if (spec.startFrom !== undefined) Object.assign(out, makeStart(ctx, spec.startFrom, animal, spec.startName ?? `${ctx.name(spec.startFrom) ?? spec.startFrom} — ${name}`));
    return out;
  });
}

function makeStart(ctx: ModContext, from: string, animal: string, name: string): { start: string; squad: string } {
  const src = ctx.get(from);
  if (!src || ctx.typeName(src.type) !== START)
    throw new EditError({ en: `${from} is not a game start`, ru: `${from} — не старт игры`, zh: `${from} 不是开局` });
  const srcSquad = (src.refs.get('squad') ?? []).find((s) => (ctx.get(s.target)?.refs.get('animals') ?? []).length > 0) ?? src.refs.get('squad')?.[0];
  if (!srcSquad) throw new EditError({ en: 'The start has no squad', ru: 'У старта нет отряда', zh: '该开局没有小队' });
  const start = ctx.duplicateRecord(from, { name });
  const squad = ctx.duplicateRecord(srcSquad.target, { name: `${name} squad` });
  ctx.setReferences(squad, 'animals', [{ target: animal, v0: 1, v1: 1, v2: 0 }]);
  ctx.setReferences(
    start,
    'squad',
    (ctx.get(start)?.refs.get('squad') ?? []).map((s) => (s.target === srcSquad.target ? { ...s, target: squad } : s)),
  );
  return { start, squad };
}
