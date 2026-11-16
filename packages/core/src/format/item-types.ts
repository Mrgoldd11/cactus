/**
 * The record type is stored in binary files as a number, an index into this list
 * (order of the game enum itemType; checked against OpenConstructionSet and the
 * `Type:` comments in locale/<language>/gamedata.po). Names match the `fcs.def` sections.
 *
 * This is the only thing the core knows about the data "by heart": the game files have no
 * "number → name" table.
 */
export const ITEM_TYPE_NAMES = [
  'BUILDING', // 0
  'CHARACTER',
  'WEAPON',
  'ARMOUR',
  'ITEM',
  'ANIMAL_ANIMATION',
  'ATTACHMENT',
  'RACE',
  'LOCATION',
  'WAR_SAVESTATE',
  'FACTION', // 10
  'NULL_ITEM',
  'ZONE_MAP',
  'TOWN',
  'WORLDMAP_CHARACTER',
  'CHARACTER_APPEARANCE_OLD',
  'LOCATIONAL_DAMAGE',
  'COMBAT_TECHNIQUE',
  'DIALOGUE',
  'DIALOGUE_LINE',
  'TECHTREE', // 20
  'RESEARCH',
  'AI_TASK',
  'AI_STATE',
  'ANIMATION',
  'STATS',
  'PERSONALITY',
  'CONSTANTS',
  'BIOMES',
  'BUILDING_PART',
  'INSTANCE_COLLECTION', // 30
  'DIALOG_ACTION',
  'TEMPORARY_INFO',
  'MOD_FILENAME',
  'PLATOON',
  'GAMESTATE_BUILDING',
  'GAMESTATE_CHARACTER',
  'GAMESTATE_FACTION',
  'GAMESTATE_TOWN_INSTANCE_LIST',
  'STATE',
  'SAVED_STATE', // 40
  'INVENTORY_STATE',
  'INVENTORY_ITEM_STATE',
  'REPEATABLE_BUILDING_PART_SLOT',
  'MATERIAL_SPEC',
  'MATERIAL_SPECS_COLLECTION',
  'CONTAINER',
  'MATERIAL_SPECS_CLOTHING',
  'GAMESTATE_BUILDING_INTERIOR',
  'VENDOR_LIST',
  'MATERIAL_SPECS_WEAPON', // 50
  'WEAPON_MANUFACTURER',
  'SQUAD_TEMPLATE',
  'ROAD',
  'LOCATION_NODE',
  'COLOR_DATA',
  'CAMERA',
  'MEDICAL_STATE',
  'MEDICAL_PART_STATE',
  'FOLIAGE_LAYER',
  'FOLIAGE_MESH', // 60
  'GRASS',
  'BUILDING_FUNCTIONALITY',
  'DAY_SCHEDULE',
  'NEW_GAME_STARTOFF',
  'GAMESTATE_CRAFTING',
  'CHARACTER_APPEARANCE',
  'GAMESTATE_AI',
  'WILDLIFE_BIRDS',
  'MAP_FEATURES',
  'DIPLOMATIC_ASSAULTS', // 70
  'SINGLE_DIPLOMATIC_ASSAULT',
  'AI_PACKAGE',
  'DIALOGUE_PACKAGE',
  'GUN_DATA',
  'HUMAN_CHARACTER',
  'ANIMAL_CHARACTER',
  'UNIQUE_SQUAD_TEMPLATE',
  'FACTION_TEMPLATE',
  'AI_SCHEDULE',
  'WEATHER', // 80
  'SEASON',
  'EFFECT',
  'ITEM_PLACEMENT_GROUP',
  'WORD_SWAPS',
  'NEST',
  'NEST_ITEM',
  'CHARACTER_PHYSICS_ATTACHMENT',
  'LIGHT',
  'HEAD',
  'BLUEPRINT', // 90
  'SHOP_TRADER_CLASS',
  'FOLIAGE_BUILDING',
  'FACTION_CAMPAIGN',
  'GAMESTATE_TOWN',
  'BIOME_GROUP',
  'EFFECT_FOG_VOLUME',
  'FARM_DATA',
  'FARM_PART',
  'ENVIRONMENT_RESOURCES',
  'RACE_GROUP', // 100
  'ARTIFACTS',
  'MAP_ITEM',
  'BUILDINGS_SWAP',
  'ITEMS_CULTURE',
  'ANIMATION_EVENT',
  'TUTORIAL',
  'CROSSBOW',
  'TERRAIN_DECALS',
  'AMBIENT_SOUND',
  'WORLD_EVENT_STATE', // 110
  'LIMB_REPLACEMENT',
  'ANIMATION_FILE',
  'BOAT',
  'GAMESTATE_BOAT',
  'BUILD_GRID',
  'BUILDING_SHELL',
] as const;

export type ItemTypeName = (typeof ITEM_TYPE_NAMES)[number];

const byName = new Map<string, number>(ITEM_TYPE_NAMES.map((n, i) => [n, i]));

/**
 * Record types added on top of the built-in table. The game and FCS know only the types above;
 * plugins add their own (FCS Extended: `enum itemType { VARIABLE=900 }` in a mod's `fcs.def`).
 * The table is plain data that belongs to a schema (`GameSchema.itemTypes`), not global state:
 * two mods with different extensions can be open in one process.
 */
export interface ItemTypes {
  /** Number -> name of the added types. */
  readonly extra: ReadonlyMap<number, string>;
  /** Name -> number of the added types. Two names may share a number; `extra` then holds the last one. */
  readonly extraByName: ReadonlyMap<string, number>;
}

/** The built-in table alone. */
export const VANILLA_ITEM_TYPES: ItemTypes = { extra: new Map(), extraByName: new Map() };

/** Type name by number; `TYPE_<n>` for unknown numbers. `types` is the schema table with extension types. */
export function itemTypeName(type: number, types?: ItemTypes): string {
  return ITEM_TYPE_NAMES[type] ?? types?.extra.get(type) ?? `TYPE_${type}`;
}

/** Type number by name (`DIALOGUE` → 18) or undefined. `types` is the schema table with extension types. */
export function itemTypeId(name: string, types?: ItemTypes): number | undefined {
  return byName.get(name) ?? types?.extraByName.get(name);
}

export function isItemTypeName(name: string): name is ItemTypeName;
export function isItemTypeName(name: string, types: ItemTypes | undefined): boolean;
export function isItemTypeName(name: string, types?: ItemTypes): boolean {
  return byName.has(name) || (types?.extraByName.has(name) ?? false);
}
