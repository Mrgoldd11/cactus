/**
 * Category tree node names per interface language (the labels in `fcs_layout.def` are English).
 * Key: the node label as in the layout file (without trailing spaces). A node missing from the
 * table, or a language without a table, shows the English label as is (e.g. from a mod or another
 * layout version). A new interface language adds its table to CATEGORY_NAMES.
 */
import type { Lang } from '../../shared/api.ts';

const ru: Readonly<Record<string, string>> = {
  Buildings: 'Постройки',
  Walls: 'Стены',
  Furniture: 'Мебель',
  Exterior: 'Внешний декор',
  Nodes: 'Узлы',
  Doors: 'Двери',
  Parts: 'Части построек',
  Materials: 'Материалы',
  Functionality: 'Функции построек',
  'Farm Data': 'Данные ферм',
  Lights: 'Освещение',
  Plants: 'Растения',

  Items: 'Предметы',
  Weapons: 'Оружие',
  Models: 'Модели',
  Manufacturer: 'Производители',
  'Ranged Weapons': 'Стрелковое оружие',
  Crossbows: 'Арбалеты',
  Armour: 'Броня',
  Bags: 'Сумки',
  'Placeable Groups': 'Группы размещения',
  'Nest Items': 'Предметы гнёзд',
  'Physics Attachment': 'Физические крепления',
  Maps: 'Карты',
  Books: 'Книги',
  'Limb replacement': 'Замена конечностей',

  'Dialogue Package': 'Пакеты диалогов',
  Dialogue: 'Диалоги',
  'Diplomatic Assaults': 'Дипломатические штурмы',
  'Word Swaps': 'Замены слов',
  'World States': 'Состояния мира',
  _lines: 'Реплики',

  Races: 'Расы',
  Groups: 'Группы',

  Characters: 'Персонажи',
  Stats: 'Характеристики',
  Personality: 'Характеры',
  Hair: 'Волосы',
  Head: 'Головы',
  Animals: 'Животные',

  Animation: 'Анимация',
  'Animation Events': 'События анимации',
  'Animal Animations': 'Анимации животных',
  'Combat Techniques': 'Боевые приёмы',
  'Animation Files': 'Файлы анимации',

  Faction: 'Фракции',
  Squads: 'Отряды',
  'Special Squads': 'Особые отряды',
  'Faction Templates': 'Шаблоны фракций',
  'Buildings swaps': 'Замены построек',
  'Trade Culture': 'Торговая культура',

  Towns: 'Города',
  'Locational Damage': 'Урон по частям тела',

  Biomes: 'Биомы',
  'Foliage Layers': 'Слои растительности',
  Meshes: 'Меши',
  Grass: 'Трава',
  'Map Features': 'Объекты карты',
  Birds: 'Птицы',
  Weather: 'Погода',
  'Spawn Area': 'Зоны появления',
  Resources: 'Ресурсы',
  Seasons: 'Времена года',

  'AI Packages': 'Пакеты ИИ',
  Goals: 'Цели',
  'War Campaigns': 'Военные кампании',

  'Vendor Lists': 'Списки торговцев',
  'Colour Scheme': 'Цветовые схемы',
  Research: 'Исследования',
  'Game Starts': 'Начала игры',

  Effects: 'Эффекты',
  'Effect volumes': 'Объёмы эффектов',
  'Ambient Sounds': 'Фоновые звуки',
};

const zh: Readonly<Record<string, string>> = {
  Buildings: '建筑',
  Walls: '墙壁',
  Furniture: '家具',
  Exterior: '外部装饰',
  Nodes: '节点',
  Doors: '门',
  Parts: '建筑部件',
  Materials: '材料',
  Functionality: '建筑功能',
  'Farm Data': '农场数据',
  Lights: '照明',
  Plants: '植物',

  Items: '物品',
  Weapons: '武器',
  Models: '模型',
  Manufacturer: '制造商',
  'Ranged Weapons': '远程武器',
  Crossbows: '弩',
  Armour: '护甲',
  Bags: '背包',
  'Placeable Groups': '放置组',
  'Nest Items': '巢穴物品',
  'Physics Attachment': '物理挂件',
  Maps: '地图',
  Books: '书籍',
  'Limb replacement': '义肢',

  'Dialogue Package': '对话包',
  Dialogue: '对话',
  'Diplomatic Assaults': '外交突袭',
  'Word Swaps': '词语替换',
  'World States': '世界状态',
  _lines: '台词',

  Races: '种族',
  Groups: '群组',

  Characters: '角色',
  Stats: '属性',
  Personality: '性格',
  Hair: '头发',
  Head: '头部',
  Animals: '动物',

  Animation: '动画',
  'Animation Events': '动画事件',
  'Animal Animations': '动物动画',
  'Combat Techniques': '战斗技巧',
  'Animation Files': '动画文件',

  Faction: '派系',
  Squads: '小队',
  'Special Squads': '特殊小队',
  'Faction Templates': '派系模板',
  'Buildings swaps': '建筑替换',
  'Trade Culture': '贸易文化',

  Towns: '城镇',
  'Locational Damage': '部位伤害',

  Biomes: '生物群系',
  'Foliage Layers': '植被层',
  Meshes: '网格',
  Grass: '草',
  'Map Features': '地图要素',
  Birds: '鸟类',
  Weather: '天气',
  'Spawn Area': '刷新区域',
  Resources: '资源',
  Seasons: '季节',

  'AI Packages': 'AI 包',
  Goals: '目标',
  'War Campaigns': '战争行动',

  'Vendor Lists': '商人清单',
  'Colour Scheme': '配色方案',
  Research: '研究',
  'Game Starts': '开局',

  Effects: '效果',
  'Effect volumes': '效果体积',
  'Ambient Sounds': '环境音',
};

const CATEGORY_NAMES: Partial<Record<Lang, Readonly<Record<string, string>>>> = { ru, zh };

/** Node label in the interface language, English when there is no entry. */
export function categoryName(label: string, lang: Lang): string {
  return CATEGORY_NAMES[lang]?.[label] ?? label;
}

/**
 * Title of the «+ New» window for a category, by the node label: «New book», «Новая книга».
 * Only common categories have one (Russian needs the grammatical gender); others get the
 * generic «New record in “…”».
 */
const newEn: Readonly<Record<string, string>> = {
  Buildings: 'New building',
  Walls: 'New wall',
  Furniture: 'New furniture',
  Doors: 'New door',
  Lights: 'New light',
  Plants: 'New plant',
  Items: 'New item',
  Weapons: 'New weapon',
  'Ranged Weapons': 'New ranged weapon',
  Crossbows: 'New crossbow',
  Armour: 'New armour',
  Bags: 'New bag',
  Maps: 'New map',
  Books: 'New book',
  'Dialogue Package': 'New dialogue package',
  Dialogue: 'New dialogue',
  Races: 'New race',
  Characters: 'New character',
  Animals: 'New animal',
  Faction: 'New faction',
  Squads: 'New squad',
  Towns: 'New town',
  Biomes: 'New biome',
  'AI Packages': 'New AI package',
  'Vendor Lists': 'New vendor list',
  Research: 'New research',
  'Game Starts': 'New game start',
  Effects: 'New effect',
};

const newRu: Readonly<Record<string, string>> = {
  Buildings: 'Новая постройка',
  Walls: 'Новая стена',
  Furniture: 'Новая мебель',
  Doors: 'Новая дверь',
  Lights: 'Новый источник света',
  Plants: 'Новое растение',
  Items: 'Новый предмет',
  Weapons: 'Новое оружие',
  'Ranged Weapons': 'Новое стрелковое оружие',
  Crossbows: 'Новый арбалет',
  Armour: 'Новая броня',
  Bags: 'Новая сумка',
  Maps: 'Новая карта',
  Books: 'Новая книга',
  'Dialogue Package': 'Новый пакет диалогов',
  Dialogue: 'Новый диалог',
  Races: 'Новая раса',
  Characters: 'Новый персонаж',
  Animals: 'Новое животное',
  Faction: 'Новая фракция',
  Squads: 'Новый отряд',
  Towns: 'Новый город',
  Biomes: 'Новый биом',
  'AI Packages': 'Новый пакет ИИ',
  'Vendor Lists': 'Новый список торговца',
  Research: 'Новое исследование',
  'Game Starts': 'Новое начало игры',
  Effects: 'Новый эффект',
};

const NEW_TITLES: Partial<Record<Lang, Readonly<Record<string, string>>>> = {
  en: newEn,
  ru: newRu,
  // «新建» + the category name reads naturally in Chinese.
  zh: Object.fromEntries(Object.keys(newEn).flatMap((k) => (zh[k] !== undefined ? [[k, `新建${zh[k]}`]] : []))),
};

/** «+ New» window title for a category node; undefined — use the generic title. */
export function newRecordTitle(label: string, lang: Lang): string | undefined {
  return NEW_TITLES[lang]?.[label];
}
