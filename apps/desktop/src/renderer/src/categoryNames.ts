/**
 * Русские названия узлов дерева категорий (подписи из `fcs_layout.def` — английские).
 * Ключ — подпись узла как в файле раскладки (без хвостовых пробелов). Узла нет в таблице —
 * показывается английская подпись как есть (например, из мода или другой версии раскладки).
 */
export const CATEGORY_RU: Readonly<Record<string, string>> = {
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
