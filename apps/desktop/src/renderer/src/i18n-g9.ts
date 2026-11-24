/** Strings of the dialogue screen fixes after the mouse test (UI review G9), merged into `i18n.ts`. */

function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const g9En = {
  // Record picker: records with the same name.
  pkDupHint: (origin: string, uses: number, where: string): string =>
    `Other records have the same name. This one comes from ${origin}, used in ${uses} ${uses === 1 ? 'place' : 'places'}${where ? `: ${where}` : ''}.`,
  pkDupUses: (n: number): string => `${n}×`,
  // Empty panels: record types in words.
  emptyPickOf: (types: readonly string[]): string => `Select a record: ${types.length > 1 ? `${types.slice(0, -1).join(', ')} or ${types[types.length - 1]!}` : types.join('')}.`,
  // Start of the «Dialogues» screen.
  dsTitle: 'What characters say',
  dsLead: 'Start a new dialogue: the wizard asks who speaks, when, and what to say, and makes the lines, the package and the link to the character.',
  dsNew: 'New dialogue…',
  dsNewTip: 'Opens the «Dialogue on an event» wizard (the same as in Create)',
  dsOpen: 'or open an existing one',
  dsSearch: 'Character or dialogue: barman, Hobbs…',
  dsNothing: 'Nothing found. Try another word or the English name.',
  dsMore: (n: number): string => `…and ${n} more: refine the search`,
  dsMine: 'Dialogues of your mod',
  dsMineNone: 'Your mod has no dialogues yet.',
  dsCharHint: 'A character opens their main dialogue, with a switcher to the others.',
  // Yes / no conditions.
  ynYes: 'yes',
  ynNo: 'no',
  ynTip: 'Whether the condition must hold (the game stores = 1) or must not (= 0)',
  edNameLater: 'made from the event once you choose it',
  edNameTip: 'The name of the DIALOGUE record: players never see it, it helps you find the dialogue in the editor.',
  lnSpeakerPlayer: 'Player (the one the NPC talks to)',
  plThen: 'Then:',
  pkMaybe: 'Maybe:',
  edScoreLead: 'For your dialogue to be heard instead of the standard one, it needs more points. The wizard has already set the right number.',
  unsavedWhere: (dir: string): string => `Not saved yet: will be saved to ${dir}`,
  unsavedWhereTip: 'Save (Ctrl+S) suggests this folder; Kenshi finds mods in its mods folder.',
  plSumBonus: 'bonus',
  plSumLine: 'first line',
  plSumTip: 'Where the points come from: the bonus set on the dialogue, what the game adds for its conditions, and the best first line.',
  howtoFromPlay: 'The character from «Play»:',
  dgZoomIn: 'Zoom in (around the selected card). The wheel zooms too; Shift or Ctrl + wheel scrolls.',
  dgZoomOut: 'Zoom out (around the selected card)',
};

export const g9Ru: typeof g9En = {
  pkDupHint: (origin, uses, where) =>
    `Есть другие записи с тем же именем. Эта — из ${origin}, используется в ${uses} ${ruPlural(uses, 'месте', 'местах', 'местах')}${where ? `: ${where}` : ''}.`,
  pkDupUses: (n) => `${n}×`,
  emptyPickOf: (types) => `Выберите запись: ${types.length > 1 ? `${types.slice(0, -1).join(', ')} или ${types[types.length - 1]!}` : types.join('')}.`,
  dsTitle: 'Что говорят персонажи',
  dsLead: 'Начните новый диалог: мастер спросит, кто говорит, когда и что сказать, и сам сделает реплики, пакет и связь с персонажем.',
  dsNew: 'Новый диалог…',
  dsNewTip: 'Открывает мастер «Диалог на событие» (тот же, что в «Создать»)',
  dsOpen: 'или откройте существующий',
  dsSearch: 'Персонаж или диалог: трактирщик, Хоббс…',
  dsNothing: 'Ничего не нашлось. Попробуйте другое слово или английское имя.',
  dsMore: (n) => `…и ещё ${n}: уточните поиск`,
  dsMine: 'Диалоги вашего мода',
  dsMineNone: 'В вашем моде пока нет диалогов.',
  dsCharHint: 'Персонаж открывает свой главный диалог, остальные — в переключателе.',
  ynYes: 'да',
  ynNo: 'нет',
  ynTip: 'Условие должно выполняться (игра хранит = 1) или не выполняться (= 0)',
  edNameLater: 'появится, когда выберете событие',
  edNameTip: 'Имя записи DIALOGUE: игрок его не видит, оно нужно, чтобы найти диалог в редакторе.',
  lnSpeakerPlayer: 'Игрок (собеседник NPC)',
  plThen: 'Затем:',
  pkMaybe: 'Может быть:',
  edScoreLead: 'Чтобы ваш диалог звучал вместо стандартного, у него должно быть больше очков. Мастер уже поставил нужное число.',
  unsavedWhere: (dir) => `Ещё не сохранён: будет сохранён в ${dir}`,
  unsavedWhereTip: '«Сохранить» (Ctrl+S) предложит эту папку: Kenshi ищет моды в своей папке mods.',
  plSumBonus: 'бонус',
  plSumLine: 'первая реплика',
  plSumTip: 'Откуда очки: бонус, заданный у диалога, что игра добавляет за его условия, и лучшая первая реплика.',
  howtoFromPlay: 'Персонаж из «Проиграть»:',
  dgZoomIn: 'Приблизить (к выбранной карточке). Колесо тоже масштабирует; Shift или Ctrl + колесо — прокрутка.',
  dgZoomOut: 'Отдалить (от выбранной карточки)',
};

export const g9Zh: typeof g9En = {
  pkDupHint: (origin, uses, where) => `还有其他同名记录。这一条来自 ${origin}，被 ${uses} 处使用${where ? `：${where}` : ''}。`,
  pkDupUses: (n) => `${n}×`,
  emptyPickOf: (types) => `请选择记录：${types.length > 1 ? `${types.slice(0, -1).join('、')}或${types[types.length - 1]!}` : types.join('')}。`,
  dsTitle: '角色说的话',
  dsLead: '新建一个对话：向导会询问谁说话、何时说、说什么，并自动创建台词、对话包以及与角色的关联。',
  dsNew: '新建对话…',
  dsNewTip: '打开“事件对话”向导（与“创建”中的相同）',
  dsOpen: '或打开已有的',
  dsSearch: '角色或对话：酒保、Hobbs…',
  dsNothing: '没有找到。换个词或试试英文名称。',
  dsMore: (n) => `…还有 ${n} 条：请细化搜索`,
  dsMine: '你的模组中的对话',
  dsMineNone: '你的模组中还没有对话。',
  dsCharHint: '角色会打开其主要对话，其余对话在切换器中。',
  ynYes: '是',
  ynNo: '否',
  ynTip: '条件必须成立（游戏存储为 = 1）或必须不成立（= 0）',
  edNameLater: '选择事件后自动生成',
  edNameTip: 'DIALOGUE 记录的名称：玩家看不到，用于在编辑器中查找对话。',
  lnSpeakerPlayer: '玩家（NPC 的交谈对象）',
  plThen: '然后：',
  pkMaybe: '也许是：',
  edScoreLead: '要让你的对话代替原版对话被说出，它需要更高的分数。向导已经设置好了合适的数值。',
  unsavedWhere: (dir) => `尚未保存：将保存到 ${dir}`,
  unsavedWhereTip: '“保存”（Ctrl+S）会建议此文件夹：Kenshi 在其 mods 文件夹中查找模组。',
  plSumBonus: '加成',
  plSumLine: '首句',
  plSumTip: '分数来源：对话设置的加成、游戏为其条件增加的分数，以及最佳首句。',
  howtoFromPlay: '来自“试玩”的角色：',
  dgZoomIn: '放大（以所选卡片为中心）。滚轮也可缩放；Shift 或 Ctrl + 滚轮为滚动。',
  dgZoomOut: '缩小（以所选卡片为中心）',
};
