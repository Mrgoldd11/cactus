/**
 * Names and short explanations of the small dialogue enums in en/ru/zh: who (TalkerEnum),
 * comparison (ComparisonEnum), repetition limit (DialogRepetitionEnum), target type
 * (CharacterTypeEnum), personality traits (PersonalityTags) and long-term memories
 * (CharacterPerceptionTags_LongTerm). Sources: fcs.def descriptions, the value names and vanilla use.
 */
import { t, type DialogValueHelp } from './dialog-help-types.ts';
import { mapUi, type UiText } from '../ui-text.ts';

const h = (label: UiText, desc: UiText, extra: Partial<Pick<DialogValueHelp, 'undescribed' | 'unused'>> = {}): DialogValueHelp => ({ label, desc, ...extra });

/** How a talker reads inside a phrase: `s` — subject («I», «я»), `o` — owner («my», «меня»). */
export interface TalkerForms {
  s: UiText;
  o: UiText;
}

export interface TalkerHelp extends DialogValueHelp {
  forms: TalkerForms;
}

const who = (label: UiText, desc: UiText, s: UiText, o: UiText): TalkerHelp => ({ label, desc, forms: { s, o } });

export const TALKER_HELP: Readonly<Record<string, TalkerHelp>> = {
  T_ME: who(t('me', 'я', '我'), t('The speaker of the line.', 'Тот, кто говорит реплику.', '说这句台词的人。'), t('I', 'я', '我'), t('my', 'меня', '我')),
  T_TARGET: who(
    t('target', 'собеседник', '对方'),
    t('The one the speaker talks to.', 'Тот, к кому обращается говорящий.', '说话者交谈的对象。'),
    t('the target', 'собеседник', '对方'),
    t('the target\'s', 'собеседника', '对方'),
  ),
  T_TARGET_IF_PLAYER: who(
    t('target if player', 'собеседник, если игрок', '对方（若为玩家）'),
    t('The target, but only when it is a player character.', 'Собеседник, но только если это персонаж игрока.', '对方，但仅当其为玩家角色时。'),
    t('the player target', 'собеседник-игрок', '作为玩家的对方'),
    t('the player target\'s', 'собеседника-игрока', '作为玩家的对方'),
  ),
  T_INTERJECTOR1: who(
    t('interjector 1', 'вмешавшийся 1', '插话者 1'),
    t('The first character who joins the talk (an interjection line).', 'Первый, кто вмешивается в разговор (реплика-вмешательство).', '第一个插话的角色（插话台词）。'),
    t('interjector 1', 'вмешавшийся 1', '插话者 1'),
    t('interjector 1\'s', 'вмешавшегося 1', '插话者 1'),
  ),
  T_INTERJECTOR2: who(
    t('interjector 2', 'вмешавшийся 2', '插话者 2'),
    t('The second character who joins the talk.', 'Второй, кто вмешивается в разговор.', '第二个插话的角色。'),
    t('interjector 2', 'вмешавшийся 2', '插话者 2'),
    t('interjector 2\'s', 'вмешавшегося 2', '插话者 2'),
  ),
  T_INTERJECTOR3: who(
    t('interjector 3', 'вмешавшийся 3', '插话者 3'),
    t('The third character who joins the talk.', 'Третий, кто вмешивается в разговор.', '第三个插话的角色。'),
    t('interjector 3', 'вмешавшийся 3', '插话者 3'),
    t('interjector 3\'s', 'вмешавшегося 3', '插话者 3'),
  ),
  T_WHOLE_SQUAD: who(
    t('whole squad', 'весь отряд', '整个小队'),
    t('The whole squad of the speaker; how a condition is checked for a squad is not described.', 'Весь отряд говорящего; как условие проверяется для отряда, не описано.', '说话者的整个小队；条件如何对小队检查未描述。'),
    t('the whole squad', 'весь отряд', '整个小队'),
    t('the whole squad\'s', 'всего отряда', '整个小队'),
  ),
  T_TARGET_WITH_RACE: who(
    t('target of the race', 'собеседник нужной расы', '指定种族的对方'),
    t('A member of the target squad who matches the «target race» list of the line (fcs.def).', 'Член отряда собеседника, подходящий под список «target race» реплики (fcs.def).', '对方小队中符合台词「target race」列表的成员（fcs.def）。'),
    t('the target of the race', 'собеседник нужной расы', '指定种族的对方'),
    t('the target of the race\'s', 'собеседника нужной расы', '指定种族的对方'),
  ),
};

export interface ComparisonHelp extends DialogValueHelp {
  /** Words before the number in a phrase: «more than», «больше». */
  word: UiText;
}

export const COMPARISON_HELP: Readonly<Record<string, ComparisonHelp>> = {
  CE_EQUALS: { label: t('equals', 'равно', '等于'), desc: t('The value must be exactly this. For yes/no conditions 1 is yes and 0 is no.', 'Значение должно быть ровно таким. У условий «да/нет» 1 — да, 0 — нет.', '值必须正好等于此数。是/否条件中 1 为是，0 为否。'), word: t('exactly', 'ровно', '等于') },
  CE_LESS_THAN: { label: t('less than', 'меньше', '小于'), desc: t('The value must be less than this.', 'Значение должно быть меньше этого.', '值必须小于此数。'), word: t('less than', 'меньше', '少于') },
  CE_MORE_THAN: { label: t('more than', 'больше', '大于'), desc: t('The value must be more than this.', 'Значение должно быть больше этого.', '值必须大于此数。'), word: t('more than', 'больше', '多于') },
};

const REP = t('How often the line can play (fcs.def): ', 'Как часто может звучать реплика (fcs.def): ', '台词可以多久播放一次（fcs.def）：');
const rep = (label: UiText, rest: UiText, extra: Partial<Pick<DialogValueHelp, 'undescribed'>> = {}): DialogValueHelp =>
  h(label, mapUi([REP, rest], ([a, b]) => `${a}${b}`), extra);

export const REPETITION_HELP: Readonly<Record<string, DialogValueHelp>> = {
  DR_NO_LIMIT: rep(t('no limit', 'без ограничений', '无限制'), t('no limit.', 'без ограничений.', '无限制。')),
  DR_SHORT_2: rep(t('2 h', '2 ч', '2 小时'), t('once in 2 hours (by the code name).', 'раз в 2 часа (по имени кода).', '每 2 小时一次（按代码名称）。')),
  DR_MEDIUM_6: rep(t('6 h', '6 ч', '6 小时'), t('once in 6 hours (by the code name).', 'раз в 6 часов (по имени кода).', '每 6 小时一次（按代码名称）。')),
  DR_LONG_48: rep(t('48 h', '48 ч', '48 小时'), t('once in 48 hours (by the code name).', 'раз в 48 часов (по имени кода).', '每 48 小时一次（按代码名称）。')),
  DR_LONG_1WEEK: rep(t('a week', 'неделя', '一周'), t('once a week (by the code name).', 'раз в неделю (по имени кода).', '每周一次（按代码名称）。')),
  DR_ONCE_ONLY: rep(t('once only', 'один раз', '仅一次'), t('only once.', 'только один раз.', '只有一次。')),
  DR_VSHORT_020: rep(
    t('very short', 'очень коротко', '很短'),
    t('a very short pause; «020» may be 0.2 hours, not described.', 'очень короткая пауза; «020» — возможно, 0,2 часа, не описано.', '很短的间隔；「020」可能是 0.2 小时，未描述。'),
    { undescribed: true },
  ),
};

const TYPE = t('Only for targets of this type (fcs.def «target is type»).', 'Только для собеседников этого типа (fcs.def «target is type»).', '仅对此类型的对方（fcs.def「target is type」）。');
const ot = (label: UiText, extra: Partial<Pick<DialogValueHelp, 'unused'>> = {}): DialogValueHelp => h(label, TYPE, extra);

export const CHARACTER_TYPE_HELP: Readonly<Record<string, DialogValueHelp>> = {
  OT_NONE: h(t('any', 'любой', '任意'), t('Not set: the line is for a target of any type.', 'Не задано: реплика для собеседника любого типа.', '未设置：台词适用于任何类型的对方。')),
  OT_LAW_ENFORCEMENT: ot(t('law enforcement', 'стража', '执法者')),
  OT_MILITARY: ot(t('military', 'военные', '军人')),
  OT_TRADER: ot(t('trader', 'торговец', '商人')),
  OT_CIVILIAN: ot(t('civilian', 'горожанин', '平民')),
  OT_DIPLOMAT: ot(t('diplomat', 'дипломат', '外交官')),
  OT_SLAVE: ot(t('slave', 'раб', '奴隶')),
  OT_SLAVER: ot(t('slaver', 'работорговец', '奴隶贩子')),
  OT_BANDIT: ot(t('bandit', 'бандит', '强盗')),
  OT_ADVENTURER: ot(t('adventurer', 'искатель приключений', '冒险者')),
  OT_END: h(t('end of the list', 'конец списка', '列表末尾'), t('Service value: the number of types.', 'Служебное значение: число типов.', '内部值：类型的数量。'), { unused: true }),
};

const PT = t(
  'A personality trait (PERSONALITY «tags»), checked by DC_PERSONALITY_TAG.',
  'Черта характера (PERSONALITY «tags»), её проверяет DC_PERSONALITY_TAG.',
  '性格特征（PERSONALITY「tags」），由 DC_PERSONALITY_TAG 检查。',
);
const pt = (label: UiText) => h(label, PT);
const NOBODY = t(
  ' No vanilla personality gives it, so vanilla lines that check it see «no».',
  ' Ни одна ванильная личность её не даёт, поэтому реплики ванили с проверкой видят «нет».',
  '原版没有任何性格赋予它，因此检查它的原版台词得到「否」。',
);
const ptNobody = (label: UiText) => h(label, mapUi([PT, NOBODY], ([a, b]) => `${a}${b}`));
const erased = (hint: UiText): DialogValueHelp =>
  h(t('unnamed trait', 'безымянная черта', '无名特征'), {
    en: `The name is erased in the FCS sources and no vanilla personality gives it; not described. Vanilla lines with it: ${hint.en}.`,
    ru: `Имя стёрто в исходниках FCS, ни одна ванильная личность её не даёт; не описано. Реплики ванили с ней: ${hint.ru}.`,
    zh: `名称在 FCS 源码中被抹去，原版没有任何性格赋予它；未描述。原版使用它的台词：${hint.zh}。`,
  }, { undescribed: true });

export const PERSONALITY_HELP: Readonly<Record<string, DialogValueHelp>> = {
  PT_NONE: h(t('none', 'нет', '无'), t('Empty value: no trait.', 'Пустое значение: черты нет.', '空值：没有特征。'), { unused: true }),
  PT_HONORABLE: pt(t('honorable', 'честный', '正直')),
  PT_TRAITOROUS: pt(t('traitorous', 'вероломный', '奸诈')),
  PT___: erased(t('«Yeah! High five me!», «Tear them down!»', '«Yeah! High five me!», «Tear them down!»', '「Yeah! High five me!」、「Tear them down!」')),
  PT__: erased(t('«Fight alone. Die alone.», «You should\'ve run.»', '«Fight alone. Die alone.», «You should\'ve run.»', '「Fight alone. Die alone.」、「You should\'ve run.」')),
  PT_SMART: pt(t('smart', 'умный', '聪明')),
  PT_DUMB: pt(t('dumb', 'глупый', '愚笨')),
  PT____: erased(t('«Thank you.», «Sorry to trouble you.»', '«Thank you.», «Sorry to trouble you.»', '「Thank you.」、「Sorry to trouble you.」')),
  PT_____: erased(t('«Don\'t owe you a thing.», «Get out of my house.»', '«Don\'t owe you a thing.», «Get out of my house.»', '「Don\'t owe you a thing.」、「Get out of my house.」')),
  PT_BRAVE: pt(t('brave', 'храбрый', '勇敢')),
  PT_FEARFUL: pt(t('fearful', 'трусливый', '胆小')),
  PT_WARM_KIND: ptNobody(t('warm, kind', 'добрый', '温和善良')),
  PT_COLD_CRUEL: ptNobody(t('cold, cruel', 'жестокий', '冷酷残忍')),
  PT_NORMAL: h(t('normal', 'обычный', '普通'), t('A personality trait; no vanilla line checks it.', 'Черта характера; ни одна реплика ванили её не проверяет.', '性格特征；原版没有台词检查它。'), { unused: true }),
  PT_MANIACAL: pt(t('maniacal', 'безумный', '疯狂')),
  PT_END: h(t('end of the list', 'конец списка', '列表末尾'), t('Service value: the number of traits.', 'Служебное значение: число черт.', '内部值：特征的数量。'), { unused: true }),
};

const LT = t(
  'A long-term memory of a character about someone, checked by DC_HAS_TAG.',
  'Долгая память персонажа о ком-то, её проверяет DC_HAS_TAG.',
  '角色对某人的长期记忆，由 DC_HAS_TAG 检查。',
);
const lt = (label: UiText, extra: Partial<Pick<DialogValueHelp, 'unused'>> = {}) => h(label, LT, extra);

export const PERCEPTION_TAG_HELP: Readonly<Record<string, DialogValueHelp>> = {
  LT_NONE: h(t('none', 'нет', '无'), t('Empty value: no memory.', 'Пустое значение: памяти нет.', '空值：没有记忆。'), { unused: true }),
  LT_MY_INTRUDER: lt(t('broke into my place', 'вторгался ко мне', '闯入过我的地方'), { unused: true }),
  LT_MY_LIFESAVER: lt(t('saved my life', 'спас мне жизнь', '救过我的命')),
  LT_FREED_ME: lt(t('freed me', 'освободил меня', '解救过我')),
  LT_STOLE_FROM_ME: lt(t('stole from me', 'обокрал меня', '偷过我的东西')),
  LT_MY_CAPTOR: lt(t('held me captive', 'держал меня в плену', '囚禁过我')),
  LT_FRIENDLY_AQUAINTANCE: lt(t('friendly acquaintance', 'добрый знакомый', '友好的熟人'), { unused: true }),
  LT_DEFEATED_MY_SQUAD_ONCE: lt(t('once beat my squad', 'однажды разбил мой отряд', '曾击败我的小队')),
  LT_SQUAD_LOST_TO_ME_ONCE: lt(t('once lost to me', 'однажды проиграл мне', '曾输给我')),
  LT_KILLED_MY_FRIEND: lt(t('killed my friend', 'убил моего друга', '杀了我的朋友')),
  LT_I_SCREWED_THIS_GUY: lt(t('I cheated them', 'я его обманул', '我坑过他'), { unused: true }),
  LT_MAX: h(t('end of the list', 'конец списка', '列表末尾'), t('Service value: the number of memories.', 'Служебное значение: число меток памяти.', '内部值：记忆标签的数量。'), { unused: true }),
};
