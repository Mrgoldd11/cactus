/**
 * Ways into the game: how a record of a type can get into the world, derived from the schema.
 *
 * A way is a reference field of another type that points to this type and that «Where in game»
 * follows upward (`UP_EDGES`): an item is sold through `VENDOR_LIST.items`, lies in the world
 * through `ITEM_PLACEMENT_GROUP.items`, is carried through `SQUAD_TEMPLATE.special items`. A few
 * ways are not followed by «Where in game» but still bring a record into the game (the race of a
 * character); those are only counted.
 *
 * Also here: a short «in game» line for the inspector header (`whereBrief`), the lists a sample
 * record is in (`sameListsAs`) and adding a record to such lists as one undo step (`addToLists`).
 */
import type { GameSchema } from '../schema/game-schema.ts';
import { EditError, type ModContext } from '../model/context.ts';
import { quote, uiText, type UiText } from '../ui-text.ts';
import { displayName, upEdge, type WhereFact, type WhereRole } from './where.ts';

export interface WayIn {
  /** Type of the record that takes this one in (`VENDOR_LIST`). */
  sourceType: string;
  /** Its reference field (`items`). */
  field: string;
  role: WhereRole | undefined;
  /** What the way is: «Sold by a trader»; generic ways — «Vendor list · items». */
  title: UiText;
  /** The chain to a place: «vendor list → trader squad → town». */
  hint: UiText;
  /** Button that picks a record of `sourceType` to add to; absent — the way is only explained. */
  action?: UiText;
  /** Button «add to the same list as the sample»: `{name}` is the list record name. */
  same: UiText;
  /** Plain words (a common way); false — the generic «type · field» form. */
  plain: boolean;
  /** «Where in game» does not follow this link: records using it are counted, not traced. */
  counted?: boolean;
}

interface WayWords {
  role?: WhereRole;
  title: UiText;
  hint: UiText;
  action?: UiText;
  same: UiText;
}

const SOLD: WayWords = {
  role: 'sold',
  title: { en: 'Sold by a trader', ru: 'Продаётся у торговца', zh: '由商人出售' },
  hint: { en: 'vendor list → trader squad → town', ru: 'список торговца → отряд торговца → город', zh: '商人列表 → 商人小队 → 城镇' },
  action: { en: 'Add to a vendor list…', ru: 'Добавить в список торговца…', zh: '添加到商人列表…' },
  same: { en: 'Add to the same list “{name}”', ru: 'Добавить в тот же список «{name}»', zh: '添加到同一列表“{name}”' },
};

const BLUEPRINT: WayWords = {
  role: 'sold',
  title: { en: 'Blueprint sold by a trader', ru: 'Чертёж продаётся у торговца', zh: '商人出售蓝图' },
  hint: SOLD.hint,
  action: SOLD.action!,
  same: SOLD.same,
};

const LYING: WayWords = {
  role: 'lying',
  title: { en: 'Lies in the world', ru: 'Лежит в мире', zh: '散落在世界中' },
  hint: { en: 'item placement group → buildings where it stands', ru: 'группа размещения → постройки, где она стоит', zh: '物品摆放组 → 所在建筑' },
  action: { en: 'Add to a placement group…', ru: 'Добавить в группу размещения…', zh: '添加到物品摆放组…' },
  same: { en: 'Add to the same group “{name}”', ru: 'Добавить в ту же группу «{name}»', zh: '添加到同一摆放组“{name}”' },
};

const GEAR: WayWords = {
  role: 'carried',
  title: { en: 'Worn by a character', ru: 'Снаряжение персонажа', zh: '角色装备' },
  hint: { en: 'character wears it from the start → their squad → town', ru: 'персонаж носит с начала игры → его отряд → город', zh: '角色开局即装备 → 其小队 → 城镇' },
  action: { en: 'Give to a character…', ru: 'Дать персонажу…', zh: '交给角色…' },
  same: { en: 'Give to the same character “{name}”', ru: 'Дать тому же персонажу «{name}»', zh: '交给同一角色“{name}”' },
};

const MEMBER: WayWords = {
  role: 'member',
  title: { en: 'Squad member', ru: 'Член отряда', zh: '小队成员' },
  hint: { en: 'squad → town or faction where it lives', ru: 'отряд → город или фракция, где он живёт', zh: '小队 → 其所在城镇或派系' },
  action: { en: 'Add to a squad…', ru: 'Добавить в отряд…', zh: '添加到小队…' },
  same: { en: 'Add to the same squad “{name}”', ru: 'Добавить в тот же отряд «{name}»', zh: '添加到同一小队“{name}”' },
};

const TOWN_HINT: UiText = { en: 'town → its place on the map', ru: 'город → его место на карте', zh: '城镇 → 地图上的位置' };
const TOWN_SAME: UiText = { en: 'Add to the same town “{name}”', ru: 'Добавить в тот же город «{name}»', zh: '添加到同一城镇“{name}”' };
const TOWN_ACTION: UiText = { en: 'Add to a town…', ru: 'Добавить в город…', zh: '添加到城镇…' };

/** Plain words of the common ways: `TYPE.field`, or `TYPE.*` for every field of the type. */
const WAY_WORDS: Readonly<Record<string, WayWords>> = {
  'VENDOR_LIST.armour blueprints': BLUEPRINT,
  'VENDOR_LIST.crossbow blueprints': BLUEPRINT,
  'VENDOR_LIST.backpack blueprints': BLUEPRINT,
  'VENDOR_LIST.blueprints': BLUEPRINT,
  'VENDOR_LIST.*': SOLD,
  'ITEM_PLACEMENT_GROUP.*': LYING,
  'SQUAD_TEMPLATE.special items': {
    role: 'carried',
    title: { en: 'A squad has it from the start', ru: 'Есть у отряда с начала игры', zh: '小队开局即持有' },
    hint: { en: 'squad special items → where the squad lives', ru: 'особые предметы отряда → где отряд живёт', zh: '小队特殊物品 → 小队所在地' },
    action: { en: 'Give to a squad…', ru: 'Дать отряду…', zh: '交给小队…' },
    same: { en: 'Give to the same squad “{name}”', ru: 'Дать тому же отряду «{name}»', zh: '交给同一小队“{name}”' },
  },
  'CHARACTER.inventory': {
    role: 'carried',
    title: { en: 'In a character’s inventory', ru: 'В инвентаре персонажа', zh: '在角色物品栏中' },
    hint: { en: 'character inventory → their squad → town', ru: 'инвентарь персонажа → его отряд → город', zh: '角色物品栏 → 其小队 → 城镇' },
    action: GEAR.action!,
    same: GEAR.same,
  },
  'CHARACTER.weapons': GEAR,
  'CHARACTER.clothing': GEAR,
  'CHARACTER.crossbows': GEAR,
  'ANIMAL_CHARACTER.weapon': {
    role: 'carried',
    title: { en: 'An animal’s weapon', ru: 'Оружие животного', zh: '动物的武器' },
    hint: { en: 'animal → its squad → where it lives', ru: 'животное → его отряд → где он живёт', zh: '动物 → 其小队 → 所在地' },
    action: { en: 'Give to an animal…', ru: 'Дать животному…', zh: '交给动物…' },
    same: { en: 'Give to the same animal “{name}”', ru: 'Дать тому же животному «{name}»', zh: '交给同一动物“{name}”' },
  },
  'SQUAD_TEMPLATE.leader': {
    role: 'member',
    title: { en: 'Squad leader', ru: 'Лидер отряда', zh: '小队首领' },
    hint: MEMBER.hint,
    action: { en: 'Make the leader of a squad…', ru: 'Сделать лидером отряда…', zh: '设为小队首领…' },
    same: { en: 'Leader of the same squad “{name}”', ru: 'Лидер того же отряда «{name}»', zh: '同一小队“{name}”的首领' },
  },
  'SQUAD_TEMPLATE.squad': MEMBER,
  'SQUAD_TEMPLATE.squad2': MEMBER,
  'SQUAD_TEMPLATE.choosefrom list': {
    role: 'member',
    title: { en: 'One of a squad’s choices', ru: 'Один из вариантов в отряде', zh: '小队候选之一' },
    hint: MEMBER.hint,
    action: MEMBER.action!,
    same: MEMBER.same,
  },
  'SQUAD_TEMPLATE.animals': {
    role: 'member',
    title: { en: 'Animal of a squad', ru: 'Животное отряда', zh: '小队的动物' },
    hint: MEMBER.hint,
    action: MEMBER.action!,
    same: MEMBER.same,
  },
  'SQUAD_TEMPLATE.animals2': {
    role: 'member',
    title: { en: 'Animal of a squad', ru: 'Животное отряда', zh: '小队的动物' },
    hint: MEMBER.hint,
    action: MEMBER.action!,
    same: MEMBER.same,
  },
  'SQUAD_TEMPLATE.building': {
    role: 'lives',
    title: { en: 'Home of a squad', ru: 'Здание отряда', zh: '小队的建筑' },
    hint: { en: 'the squad lives in this building → town', ru: 'отряд живёт в этом здании → город', zh: '小队住在此建筑 → 城镇' },
    action: { en: 'Give to a squad…', ru: 'Дать отряду…', zh: '交给小队…' },
    same: { en: 'Give to the same squad “{name}”', ru: 'Дать тому же отряду «{name}»', zh: '交给同一小队“{name}”' },
  },
  'TOWN.residents': {
    role: 'lives',
    title: { en: 'Lives in a town', ru: 'Живёт в городе', zh: '住在城镇' },
    hint: TOWN_HINT,
    action: TOWN_ACTION,
    same: TOWN_SAME,
  },
  'TOWN.default resident': {
    role: 'lives',
    title: { en: 'Default residents of a town', ru: 'Жители города по умолчанию', zh: '城镇默认居民' },
    hint: TOWN_HINT,
    action: TOWN_ACTION,
    same: TOWN_SAME,
  },
  'TOWN.bar squads': {
    role: 'lives',
    title: { en: 'Sits in a town bar', ru: 'Сидит в баре города', zh: '在城镇酒吧' },
    hint: TOWN_HINT,
    action: TOWN_ACTION,
    same: TOWN_SAME,
  },
  'TOWN.roaming squads': {
    role: 'lives',
    title: { en: 'Roams around a town', ru: 'Бродит у города', zh: '在城镇周边游荡' },
    hint: TOWN_HINT,
    action: TOWN_ACTION,
    same: TOWN_SAME,
  },
  'BIOME_GROUP.homeless spawns': {
    role: 'lives',
    title: { en: 'Roams a biome', ru: 'Бродит в биоме', zh: '在生物群系中游荡' },
    hint: { en: 'biome → its part of the map', ru: 'биом → его часть карты', zh: '生物群系 → 地图区域' },
    action: { en: 'Add to a biome…', ru: 'Добавить в биом…', zh: '添加到生物群系…' },
    same: { en: 'Add to the same biome “{name}”', ru: 'Добавить в тот же биом «{name}»', zh: '添加到同一生物群系“{name}”' },
  },
  'NEW_GAME_STARTOFF.squad': {
    role: 'member',
    title: { en: 'Player squad at a game start', ru: 'Отряд игрока на старте', zh: '开局玩家小队' },
    hint: { en: 'game start → the player gets this squad', ru: 'начало игры → игрок получает этот отряд', zh: '游戏开局 → 玩家获得此小队' },
    action: { en: 'Add to a game start…', ru: 'Добавить в начало игры…', zh: '添加到游戏开局…' },
    same: { en: 'Add to the same game start “{name}”', ru: 'Добавить в то же начало игры «{name}»', zh: '添加到同一开局“{name}”' },
  },
};

/**
 * Ways «Where in game» does not follow (they would flood it: every character of a race), but
 * that do bring a record into the game. Explained and counted; no button, since such a field
 * holds one record (setting it replaces another race).
 */
const COUNTED_WAYS: Readonly<Record<string, WayWords>> = {
  'CHARACTER.race': {
    role: 'member',
    title: { en: 'Race of a character', ru: 'Раса персонажа', zh: '角色的种族' },
    hint: { en: 'character of this race → their squad → town', ru: 'персонаж этой расы → его отряд → город', zh: '此种族的角色 → 其小队 → 城镇' },
    same: { en: '“{name}”', ru: '«{name}»', zh: '“{name}”' },
  },
  'ANIMAL_CHARACTER.race': {
    role: 'member',
    title: { en: 'Race of an animal', ru: 'Раса животного', zh: '动物的种族' },
    hint: { en: 'animal of this race → its squad', ru: 'животное этой расы → его отряд', zh: '此种族的动物 → 其小队' },
    same: { en: '“{name}”', ru: '«{name}»', zh: '“{name}”' },
  },
  'NEW_GAME_STARTOFF.force race': {
    role: 'member',
    title: { en: 'Race forced by a game start', ru: 'Раса на старте игры', zh: '开局指定种族' },
    hint: { en: 'game start → the player’s characters get this race', ru: 'начало игры → персонажи игрока этой расы', zh: '游戏开局 → 玩家角色为此种族' },
    same: { en: '“{name}”', ru: '«{name}»', zh: '“{name}”' },
  },
};

/** Words for the record types that can take a record into the game (the generic «type · field» form). */
const TYPE_WORDS: Readonly<Record<string, UiText>> = {
  VENDOR_LIST: { en: 'Vendor list', ru: 'Список торговца', zh: '商人列表' },
  CHARACTER: { en: 'Character', ru: 'Персонаж', zh: '角色' },
  ANIMAL_CHARACTER: { en: 'Animal', ru: 'Животное', zh: '动物' },
  ITEM_PLACEMENT_GROUP: { en: 'Item placement group', ru: 'Группа размещения', zh: '物品摆放组' },
  SQUAD_TEMPLATE: { en: 'Squad', ru: 'Отряд', zh: '小队' },
  UNIQUE_SQUAD_TEMPLATE: { en: 'Unique squad', ru: 'Уникальный отряд', zh: '独特小队' },
  TOWN: { en: 'Town', ru: 'Город', zh: '城镇' },
  FACTION: { en: 'Faction', ru: 'Фракция', zh: '派系' },
  FACTION_CAMPAIGN: { en: 'Faction raid', ru: 'Набег фракции', zh: '派系袭击' },
  SINGLE_DIPLOMATIC_ASSAULT: { en: 'Diplomatic assault', ru: 'Дипломатический набег', zh: '外交袭击' },
  BIOME_GROUP: { en: 'Biome group', ru: 'Группа биомов', zh: '生物群系组' },
  BIOMES: { en: 'Biome', ru: 'Биом', zh: '生物群系' },
  BUILDING: { en: 'Building', ru: 'Постройка', zh: '建筑' },
  ROAD: { en: 'Road', ru: 'Дорога', zh: '道路' },
  NEW_GAME_STARTOFF: { en: 'Game start', ru: 'Начало игры', zh: '游戏开局' },
  DIALOGUE_LINE: { en: 'Dialogue line', ru: 'Реплика', zh: '台词' },
  DIALOGUE: { en: 'Dialogue', ru: 'Диалог', zh: '对话' },
  DIALOGUE_PACKAGE: { en: 'Dialogue package', ru: 'Пакет диалогов', zh: '对话包' },
};

/** A record type in words; unknown types stay as their code. */
export function typeWords(type: string): UiText {
  return TYPE_WORDS[type] ?? { en: type };
}

const GENERIC_ACTION: UiText = { en: 'Add…', ru: 'Добавить…', zh: '添加…' };
const GENERIC_SAME: UiText = { en: 'Add to the same “{name}”', ru: 'Добавить туда же: «{name}»', zh: '添加到同一“{name}”' };

const ROLE_ORDER: readonly (WhereRole | undefined)[] = ['sold', 'lying', 'carried', 'member', 'lives', 'loot', 'says', 'placed', 'related', undefined];

function textOf(map: Readonly<Record<string, string | undefined>>): UiText {
  return map as UiText;
}

function wordsFor(table: Readonly<Record<string, WayWords>>, sourceType: string, field: string): WayWords | undefined {
  return table[`${sourceType}.${field}`] ?? table[`${sourceType}.*`];
}

/**
 * Ways a record of `type` gets into the game, from the schema: every reference field of another
 * type that targets `type` and is an upward link of «Where in game» (or a counted way). Common
 * ways come first and in plain words.
 */
export function waysIntoGame(schema: GameSchema | undefined, type: string): WayIn[] {
  if (!schema) return [];
  const out: WayIn[] = [];
  for (const [sourceType, ts] of schema.types) {
    for (const f of ts.fields.values()) {
      if (f.kind !== 'reference' || f.targetType !== type) continue;
      const edge = upEdge(sourceType, f.name);
      const counted = edge ? undefined : wordsFor(COUNTED_WAYS, sourceType, f.name);
      if (!edge && !counted) continue;
      const words = counted ?? wordsFor(WAY_WORDS, sourceType, f.name);
      const tw = typeWords(sourceType);
      const generic: UiText = textOf(Object.fromEntries(['en', 'ru', 'zh'].map((l) => [l, `${uiText(tw, l)} · ${f.name}`])));
      const edgeHint: UiText | undefined = edge ? { en: edge.en, ru: edge.ru, ...(edge.zh ? { zh: edge.zh } : {}) } : undefined;
      const way: WayIn = {
        sourceType,
        field: f.name,
        role: words?.role ?? edge?.role,
        title: words?.title ?? generic,
        hint: words?.hint ?? edgeHint ?? { en: '' },
        same: words?.same ?? GENERIC_SAME,
        plain: words !== undefined,
      };
      if (counted) way.counted = true;
      else way.action = words?.action ?? GENERIC_ACTION;
      out.push(way);
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.plain) - Number(a.plain) ||
      ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
      a.sourceType.localeCompare(b.sourceType) ||
      a.field.localeCompare(b.field),
  );
}

/** The way through `sourceType.field` for a record of `type`, if there is one. */
export function wayOf(schema: GameSchema | undefined, type: string, sourceType: string, field: string): WayIn | undefined {
  return waysIntoGame(schema, type).find((w) => w.sourceType === sourceType && w.field === field);
}

/** `{name}` of a way text filled in. */
export function wayText(text: UiText, name: string, lang = 'en'): string {
  return uiText(text, lang).replace('{name}', name);
}

/** How many live records take `sid` in through counted ways (characters of a race…), per way. */
export function countedUses(ctx: ModContext, sid: string, ways: readonly WayIn[]): { way: WayIn; count: number }[] {
  const counted = ways.filter((w) => w.counted);
  if (counted.length === 0) return [];
  const n = new Map<WayIn, Set<string>>();
  for (const e of ctx.referencesTo(sid)) {
    if (e.source === sid || ctx.status(e.source) === 'deleted') continue;
    const src = ctx.get(e.source);
    if (!src) continue;
    const st = ctx.typeName(src.type);
    const w = counted.find((x) => x.sourceType === st && x.field === e.category);
    if (!w) continue;
    const set = n.get(w) ?? new Set<string>();
    set.add(e.source);
    n.set(w, set);
  }
  return counted.flatMap((way) => {
    const count = n.get(way)?.size ?? 0;
    return count > 0 ? [{ way, count }] : [];
  });
}

// ---------------------------------------------------------------- the «in game» line

const BRIEF: Readonly<Record<WhereRole, UiText>> = {
  sold: { en: 'sold by {who}', ru: 'продаёт {who}', zh: '{who} 出售' },
  carried: { en: 'with {who}', ru: 'у {who}', zh: '{who} 持有' },
  lying: { en: 'lies: {who}', ru: 'лежит: {who}', zh: '散落：{who}' },
  placed: { en: 'stands in the world', ru: 'стоит в мире', zh: '放置在世界中' },
  loot: { en: 'loot: {who}', ru: 'добыча: {who}', zh: '战利品：{who}' },
  member: { en: 'in {who}', ru: 'в {who}', zh: '在 {who}' },
  lives: { en: 'lives: {who}', ru: 'живёт: {who}', zh: '居住：{who}' },
  says: { en: 'says {who}', ru: 'говорит {who}', zh: '{who} 说' },
  related: { en: 'via {who}', ru: 'через {who}', zh: '通过 {who}' },
};

const SQUAD_WORD: UiText = { en: 'squad {name}', ru: 'отряд {name}', zh: '小队 {name}' };

/** One fact of «Where in game» in a few words: «sold by Priest (holy church)», «with Moll». */
export function whereBriefPart(f: WhereFact, lang = 'en'): string {
  const leader = f.holder?.squad?.leader[0];
  const first = f.path[0];
  let who: string;
  if (leader) who = displayName(leader);
  else if (f.holder?.type === 'SQUAD_TEMPLATE') who = wayText(SQUAD_WORD, quote(f.holder.name, lang), lang);
  else if (f.holder) who = displayName(f.holder);
  else if (first) who = displayName(first);
  else who = f.places[0] ? displayName(f.places[0]) : '';
  if (f.role === 'lives' && !leader && f.places[0]) who = displayName(f.places[0]);
  let text = uiText(BRIEF[f.role], lang).replace('{who}', who);
  // Sold: which list, the thing the modder edits.
  if (f.role === 'sold' && first && first.type === 'VENDOR_LIST') text += ` (${displayName(first)})`;
  return text.trim();
}

/** The «in game» line: distinct short parts of the facts, the first `max` of them, and how many more. */
export function whereBrief(facts: readonly WhereFact[], lang = 'en', max = 3): { parts: string[]; more: number } {
  const all = [...new Set(facts.map((f) => whereBriefPart(f, lang)).filter((s) => s !== ''))];
  return { parts: all.slice(0, max), more: Math.max(0, all.length - max) };
}

// ---------------------------------------------------------------- adding to lists

/** A reference list slot: record `source` has the record in its field `category`. */
export interface ListSlot {
  source: string;
  category: string;
  /** Values of the reference (quantity, chance…) as in the sample. */
  values: readonly number[];
}

/**
 * The lists `sample` is in that are ways into the game for `sid` (same type of field target),
 * and that do not have `sid` yet. A book made from «Book of Grace»: the vendor lists «holy church»
 * and «Lore: Flotsam Village Notes», the special items of squad «flotsam hq».
 */
export function sameListsAs(ctx: ModContext, sid: string, sample: string): ListSlot[] {
  const rec = ctx.get(sid);
  if (!rec) return [];
  const ways = waysIntoGame(ctx.schema, ctx.typeName(rec.type)).filter((w) => !w.counted);
  const out: ListSlot[] = [];
  const seen = new Set<string>();
  for (const e of ctx.referencesTo(sample)) {
    if (e.source === sample || e.source === sid || ctx.status(e.source) === 'deleted') continue;
    const src = ctx.get(e.source);
    if (!src) continue;
    const st = ctx.typeName(src.type);
    if (!ways.some((w) => w.sourceType === st && w.field === e.category)) continue;
    const key = `${e.source}\u0000${e.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = src.refs.get(e.category) ?? [];
    if (list.some((r) => r.target === sid)) continue;
    const ref = list.find((r) => r.target === sample);
    if (!ref) continue;
    out.push({ source: e.source, category: e.category, values: [ref.v0, ref.v1, ref.v2] });
  }
  // Common ways first (sold before carried), then by list name.
  const rank = (x: ListSlot): number => ways.findIndex((w) => w.sourceType === ctx.typeName(ctx.get(x.source)!.type) && w.field === x.category);
  const name = (s: string): string => ctx.localizedName(s) ?? ctx.name(s) ?? s;
  return out.sort((a, b) => rank(a) - rank(b) || name(a.source).localeCompare(name(b.source)) || a.category.localeCompare(b.category));
}

/** History label of adding a record to lists; `step-title.ts` turns it into a clear title. */
export function addToListsLabel(sid: string, slots: readonly Pick<ListSlot, 'source' | 'category'>[], sample?: string): string {
  if (slots.length === 1 && sample === undefined) return `в игру: ${sid} → ${slots[0]!.source} (${slots[0]!.category})`;
  return `в игру: ${sid} → мест ${slots.length}${sample !== undefined ? ` как у ${sample}` : ''}`;
}

/**
 * Add `sid` to the reference lists `slots` as one undo step. Each slot must be a way into the
 * game for the record's type. Values: those of the slot (a sample's), else the schema defaults.
 * A list that already has the record keeps it as it is. Returns how many lists changed.
 */
export function addToLists(ctx: ModContext, sid: string, slots: readonly (Omit<ListSlot, 'values'> & { values?: readonly number[] })[], sample?: string): number {
  const rec = ctx.get(sid);
  if (!rec) throw new EditError({ en: `No record ${sid}`, ru: `Нет записи ${sid}`, zh: `没有记录 ${sid}` });
  if (slots.length === 0) return 0;
  const type = ctx.typeName(rec.type);
  for (const s of slots) {
    const src = ctx.get(s.source);
    if (!src || ctx.status(s.source) === 'deleted')
      throw new EditError({ en: `No record ${s.source}`, ru: `Нет записи ${s.source}`, zh: `没有记录 ${s.source}` });
    const st = ctx.typeName(src.type);
    if (!wayOf(ctx.schema, type, st, s.category)?.action) {
      const name = ctx.localizedName(s.source) ?? ctx.name(s.source) ?? s.source;
      throw new EditError({
        en: `“${name}” (${st}.${s.category}) does not take ${type}`,
        ru: `«${name}» (${st}.${s.category}) не принимает ${type}`,
        zh: `“${name}”（${st}.${s.category}）不接受 ${type}`,
      });
    }
  }
  let changed = 0;
  ctx.transaction(addToListsLabel(sid, slots, sample), () => {
    for (const s of slots) {
      if ((ctx.get(s.source)!.refs.get(s.category) ?? []).some((r) => r.target === sid)) continue;
      ctx.addReference(s.source, s.category, sid, s.values ?? ctx.refDefaults(s.source, s.category));
      changed++;
    }
  });
  return changed;
}

// ---------------------------------------------------------------- the sample of a new record

/**
 * The record a mod record was made from in this session: «+ New» with a sample, or «Copy».
 * Read from the undo history (the step that created the record); undefined — made empty, made
 * earlier, or the step was undone.
 */
export function sampleOf(ctx: ModContext, sid: string): string | undefined {
  for (const cs of ctx.history().undo) {
    const created = cs.ops.some((op) => op.kind === 'record' && op.stringId === sid && op.before === undefined && op.after !== undefined);
    if (!created) continue;
    const m = /^новая запись «.*» по образцу (.+)$/s.exec(cs.label) ?? /^копия (.+)$/s.exec(cs.label);
    const sample = m?.[1];
    return sample !== undefined && sample !== sid && ctx.get(sample) ? sample : undefined;
  }
  return undefined;
}
