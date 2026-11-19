/**
 * Dialogue conditions (`DialogConditionEnum`, `DIALOG_ACTION.'condition name'`) in plain words:
 * name, explanation and a phrase template (syntax in `dialog-help-types.ts`, `ConditionHelp.phrase`).
 *
 * Neither `fcs.def`, `fcs_enums.def` nor the FCS sources describe these values. Meaning comes from
 * the code names and from how vanilla lines use them (who, comparison, values and the text of the
 * line; census over gamedata.base, Newwworld, Dialogue and rebirth, 2026-11-19). Values no vanilla
 * line uses are `unused`; values whose meaning can not be read from the name are `undescribed`.
 * Official Russian game words come from `locale/ru_RU` («Голодает», «Без сознания», «Каты», «Тех. уровень»).
 */
import { t, type ConditionGroup, type ConditionHelp } from './dialog-help-types.ts';
import type { UiText } from '../ui-text.ts';

type Extra = Partial<Pick<ConditionHelp, 'undescribed' | 'unused'>>;
const bool = (group: ConditionGroup, label: UiText, desc: UiText, phrase: UiText, extra: Extra = {}): ConditionHelp => ({ group, kind: 'bool', label, desc, phrase, ...extra });
const num = (group: ConditionGroup, label: UiText, desc: UiText, phrase: UiText, extra: Extra = {}): ConditionHelp => ({ group, kind: 'number', label, desc, phrase, ...extra });
const U = { unused: true } as const;
const UU = { unused: true, undescribed: true } as const;

export const CONDITION_HELP: Readonly<Record<string, ConditionHelp>> = {
  DC_NONE: bool(
    'service',
    t('No condition', 'Нет условия', '无条件'),
    t('Empty value: the condition is not set.', 'Пустое значение: условие не задано.', '空值：未设置条件。'),
    t('no condition', 'без условия', '无条件'),
    U,
  ),
  DC_RELATIONS: num(
    'relations',
    t('Faction relations', 'Отношения фракций', '派系关系'),
    t(
      'Relations between my faction and the faction of «who», from −100 to 100. Vanilla: «who» is usually the target, values from −60 to 50.',
      'Отношения моей фракции и фракции «кого», от −100 до 100. В ванили «кто» обычно собеседник, значения от −60 до 50.',
      '我的派系与「谁」的派系之间的关系，从 −100 到 100。原版中「谁」通常是对方，数值在 −60 到 50 之间。',
    ),
    t('faction relations ({s}) are {cmp} {n}', 'отношения фракций ({s}) {cmp} {n}', '派系关系（{s}）{cmp} {n}'),
  ),
  DC_PLAYERMONEY: num(
    'money',
    t('Player money', 'Деньги игрока', '玩家的钱'),
    t(
      'How many cats the player has (by the code name, whatever «who» is). Vanilla: prices and bribes, «more than 3000».',
      'Сколько кат у игрока (по имени кода — при любом «кто»). В ванили — цены и взятки: «больше 3000».',
      '玩家有多少猫币（按代码名称，与「谁」无关）。原版用于价格和贿赂：「多于 3000」。',
    ),
    t('the player has {cmp} {n} cats', 'у игрока {cmp} {n} кат', '玩家的钱{cmp} {n}'),
  ),
  DC_REPUTATION: num(
    'relations',
    t('Reputation', 'Репутация', '声望'),
    t(
      'A reputation number of «who». Not described; vanilla compares it with 10–80, mostly «more than», mostly for me.',
      'Число «репутации» у «кого». Не описано; в ванили сравнивают с 10–80, чаще «больше», чаще у меня.',
      '「谁」的声望数值。未描述；原版中与 10–80 比较，多为「大于」，多用于我。',
    ),
    t('the reputation ({s}) is {cmp} {n}', 'репутация ({s}) {cmp} {n}', '声望（{s}）{cmp} {n}'),
    { undescribed: true },
  ),
  DC_CARRYING_BOUNTY_ALIVE: bool(
    'captivity',
    t('Carrying a live bounty', 'Несёт живого с наградой', '扛着活的悬赏目标'),
    t(
      '«Who» carries a living character with a bounty on the shoulder. Vanilla: bounty offices, «Looks like you\'ve caught a bounty».',
      '«Кто» несёт на плече живого персонажа, за которого назначена награда. В ванили — пункты наград: «Looks like you\'ve caught a bounty».',
      '「谁」肩上扛着一个有悬赏的活人。原版用于赏金处：「Looks like you\'ve caught a bounty」。',
    ),
    t('{s} <am|is> [|not ]carrying a live bounty target', '{s} [|не ]<несу|несёт> живого, за которого назначена награда', '{s}[|没有]扛着活的悬赏目标'),
  ),
  DC_CARRYING_BOUNTY_DEAD: bool(
    'captivity',
    t('Carrying a dead bounty', 'Несёт мёртвого с наградой', '扛着死的悬赏目标'),
    t(
      '«Who» carries a dead character with a bounty. Vanilla: «Is he dead? You only get paid half».',
      '«Кто» несёт мёртвого персонажа, за которого назначена награда. В ванили: «Is he dead? You only get paid half».',
      '「谁」扛着一个有悬赏的死人。原版：「Is he dead? You only get paid half」。',
    ),
    t('{s} <am|is> [|not ]carrying a dead bounty target', '{s} [|не ]<несу|несёт> мёртвого, за которого назначена награда', '{s}[|没有]扛着死的悬赏目标'),
  ),
  DC_FACTION_VARIABLE: num(
    'service',
    t('Faction variable', 'Переменная фракции', '派系变量'),
    t('Not described; no vanilla line uses it.', 'Не описано; в ванили не используется.', '未描述；原版未使用。'),
    t('the faction variable ({s}) is {cmp} {n}', 'переменная фракции ({s}) {cmp} {n}', '派系变量（{s}）{cmp} {n}'),
    UU,
  ),
  DC_IMPRISONED_BY_TARGET: bool(
    'captivity',
    t('Prisoner of the target', 'В плену у собеседника', '被对方囚禁'),
    t('«Who» is a prisoner of the target\'s faction. Vanilla: «Soon as I\'m free...».', '«Кто» в плену у фракции собеседника. В ванили: «Soon as I\'m free...».', '「谁」是对方派系的囚犯。原版：「Soon as I\'m free...」。'),
    t('{s} <am|is> [|not ]a prisoner of the target', '{s} [|не ]в плену у собеседника', '{s}[|没有]被对方囚禁'),
  ),
  DC_IMPRISONED_BY_OTHER: bool(
    'captivity',
    t('Prisoner of someone else', 'В плену у других', '被他人囚禁'),
    t('«Who» is a prisoner, but not of the target\'s faction. Vanilla: «Good day, prison brother».', '«Кто» в плену, но не у фракции собеседника. В ванили: «Good day, prison brother».', '「谁」是囚犯，但不是被对方派系囚禁。原版：「Good day, prison brother」。'),
    t('{s} <am|is> [|not ]a prisoner of someone else', '{s} [|не ]в плену у других', '{s}[|没有]被他人囚禁'),
  ),
  DC_IS_A_TRADER: bool(
    'who',
    t('Trader', 'Торговец', '商人'),
    t('«Who» is a trader. Vanilla: guards\' lines check that I am not a trader.', '«Кто» — торговец. В ванили реплики стражи проверяют, что я не торговец.', '「谁」是商人。原版守卫台词会检查我不是商人。'),
    t('{s} <am|is> [|not ]a trader', '{s} [— |не ]торговец', '{s}[|不]是商人'),
  ),
  DC_FACTION_RANK: num(
    'relations',
    t('Faction rank', 'Звание во фракции', '派系等级'),
    t(
      'Rank of «who» in my faction: 0 — not a member, 1 and more — a member. Vanilla: joining the Shinobi Thieves.',
      'Звание «кого» в моей фракции: 0 — не член, 1 и больше — член. В ванили — вступление в Воров шиноби.',
      '「谁」在我派系中的等级：0 — 非成员，1 及以上 — 成员。原版用于加入忍者盗贼。',
    ),
    t('{o} rank in my faction is {cmp} {n}', 'звание {o} в моей фракции {cmp} {n}', '{s}在我派系中的等级{cmp} {n}'),
  ),
  DC_BUILDING_IS_CLOSED_AND_SECURED: bool(
    'place',
    t('Building closed and locked', 'Здание закрыто и заперто', '建筑已关闭上锁'),
    t(
      'The building where «who» is is closed and locked (a shop at night). Vanilla mostly checks it is not: «And how\'d you get in?!».',
      'Здание, где находится «кто», закрыто и заперто (лавка ночью). В ванили чаще проверяют, что нет: «And how\'d you get in?!».',
      '「谁」所在的建筑已关闭上锁（夜间的商店）。原版多检查「没有」：「And how\'d you get in?!」。',
    ),
    t('the building ({s}) is [|not ]closed and locked', 'здание ({s}) [|не ]закрыто и заперто', '建筑（{s}）[|没有]关闭上锁'),
  ),
  DC_PLAYER_TECH_LEVEL: num(
    'money',
    t('Player tech level', 'Тех. уровень игрока', '玩家科技等级'),
    t('Research level of the player. Vanilla: two lines about Ancient Science books.', 'Уровень исследований игрока. В ванили — две реплики о книгах древней науки.', '玩家的研究等级。原版：两句关于古代科学书籍的台词。'),
    t('the player\'s tech level is {cmp} {n}', 'тех. уровень игрока {cmp} {n}', '玩家科技等级{cmp} {n}'),
  ),
  DC_NUM_DIALOG_EVENT_REPEATS: num(
    'service',
    t('Event repeats', 'Повторов события', '事件重复次数'),
    t(
      'How many times this event has fired again for me. Vanilla: warnings that grow angrier, «Alive or dead, you\'re going to get out of my house!» after more than 4.',
      'Сколько раз это событие уже повторилось у меня. В ванили — предупреждения всё злее: «Alive or dead, you\'re going to get out of my house!» после 4.',
      '这个事件在我身上已重复了多少次。原版：越来越生气的警告，超过 4 次后「Alive or dead, you\'re going to get out of my house!」。',
    ),
    t('the event has repeated {cmp} {n} times', 'событие повторилось {cmp} {n} раз', '事件重复次数{cmp} {n}'),
  ),
  DC_IS_IMPRISONED: bool(
    'captivity',
    t('Imprisoned', 'В плену', '被囚禁'),
    t('«Who» is a prisoner (in a cell, a cage or shackles). Vanilla: begging prisoners and «Thief!» lines that check it is not.', '«Кто» в плену (в камере, клетке или кандалах). В ванили — мольбы пленных и крики «Thief!», где проверяют, что нет.', '「谁」是囚犯（牢房、笼子或镣铐）。原版：囚犯的哀求，以及检查「不是」的「Thief!」台词。'),
    t('{s} <am|is> [|not ]imprisoned', '{s} [|не ]в плену', '{s}[|没有]被囚禁'),
  ),
  DC_IMPRISONMENT_IS_DEATHROW: bool(
    'captivity',
    t('On death row', 'Приговорён к смерти', '被判死刑'),
    t('The imprisonment of «who» is a death sentence (by the code name). No vanilla line uses it.', 'Плен «кого» — смертный приговор (по имени кода). В ванили не используется.', '「谁」的监禁是死刑（按代码名称）。原版未使用。'),
    t('{s} <am|is> [|not ]on death row', '{s} [|не ]приговорён к смерти', '{s}[|没有]被判死刑'),
    U,
  ),
  DC_TARGET_IN_TALKING_RANGE: bool(
    'place',
    t('Within talking range', 'Рядом для разговора', '在交谈距离内'),
    t('«Who» is close enough to talk. Vanilla: guards shout «Halt!» only when the target is near.', '«Кто» достаточно близко, чтобы говорить. В ванили стража кричит «Halt!», только когда собеседник рядом.', '「谁」足够近可以交谈。原版：只有对方靠近时守卫才会喊「Halt!」。'),
    t('{s} <am|is> [|not ]within talking range', '{s} [|не ]рядом, на расстоянии разговора', '{s}[|不]在交谈距离内'),
  ),
  DC_IN_MY_BUILDING: bool(
    'place',
    t('In my building', 'В моём здании', '在我的建筑里'),
    t('«Who» is inside a building that belongs to me (a home, a shop). Vanilla: «Not in my house!».', '«Кто» внутри здания, которое принадлежит мне (дом, лавка). В ванили: «Not in my house!».', '「谁」在属于我的建筑里（住所、商店）。原版：「Not in my house!」。'),
    t('{s} <am|is> [|not ]in my building', '{s} [|не ]в моём здании', '{s}[|不]在我的建筑里'),
  ),
  DC_TARGET_LAST_SEEN_X_HOURS_AGO: num(
    'relations',
    t('Hours since last seen', 'Часов с последней встречи', '距上次见面的小时数'),
    t('How many hours ago I last saw «who». Vanilla: greetings that differ after a long absence.', 'Сколько часов назад я последний раз видел «кого». В ванили — приветствия после долгой разлуки.', '我上次见到「谁」是多少小时前。原版：久别后的不同问候。'),
    t('I last saw {s} {cmp} {n} hours ago', 'с последней встречи ({s}) прошло {cmp} {n} ч', '距上次见到{s}{cmp} {n} 小时'),
  ),
  DC_IS_LEADER: bool(
    'squad',
    t('Squad leader', 'Лидер отряда', '小队队长'),
    t('«Who» is the leader of the squad. Vanilla: the leader gives orders, «Get him!».', '«Кто» — лидер отряда. В ванили лидер отдаёт приказы: «Get him!».', '「谁」是小队队长。原版：队长下令，「Get him!」。'),
    t('{s} <am|is> [|not ]the squad leader', '{s} [— |не ]лидер отряда', '{s}[|不]是小队队长'),
  ),
  DC_MET_TARGET_BEFORE: bool(
    'relations',
    t('Met before', 'Встречались раньше', '以前见过'),
    t('I have met the target before. Vanilla: «who» is usually the target; first-meeting greetings check «not».', 'Я уже встречал собеседника. В ванили «кто» обычно собеседник; приветствия при первой встрече проверяют «нет».', '我以前见过对方。原版中「谁」通常是对方；初次见面的问候检查「没有」。'),
    t('{s} <have|has> [|not ]met <the target|me> before', '{s} [|не ]<встречал собеседника|встречал меня> раньше', '{s}[|没有]<见过对方|见过我>'),
  ),
  DC_WEAKER_THAN_ME: bool(
    'squad',
    t('Weaker than me', 'Слабее меня', '比我弱'),
    t('«Who» is weaker than me in a fight; how the game estimates it is not described. Vanilla: «Look at that guy!».', '«Кто» слабее меня в бою; как игра это оценивает, не описано. В ванили: «Look at that guy!».', '「谁」在战斗中比我弱；游戏如何评估未描述。原版：「Look at that guy!」。'),
    t('{s} <am|is> [|not ]weaker than me', '{s} [|не ]слабее меня', '{s}[|不]比我弱'),
  ),
  DC_STRONGER_THAN_ME: bool(
    'squad',
    t('Stronger than me', 'Сильнее меня', '比我强'),
    t('«Who» is stronger than me in a fight; how the game estimates it is not described. Vanilla: «He\'d kill me».', '«Кто» сильнее меня в бою; как игра это оценивает, не описано. В ванили: «He\'d kill me».', '「谁」在战斗中比我强；游戏如何评估未描述。原版：「He\'d kill me」。'),
    t('{s} <am|is> [|not ]stronger than me', '{s} [|не ]сильнее меня', '{s}[|不]比我强'),
  ),
  DC_HAS_TAG: bool(
    'relations',
    t('I remember about them', 'Память о собеседнике', '对其的记忆'),
    t(
      'My long-term memory about «who» has the mark chosen in «tag»: stole from me, freed me, my captor… Gives one more score point.',
      'В моей долгой памяти о «ком» есть отметка из поля «tag»: обокрал меня, освободил меня, держал в плену… Даёт ещё одно очко.',
      '我对「谁」的长期记忆中有「tag」里选的标记：偷过我、救过我、俘虏过我……多加一分。',
    ),
    t('I [|do not ]remember: {s} — “{tag}”', 'я [|не ]помню: {s} — «{tag}»', '我[|不]记得：{s} — 「{tag}」'),
  ),
  DC_IS_ALLY: bool(
    'relations',
    t('Ally', 'Союзник', '盟友'),
    t('«Who» is my ally (a friendly faction).', '«Кто» — мой союзник (дружественная фракция).', '「谁」是我的盟友（友好派系）。'),
    t('{s} <am|is> [|not ]an ally', '{s} [— |не ]союзник', '{s}[|不]是盟友'),
  ),
  DC_IS_ENEMY: bool(
    'relations',
    t('Enemy', 'Враг', '敌人'),
    t('«Who» is my enemy (a hostile faction).', '«Кто» — мой враг (враждебная фракция).', '「谁」是我的敌人（敌对派系）。'),
    t('{s} <am|is> [|not ]an enemy', '{s} [— |не ]враг', '{s}[|不]是敌人'),
  ),
  DC_PERSONALITY_TAG: bool(
    'who',
    t('Personality trait', 'Черта характера', '性格特征'),
    t(
      '«Who» has the personality trait chosen in «tag» (honorable, smart, brave…). The most used condition in vanilla.',
      'У «кого» есть черта характера из поля «tag» (честный, умный, храбрый…). Самое частое условие в ванили.',
      '「谁」拥有「tag」中选择的性格特征（正直、聪明、勇敢……）。原版中最常用的条件。',
    ),
    t('{s} [<have|has>|<do|does> not have] the “{tag}” trait', 'у {o} [есть черта|нет черты] «{tag}»', '{s}[有|没有]「{tag}」特征'),
  ),
  DC_BROKEN_LEG: bool(
    'state',
    t('Broken leg', 'Сломана нога', '断腿'),
    t('«Who» has a broken leg.', 'У «кого» сломана нога.', '「谁」腿断了。'),
    t('{s} [<have|has>|<do|does> not have] a broken leg', 'у {o} [|не ]сломана нога', '{s}[|没有]断腿'),
  ),
  DC_BROKEN_ARM: bool(
    'state',
    t('Broken arm', 'Сломана рука', '断臂'),
    t('«Who» has a broken arm.', 'У «кого» сломана рука.', '「谁」手臂断了。'),
    t('{s} [<have|has>|<do|does> not have] a broken arm', 'у {o} [|не ]сломана рука', '{s}[|没有]断臂'),
  ),
  DC_DAMAGED_HEAD: bool(
    'state',
    t('Head injury', 'Ранена голова', '头部受伤'),
    t('«Who» has an injured head. Vanilla: «my head hurts».', 'У «кого» ранена голова. В ванили: «my head hurts».', '「谁」头部受伤。原版：「my head hurts」。'),
    t('{s} [<have|has>|<do|does> not have] a head injury', 'у {o} [|не ]ранена голова', '{s}[|没有]头部受伤'),
  ),
  DC_NEARLY_KO: bool(
    'state',
    t('Nearly unconscious', 'Почти без сознания', '快要昏迷'),
    t(
      '«Who» is badly hurt, close to falling unconscious. DC_IS_NEARLY_KO looks the same; how they differ is not described.',
      '«Кто» тяжело ранен, вот-вот потеряет сознание. DC_IS_NEARLY_KO выглядит так же; чем они отличаются, не описано.',
      '「谁」伤势很重，快要昏迷。DC_IS_NEARLY_KO 看起来相同；两者区别未描述。',
    ),
    t('{s} <am|is> [|not ]nearly unconscious', '{s} [почти без сознания|не на грани обморока]', '{s}[|没有]快要昏迷'),
  ),
  DC_IN_A_NON_PLAYER_TOWN: bool(
    'place',
    t('In a town not of the player', 'В чужом городе', '在非玩家城镇'),
    t(
      '«Who» is in a town or base that does not belong to the player. The only way to tell a town apart besides «in town of» (by the owner faction).',
      '«Кто» в городе или базе, которые не принадлежат игроку. Кроме «in town of» (по фракции-хозяину), город иначе не различить.',
      '「谁」在不属于玩家的城镇或基地中。除了「in town of」（按所属派系）外，无法区分城镇。',
    ),
    t('{s} <am|is> [|not ]in a town that is not the player\'s', '{s} [|не ]в городе, который не принадлежит игроку', '{s}[|不]在非玩家城镇'),
  ),
  DC_IS_RUNNING: bool(
    'state',
    t('Running', 'Бежит', '在奔跑'),
    t('«Who» is running. Vanilla: «I said get lost!» to a target that runs on.', '«Кто» бежит. В ванили: «I said get lost!» собеседнику, который бежит дальше.', '「谁」在奔跑。原版：对继续奔跑的对方说「I said get lost!」。'),
    t('{s} <am|is> [|not ]running', '{s} [|не ]<бегу|бежит>', '{s}[正在|没有]奔跑'),
  ),
  DC_COPS_AROUND: bool(
    'place',
    t('Guards nearby', 'Рядом стража', '附近有守卫'),
    t('Law enforcers (guards) are near «who». Vanilla: «Guards!» when they are near, a fight when they are not.', 'Рядом с «кем» есть стражи порядка. В ванили: «Guards!», если стража рядом, драка — если нет.', '「谁」附近有执法者（守卫）。原版：附近有守卫时喊「Guards!」，没有时直接打。'),
    t('[there are|there are no] guards near <me|{s}>', 'рядом [есть стража|нет стражи] ({s})', '{s}附近[有|没有]守卫'),
  ),
  NULL_NULL_____DC_TARGET_SQUAD_SIZE: num(
    'service',
    t('Target squad size (removed)', 'Размер отряда собеседника (удалено)', '对方小队人数（已删除）'),
    t(
      'The name is erased in FCS (NULL_NULL): the condition was removed. No vanilla line uses it; use DC_SQUAD_SIZE with «who» = the target.',
      'Имя стёрто в FCS (NULL_NULL): условие убрали. В ванили не используется; вместо него DC_SQUAD_SIZE с «кто» = собеседник.',
      'FCS 中名称已被抹去（NULL_NULL）：该条件已删除。原版未使用；请改用「谁」= 对方的 DC_SQUAD_SIZE。',
    ),
    t('the target\'s squad has {cmp} {n} members', 'в отряде собеседника {cmp} {n} чел.', '对方小队人数{cmp} {n}'),
    U,
  ),
  DC_SQUAD_SIZE: num(
    'squad',
    t('Squad size', 'Размер отряда', '小队人数'),
    t('How many members the squad of «who» has. Vanilla: «Can I join the party?» when the target is alone.', 'Сколько человек в отряде «кого». В ванили: «Can I join the party?», когда собеседник один.', '「谁」的小队有多少人。原版：对方独自一人时「Can I join the party?」。'),
    t('{o} squad has {cmp} {n} members', 'в отряде {o} {cmp} {n} чел.', '{s}的小队人数{cmp} {n}'),
  ),
  DC_IS_PLAYER: bool(
    'who',
    t('Player\'s character', 'Персонаж игрока', '玩家角色'),
    t('«Who» is a character of the player.', '«Кто» — персонаж игрока.', '「谁」是玩家的角色。'),
    t('{s} <am|is> [|not ]a character of the player', '{s} [— |не ]персонаж игрока', '{s}[|不]是玩家角色'),
  ),
  DC_NUM_BACKPACKS: num(
    'squad',
    t('Backpacks', 'Число рюкзаков', '背包数量'),
    t('How many backpacks «who» carries (the character or the whole squad — not described). Vanilla: tolls, «And what about them backpacks o\' yours?».', 'Сколько рюкзаков у «кого» (у персонажа или у всего отряда — не описано). В ванили — пошлины: «And what about them backpacks o\' yours?».', '「谁」带着多少背包（角色还是整个小队 — 未描述）。原版：过路费，「And what about them backpacks o\' yours?」。'),
    t('{s} <carry|carries> {cmp} {n} backpacks', 'у {o} рюкзаков {cmp} {n}', '{s}的背包数{cmp} {n}'),
  ),
  DC_SQUAD_ONLY_ANIMALS: bool(
    'squad',
    t('Squad of animals only', 'В отряде только звери', '小队只有动物'),
    t('The squad of «who» has only animals. Vanilla: «Beast attack!».', 'В отряде «кого» только звери. В ванили: «Beast attack!».', '「谁」的小队只有动物。原版：「Beast attack!」。'),
    t('{o} squad is [|not ]animals only', 'в отряде {o} [только звери|не только звери]', '{s}的小队[只有|不只有]动物'),
  ),
  DC_IS_OUTNUMBERED: bool(
    'squad',
    t('Outnumbered', 'В меньшинстве', '寡不敌众'),
    t('The side of «who» has fewer fighters than the enemy. Vanilla: «You won\'t get away with this!».', 'У стороны «кого» меньше бойцов, чем у врага. В ванили: «You won\'t get away with this!».', '「谁」一方的战斗人员少于敌人。原版：「You won\'t get away with this!」。'),
    t('{s} <am|is> [|not ]outnumbered', '{s} [|не ]в меньшинстве', '{s}[|没有]寡不敌众'),
  ),
  DC_BOUNTY_AMOUNT_PERCEIVED: num(
    'money',
    t('Known bounty', 'Известная награда', '已知悬赏'),
    t('The bounty on «who» as I know it, not necessarily the actual one (by the code name). No vanilla line uses it.', 'Награда за голову «кого», какой я её знаю, не обязательно настоящая (по имени кода). В ванили не используется.', '我所知道的「谁」的悬赏，不一定是实际的（按代码名称）。原版未使用。'),
    t('{o} bounty, as I know it, is {cmp} {n} cats', 'известная мне награда ({s}) {cmp} {n} кат', '我所知的{s}悬赏{cmp} {n}'),
    U,
  ),
  DC_IS_KO: bool(
    'state',
    t('Unconscious', 'Без сознания', '昏迷'),
    t('«Who» is unconscious. Vanilla: guards\' lines check the target is awake.', '«Кто» без сознания. В ванили реплики стражи проверяют, что собеседник в сознании.', '「谁」昏迷了。原版：守卫台词检查对方是清醒的。'),
    t('{s} <am|is> [|not ]unconscious', '{s} [|не ]без сознания', '{s}[|没有]昏迷'),
  ),
  DC_IS_NEARLY_KO: bool(
    'state',
    t('Close to a knock-out', 'На грани нокаута', '濒临昏迷'),
    t(
      '«Who» is close to falling unconscious. DC_NEARLY_KO looks the same; how they differ is not described. Vanilla: «Looks like you got it rough too».',
      '«Кто» вот-вот потеряет сознание. DC_NEARLY_KO выглядит так же; чем они отличаются, не описано. В ванили: «Looks like you got it rough too».',
      '「谁」快要昏迷。DC_NEARLY_KO 看起来相同；两者区别未描述。原版：「Looks like you got it rough too」。',
    ),
    t('{s} <am|is> [|not ]close to a knock-out', '{s} [|не ]на грани нокаута', '{s}[|没有]濒临昏迷'),
  ),
  DC_SQUAD_IS_DOWN: bool(
    'squad',
    t('Squad is down', 'Отряд повержен', '小队已倒下'),
    t('The whole squad of «who» is down (unconscious or dead). Vanilla: «Damn...».', 'Весь отряд «кого» лежит (без сознания или мёртв). В ванили: «Damn...».', '「谁」的整个小队都倒下了（昏迷或死亡）。原版：「Damn...」。'),
    t('{o} squad is [|not ]down', 'отряд {o} [|не ]повержен', '{s}的小队[已|没有]倒下'),
  ),
  DC_IS_DEAD: bool(
    'state',
    t('Dead', 'Мёртв', '死亡'),
    t('«Who» is dead. Vanilla: looters over a body, «A dead guy can\'t use all of this cool stuff».', '«Кто» мёртв. В ванили — мародёры над телом: «A dead guy can\'t use all of this cool stuff».', '「谁」死了。原版：搜刮尸体，「A dead guy can\'t use all of this cool stuff」。'),
    t('{s} <am|is> [dead|alive]', '{s} [мёртв|жив]', '{s}[已死亡|还活着]'),
  ),
  DC_IS_FEMALE: bool(
    'who',
    t('Female', 'Женщина', '女性'),
    t('«Who» is a woman. Vanilla: «brother» or «sister» in greetings.', '«Кто» — женщина. В ванили — «brother» или «sister» в приветствиях.', '「谁」是女性。原版：问候中的「brother」或「sister」。'),
    t('{s} <am|is> [female|male]', '{s} [— женщина|— мужчина]', '{s}是[女性|男性]'),
  ),
  DC_CARRYING_SOMEONE_TO_ENSLAVE: bool(
    'captivity',
    t('Carrying someone to enslave', 'Несёт кого-то в рабство', '扛着要卖为奴的人'),
    t('«Who» carries a character who can be sold into slavery. Vanilla: «A new slave? Give you 400 \'cats for \'im».', '«Кто» несёт персонажа, которого можно продать в рабство. В ванили: «A new slave? Give you 400 \'cats for \'im».', '「谁」扛着一个可以卖为奴隶的人。原版：「A new slave? Give you 400 \'cats for \'im」。'),
    t('{s} <am|is> [|not ]carrying someone to enslave', '{s} [|не ]<несу|несёт> кого-то, кого можно продать в рабство', '{s}[|没有]扛着要卖为奴的人'),
  ),
  DC_BOUNTY_AMOUNT_ACTUAL: num(
    'money',
    t('Bounty', 'Награда за голову', '悬赏金额'),
    t('The actual bounty on «who», in cats. Vanilla: «Come for my bounty ah?».', 'Настоящая награда за голову «кого», в катах. В ванили: «Come for my bounty ah?».', '「谁」实际的悬赏金额（猫币）。原版：「Come for my bounty ah?」。'),
    t('{o} bounty is {cmp} {n} cats', 'награда за голову ({s}) {cmp} {n} кат', '{s}的悬赏{cmp} {n}'),
  ),
  DC_IM_UNARMED: bool(
    'state',
    t('Unarmed', 'Без оружия', '手无寸铁'),
    t('«Who» has no weapon (by the code name, «I\'m unarmed»). Vanilla: «Bandits! Help!» from an unarmed townsman.', '«Кто» без оружия (по имени кода, «I\'m unarmed»). В ванили: «Bandits! Help!» у безоружного горожанина.', '「谁」没有武器（按代码名称「I\'m unarmed」）。原版：手无寸铁的市民喊「Bandits! Help!」。'),
    t('{s} <am|is> [unarmed|armed]', '{s} [без оружия|с оружием]', '{s}[手无寸铁|持有武器]'),
  ),
  DC_TOWN_HAS_FORTIFICATIONS_WALLS: bool(
    'place',
    t('Town has walls', 'У города есть стены', '城镇有城墙'),
    t('The town where «who» is has fortification walls (by the code name). No vanilla line uses it.', 'У города, где «кто», есть крепостные стены (по имени кода). В ванили не используется.', '「谁」所在的城镇有城墙（按代码名称）。原版未使用。'),
    t('the town ({s}) [has|has no] walls', 'у города ({s}) [есть стены|нет стен]', '城镇（{s}）[有|没有]城墙'),
    U,
  ),
  DC_TARGET_IS_MY_MISSION_TARGET: bool(
    'relations',
    t('Target of my mission', 'Цель моего задания', '我的任务目标'),
    t('«Who» is the target of my mission (by the code name). No vanilla line uses it.', '«Кто» — цель моего задания (по имени кода). В ванили не используется.', '「谁」是我任务的目标（按代码名称）。原版未使用。'),
    t('{s} <am|is> [|not ]the target of my mission', '{s} [— |не ]цель моего задания', '{s}[|不]是我的任务目标'),
    U,
  ),
  DC_MY_MISSION_IS_FRIENDLY: bool(
    'relations',
    t('My mission is friendly', 'Моё задание мирное', '我的任务是友好的'),
    t('My mission is a peaceful one (by the code name). No vanilla line uses it.', 'Моё задание мирное (по имени кода). В ванили не используется.', '我的任务是和平的（按代码名称）。原版未使用。'),
    t('my mission is [|not ]friendly', 'моё задание [|не ]мирное', '我的任务[|不]是友好的'),
    U,
  ),
  DC_I_LOVE_THIS_GUY: bool(
    'relations',
    t('I love them', 'Обожаю его', '我喜欢这个人'),
    t('I like «who» very much; how the game decides is not described. Vanilla: «Brother!».', 'Я очень люблю «кого»; как игра это решает, не описано. В ванили: «Brother!».', '我非常喜欢「谁」；游戏如何判断未描述。原版：「Brother!」。'),
    t('I [|do not ]love <myself|{s}>', 'я [|не ]обожаю <себя|{o}>', '我[|不]喜欢<自己|{s}>'),
  ),
  DC_I_HATE_THIS_GUY: bool(
    'relations',
    t('I hate them', 'Ненавижу его', '我讨厌这个人'),
    t('I hate «who»; how the game decides is not described. Vanilla: insults.', 'Я ненавижу «кого»; как игра это решает, не описано. В ванили — оскорбления.', '我讨厌「谁」；游戏如何判断未描述。原版：辱骂。'),
    t('I [|do not ]hate <myself|{s}>', 'я [|не ]ненавижу <себя|{o}>', '我[|不]讨厌<自己|{s}>'),
  ),
  DC_I_SHOULD_SCREW_THIS_GUY_OVER: bool(
    'relations',
    t('I should cheat them', 'Стоит его обмануть', '我该坑他一把'),
    t('I want to cheat or betray «who» (by the code name). No vanilla line uses it.', 'Мне стоит обмануть или предать «кого» (по имени кода). В ванили не используется.', '我想欺骗或背叛「谁」（按代码名称）。原版未使用。'),
    t('I should [|not ]cheat <myself|{s}>', 'мне [|не ]стоит обмануть <себя|{o}>', '我[|不]该坑<自己|{s}>'),
    U,
  ),
  DC_I_SHOULD_HELP_THIS_GUY: bool(
    'relations',
    t('I should help them', 'Стоит ему помочь', '我该帮他'),
    t('I want to help «who» (by the code name). Vanilla: three lines, «Let me help!».', 'Мне стоит помочь «кому» (по имени кода). В ванили — три реплики: «Let me help!».', '我想帮助「谁」（按代码名称）。原版：三句台词，「Let me help!」。'),
    t('I should [|not ]help <myself|{s}>', '[стоит|не стоит] помочь: {s}', '我[|不]该帮<自己|{s}>'),
  ),
  DC_IN_COMBAT: bool(
    'state',
    t('In combat', 'В бою', '战斗中'),
    t('«Who» is fighting. Vanilla checks «not in combat» in almost 400 lines, so that a talk does not start in the middle of a fight.', '«Кто» дерётся. В ванили почти 400 реплик проверяют «не в бою», чтобы разговор не начинался посреди драки.', '「谁」正在战斗。原版近 400 句台词检查「不在战斗中」，以免在打斗中开始对话。'),
    t('{s} <am|is> [|not ]in combat', '{s} [|не ]в бою', '{s}[正在|不在]战斗中'),
  ),
  DC_WITHIN_TOWN_WALLS: bool(
    'place',
    t('Within town walls', 'Внутри городских стен', '在城墙内'),
    t('«Who» is inside the walls of a town. Vanilla: raids, «Charge!».', '«Кто» внутри городских стен. В ванили — набеги: «Charge!».', '「谁」在城墙之内。原版：袭击，「Charge!」。'),
    t('{s} <am|is> [|not ]within the town walls', '{s} [|не ]внутри городских стен', '{s}[|不]在城墙内'),
  ),
  DC_TOWN_WALLS_LOCKED_UP: bool(
    'place',
    t('Town gates locked', 'Ворота города заперты', '城门已锁'),
    t('The gates of the town where «who» is are closed. Vanilla: «Open the gates!».', 'Ворота города, где «кто», закрыты. В ванили: «Open the gates!».', '「谁」所在城镇的城门关着。原版：「Open the gates!」。'),
    t('the town gates ({s}) are [|not ]locked', 'ворота города ({s}) [|не ]заперты', '城门（{s}）[已|没有]上锁'),
  ),
  DC_IS_SLAVE: bool(
    'captivity',
    t('Slave', 'Раб', '奴隶'),
    t('«Who» is a slave. Vanilla: «Is this real? Am I free?».', '«Кто» — раб. В ванили: «Is this real? Am I free?».', '「谁」是奴隶。原版：「Is this real? Am I free?」。'),
    t('{s} <am|is> [|not ]a slave', '{s} [— |не ]раб', '{s}[|不]是奴隶'),
  ),
  DC_HAS_A_BASE_NEARBY: bool(
    'place',
    t('Own base nearby', 'Рядом своя база', '附近有基地'),
    t('«Who» has their own base nearby (by the code name). No vanilla line uses it.', 'У «кого» рядом своя база (по имени кода). В ванили не используется.', '「谁」附近有自己的基地（按代码名称）。原版未使用。'),
    t('{s} [<have|has>|<do|does> not have] a base nearby', 'у {o} [есть база|нет базы] рядом', '{s}附近[有|没有]基地'),
    U,
  ),
  DC_TARGET_IS_SLAVE_OF_MY_FACTION: bool(
    'captivity',
    t('Slave of my faction', 'Раб моей фракции', '我派系的奴隶'),
    t('«Who» is a slave who belongs to my faction. Vanilla: «Escaped slave!!!».', '«Кто» — раб, принадлежащий моей фракции. В ванили: «Escaped slave!!!».', '「谁」是属于我派系的奴隶。原版：「Escaped slave!!!」。'),
    t('{s} <am|is> [|not ]a slave of my faction', '{s} [— |не ]раб моей фракции', '{s}[|不]是我派系的奴隶'),
  ),
  DC_IS_ESCAPED_SLAVE: bool(
    'captivity',
    t('Escaped slave', 'Беглый раб', '逃跑的奴隶'),
    t('«Who» is a runaway slave (marked by DA_TAG_ESCAPED_SLAVE). Vanilla: «That one there, they\'re branded!».', '«Кто» — беглый раб (отмечен эффектом DA_TAG_ESCAPED_SLAVE). В ванили: «That one there, they\'re branded!».', '「谁」是逃跑的奴隶（由 DA_TAG_ESCAPED_SLAVE 标记）。原版：「That one there, they\'re branded!」。'),
    t('{s} <am|is> [|not ]an escaped slave', '{s} [— |не ]беглый раб', '{s}[|不]是逃跑的奴隶'),
  ),
  DC_IS_IN_LOCKED_CAGE: bool(
    'captivity',
    t('In a locked cage', 'В запертой клетке', '在上锁的笼子里'),
    t('«Who» sits in a locked cage.', '«Кто» сидит в запертой клетке.', '「谁」被关在上锁的笼子里。'),
    t('{s} <am|is> [|not ]in a locked cage', '{s} [|не ]в запертой клетке', '{s}[|不]在上锁的笼子里'),
  ),
  DC_WEARING_LOCKED_SHACKLES: bool(
    'captivity',
    t('In locked shackles', 'В запертых кандалах', '戴着上锁的镣铐'),
    t('«Who» wears locked shackles. Vanilla: «I need to get these shackles off...».', 'На «ком» запертые кандалы. В ванили: «I need to get these shackles off...».', '「谁」戴着上锁的镣铐。原版：「I need to get these shackles off...」。'),
    t('{s} <am|is> [|not ]in locked shackles', '{s} [|не ]в запертых кандалах', '{s}[|没有]戴着上锁的镣铐'),
  ),
  DC_IS_SAME_RACE_AS_ME: bool(
    'who',
    t('Same race as me', 'Моей расы', '与我同种族'),
    t('«Who» is of the same race as me. Vanilla: racist insults check «not», «Thieving flatskin!».', '«Кто» той же расы, что и я. В ванили расистские оскорбления проверяют «нет»: «Thieving flatskin!».', '「谁」与我同种族。原版：种族歧视的辱骂检查「不是」，「Thieving flatskin!」。'),
    t('{s} <am|is> [|not ]of my race', '{s} [|не ]моей расы', '{s}[|不]是我的种族'),
  ),
  DC_CAN_AFFORD_BOUNTY: bool(
    'money',
    t('Can pay the bounty', 'Может заплатить награду', '付得起悬赏'),
    t('«Who» has enough money to pay off their bounty (by the code name). No vanilla line uses it.', 'У «кого» хватает денег, чтобы откупиться от награды за голову (по имени кода). В ванили не используется.', '「谁」有足够的钱付清自己的悬赏（按代码名称）。原版未使用。'),
    t('{s} [can|cannot] pay off <my|their> bounty', '{s} [|не ]<могу|может> откупиться от награды за голову', '{s}[付得起|付不起]悬赏'),
    U,
  ),
  DC_IS_SNEAKING: bool(
    'state',
    t('Sneaking', 'Скрытность', '潜行'),
    t('«Who» is in sneaking mode. Vanilla: «You\'re sneaking around now? I\'m looking right at you!».', '«Кто» в режиме скрытности. В ванили: «You\'re sneaking around now? I\'m looking right at you!».', '「谁」处于潜行模式。原版：「You\'re sneaking around now? I\'m looking right at you!」。'),
    t('{s} <am|is> [|not ]sneaking', '{s} [|не ]в режиме скрытности', '{s}[正在|没有]潜行'),
  ),
  DC_IS_INDOORS: bool(
    'place',
    t('Indoors', 'В помещении', '在室内'),
    t('«Who» is inside a building. Vanilla: a bar greeting, «Welcome to the Dancing Skeleton».', '«Кто» внутри здания. В ванили — приветствие в баре: «Welcome to the Dancing Skeleton».', '「谁」在建筑内。原版：酒吧问候，「Welcome to the Dancing Skeleton」。'),
    t('{s} <am|is> [indoors|outdoors]', '{s} [в помещении|под открытым небом]', '{s}在[室内|室外]'),
  ),
  DC_HAS_ILLEGAL_ITEM: bool(
    'captivity',
    t('Carries illegal goods', 'Есть запрещённое', '携带违禁品'),
    t('«Who» carries items illegal for my faction. Vanilla: a search at the gate, «Spread your legs…».', 'У «кого» есть вещи, запрещённые моей фракцией. В ванили — обыск у ворот: «Spread your legs…».', '「谁」携带我派系禁止的物品。原版：门口搜身，「Spread your legs…」。'),
    t('{s} [<carry|carries>|<do|does> not carry] illegal goods', 'у {o} [есть|нет] запрещённ[ые вещи|ых вещей]', '{s}[携带|没有携带]违禁品'),
  ),
  DC_USING_MY_TRAINING_EQUIPMENT: bool(
    'place',
    t('Using my training gear', 'Занимается на моём тренажёре', '使用我的训练器材'),
    t('«Who» trains on my training dummy or other training equipment. Vanilla: «I said you can\'t use that.».', '«Кто» тренируется на моём манекене или другом тренажёре. В ванили: «I said you can\'t use that.».', '「谁」在用我的训练假人或其他训练器材。原版：「I said you can\'t use that.」。'),
    t('{s} <am|is> [|not ]using my training equipment', '{s} [|не ]<занимаюсь|занимается> на моём тренажёре', '{s}[正在|没有]使用我的训练器材'),
  ),
  DC_STARVING: bool(
    'state',
    t('Starving', 'Голодает', '饥饿'),
    t('«Who» is starving (the game\'s «Starving» status). Vanilla: guards at the gate check it.', '«Кто» голодает (состояние «Голодает» в игре). В ванили это проверяет стража у ворот.', '「谁」正在挨饿（游戏中的「饥饿」状态）。原版：门口的守卫会检查。'),
    t('{s} <am|is> [|not ]starving', '{s} [|не ]<голодаю|голодает>', '{s}[正在|没有]挨饿'),
  ),
  DC_MIXED_GENDER_GROUP: bool(
    'squad',
    t('Mixed-gender squad', 'Отряд из мужчин и женщин', '男女混合小队'),
    t('The squad of «who» has both men and women. Vanilla: three lines, «I asked for the leader, where are your brothers».', 'В отряде «кого» есть и мужчины, и женщины. В ванили — три реплики: «I asked for the leader, where are your brothers».', '「谁」的小队里有男有女。原版：三句台词，「I asked for the leader, where are your brothers」。'),
    t('{o} squad [has|does not have] both men and women', 'в отряде {o} [есть|нет] и мужчин[ы|], и женщин[ы|]', '{s}的小队[是|不是]男女混合'),
  ),
  DC_TOWN_LEVEL_CURRENT_LOCATION: num(
    'place',
    t('Level of this town', 'Уровень города здесь', '当前城镇等级'),
    t('Level (size) of the town where «who» is now. Vanilla: tax collectors at a player town, «Time to pay up this week\'s contributions».', 'Уровень (размер) города, где сейчас «кто». В ванили — сборщики дани в городе игрока: «Time to pay up this week\'s contributions».', '「谁」当前所在城镇的等级（规模）。原版：玩家城镇的收税人，「Time to pay up this week\'s contributions」。'),
    t('the level of the town ({s}) is {cmp} {n}', 'уровень города ({s}) {cmp} {n}', '城镇等级（{s}）{cmp} {n}'),
  ),
  DC_PLAYERS_BEST_TOWN_LEVEL: num(
    'place',
    t('Player\'s best town level', 'Лучший город игрока', '玩家最高城镇等级'),
    t('The level of the player\'s biggest town. Vanilla: an inspector reads a report about the player\'s base.', 'Уровень самого большого города игрока. В ванили — проверяющий читает отчёт о базе игрока.', '玩家最大城镇的等级。原版：检查员阅读关于玩家基地的报告。'),
    t('the player\'s best town level is {cmp} {n}', 'уровень лучшего города игрока {cmp} {n}', '玩家最高城镇等级{cmp} {n}'),
  ),
  DC_IN_A_PLAYER_TOWN: bool(
    'place',
    t('In a player town', 'В городе игрока', '在玩家城镇'),
    t('«Who» is in a town or base of the player. Vanilla: «How quaint, a new village!».', '«Кто» в городе или на базе игрока. В ванили: «How quaint, a new village!».', '「谁」在玩家的城镇或基地。原版：「How quaint, a new village!」。'),
    t('{s} <am|is> [|not ]in a player town', '{s} [|не ]в городе игрока', '{s}[|不]在玩家城镇'),
  ),
  DC_TARGET_CHARACTER_EXISTS: bool(
    'who',
    t('Character exists', 'Персонаж существует', '角色存在'),
    t('«Who» exists in the world. Not described further. Vanilla: revenge and hunting dialogues, «There you are. I\'ve been looking for you».', '«Кто» есть в мире. Подробнее не описано. В ванили — диалоги мести и охоты: «There you are. I\'ve been looking for you».', '「谁」存在于世界中。未进一步描述。原版：复仇和追猎对话，「There you are. I\'ve been looking for you」。'),
    t('{s} [|does not ]exist<|s>', '{s} [есть|отсутствует] в мире', '{s}[存在|不存在]'),
    { undescribed: true },
  ),
  DC_IS_RECRUITABLE: bool(
    'who',
    t('Can be recruited', 'Можно нанять', '可招募'),
    t('«Who» can join the player\'s squad. Vanilla: freed prisoners, «I owe you now friend».', '«Кто» может вступить в отряд игрока. В ванили — освобождённые пленники: «I owe you now friend».', '「谁」可以加入玩家的小队。原版：被解救的囚犯，「I owe you now friend」。'),
    t('{s} [can|cannot] be recruited', '{s} [|не ]<могу|может> вступить в отряд игрока', '{s}[可以|不能]被招募'),
  ),
  DC_HAS_AI_CONTRACT: bool(
    'squad',
    t('Has an AI contract', 'Есть AI-контракт', '有 AI 合约'),
    t('«Who» runs an AI package as a contract job (see «AI contract» of a line; by the code name). No vanilla line uses it.', '«Кто» выполняет AI-пакет как контракт (см. «AI contract» у реплики; по имени кода). В ванили не используется.', '「谁」正在执行作为合约工作的 AI 包（见台词的「AI contract」；按代码名称）。原版未使用。'),
    t('{s} [<have|has>|<do|does> not have] an AI contract', 'у {o} [есть AI-контракт|нет AI-контракта]', '{s}[有|没有] AI 合约'),
    U,
  ),
  DC_HAS_ROBOT_LIMBS: bool(
    'who',
    t('Has robotic limbs', 'Есть протезы', '有机械肢体'),
    t('«Who» has robotic limbs. Vanilla: the Holy Nation reacts, «Skeleton!? Okran have mercy!».', 'У «кого» есть протезы. В ванили так реагирует Святая Нация: «Skeleton!? Okran have mercy!».', '「谁」有机械肢体。原版：神圣国度的反应，「Skeleton!? Okran have mercy!」。'),
    t('{s} [<have|has>|<do|does> not have] robotic limbs', 'у {o} [есть протезы|нет протезов]', '{s}[有|没有]机械肢体'),
  ),
  DC_END: bool(
    'service',
    t('End of the list', 'Конец списка', '列表末尾'),
    t('Service value: the number of conditions. Not a condition.', 'Служебное значение: число условий. Не условие.', '内部值：条件的数量。不是条件。'),
    t('end of the list', 'конец списка', '列表末尾'),
    U,
  ),
};
