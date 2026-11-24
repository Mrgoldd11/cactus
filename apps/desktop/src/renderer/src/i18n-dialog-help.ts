/** Strings of dialogue conditions and effects in plain words: value picker with search, phrases (merged into `i18n.ts`). */
export const dialogHelpEn = {
  dhSearch: 'find…',
  dhSearchTip: 'Find by name, English name or code (DC_…, DA_…). Enter picks the first match.',
  dhNoMatch: 'nothing found',
  dhOther: 'Other',
  dhUnusedData: 'not used in the loaded data',
  dhCodeTip: 'As stored in the game data',
};

export const dialogHelpRu: typeof dialogHelpEn = {
  dhSearch: 'найти…',
  dhSearchTip: 'Поиск по названию, английскому названию или коду (DC_…, DA_…). Enter выбирает первое найденное.',
  dhNoMatch: 'ничего не найдено',
  dhOther: 'Другое',
  dhUnusedData: 'не встречается в загруженных данных',
  dhCodeTip: 'Как записано в данных игры',
};

export const dialogHelpZh: typeof dialogHelpEn = {
  dhSearch: '查找…',
  dhSearchTip: '按名称、英文名称或代码（DC_…、DA_…）查找。回车选择第一个结果。',
  dhNoMatch: '未找到',
  dhOther: '其他',
  dhUnusedData: '已加载的数据中未使用',
  dhCodeTip: '游戏数据中的原始写法',
};
