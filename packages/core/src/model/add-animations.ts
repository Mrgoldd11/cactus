/**
 * «Add animations» wizard (R3): bring clips exported from Blender (Kenshi IO Tools) into a mod.
 *
 * How the game links them (fcs.def + vanilla/Workshop data):
 *  - human clips live inside `.skeleton` files. A RACE lists extra skeletons in `animation files`
 *    → ANIMATION_FILE (`male animation` / `female animation`); their clips are added to (or replace)
 *    the clips of the race body's own skeleton;
 *  - an ANIMATION record is linked to nothing: the game finds the clip by `anim name`, which must equal
 *    the clip name in the skeleton exactly (the classic modding mistake is a near miss);
 *  - animals: ANIMAL_CHARACTER `animations` → ANIMAL_ANIMATION (same `anim name` rule).
 *
 * Ogre (OgreMain, `Skeleton::_mergeSkeletonAnimations` via `_buildMapBoneByName`, both imported by
 * the game) maps the bones of an extra skeleton by name. Bones the race lacks are added (their keys move
 * nothing on the body); a bone present in both whose parent differs throws «Source skeleton incompatible
 * with this skeleton: difference hierarchy between bone…» — very likely a crash.
 *
 * No disk access here: skeletons come parsed, file paths come as the record will hold them.
 */
import { decodeText, encodeText } from '../text.ts';
import type { OgreSkeleton } from '../mesh/ogre-skeleton.ts';
import type { UiText } from '../ui-text.ts';
import { EditError, type ModContext } from './context.ts';

export type AnimRecordType = 'ANIMATION' | 'ANIMAL_ANIMATION';

/** How an exported skeleton fits the skeleton of a race body. */
export interface SkeletonFit {
  fileBones: number;
  raceBones: number;
  /** Bones of the file that the race skeleton has too (by name). */
  common: number;
  /** Bones of the file the race lacks: the game adds them, but they move nothing on the body. */
  extra: string[];
  /** Of `extra`: bones that some clip of the file actually animates. */
  animatedExtra: string[];
  /** Race bones the file lacks: clips simply leave them in place. */
  absent: string[];
  /** Same bone, other parent: Ogre refuses to merge such a file (likely a crash). */
  hierarchy: { bone: string; fileParent: string | null; raceParent: string | null }[];
}

export type FitVerdict = 'ok' | 'warn' | 'error';

export function skeletonFit(file: OgreSkeleton, race: OgreSkeleton): SkeletonFit {
  const raceByName = new Map(race.bones.map((b, i) => [b.name, i]));
  const fileNames = new Set(file.bones.map((b) => b.name));
  const parentName = (s: OgreSkeleton, i: number): string | null => {
    const p = s.bones[i]?.parent ?? -1;
    return p < 0 ? null : (s.bones[p]?.name ?? null);
  };
  const extra: string[] = [];
  const hierarchy: SkeletonFit['hierarchy'] = [];
  let common = 0;
  file.bones.forEach((b, i) => {
    const r = raceByName.get(b.name);
    if (r === undefined) {
      extra.push(b.name);
      return;
    }
    common++;
    const fp = parentName(file, i);
    const rp = parentName(race, r);
    if (fp !== rp) hierarchy.push({ bone: b.name, fileParent: fp, raceParent: rp });
  });
  const extraSet = new Set(extra);
  const animated = new Set<string>();
  for (const a of file.animations)
    for (const t of a.tracks) {
      const n = file.bones[t.bone]?.name;
      if (n !== undefined && extraSet.has(n)) animated.add(n);
    }
  return {
    fileBones: file.bones.length,
    raceBones: race.bones.length,
    common,
    extra,
    animatedExtra: extra.filter((n) => animated.has(n)),
    absent: race.bones.filter((b) => !fileNames.has(b.name)).map((b) => b.name),
    hierarchy,
  };
}

/** error: no common bone or a hierarchy clash; warn: clips move bones the race lacks. */
export function fitVerdict(fit: SkeletonFit): FitVerdict {
  if (fit.common === 0 || fit.hierarchy.length > 0) return 'error';
  if (fit.animatedExtra.length > 0) return 'warn';
  return 'ok';
}

const MAX_LIST = 6;

function list(names: readonly string[]): string {
  return names.length <= MAX_LIST ? names.join(', ') : `${names.slice(0, MAX_LIST).join(', ')} … (+${names.length - MAX_LIST})`;
}

/** The fit in plain words, worst first (empty — the file fits). */
export function skeletonFitText(fit: SkeletonFit): UiText[] {
  const out: UiText[] = [];
  if (fit.common === 0)
    out.push({
      en: 'Not a single bone of the file is in the race skeleton: this file is for another skeleton.',
      ru: 'Ни одной кости файла нет в скелете расы: этот файл сделан для другого скелета.',
      zh: '文件中没有一根骨骼存在于种族骨架中：此文件是为其他骨架制作的。',
    });
  if (fit.hierarchy.length > 0) {
    const h = fit.hierarchy.map((x) => `${x.bone} (${x.fileParent ?? '—'} ≠ ${x.raceParent ?? '—'})`);
    out.push({
      en: `Bones hang on other bones than in the race skeleton: ${list(h)}. The game refuses such a file and is likely to crash.`,
      ru: `Кости висят не на тех костях, что в скелете расы: ${list(h)}. Игра такой файл не принимает и, скорее всего, упадёт.`,
      zh: `骨骼的父骨骼与种族骨架不同：${list(h)}。游戏会拒绝此文件，很可能崩溃。`,
    });
  }
  if (fit.animatedExtra.length > 0)
    out.push({
      en: `The clips move bones the race does not have: ${list(fit.animatedExtra)}. These bones will not move on the body.`,
      ru: `Клипы двигают кости, которых нет у расы: ${list(fit.animatedExtra)}. На теле эти кости двигаться не будут.`,
      zh: `动画移动了种族没有的骨骼：${list(fit.animatedExtra)}。这些骨骼在身体上不会动。`,
    });
  return out;
}

/** One clip of the exported file as the wizard shows it. */
export interface ClipRow {
  clip: string;
  /** Seconds. */
  length: number;
  /** Bone tracks; 0 — the clip moves nothing. */
  tracks: number;
  /** The race already has a clip with this name: the file replaces it in the game. */
  replaces: boolean;
  /** Records of the wizard's type whose `anim name` is exactly this clip. */
  records: string[];
  /** Records whose `anim name` differs from the clip only by case, spaces, `_` or `-`. */
  nearMisses: { sid: string; animName: string }[];
}

/** Clip name compared loosely: the near misses moders make. */
export function looseClipName(s: string): string {
  return s.toLowerCase().replace(/[\s_\-.]+/g, '');
}

function liveOfType(ctx: ModContext, type: string): string[] {
  const id = ctx.typeId(type);
  const out: string[] = [];
  if (id === undefined) return out;
  for (const sid of ctx.allStringIds()) {
    const h = ctx.headline(sid);
    if (h && h.type === id && ctx.status(sid) !== 'deleted') out.push(sid);
  }
  return out;
}

export function animNameOf(ctx: ModContext, sid: string): string {
  const v = ctx.get(sid)?.strings.get('anim name');
  return v ? decodeText(v) : '';
}

/**
 * Rows for the clips of `file`. `raceClips` — clip names the race already has (its body skeleton and
 * the animation files it lists).
 */
export function clipRows(ctx: ModContext, file: OgreSkeleton, raceClips: ReadonlySet<string>, type: AnimRecordType): ClipRow[] {
  const exact = new Map<string, string[]>();
  const loose = new Map<string, { sid: string; animName: string }[]>();
  for (const sid of liveOfType(ctx, type)) {
    const n = animNameOf(ctx, sid);
    if (n === '') continue;
    (exact.get(n) ?? exact.set(n, []).get(n)!).push(sid);
    const l = looseClipName(n);
    (loose.get(l) ?? loose.set(l, []).get(l)!).push({ sid, animName: n });
  }
  return file.animations.map((a) => ({
    clip: a.name,
    length: a.length,
    tracks: a.tracks.length,
    replaces: raceClips.has(a.name),
    records: exact.get(a.name) ?? [],
    // A record whose name is a clip the race really has is not a typo: renaming it would break that clip.
    nearMisses: (loose.get(looseClipName(a.name)) ?? []).filter((m) => m.animName !== a.name && !raceClips.has(m.animName)),
  }));
}

/** Words of a clip or record name: `idle_stand_relax` → idle, stand, relax. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));
}

/**
 * A record of the type whose settings suit the clip best: most words shared between the clip name and
 * the record's `anim name` or name; vanilla records win ties. undefined — nothing alike.
 */
export function suggestAnimSample(ctx: ModContext, clip: string, type: AnimRecordType): string | undefined {
  const want = new Set(words(clip));
  if (want.size === 0) return undefined;
  let best: { sid: string; score: number } | undefined;
  for (const sid of liveOfType(ctx, type)) {
    const have = new Set([...words(animNameOf(ctx, sid)), ...words(ctx.name(sid) ?? '')]);
    let score = 0;
    for (const w of want) if (have.has(w)) score += 2;
    if (score === 0) continue;
    if (ctx.status(sid) === 'base') score += 1;
    if (!best || score > best.score) best = { sid, score };
  }
  return best?.sid;
}

/** Records of the type sorted by name, for the «settings like» lists. */
export function animSamples(ctx: ModContext, type: AnimRecordType): string[] {
  return liveOfType(ctx, type).sort((a, b) => (ctx.name(a) ?? a).localeCompare(ctx.name(b) ?? b));
}

/**
 * Whether the race is an animal (some ANIMAL_CHARACTER has it as `race`): its clip records are
 * ANIMAL_ANIMATION, linked from those characters' `animations`.
 */
export function raceAnimalCharacters(ctx: ModContext, race: string): string[] {
  const animal = ctx.typeId('ANIMAL_CHARACTER');
  const out: string[] = [];
  for (const e of ctx.referencesTo(race)) {
    if (e.category !== 'race' || ctx.status(e.source) === 'deleted') continue;
    if (ctx.headline(e.source)?.type === animal && !out.includes(e.source)) out.push(e.source);
  }
  return out;
}

/** `.\mods\<mod>\<sub>\<file>` — a path inside the mod folder as records hold it. */
export function modFileRecordPath(modFolder: string, sub: string, fileName: string): string {
  const parts = ['.', 'mods', modFolder, ...sub.split(/[\\/]+/).filter((p) => p !== ''), fileName];
  return parts.join('\\');
}

/** Folder name of a mod file: `My Mod.mod` → `My Mod`. */
export function modFolderName(modFileName: string): string {
  return modFileName.replace(/^.*[\\/]/, '').replace(/\.mod$/i, '');
}

function samePath(a: string, b: string): boolean {
  const n = (s: string): string => s.trim().replace(/\//g, '\\').replace(/^(\.\\)+/, '').toLowerCase();
  return n(a) === n(b);
}

/** ANIMATION_FILE records whose male (or, without a male file, female) skeleton is this path. */
export function animationFilesFor(ctx: ModContext, path: string): string[] {
  return liveOfType(ctx, 'ANIMATION_FILE').filter((sid) => {
    const rec = ctx.get(sid);
    const v = rec?.files.get('male animation') ?? rec?.files.get('female animation');
    return v !== undefined && samePath(decodeText(v), path);
  });
}

export interface NewClipRecord {
  clip: string;
  /** Record name (defaults to the clip name). */
  name?: string;
  /** Record of the same type to copy the settings from; without — an empty record. */
  sample?: string;
}

export interface AddAnimationsInput {
  type: AnimRecordType;
  /** Races that get the ANIMATION_FILE in `animation files`. */
  races: string[];
  /** Skeleton paths as the record holds them (`.\mods\X\animations\a.skeleton`). */
  male?: string;
  female?: string;
  /** Name of a new ANIMATION_FILE record. */
  fileName: string;
  /** Use this ANIMATION_FILE (its paths are updated) instead of creating one. */
  reuseFile?: string;
  clips: NewClipRecord[];
  /** Near misses to fix: set `anim name` of the record to the clip name. */
  fixes: { sid: string; clip: string }[];
  /** Animals: ANIMAL_CHARACTER records that get the new clip records in `animations`. */
  animalCharacters?: string[];
}

export interface AddAnimationsResult {
  animationFile: string;
  /** New clip records, in input order. */
  records: string[];
  /** Races that got the file (those that already had it are left out). */
  racesLinked: string[];
  fixed: number;
}

/** History label (step-title.ts turns it into en/ru/zh). */
export function addAnimationsLabel(fileName: string, clips: number, races: number): string {
  return `анимации «${fileName}»: клипов ${clips}, рас ${races}`;
}

/** Everything the wizard does, as one undo step. */
export function applyAddAnimations(ctx: ModContext, input: AddAnimationsInput): AddAnimationsResult {
  if (!input.male && !input.female)
    throw new EditError({ en: 'Choose a skeleton file', ru: 'Выберите файл скелета', zh: '请选择骨骼文件' });
  for (const r of input.races)
    if (!ctx.get(r) || ctx.typeName(ctx.get(r)!.type) !== 'RACE')
      throw new EditError({ en: `${r} is not a race`, ru: `${r} — не раса`, zh: `${r} 不是种族` });
  const typeId = ctx.typeId(input.type);
  const fileType = ctx.typeId('ANIMATION_FILE');
  if (typeId === undefined || fileType === undefined)
    throw new EditError({ en: `Unknown type ${input.type}`, ru: `Неизвестный тип ${input.type}`, zh: `未知类型 ${input.type}` });
  const label = addAnimationsLabel(input.fileName.trim() || 'animations', input.clips.length, input.races.length);
  return ctx.transaction(label, () => {
    let file = input.reuseFile;
    if (file === undefined) {
      file = ctx.createRecord(fileType, input.fileName.trim() || 'animations');
      ctx.setField(file, 'bools', 'preprocess', true);
    }
    if (input.male) ctx.setField(file, 'files', 'male animation', encodeText(input.male));
    if (input.female) ctx.setField(file, 'files', 'female animation', encodeText(input.female));
    const racesLinked: string[] = [];
    for (const race of input.races) {
      const has = (ctx.get(race)?.refs.get('animation files') ?? []).some((r) => r.target === file);
      if (has) continue;
      ctx.addReference(race, 'animation files', file);
      racesLinked.push(race);
    }
    const records: string[] = [];
    for (const c of input.clips) {
      const name = c.name?.trim() || c.clip;
      let sid: string;
      const sample = c.sample !== undefined ? ctx.get(c.sample) : undefined;
      if (sample && sample.type === typeId) sid = ctx.duplicateRecord(c.sample!, { name });
      else sid = ctx.createRecord(typeId, name);
      // The one field that must be exact: the clip name as the skeleton has it.
      ctx.setField(sid, 'strings', 'anim name', encodeText(c.clip));
      records.push(sid);
    }
    for (const f of input.fixes) ctx.setField(f.sid, 'strings', 'anim name', encodeText(f.clip));
    if (input.type === 'ANIMAL_ANIMATION')
      for (const ch of input.animalCharacters ?? [])
        for (const sid of records) if (!(ctx.get(ch)?.refs.get('animations') ?? []).some((r) => r.target === sid)) ctx.addReference(ch, 'animations', sid);
    return { animationFile: file, records, racesLinked, fixed: input.fixes.length };
  });
}
