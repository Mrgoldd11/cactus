/** Record list search syntax strings (merged into the shared dictionary `i18n.ts`). */
export const searchEn = {
  searchHelpTip: 'Search syntax',
  searchHelpTitle: 'Search: words and conditions',
  searchHelpIntro: 'Plain words look in the name, the translation and the id. Conditions are separated by ;',
  searchHelpOps: '= equal, != not equal, > < >= <= numbers, : contains, !: does not contain, ? regular expression, key? — the field is set',
  searchHelpKeywords: 'type — record type, state — new / changed / deleted / base / mod, ref — a referenced record (ref>0 — how many records reference this one)',
  searchHelpPath: 'list.field — through references: some record in the list matches. "type" in quotes — a field named type, not the keyword.',
  searchHelpExamples: 'Examples (click to try):',
  searchHelpEx: [
    ['bandit; type=CHARACTER', 'characters with “bandit” in the name'],
    ['type=WEAPON; weight kg>10', 'weapons heavier than 10 kg'],
    ['state=mod', 'everything the mod adds or changes'],
    ['name?^hive soldier', 'names by regular expression'],
    ['ref=Katana', 'records that reference the Katana'],
    ['type=CHARACTER; vendors.weapons:katana', 'traders whose shop lists sell katanas (two levels of references)'],
  ] as readonly (readonly [string, string])[],
  searchBadCondition: (err: string): string => `Condition ignored: ${err}`,
  searchUnknownKeys: (keys: string): string => `No such field in any type: ${keys} — this condition matches nothing`,
};

export type SearchStrings = typeof searchEn;

export const searchRu: SearchStrings = {
  searchHelpTip: 'Синтаксис поиска',
  searchHelpTitle: 'Поиск: слова и условия',
  searchHelpIntro: 'Обычные слова ищутся в имени, переводе и id. Условия разделяются знаком ;',
  searchHelpOps: '= равно, != не равно, > < >= <= числа, : содержит, !: не содержит, ? регулярное выражение, поле? — поле задано',
  searchHelpKeywords: 'type — тип записи, state — new / changed / deleted / base / mod, ref — запись, на которую ссылаются (ref>0 — сколько записей ссылаются на эту)',
  searchHelpPath: 'список.поле — через ссылки: подходит хотя бы одна запись списка. "type" в кавычках — поле с именем type, а не ключевое слово.',
  searchHelpExamples: 'Примеры (нажмите, чтобы попробовать):',
  searchHelpEx: [
    ['bandit; type=CHARACTER', 'персонажи со словом «bandit» в имени'],
    ['type=WEAPON; weight kg>10', 'оружие тяжелее 10 кг'],
    ['state=mod', 'всё, что мод добавляет или меняет'],
    ['name?^hive soldier', 'имена по регулярному выражению'],
    ['ref=Katana', 'записи, которые ссылаются на Катану'],
    ['type=CHARACTER; vendors.weapons:katana', 'торговцы, в чьих списках товаров есть катаны (две ступени ссылок)'],
  ],
  searchBadCondition: (err: string): string => `Условие пропущено: ${err}`,
  searchUnknownKeys: (keys: string): string => `Такого поля нет ни в одном типе: ${keys} — это условие ничего не найдёт`,
};

export const searchZh: SearchStrings = {
  searchHelpTip: '搜索语法',
  searchHelpTitle: '搜索：词语与条件',
  searchHelpIntro: '普通词语在名称、译名和 ID 中查找。条件之间用 ; 分隔',
  searchHelpOps: '= 等于，!= 不等于，> < >= <= 数字，: 包含，!: 不包含，? 正则表达式，字段? — 字段已设置',
  searchHelpKeywords: 'type — 记录类型，state — new / changed / deleted / base / mod，ref — 被引用的记录（ref>0 — 有多少记录引用此记录）',
  searchHelpPath: '列表.字段 — 通过引用：列表中至少一条记录符合。加引号的 "type" — 名为 type 的字段，而不是关键字。',
  searchHelpExamples: '示例（点击试用）：',
  searchHelpEx: [
    ['bandit; type=CHARACTER', '名称含 “bandit” 的角色'],
    ['type=WEAPON; weight kg>10', '重量大于 10 千克的武器'],
    ['state=mod', '模组新增或修改的全部内容'],
    ['name?^hive soldier', '按正则表达式匹配名称'],
    ['ref=Katana', '引用武士刀（Katana）的记录'],
    ['type=CHARACTER; vendors.weapons:katana', '商店清单中出售武士刀的商人（两层引用）'],
  ],
  searchBadCondition: (err: string): string => `已忽略条件：${err}`,
  searchUnknownKeys: (keys: string): string => `任何类型都没有此字段：${keys} — 此条件找不到任何记录`,
};
