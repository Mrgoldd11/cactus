/**
 * «Race compatibility» wizard: make a new race behave like a sample race («like Greenlander»).
 * Finds every place the sample race is referenced (who may wear armour and clothing, weapon
 * damage bonus, dialogue race conditions, race groups, start scenarios, faction population) and
 * what the sample race itself carries (animation files, hairs, heads, body setup, inventory flags,
 * part maps), and offers to add the new race there with the same reference values. The result is a
 * «was → will be» preview in the bulk-edit shape: applied as one undo step, written only into the
 * open mod.
 */
import { decodeText } from '../text.ts';
import type { UiText } from '../ui-text.ts';
import type { GameRecord, Reference } from '../format/types.ts';
import { gamePath } from '../mesh/model-of.ts';
import { EditError, type ModContext } from './context.ts';
import type { BulkPreview } from './bulk.ts';
import type { EditOp } from './ops.ts';
import { lookupRecord } from './search.ts';

/** Change groups in display order. */
export type RaceCompatGroup =
  | 'armour'
  | 'weapons'
  | 'items'
  | 'dialogue'
  | 'raceGroups'
  | 'starts'
  | 'animations'
  | 'factions'
  | 'looks'
  | 'body'
  | 'flags'
  | 'other';

export const RACE_COMPAT_GROUPS: readonly RaceCompatGroup[] = [
  'armour',
  'weapons',
  'items',
  'dialogue',
  'raceGroups',
  'starts',
  'animations',
  'factions',
  'looks',
  'body',
  'flags',
  'other',
];

/** Groups that are checked by default; the rest change NPC looks or population and stay opt-in. */
export const RACE_COMPAT_DEFAULT_ON: ReadonlySet<RaceCompatGroup> = new Set<RaceCompatGroup>([
  'armour',
  'weapons',
  'items',
  'dialogue',
  'raceGroups',
  'starts',
  'animations',
]);

export interface RaceCompatChange {
  /** Unique key of the change (record + field), for checkboxes. */
  key: string;
  group: RaceCompatGroup;
  sid: string;
  /** Record name (for a dialogue line without a name, the start of its text). */
  name: string;
  /** Record type name. */
  type: string;
  /** Field or reference list that changes. */
  field: string;
  before: string;
  after: string;
  /** Layer the record comes from (vanilla file, dependency, context mod or the mod itself). */
  origin: string;
  /**
   * The record comes from a context mod that is not a dependency of the mod: without that mod in
   * the game the edit points at nothing. Unchecked by default.
   */
  contextOnly: boolean;
  /** Checked by default. */
  checked: boolean;
  ops: EditOp[];
}

/** Single-race fields that reference the sample: shown, never changed (that is a swap, not a list). */
export interface RaceCompatInfo {
  sid: string;
  name: string;
  type: string;
  field: string;
}

export interface RaceCompatPlan {
  race: string;
  sample: string;
  raceName: string;
  sampleName: string;
  changes: RaceCompatChange[];
  /** Places that already have the new race next to the sample (nothing to do). */
  already: number;
  info: RaceCompatInfo[];
}

export interface RaceCompatOptions {
  /** Context mods (file names) that are not dependencies of the mod. */
  contextMods?: readonly string[];
}

const RACE = 'RACE';
const DIALOGUE_FIELDS = new Set(['my race', 'my subrace', 'target race', 'no target race']);
const ITEM_TYPES = new Set(['ITEM', 'CONTAINER', 'LIMB_REPLACEMENT', 'NEST_ITEM']);
/** Type → single-race field that is not a list of allowed races. */
const SINGLE_RACE: Record<string, string> = {
  CHARACTER: 'race',
  ANIMAL_CHARACTER: 'race',
  SQUAD_TEMPLATE: 'race override',
  UNIQUE_SQUAD_TEMPLATE: 'race override',
};
/** Outgoing reference lists of the sample race that are copied into the new race. */
const COPY_LISTS: { field: string; group: RaceCompatGroup; whenEmpty?: boolean }[] = [
  { field: 'animation files', group: 'animations' },
  { field: 'hairs', group: 'looks' },
  { field: 'hair colors', group: 'looks' },
  { field: 'heads male', group: 'looks' },
  { field: 'heads female', group: 'looks' },
  // Body setup: a race made from scratch has none of these, so they are ticked when the list is empty.
  { field: 'combat anatomy', group: 'body', whenEmpty: true },
  { field: 'limb replacement', group: 'body', whenEmpty: true },
  { field: 'severed limbs', group: 'body', whenEmpty: true },
  { field: 'AI Goals', group: 'body', whenEmpty: true },
];
const COPY_FLAGS = ['no hats', 'no shirts', 'no shoes'];
const COPY_SINGLE_REFS = ['part map male', 'part map female'];
/** Lists whose v0 means something to the user (percent, share): shown next to the name. */
const VALUE_FIELDS = new Set(['race damage', 'hairs', 'hair colors']);
const MAX_NAMES = 8;

function groupOf(type: string, field: string): RaceCompatGroup {
  if (DIALOGUE_FIELDS.has(field)) return 'dialogue';
  if (type === 'RACE_GROUP') return 'raceGroups';
  if (type === 'NEW_GAME_STARTOFF') return 'starts';
  if (type === 'FACTION' || type === 'FACTION_TEMPLATE') return 'factions';
  if (type === 'ARMOUR') return 'armour';
  if (type === 'WEAPON' || type === 'CROSSBOW') return 'weapons';
  if (ITEM_TYPES.has(type)) return 'items';
  return 'other';
}

/** Record name; a dialogue line has no real name (empty or the type name), so the start of its text. */
function recordName(ctx: ModContext, rec: GameRecord, sid: string): string {
  const name = decodeText(rec.name);
  if (name && name !== ctx.typeName(rec.type)) return name;
  const text = rec.strings.get('text0');
  const t = text ? decodeText(text).replace(/\s+/g, ' ').trim() : '';
  if (t) return t.length > 60 ? `${t.slice(0, 57)}…` : t;
  return sid;
}

function targetName(ctx: ModContext, sid: string): string {
  return ctx.localizedName(sid) ?? ctx.name(sid) ?? sid;
}

function refsText(ctx: ModContext, refs: readonly { target: string; v0: number }[], withValues: boolean): string {
  if (refs.length === 0) return '';
  const names = refs.slice(0, MAX_NAMES).map((r) => (withValues ? `${targetName(ctx, r.target)} (${r.v0})` : targetName(ctx, r.target)));
  return refs.length > MAX_NAMES ? `${names.join(', ')}, … +${refs.length - MAX_NAMES}` : names.join(', ');
}

function values(r: Reference): number[] {
  return [r.v0, r.v1, r.v2];
}

/** A RACE record by id or name; other types, absence and ambiguity give a readable error. */
export function findRace(ctx: ModContext, spec: string): string {
  const text = spec.trim();
  if (text === '') throw new EditError({ en: 'Give the race (id or name)', ru: 'Укажите расу (id или имя)', zh: '请指定种族（ID 或名称）' });
  const hit = lookupRecord(ctx, text, { preferTypes: [RACE] });
  if (hit.stringId === undefined) {
    const races = hit.candidates.filter((c) => c.type === RACE);
    if (races.length === 1) return races[0]!.stringId;
    if (hit.candidates.length > 1)
      throw new EditError({
        en: `“${text}” matches several records — give the id`,
        ru: `«${text}» подходит к нескольким записям — укажите id`,
        zh: `“${text}” 匹配多条记录 — 请指定 ID`,
      });
    throw new EditError({ en: `No race “${text}”`, ru: `Нет расы «${text}»`, zh: `没有种族 “${text}”` });
  }
  const rec = ctx.get(hit.stringId);
  if (!rec || ctx.typeName(rec.type) !== RACE)
    throw new EditError({ en: `“${text}” is not a race`, ru: `«${text}» — не раса`, zh: `“${text}” 不是种族` });
  return hit.stringId;
}

/**
 * Everything the new race needs to work like the sample race. Changes nothing; both must be
 * existing RACE records (ids).
 */
export function planRaceCompat(ctx: ModContext, race: string, sample: string, options: RaceCompatOptions = {}): RaceCompatPlan {
  const raceRec = ctx.get(race);
  const sampleRec = ctx.get(sample);
  for (const [sid, rec] of [
    [race, raceRec],
    [sample, sampleRec],
  ] as const) {
    if (!rec || ctx.status(sid) === 'deleted' || ctx.typeName(rec.type) !== RACE)
      throw new EditError({ en: `${sid} is not a race`, ru: `${sid} — не раса`, zh: `${sid} 不是种族` });
  }
  if (race === sample)
    throw new EditError({ en: 'The new race and the sample are the same race', ru: 'Новая раса и образец — одна и та же раса', zh: '新种族和样板是同一个种族' });
  const contextMods = new Set((options.contextMods ?? []).map((m) => m.toLowerCase()));
  const changes: RaceCompatChange[] = [];
  const info: RaceCompatInfo[] = [];
  let already = 0;

  // Incoming: records that list the sample race → add the new race with the same values.
  const seen = new Set<string>();
  for (const e of ctx.referencesTo(sample)) {
    if (!e.ref || e.source === race || e.source === sample) continue;
    const key = `${e.source}|${e.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = ctx.get(e.source);
    if (!rec || ctx.status(e.source) === 'deleted') continue;
    const type = ctx.typeName(rec.type);
    const name = recordName(ctx, rec, e.source);
    if (SINGLE_RACE[type] === e.category) {
      info.push({ sid: e.source, name, type, field: e.category });
      continue;
    }
    const list = rec.refs.get(e.category) ?? [];
    if (list.some((r) => r.target === race)) {
      already++;
      continue;
    }
    const group = groupOf(type, e.category);
    const origin = ctx.origin(e.source)?.origin ?? ctx.modName;
    const contextOnly = contextMods.has(origin.toLowerCase());
    const withValues = VALUE_FIELDS.has(e.category) || group === 'factions';
    const added = { ...e.ref, target: race };
    changes.push({
      key,
      group,
      sid: e.source,
      name,
      type,
      field: e.category,
      before: refsText(ctx, list, withValues),
      after: refsText(ctx, [...list, added], withValues),
      origin,
      contextOnly,
      checked: RACE_COMPAT_DEFAULT_ON.has(group) && !contextOnly,
      ops: [{ op: 'addRef', id: e.source, category: e.category, target: race, values: values(e.ref) }],
    });
  }

  // Outgoing: what the sample race carries → copy into the new race.
  const raceOrigin = ctx.origin(race)?.origin ?? ctx.modName;
  const raceName = recordName(ctx, raceRec!, race);
  const own = (group: RaceCompatGroup, field: string, before: string, after: string, ops: EditOp[], checked = RACE_COMPAT_DEFAULT_ON.has(group)): void => {
    changes.push({
      key: `${race}|${field}`,
      group,
      sid: race,
      name: raceName,
      type: RACE,
      field,
      before,
      after,
      origin: raceOrigin,
      contextOnly: false,
      checked,
      ops,
    });
  };
  for (const { field, group, whenEmpty } of COPY_LISTS) {
    const mine = raceRec!.refs.get(field) ?? [];
    const missing = (sampleRec!.refs.get(field) ?? []).filter((r) => r.target !== race && !mine.some((m) => m.target === r.target));
    if (missing.length === 0) continue;
    const withValues = VALUE_FIELDS.has(field);
    own(
      group,
      field,
      refsText(ctx, mine, withValues),
      refsText(ctx, [...mine, ...missing], withValues),
      missing.map((r) => ({ op: 'addRef', id: race, category: field, target: r.target, values: values(r) })),
      RACE_COMPAT_DEFAULT_ON.has(group) || (whenEmpty === true && mine.length === 0),
    );
  }
  for (const field of COPY_FLAGS) {
    const want = sampleRec!.bools.get(field) ?? false;
    const have = raceRec!.bools.get(field) ?? false;
    if (want !== have) own('flags', field, String(have), String(want), [{ op: 'set', id: race, field, value: want }]);
  }
  for (const field of COPY_SINGLE_REFS) {
    const want = sampleRec!.refs.get(field) ?? [];
    const have = raceRec!.refs.get(field) ?? [];
    if (want.length === 0 || (have.length === want.length && have.every((r, i) => r.target === want[i]!.target))) continue;
    own('flags', field, refsText(ctx, have, false), refsText(ctx, want, false), [
      { op: 'setRefs', id: race, category: field, refs: want.map((r) => ({ target: r.target, values: values(r) })) },
    ]);
  }

  const order = new Map(RACE_COMPAT_GROUPS.map((g, i) => [g, i]));
  changes.sort((a, b) => order.get(a.group)! - order.get(b.group)! || a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.field.localeCompare(b.field));
  info.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { race, sample, raceName, sampleName: recordName(ctx, sampleRec!, sample), changes, already, info };
}

/** Step label (Russian, a step-title key): `раса: «New» как «Greenlander» (12 правок)`. */
export function raceCompatLabel(raceName: string, sampleName: string, count: number): string {
  return `раса: «${raceName}» как «${sampleName}» (${count} правок)`;
}

/**
 * The chosen changes (by key; default — the checked ones) as a bulk preview: `applyBulk` applies
 * it as one undo step.
 */
export function raceCompatPreview(plan: RaceCompatPlan, keys?: Iterable<string>): BulkPreview {
  const chosen = keys ? new Set(keys) : undefined;
  const picked = plan.changes.filter((c) => (chosen ? chosen.has(c.key) : c.checked));
  return {
    matched: new Set(picked.map((c) => c.sid)).size,
    changes: picked.map((c) => ({ sid: c.sid, name: c.name, field: c.field, before: c.before, after: c.after })),
    skipped: [],
    ops: picked.flatMap((c) => c.ops),
    label: raceCompatLabel(plan.raceName, plan.sampleName, picked.length),
  };
}

/** Mesh files of a race (game-relative paths): for the skeleton check. */
export function raceMeshes(ctx: ModContext, sid: string): { male?: string; female?: string } {
  const rec = ctx.get(sid);
  if (!rec) return {};
  const file = (k: string): string | undefined => {
    const v = rec.files.get(k);
    return v ? gamePath(decodeText(v)) : undefined;
  };
  const male = file('male mesh');
  const female = file('female mesh');
  return { ...(male ? { male } : {}), ...(female ? { female } : {}) };
}

/**
 * Skeleton warning: the new race's mesh uses another skeleton than the sample's, so the sample's
 * animation files may not fit. `skeletonOf` reads the mesh's skeleton link (undefined — unknown).
 */
export function raceSkeletonWarning(
  ctx: ModContext,
  plan: RaceCompatPlan,
  skeletonOf: (meshPath: string) => string | undefined,
): UiText | undefined {
  const a = raceMeshes(ctx, plan.race);
  const b = raceMeshes(ctx, plan.sample);
  const norm = (s: string | undefined): string | undefined => s?.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  for (const g of ['male', 'female'] as const) {
    const pa = a[g];
    const pb = b[g];
    if (!pa || !pb) continue;
    const sa = norm(skeletonOf(pa));
    const sb = norm(skeletonOf(pb));
    if (!sa || !sb || sa === sb) continue;
    return skeletonWarningText(plan, sa, sb);
  }
  return undefined;
}

export function skeletonWarningText(plan: RaceCompatPlan, raceSkeleton: string, sampleSkeleton: string): UiText {
  return {
    en: `“${plan.raceName}” uses the skeleton ${raceSkeleton}, “${plan.sampleName}” uses ${sampleSkeleton}: the sample’s animations may not fit the new race.`,
    ru: `У «${plan.raceName}» скелет ${raceSkeleton}, у «${plan.sampleName}» — ${sampleSkeleton}: анимации образца могут не подойти новой расе.`,
    zh: `“${plan.raceName}” 使用骨架 ${raceSkeleton}，“${plan.sampleName}” 使用 ${sampleSkeleton}：样板的动画可能不适合新种族。`,
  };
}

const GROUP_TEXT: Record<RaceCompatGroup, UiText> = {
  armour: { en: 'Armour and clothing', ru: 'Броня и одежда', zh: '护甲和服装' },
  weapons: { en: 'Weapons (race damage)', ru: 'Оружие (урон по расе)', zh: '武器（种族伤害）' },
  items: { en: 'Backpacks and other items', ru: 'Рюкзаки и другие предметы', zh: '背包和其他物品' },
  dialogue: { en: 'Dialogue race conditions', ru: 'Условия расы в диалогах', zh: '对话种族条件' },
  raceGroups: { en: 'Race groups (character editor)', ru: 'Группы рас (редактор персонажа)', zh: '种族组（角色编辑器）' },
  starts: { en: 'Start scenarios', ru: 'Стартовые сценарии', zh: '开局场景' },
  animations: { en: 'Animation files of the race', ru: 'Файлы анимаций расы', zh: '种族的动画文件' },
  factions: { en: 'Faction population', ru: 'Население фракций', zh: '派系人口' },
  looks: { en: 'Hairs, hair colours and heads', ru: 'Причёски, цвета волос и головы', zh: '发型、发色和头部' },
  body: { en: 'Body: combat anatomy, limbs, AI goals', ru: 'Тело: боевая анатомия, конечности, цели ИИ', zh: '身体：战斗解剖、肢体、AI 目标' },
  flags: { en: 'Inventory slots and part maps', ru: 'Слоты одежды и карты частей тела', zh: '服装栏位和身体部位贴图' },
  other: { en: 'Other references', ru: 'Другие ссылки', zh: '其他引用' },
};

export function raceCompatGroupText(group: RaceCompatGroup, lang = 'en'): string {
  const t = GROUP_TEXT[group];
  return t[lang] ?? t.en;
}

/** Text report (MCP, CLI): groups with their changes, single-race uses, totals. */
export function formatRaceCompat(plan: RaceCompatPlan, chosen: ReadonlySet<string>, limit = 50, lang = 'en'): string[] {
  const ru = lang === 'ru';
  const lines: string[] = [
    ru
      ? `«${plan.raceName}» (${plan.race}) как «${plan.sampleName}» (${plan.sample})`
      : `“${plan.raceName}” (${plan.race}) like “${plan.sampleName}” (${plan.sample})`,
  ];
  let shown = 0;
  for (const g of RACE_COMPAT_GROUPS) {
    const list = plan.changes.filter((c) => c.group === g);
    if (list.length === 0) continue;
    const on = list.filter((c) => chosen.has(c.key)).length;
    lines.push(`[${g}] ${raceCompatGroupText(g, lang)}: ${list.length}${ru ? `, отмечено ${on}` : `, chosen ${on}`}${RACE_COMPAT_DEFAULT_ON.has(g) ? '' : ru ? ' (по умолчанию выключено)' : ' (off by default)'}`);
    for (const c of list) {
      if (shown >= limit) continue;
      shown++;
      const mark = chosen.has(c.key) ? '+' : ' ';
      const ctxNote = c.contextOnly ? (ru ? ` [из мода в контексте ${c.origin}, не зависимость]` : ` [from context mod ${c.origin}, not a dependency]`) : '';
      lines.push(`  ${mark} ${c.type} ${c.sid} “${c.name}” ${c.field}: ${c.before || '—'} → ${c.after}${ctxNote}`);
    }
  }
  if (shown < plan.changes.length) lines.push(ru ? `… ещё ${plan.changes.length - shown} (limit)` : `… ${plan.changes.length - shown} more (limit)`);
  if (plan.info.length) {
    const byType = new Map<string, number>();
    for (const i of plan.info) byType.set(`${i.type}.${i.field}`, (byType.get(`${i.type}.${i.field}`) ?? 0) + 1);
    const parts = [...byType].map(([k, n]) => `${k} ${n}`).join(', ');
    lines.push(ru ? `не меняется (одна раса, а не список): ${parts}` : `not changed (a single race, not a list): ${parts}`);
  }
  if (plan.already) lines.push(ru ? `уже есть новая раса: ${plan.already}` : `already have the new race: ${plan.already}`);
  lines.push(ru ? `всего правок ${plan.changes.length}, отмечено ${chosen.size}` : `changes ${plan.changes.length}, chosen ${chosen.size}`);
  return lines;
}

/** History label of «new race based on a sample» (step-title.ts turns it into a clear title). */
export function newRaceLabel(name: string, sampleName: string, compatCount?: number): string {
  const base = `новая раса «${name}» на основе «${sampleName}»`;
  return compatCount === undefined ? base : `${base} + совместимость (${compatCount} правок)`;
}

/**
 * Why `name` cannot be the name of a new race copied from `sample` (undefined — it can): empty,
 * the sample's own name, or the name of another live race (the copy would look like that race
 * everywhere). Names are compared trimmed and case-insensitively.
 */
export function newRaceNameProblem(ctx: ModContext, sample: string, name: string): UiText | undefined {
  const want = name.trim().toLowerCase();
  if (want === '') return { en: 'Enter a name for the new race', ru: 'Введите имя новой расы', zh: '请输入新种族的名称' };
  const sampleRec = ctx.get(sample);
  if (sampleRec && decodeText(sampleRec.name).trim().toLowerCase() === want)
    return { en: 'The name is the same as the sample race', ru: 'Имя совпадает с расой-образцом', zh: '名称与样板种族相同' };
  const raceType = ctx.typeId(RACE);
  for (const sid of ctx.allStringIds()) {
    const h = ctx.headline(sid);
    if (!h || h.type !== raceType || ctx.status(sid) === 'deleted') continue;
    if (decodeText(h.name).trim().toLowerCase() === want)
      return { en: `Another race already has this name (${sid})`, ru: `Это имя уже есть у другой расы (${sid})`, zh: `已有其他种族使用此名称（${sid}）` };
  }
  return undefined;
}

/**
 * New race of the mod: a copy of the sample race (all its fields and references) under a new
 * name, as one undo step. Returns the id of the new race. The compatibility edits
 * (`planRaceCompat`) are a separate step.
 */
export function createRaceFrom(ctx: ModContext, sample: string, name: string, options: { stringId?: string } = {}): string {
  const rec = ctx.get(sample);
  if (!rec || ctx.status(sample) === 'deleted' || ctx.typeName(rec.type) !== RACE)
    throw new EditError({ en: `${sample} is not a race`, ru: `${sample} — не раса`, zh: `${sample} 不是种族` });
  const problem = newRaceNameProblem(ctx, sample, name);
  if (problem) throw new EditError(problem);
  const clean = name.trim();
  return ctx.transaction(newRaceLabel(clean, decodeText(rec.name)), () =>
    ctx.duplicateRecord(sample, { name: clean, ...(options.stringId !== undefined ? { stringId: options.stringId } : {}) }),
  );
}
