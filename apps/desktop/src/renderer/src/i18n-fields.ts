/** Strings of the «Fields» tab: references among the fields and the field description bar (merged into `i18n.ts`). */
export const fieldsEn = {
  refEmpty: 'empty',
  refPick: 'Choose…',
  refCount: (n: number): string => (n === 1 ? '1 record' : `${n} records`),
  refPickTip: 'Add a record to this list',
  fieldHelpNone: 'Select a field to see what it does.',
  fieldNoDescription: 'fcs.def has no description for this field.',
  fieldHelpEmpty: 'Empty',
};

export const fieldsRu: typeof fieldsEn = {
  refEmpty: 'пусто',
  refPick: 'Выбрать…',
  refCount: (n: number): string => `записей: ${n}`,
  refPickTip: 'Добавить запись в этот список',
  fieldHelpNone: 'Выберите поле, и здесь появится, что оно значит.',
  fieldNoDescription: 'В fcs.def у этого поля нет описания.',
  fieldHelpEmpty: 'Пусто',
};

export const fieldsZh: typeof fieldsEn = {
  refEmpty: '空',
  refPick: '选择…',
  refCount: (n: number): string => `${n} 条记录`,
  refPickTip: '向此列表添加一条记录',
  fieldHelpNone: '选择一个字段，这里会显示它的作用。',
  fieldNoDescription: 'fcs.def 中没有此字段的说明。',
  fieldHelpEmpty: '为空',
};
