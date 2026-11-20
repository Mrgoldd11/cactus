/**
 * Reference categories and plain fields of DIALOGUE_LINE in plain words, en/ru/zh.
 * Meaning comes from the fcs.def descriptions (quoted in `desc`). `phrase` templates:
 * `{list}` — the names of the referenced records joined by «or»/«and» (see `join`),
 * `{n}` — the field value.
 */
import { t, type DialogValueHelp } from './dialog-help-types.ts';
import type { UiText } from '../ui-text.ts';

export interface LineRefHelp extends DialogValueHelp {
  /** A condition for the line to play, or something that happens after it. */
  kind: 'condition' | 'effect';
  phrase: UiText;
  /** How several targets combine (fcs.def): any of them, or all of them. */
  join: 'or' | 'and';
  /** What v0 of each reference means, when it matters. */
  value?: UiText;
}

const c = (label: UiText, desc: UiText, phrase: UiText, join: 'or' | 'and' = 'or', value?: UiText): LineRefHelp =>
  value ? { kind: 'condition', label, desc, phrase, join, value } : { kind: 'condition', label, desc, phrase, join };
const e = (label: UiText, desc: UiText, phrase: UiText, value?: UiText): LineRefHelp =>
  value ? { kind: 'effect', label, desc, phrase, join: 'and', value } : { kind: 'effect', label, desc, phrase, join: 'and' };

export const LINE_REF_HELP: Readonly<Record<string, LineRefHelp>> = {
  'has package': c(
    t('Has dialogue package', 'Есть пакет диалогов', '有对话包'),
    t('The speaker has this dialogue package; on an interjection line — the interjector.', 'У говорящего есть этот пакет диалогов; у реплики-вмешательства — у вмешавшегося.', '说话者拥有此对话包；在插话台词上则是插话者。'),
    t('I have the dialogue package {list}', 'у меня есть пакет диалогов {list}', '我有对话包 {list}'),
  ),
  'in town of': c(
    t('In a town of', 'В городе фракции', '在派系城镇'),
    t('We are now in a town or base of this faction.', 'Мы сейчас в городе или на базе этой фракции.', '我们当前在此派系的城镇或基地中。'),
    t('we are in a town of {list}', 'мы в городе фракции {list}', '我们在 {list} 的城镇中'),
  ),
  'is character': c(
    t('Is character', 'Это персонаж', '是角色'),
    t('The speaker is this exact character; on an interjection line — the interjector.', 'Говорящий — именно этот персонаж; у реплики-вмешательства — вмешавшийся.', '说话者就是这个角色；在插话台词上则是插话者。'),
    t('I am {list}', 'я — {list}', '我是 {list}'),
  ),
  'my faction': c(
    t('My faction', 'Моя фракция', '我的派系'),
    t('I belong to this faction.', 'Я из этой фракции.', '我属于此派系。'),
    t('I belong to {list}', 'я из фракции {list}', '我属于 {list}'),
  ),
  'my race': c(
    t('My race', 'Моя раса', '我的种族'),
    t('My race is one of these. Several races mean «any of them».', 'Моя раса — одна из этих. Несколько рас — «любая из них».', '我的种族是其中之一。多个种族表示「任意一个」。'),
    t('my race is {list}', 'моя раса — {list}', '我的种族是 {list}'),
  ),
  'my subrace': c(
    t('My subrace', 'Моя подраса', '我的亚种'),
    t('My exact subrace. Several mean «any of them».', 'Моя точная подраса. Несколько — «любая из них».', '我的具体亚种。多个表示「任意一个」。'),
    t('my subrace is {list}', 'моя подраса — {list}', '我的亚种是 {list}'),
  ),
  'no target race': c(
    t('No target race', 'Нет расы у собеседника', '对方无此种族'),
    t('Nobody in the target squad is of these races. Several races mean «none of them».', 'В отряде собеседника никого из этих рас. Несколько рас — «ни одной из них».', '对方小队中没有这些种族的成员。多个种族表示「都没有」。'),
    t('the target squad has nobody of {list}', 'в отряде собеседника нет рас {list}', '对方小队中没有 {list}'),
    'and',
  ),
  'target carrying character': c(
    t('Target carries character', 'Собеседник несёт персонажа', '对方扛着角色'),
    t('The target carries this exact character.', 'Собеседник несёт именно этого персонажа.', '对方扛着这个特定角色。'),
    t('the target carries {list}', 'собеседник несёт {list}', '对方扛着 {list}'),
  ),
  'target faction': c(
    t('Target faction', 'Фракция собеседника', '对方的派系'),
    t('The target belongs to this faction.', 'Собеседник из этой фракции.', '对方属于此派系。'),
    t('the target belongs to {list}', 'собеседник из фракции {list}', '对方属于 {list}'),
  ),
  'target has item': c(
    t('Target has item', 'У собеседника есть вещь', '对方有物品'),
    t('The target has this item, or any of these items.', 'У собеседника есть эта вещь или любая из этих.', '对方有此物品，或其中任意一件。'),
    t('the target has {list}', 'у собеседника есть {list}', '对方有 {list}'),
  ),
  'target has item type': c(
    t('Target has item type', 'У собеседника есть вещь того же типа', '对方有同类物品'),
    t('The target has an item of the same type as this one (narcotics, meds, food…).', 'У собеседника есть вещь того же типа, что эта (наркотики, медикаменты, еда…).', '对方有与此同类型的物品（毒品、药品、食物……）。'),
    t('the target has something like {list}', 'у собеседника есть вещь того же типа, что {list}', '对方有与 {list} 同类型的物品'),
  ),
  'target race': c(
    t('Target race', 'Раса собеседника', '对方的种族'),
    t('Someone in the target squad is of one of these races. Several races mean «any of them».', 'В отряде собеседника есть кто-то из этих рас. Несколько рас — «любая из них».', '对方小队中有这些种族之一的成员。多个种族表示「任意一个」。'),
    t('the target squad has someone of {list}', 'в отряде собеседника есть {list}', '对方小队中有 {list}'),
  ),
  'world state': c(
    t('World state', 'Состояние мира', '世界状态'),
    t('This world state must hold (1) or must not hold (0). Several mean «all of them».', 'Это состояние мира должно быть (1) или не должно быть (0). Несколько — «все сразу».', '此世界状态必须成立（1）或不成立（0）。多个表示「全部」。'),
    t('the world state is {list}', 'состояние мира: {list}', '世界状态：{list}'),
    'and',
    t('1 — holds, 0 — does not', '1 — есть, 0 — нет', '1 — 成立，0 — 不成立'),
  ),
  'change relations': e(
    t('Change relations', 'Изменить отношения', '改变关系'),
    t('Changes the relations with this faction by the number.', 'Меняет отношения с этой фракцией на число.', '按数值改变与此派系的关系。'),
    t('relations change: {list}', 'меняются отношения: {list}', '关系改变：{list}'),
    t('by how much, ±', 'на сколько, ±', '改变多少，±'),
  ),
  'crowd trigger': e(
    t('Crowd trigger', 'Подхватить толпой', '群体触发'),
    t('Starts this dialogue on the other members of the squad (cheering, laughter, war cries). The number is the % of the squad.', 'Запускает этот диалог у остальных в отряде (ликование, смех, боевой клич). Число — % отряда.', '在小队其他成员身上触发此对话（欢呼、大笑、战吼）。数字为小队的百分比。'),
    t('the squad picks up {list}', 'отряд подхватывает {list}', '小队跟着说 {list}'),
    t('% of the squad', '% отряда', '小队百分比'),
  ),
  'give item': e(
    t('Give item', 'Дать вещь', '给予物品'),
    t('Gives the target this item, conjured out of thin air.', 'Даёт собеседнику эту вещь, создавая её из воздуха.', '凭空变出此物品并交给对方。'),
    t('the target gets {list}', 'собеседник получает {list}', '对方获得 {list}'),
    t('how many', 'сколько', '数量'),
  ),
  locks: e(
    t('Locks', 'Закрывает', '锁定'),
    t('Locks this dialogue, for special cases.', 'Закрывает этот диалог, для особых случаев.', '锁定此对话，用于特殊情况。'),
    t('{list} is locked', 'закрывается {list}', '{list} 被锁定'),
  ),
  'unlock but keep me': e(
    t('Unlocks, keeps this one', 'Открывает, этот остаётся', '解锁，保留本对话'),
    t('Unlocks this dialogue (it must be in the NPC dialogue package). This dialogue stays open.', 'Открывает этот диалог (он должен быть в пакете диалогов NPC). Этот диалог остаётся открытым.', '解锁此对话（必须在 NPC 的对话包中）。本对话保持开启。'),
    t('{list} opens, this dialogue stays', 'открывается {list}, этот остаётся', '{list} 解锁，本对话保留'),
  ),
  unlocks: e(
    t('Unlocks', 'Открывает', '解锁'),
    t('Unlocks this dialogue (it must be in the NPC dialogue package) and locks this one. For talks that go on in stages.', 'Открывает этот диалог (он должен быть в пакете диалогов NPC) и закрывает этот. Для разговоров по этапам.', '解锁此对话（必须在 NPC 的对话包中）并锁定本对话。用于分阶段进行的对话。'),
    t('{list} opens, this dialogue locks', 'открывается {list}, этот закрывается', '{list} 解锁，本对话锁定'),
  ),
  'AI contract': e(
    t('AI contract', 'AI-контракт', 'AI 合约'),
    t('Runs this AI package as a contract job; the number is how many hours it lasts.', 'Запускает этот AI-пакет как контракт; число — сколько часов он длится.', '将此 AI 包作为合约工作执行；数字为持续小时数。'),
    t('AI contract: {list}', 'AI-контракт: {list}', 'AI 合约：{list}'),
    t('hours', 'часы', '小时'),
  ),
  'change AI': e(
    t('Change AI', 'Сменить AI', '更换 AI'),
    t('Changes the AI package for good, for the whole squad, slaves and masters too. Does not touch the AI contract.', 'Меняет AI-пакет навсегда, всему отряду, и рабам, и хозяевам. AI-контракт не трогает.', '永久更换 AI 包，作用于整个小队，包括奴隶和主人。不影响 AI 合约。'),
    t('the squad AI becomes {list}', 'AI отряда становится {list}', '小队 AI 变为 {list}'),
  ),
  interrupt: e(
    t('Interrupt', 'Перебить', '打断'),
    t('The conversation chosen if the player interrupts us; reset at the end of the conversation.', 'Разговор, который выберется, если игрок нас перебьёт; сбрасывается в конце разговора.', '如果玩家打断我们时选择的对话；对话结束时重置。'),
    t('if the player interrupts: {list}', 'если игрок перебьёт: {list}', '如果玩家打断：{list}'),
  ),
  'trigger campaign': e(
    t('Trigger campaign', 'Запустить кампанию', '触发战役'),
    t('Starts this faction campaign in v0–v1 hours with a v2 % chance.', 'Запускает эту кампанию фракции через v0–v1 часов с шансом v2 %.', '在 v0–v1 小时后以 v2% 的几率触发此派系战役。'),
    t('campaign starts: {list}', 'запускается кампания: {list}', '战役触发：{list}'),
    t('hours from–to, % chance', 'часы от–до, % шанса', '小时 从–到，几率%'),
  ),
  'lock campaign': e(
    t('Lock campaign', 'Закрыть кампанию', '锁定战役'),
    t('Sets the «territorial» setting of this faction campaign to false.', 'Ставит у этой кампании фракции настройку «territorial» в «нет».', '将此派系战役的「territorial」设置为否。'),
    t('campaign locked: {list}', 'закрывается кампания: {list}', '战役锁定：{list}'),
  ),
  // Old fields: in vanilla data (gamedata.base, dialogue-02.mod), but fcs.def has them on no dialogue line,
  // so FCS does not show them. Shown so that a line never hides a reference; the picker does not offer them.
  'delivery AI package': e(
    t('Delivery AI package (old field)', 'AI-пакет доставки (старое поле)', '交付 AI 包（旧字段）'),
    t('Not in fcs.def for a dialogue line: an old field FCS does not show; the game may ignore it. Use «AI contract» or «Change AI».', 'В fcs.def у реплики такого поля нет: старое поле, FCS его не показывает, игра может его не читать. Вместо него — «AI-контракт» или «Сменить AI».', 'fcs.def 中对话台词没有此字段：FCS 不显示的旧字段，游戏可能不会读取。请改用「AI 合约」或「更换 AI」。'),
    t('old field: delivery AI package {list}', 'старое поле: AI-пакет доставки {list}', '旧字段：交付 AI 包 {list}'),
  ),
  'set AI package': e(
    t('Set AI package (old field)', 'Задать AI-пакет (старое поле)', '设置 AI 包（旧字段）'),
    t('Not in fcs.def for a dialogue line: an old field FCS does not show; the game may ignore it. Use «AI contract» or «Change AI».', 'В fcs.def у реплики такого поля нет: старое поле, FCS его не показывает, игра может его не читать. Вместо него — «AI-контракт» или «Сменить AI».', 'fcs.def 中对话台词没有此字段：FCS 不显示的旧字段，游戏可能不会读取。请改用「AI 合约」或「更换 AI」。'),
    t('old field: AI package becomes {list}', 'старое поле: AI-пакет становится {list}', '旧字段：AI 包变为 {list}'),
  ),
  'unlock campaign': e(
    t('Unlock campaign', 'Открыть кампанию', '解锁战役'),
    t('Sets the «territorial» setting of this faction campaign to true: it can happen now, but is not started.', 'Ставит у этой кампании фракции настройку «territorial» в «да»: она становится возможной, но не запускается.', '将此派系战役的「territorial」设置为是：使其可能发生，但不会触发。'),
    t('campaign unlocked: {list}', 'открывается кампания: {list}', '战役解锁：{list}'),
  ),
};

/** Plain fields of DIALOGUE_LINE that work as conditions; `{n}` is the value. */
export const LINE_FIELD_HELP: Readonly<Record<string, { label: UiText; desc: UiText; phrase: UiText }>> = {
  'chance permanent': {
    label: t('Chance to have', 'Шанс иметь', '拥有几率'),
    desc: t('% chance the character HAS this line at all; decided once and saved forever. For rare characters.', '% шанса, что у персонажа вообще ЕСТЬ эта реплика; решается раз и сохраняется навсегда. Для редких персонажей.', '角色「拥有」此台词的百分比几率；只决定一次并永久保存。用于稀有角色。'),
    phrase: t('{n}% of characters have this line', 'реплика есть у {n}% персонажей', '{n}% 的角色拥有此台词'),
  },
  'chance temporary': {
    label: t('Chance to use', 'Шанс сказать', '使用几率'),
    desc: t('% chance the character USES this line each time; for random choices.', '% шанса, что персонаж СКАЖЕТ эту реплику в этот раз; для случайного выбора.', '角色每次「使用」此台词的百分比几率；用于随机选择。'),
    phrase: t('said with a {n}% chance', 'звучит с шансом {n}%', '以 {n}% 几率说出'),
  },
  'repetition limit': {
    label: t('Repetition limit', 'Повтор не чаще', '重复限制'),
    desc: t('How often the line can be played.', 'Как часто может звучать реплика.', '台词可以多久播放一次。'),
    phrase: t('repeats: {n}', 'повтор: {n}', '重复：{n}'),
  },
  'score bonus': {
    label: t('Score bonus', 'Бонус к весу', '分数加成'),
    desc: t('Adds to the score of the line to give it priority.', 'Добавляет к весу реплики, чтобы дать ей приоритет.', '增加台词的分数以提高其优先级。'),
    phrase: t('score bonus {n}', 'бонус к весу {n}', '分数加成 {n}'),
  },
  'target is type': {
    label: t('Target type', 'Тип собеседника', '对方类型'),
    desc: t('Only for targets of this type (if set).', 'Только для собеседников этого типа (если задано).', '仅对此类型的对方（如果设置）。'),
    phrase: t('the target is: {n}', 'собеседник — {n}', '对方是：{n}'),
  },
};
