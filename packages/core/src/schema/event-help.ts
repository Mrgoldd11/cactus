/**
 * Package dialogue events (`EventTriggerEnum`, the numbers in `DIALOGUE_PACKAGE.dialogs` v0..v2):
 * a human name, a short explanation and who the dialogue target is, in every interface language.
 *
 * Meaning comes from the descriptions in the game's `fcs_enums.def` (`enum shared EventTriggerEnum`).
 * Values marked "Not currently used" there get `unused` (shown as "the game does not raise it"),
 * although a few vanilla packages still reference 2, 16, 50 and 68. Names erased in the FCS sources
 * (`EV_______` = 5, `EV_I_________` = 7) are explained from vanilla dialogues
 * (`knowledge/KENSHI_INTERNALS.md`). Value numbers are positions in the C# enum (`builtin-enums.ts`).
 *
 * Every value of the C# enum has an entry, `EV_NONE` and `EV_MAX` included
 * (`event-help.test.ts` checks it).
 */
import type { UiText } from '../ui-text.ts';

/** Group of events in the event picker (what kind of thing happened). */
export type EventGroup = 'talk' | 'see' | 'fight' | 'health' | 'captivity' | 'crime' | 'place' | 'life' | 'service';

export interface EventHelp {
  /** Human name: «Acid rain», «Кислотный дождь». */
  label: UiText;
  /** What happened, one or two sentences. */
  desc: UiText;
  /** Who the dialogue target is; `null` — no target (the character speaks alone); absent — not described. */
  target?: UiText | null;
  /** `fcs_enums.def`: "Not currently used". */
  unused?: true;
  group: EventGroup;
}

const t = (en: string, ru: string, zh: string): UiText => ({ en, ru, zh });

/** Order of the groups in the picker. */
export const EVENT_GROUPS: readonly EventGroup[] = ['talk', 'see', 'fight', 'health', 'captivity', 'crime', 'place', 'life', 'service'];

export const EVENT_GROUP_LABELS: Readonly<Record<EventGroup, UiText>> = {
  talk: t('Talk', 'Разговор', '对话'),
  see: t('Who I see', 'Кого видит', '看到谁'),
  fight: t('Fight', 'Бой', '战斗'),
  health: t('Healing and wounds', 'Лечение и раны', '治疗与伤势'),
  captivity: t('Captivity and slavery', 'Плен и рабство', '囚禁与奴役'),
  crime: t('Crime and property', 'Преступления и имущество', '犯罪与财产'),
  place: t('Weather and place', 'Погода и место', '天气与地点'),
  life: t('Daily life', 'Быт', '日常'),
  service: t('Service values', 'Служебные значения', '内部值'),
};

/** Group of the events the game does not raise (shown last in the picker). */
export const EVENT_UNUSED_LABEL: UiText = t('The game does not raise it', 'Игра не вызывает', '游戏不触发');

/** Explanation for values marked "Not currently used" in fcs_enums.def. */
const UNUSED_DESC = t(
  'fcs_enums.def: "Not currently used" — the game does not raise this event, a dialogue on it is never spoken.',
  'В fcs_enums.def: «Not currently used» — игра это событие не вызывает, диалог на нём не прозвучит.',
  'fcs_enums.def：“Not currently used”——游戏不会触发此事件，挂在它上面的对话不会出现。',
);
const unused = (label: UiText, group: EventGroup, what?: UiText): EventHelp => ({
  label,
  desc: what ? { en: `${what.en} ${UNUSED_DESC.en}`, ru: `${what.ru} ${UNUSED_DESC.ru}`, zh: `${what.zh}${UNUSED_DESC.zh}` } : UNUSED_DESC,
  unused: true,
  group,
});

const OFTEN = t(' Fires often: use conditions and a repeat limit.', ' Срабатывает часто: нужны условия и ограничение повтора.', '触发频繁：请使用条件和重复限制。');
const often = (d: UiText): UiText => ({ en: `${d.en}${OFTEN.en}`, ru: `${d.ru}${OFTEN.ru}`, zh: `${d.zh}${OFTEN.zh}` });

/** By value name of `EventTriggerEnum`. */
export const EVENT_HELP: Readonly<Record<string, EventHelp>> = {
  EV_NONE: {
    label: t('No event', 'Нет события', '无事件'),
    desc: t('Empty value: the game skips it in a package reference.', 'Пустое значение: в ссылке пакета игра его пропускает.', '空值：对话包引用中游戏会跳过它。'),
    group: 'service',
  },
  EV_PLAYER_TALK_TO_ME: {
    label: t('Player talks to me', 'Игрок заговорил', '玩家与我交谈'),
    desc: t(
      'The player clicked the character to talk. The only event where the player answers and chooses replies.',
      'Игрок щёлкнул по персонажу, чтобы поговорить. Единственное событие, где игрок отвечает и выбирает реплики.',
      '玩家点击角色进行交谈。这是唯一一个玩家可以回应并选择回复的事件。',
    ),
    target: t('the player character', 'персонаж игрока', '玩家角色'),
    group: 'talk',
  },
  EV_ANNOUNCEMENT: unused(t('Announcement', 'Объявление', '公告'), 'talk'),
  EV_I_SEE_NEUTRAL_SQUAD: {
    label: t('Sees a neutral squad', 'Видит нейтральный отряд', '看到中立小队'),
    desc: often(t(
      'Every time I see a neutral squad (neither ally nor enemy), more likely on screen. Be specific: a beggar should not mug a police officer.',
      'Каждый раз, когда вижу нейтральный отряд (не союзник и не враг), чаще — на экране. Уточняйте: нищий не должен грабить стражника.',
      '每次看到中立小队（既非盟友也非敌人）时触发，屏幕内更常见。要具体：乞丐不该去抢警察。',
    )),
    target: t('someone from the seen squad', 'кто-то из замеченного отряда', '被看到小队中的某人'),
    group: 'see',
  },
  EV_I_SEE_RAGDOLL: {
    label: t('Sees someone knocked out', 'Видит лежащего без сознания', '看到昏迷者'),
    desc: often(t('Every time I see a knocked-out character.', 'Каждый раз, когда вижу лежащего без сознания.', '每次看到昏迷的角色时触发。')),
    target: t('the one lying', 'лежащий', '倒地者'),
    group: 'see',
  },
  EV_______: {
    label: t('Sees a hostile squad', 'Видит враждебный отряд', '看到敌对小队'),
    desc: t(
      'The name is erased in FCS; the meaning is taken from vanilla dialogues: attack and robbery lines («Give us your stuff!»).',
      'Имя стёрто в FCS; смысл взят из ванильных диалогов: нападение и грабёж («Give us your stuff!»).',
      '该名称在 FCS 中被抹去；含义取自原版对话：袭击与抢劫（“Give us your stuff!”）。',
    ),
    target: t('someone from the hostile squad', 'кто-то из враждебного отряда', '敌对小队中的某人'),
    group: 'see',
  },
  EV_SOUND_THE_ALARM: unused(t('Sounds the alarm', 'Поднимает тревогу', '拉响警报'), 'fight'),
  EV_I_________: {
    label: t('A comrade went down', 'Упал товарищ', '同伴倒下'),
    desc: t(
      'The name is erased in FCS; the meaning is taken from vanilla dialogues: someone from my squad was knocked down.',
      'Имя стёрто в FCS; смысл взят из ванильных диалогов: кого-то из моего отряда сбили с ног.',
      '该名称在 FCS 中被抹去；含义取自原版对话：我小队中有人被击倒。',
    ),
    group: 'fight',
  },
  EV_THIEF_CAUGHT_STEALING_FROM_ME: {
    label: t('Caught a thief stealing from me', 'Поймал вора на краже у себя', '抓到偷我东西的小偷'),
    desc: t(
      'Saw a thief stealing from me personally. Consider whether I am imprisoned and whether the thief is the jailer, an inmate or a visitor.',
      'Видел, как вор крадёт лично у меня. Учитывайте, не в тюрьме ли я и кто вор: тюремщик, сокамерник или посетитель.',
      '亲眼看到小偷偷我的东西。要考虑我是否被关押，以及小偷是狱卒、狱友还是访客。',
    ),
    target: t('the thief', 'вор', '小偷'),
    group: 'crime',
  },
  EV_SHOO_FROM_MY_BUILDING: {
    label: t('Shoos someone out of my building', 'Гонит из своего дома', '把人赶出我的建筑'),
    desc: t(
      'Someone is in my house: «get out!». Repeats until they leave. In a public building, such as a shop, it is a polite «we are closed, come again!».',
      'Кто-то у меня в доме: «вон отсюда!». Повторяется, пока не уйдёт. В общественном здании, например в лавке, — вежливое «закрыто, приходите ещё!».',
      '有人在我家里：“出去！”。会反复触发直到对方离开。在商店等公共建筑里则是礼貌的“打烊了，欢迎再来！”。',
    ),
    target: t('the one in my building', 'тот, кто в моём доме', '在我建筑里的人'),
    group: 'crime',
  },
  EV_MARKED_FOR_DEATH: {
    label: t('About to be eaten', 'Его сейчас съедят', '即将被吃掉'),
    desc: t(
      'I am going to die: I am in a cage in a cannibal camp and the cannibals are coming for me.',
      'Я сейчас умру: сижу в клетке в лагере людоедов, и они идут за мной.',
      '我要死了：我被关在食人族营地的笼子里，他们正朝我走来。',
    ),
    target: null,
    group: 'captivity',
  },
  EV_SCREAMING_TORTURE: {
    label: t('Being cut up (torture)', 'Его режут (пытка)', '正被肢解（酷刑）'),
    desc: t(
      'I am dying horribly. Fires repeatedly while the cannibals hack me to death.',
      'Я умираю страшной смертью. Срабатывает снова и снова, пока людоеды меня рубят.',
      '我正惨死。食人族砍杀我时会反复触发。',
    ),
    target: null,
    group: 'captivity',
  },
  EV_BAR_TALK: unused(t('Bar talk', 'Разговор в баре', '酒吧闲聊'), 'talk'),
  EV_UNLOCK_MY_CAGE_OR_SHACKLES: {
    label: t('My cage was opened', 'Открыли клетку', '我的笼子被打开'),
    desc: t(
      'Someone not from my captors\' faction unlocked my cage or shackles: «you rescued me!». Use the conditions «in locked cage» and «wearing shackles» to cover both.',
      'Кто-то не из фракции моих тюремщиков открыл мою клетку или кандалы: «ты меня спас!». Условия «в запертой клетке» и «в кандалах» покрывают оба случая.',
      '不属于俘虏我的派系的人打开了我的笼子或镣铐：“你救了我！”。用“在上锁的笼子里”和“戴着镣铐”两个条件覆盖两种情况。',
    ),
    target: t('my rescuer', 'мой спаситель', '我的救命恩人'),
    group: 'captivity',
  },
  EV_UNLOCK_MY_CAGE_ATTEMPT: {
    label: t('Someone tries to open my cage', 'Пытаются открыть клетку', '有人试图打开我的笼子'),
    desc: t('A failed lockpick attempt on my cage: «keep trying, buddy!».', 'Неудачная попытка взломать мою клетку: «давай ещё, приятель!».', '有人撬我的笼子失败了：“继续试，伙计！”。'),
    target: t('the one trying to free me', 'тот, кто пытается меня освободить', '试图救我的人'),
    group: 'captivity',
  },
  EV_I_DEFEATED_SQUAD: {
    label: t('Defeated a squad', 'Победил отряд', '击败了小队'),
    desc: t(
      'I just won a battle: the whole enemy squad is down. Consider the target\'s faction and race, being outnumbered, «I hate this guy», injuries, religion.',
      'Я только что выиграл бой: весь вражеский отряд лежит. Учитывайте фракцию и расу собеседника, численный перевес, «ненавижу его», раны, веру.',
      '我刚赢了一场战斗：整个敌方小队都倒下了。要考虑对象的派系与种族、寡不敌众、“我恨这家伙”、伤势、信仰。',
    ),
    target: t('the one I just defeated', 'тот, кого я победил', '我刚击败的人'),
    group: 'fight',
  },
  EV_LAUNCH_ATTACK: unused(t('Launches an attack', 'Начинает атаку', '发起进攻'), 'fight'),
  EV_INTRUDER_FOUND: {
    label: t('Found an intruder', 'Нашёл чужака в доме', '发现入侵者'),
    desc: t('I just found someone inside my locked private building.', 'Я только что нашёл кого-то в своём запертом частном здании.', '我刚在自己上锁的私人建筑里发现了某人。'),
    target: t('the intruder', 'чужак', '入侵者'),
    group: 'crime',
  },
  EV_HEALING_OTHER_START: {
    label: t('Started healing someone', 'Начал лечить другого', '开始治疗他人'),
    desc: t('I just began healing another character. Tell enemy, neutral and ally apart.', 'Я только что начал лечить другого. Различайте, враг он, нейтрал или союзник.', '我刚开始治疗另一个角色。要区分对方是敌人、中立还是盟友。'),
    target: t('the one I heal', 'тот, кого лечу', '我在治疗的人'),
    group: 'health',
  },
  EV_BEING_HEALED_START: {
    label: t('Someone started healing me', 'Его начали лечить', '有人开始治疗我'),
    desc: t('Another character just began healing me. Tell enemy, neutral and ally apart.', 'Другой персонаж только что начал меня лечить. Различайте, враг он, нейтрал или союзник.', '另一个角色刚开始治疗我。要区分对方是敌人、中立还是盟友。'),
    target: t('the one healing me', 'тот, кто меня лечит', '治疗我的人'),
    group: 'health',
  },
  EV_HEALING_OTHER_FINISHED: {
    label: t('Finished healing someone', 'Закончил лечить другого', '治疗他人完毕'),
    desc: t(
      'I just stood up after finishing healing another character. Tell enemy, neutral and ally apart.',
      'Я встал, закончив лечить другого. Различайте, враг он, нейтрал или союзник.',
      '我治疗完另一个角色后刚站起来。要区分对方是敌人、中立还是盟友。',
    ),
    target: t('the one I healed', 'тот, кого лечил', '我治疗的人'),
    group: 'health',
  },
  EV_BEING_HEALED_FINISHED: {
    label: t('Was healed', 'Его вылечили', '被治疗完毕'),
    desc: t('Another character just finished healing me. Tell enemy, neutral and ally apart.', 'Другой персонаж только что меня вылечил. Различайте, враг он, нейтрал или союзник.', '另一个角色刚治好了我。要区分对方是敌人、中立还是盟友。'),
    target: t('the one who healed me', 'тот, кто меня лечил', '治疗我的人'),
    group: 'health',
  },
  EV_FIRSTAID_KIT_EMPTY: {
    label: t('Out of first aid kits', 'Аптечки кончились', '急救包用完了'),
    desc: t('I was healing someone and my first aid kits ran out.', 'Я лечил кого-то, и аптечки кончились.', '我在治疗某人时急救包用完了。'),
    group: 'health',
  },
  EV_GET_UP_PEACE: {
    label: t('Got up, the fight is over', 'Встал, бой кончился', '起身，战斗已结束'),
    desc: t(
      'I was knocked out and now I am getting up. Nobody is fighting any more. Consider injuries, others in the squad, personality.',
      'Я был без сознания и встаю. Бой уже кончился. Учитывайте раны, остальных в отряде, характер.',
      '我被击昏后正在起身。战斗已经结束。要考虑伤势、小队其他成员、性格。',
    ),
    target: null,
    group: 'fight',
  },
  EV_GET_UP_FIGHT: {
    label: t('Got up, the fight goes on', 'Встал, бой идёт', '起身，战斗仍在继续'),
    desc: t('I was knocked out and now I am getting up. The fight is still going on around me.', 'Я был без сознания и встаю. Вокруг ещё идёт бой.', '我被击昏后正在起身。周围的战斗仍在继续。'),
    target: t('my opponent', 'мой противник', '我的对手'),
    group: 'fight',
  },
  EV_GET_UP_UNNECCESSARY_FIGHT: {
    label: t('Got up for nothing, the fight was lost', 'Встал зря, бой проигран', '白白起身，战斗已输'),
    desc: t(
      'I was knocked out. The fight was lost and I was playing dead, but the player made me get up and fight again.',
      'Я был без сознания. Бой проигран, я притворялся мёртвым, но игрок заставил меня встать и драться снова.',
      '我被击昏了。战斗已输，我在装死，但玩家让我起来再打。',
    ),
    target: t('my opponent', 'мой противник', '我的对手'),
    group: 'fight',
  },
  EV_HARRASSMENT_SHOUTS: {
    label: t('Harassment shouts', 'Кричит, преследуя', '骚扰叫喊'),
    desc: t('Thug hunter behaviour: they shout this while following you (once).', 'Поведение «охотника на бандитов»: кричит это, пока идёт следом (один раз).', '“恶棍猎人”行为：跟着你时喊出这句（一次）。'),
    target: t('the one I harass', 'тот, кого преследую', '我骚扰的人'),
    group: 'talk',
  },
  EV_I_SEE_ANIMAL_SQUAD: {
    label: t('Sees animals', 'Видит животных', '看到动物'),
    desc: often(t('Like «sees a neutral squad», but for animals: «oh my god, beak things!».', 'Как «видит нейтральный отряд», но про животных: «боже, клювы!».', '类似“看到中立小队”，但针对动物：“天哪，鸟嘴怪！”。')),
    target: t('one of the animals', 'одно из животных', '其中一只动物'),
    group: 'see',
  },
  EV_SPEECH_INTERRUPTED_ATTACKED_BY_TARGET: {
    label: t('Attacked by the one I talked to', 'Напал тот, с кем говорил', '交谈对象突然袭击'),
    desc: t('I was talking to someone and he suddenly attacked me. Always use a repeat limit of at least 2 hours.', 'Я с кем-то говорил, и он вдруг на меня напал. Всегда ставьте ограничение повтора не меньше 2 ч.', '我正和某人说话，他突然袭击了我。务必设置至少 2 小时的重复限制。'),
    target: t('the attacker', 'нападающий', '袭击者'),
    group: 'fight',
  },
  EV_SPEECH_INTERRUPTED_ATTACKED_BY_STRANGERS: {
    label: t('Attacked by strangers while talking', 'Напали чужие посреди разговора', '交谈时遭陌生人袭击'),
    desc: t(
      'I was talking to someone and strangers suddenly attacked. Always use a repeat limit of at least 2 hours; be specific about who attacked.',
      'Я с кем-то говорил, и вдруг напали чужие. Всегда ставьте ограничение повтора не меньше 2 ч; уточняйте, кто напал.',
      '我正和某人说话，突然遭陌生人袭击。务必设置至少 2 小时的重复限制；具体区分袭击者是谁。',
    ),
    target: t('the attacker', 'нападающий', '袭击者'),
    group: 'fight',
  },
  EV_CONTRACT_JOB_ENDED: {
    label: t('Contract ended', 'Контракт закончился', '合约结束'),
    desc: t('An AI contract has finished: «job\'s over, bye!».', 'Закончился контракт найма: «работа окончена, бывай!».', 'AI 合约结束了：“活干完了，再见！”。'),
    target: t('my employer', 'мой наниматель', '我的雇主'),
    group: 'talk',
  },
  EV_BETRAYAL: {
    label: t('Betrayed by an ally', 'Предал союзник', '被盟友背叛'),
    desc: t('An ally just attacked me. Currently when the player hires a bodyguard and then attacks him.', 'Союзник только что на меня напал. Сейчас — когда игрок нанял телохранителя и бьёт его.', '盟友刚袭击了我。目前用于玩家雇了保镖后又攻击他。'),
    target: t('the attacker', 'нападающий', '袭击者'),
    group: 'fight',
  },
  EV_LOOTING_WEAPON_ONLY: {
    label: t('Loots only the weapon', 'Забирает только оружие', '只搜刮武器'),
    desc: t('I am looting someone but only take the weapon, because I need it or I am in a hurry.', 'Я обыскиваю кого-то, но беру только оружие: нужно или некогда.', '我在搜刮某人，但只拿武器，因为需要或赶时间。'),
    target: t('the victim', 'жертва', '受害者'),
    group: 'crime',
  },
  EV_LOOTING_EVERYTHING: {
    label: t('Loots everything', 'Забирает всё', '搜刮一切'),
    desc: t('I am looting someone and take everything I can, because I am a jerk or because he is dead.', 'Я обыскиваю кого-то и беру всё, что можно: я подлец или он мёртв.', '我在搜刮某人并拿走一切，因为我是混蛋或者他已经死了。'),
    target: t('the victim', 'жертва', '受害者'),
    group: 'crime',
  },
  EV_I_SEE_UNIFORM_IMPOSTER: {
    label: t('Sees an impostor in our uniform', 'Видит самозванца в нашей форме', '看到穿我方制服的冒充者'),
    desc: t(
      'A neutral character wears armour looted from my comrades. The armour needs «wears uniform». Military and police only.',
      'Нейтрал носит броню, снятую с моих товарищей. У брони должно быть «wears uniform». Только военные и стража.',
      '一个中立角色穿着从我战友身上扒下的护甲。护甲需要设置“wears uniform”。仅限军队和警察。',
    ),
    target: t('the impostor', 'самозванец', '冒充者'),
    group: 'see',
  },
  EV_INTRODUCING_NEW_SLAVE: {
    label: t('Welcomes a new slave', 'Встречает нового раба', '迎接新奴隶'),
    desc: t('I am a slaver who brought a new slave to their cell and now gives a speech.', 'Я работорговец: привёл нового раба в камеру и говорю ему речь.', '我是奴隶贩子，把新奴隶带进牢房，现在给他训话。'),
    target: t('the new slave', 'новый раб', '新奴隶'),
    group: 'captivity',
  },
  EV_ESCAPING_SLAVE_SPOTTED: {
    label: t('Spots an escaping slave', 'Видит беглого раба', '发现逃跑的奴隶'),
    desc: t('Not described in fcs_enums.def; by the name: I see a slave escaping.', 'В fcs_enums.def не описано; по имени: вижу, как сбегает раб.', 'fcs_enums.def 中没有描述；按名称：看到奴隶在逃跑。'),
    group: 'captivity',
  },
  EV_RECAPTURED_A_SLAVE: {
    label: t('Recaptured a slave', 'Поймал сбежавшего раба', '抓回了奴隶'),
    desc: t('One of my slaves tried to escape, I caught them and am putting the cuffs back on.', 'Мой раб пытался сбежать, я его поймал и надеваю кандалы обратно.', '我的一个奴隶试图逃跑，我抓住了他，正在重新给他戴上镣铐。'),
    target: t('the slave', 'раб', '奴隶'),
    group: 'captivity',
  },
  EV_SHOUT_AT_SLAVE_WORKER: {
    label: t('Shouts at a slave worker', 'Кричит на раба за работой', '吼斥干活的奴隶'),
    desc: t('I shout at a lazy slave while they work, to make them work harder.', 'Кричу на ленивого раба за работой, чтобы работал усерднее.', '我对干活偷懒的奴隶大吼，让他更卖力。'),
    target: t('the slave', 'раб', '奴隶'),
    group: 'captivity',
  },
  EV_SLAVE_DELIVERY: {
    label: t('Delivers slaves', 'Сдаёт рабов', '交付奴隶'),
    desc: t('I hand over fresh slaves to my slaver colleague: «here are some new slaves for you!».', 'Сдаю пойманных рабов коллеге-работорговцу: «вот тебе новые рабы!».', '我把新抓的奴隶交给奴隶贩子同伴：“给你些新奴隶！”。'),
    target: t('the colleague', 'коллега', '同伴'),
    group: 'captivity',
  },
  EV_ESCAPED_EX_SLAVE_SPOTTED: {
    label: t('Spots a branded runaway', 'Видит клеймёного беглеца', '发现带烙印的逃奴'),
    desc: t('I spotted somebody with a slave brand: a fugitive!', 'Заметил кого-то с клеймом раба: беглец!', '我发现有人带着奴隶烙印：是逃犯！'),
    target: t('the fugitive', 'беглец', '逃犯'),
    group: 'captivity',
  },
  EV_WITNESS_GENERIC_ASSAULT: {
    label: t('Witnesses an assault', 'Видит нападение', '目击袭击'),
    desc: often(t('I saw a crime happening; keep it generic.', 'Видел преступление; реплика общая.', '我看到有犯罪发生；台词保持通用。')),
    target: t('the criminal', 'преступник', '罪犯'),
    group: 'crime',
  },
  EV_WITNESS_LOOTING_ALLY: {
    label: t('Sees someone looting an ally', 'Видит, как обирают союзника', '看到有人搜刮盟友'),
    desc: t(
      'Someone is looting an ally\'s body. React differently in a town and outside. Needs a repeat limit, or it will be constant.',
      'Кто-то обирает тело союзника. В городе и вне его реакция разная. Нужно ограничение повтора, иначе будет без конца.',
      '有人在搜刮盟友的身体。城内城外反应应不同。需要重复限制，否则会一直触发。',
    ),
    target: t('the criminal', 'преступник', '罪犯'),
    group: 'crime',
  },
  EV_WITNESS_THIEF_OR_LOCKPICK: {
    label: t('Sees theft or lockpicking', 'Видит кражу или взлом', '看到盗窃或撬锁'),
    desc: t('I saw someone stealing from somebody else, lockpicking a door or freeing a slave.', 'Видел, как кто-то крадёт у другого, взламывает дверь или освобождает раба.', '我看到有人偷别人的东西、撬门或释放奴隶。'),
    target: t('the criminal', 'преступник', '罪犯'),
    group: 'crime',
  },
  EV_BOUNTY_SPOTTED: {
    label: t('Recognises a wanted person', 'Узнал разыскиваемого', '认出通缉犯'),
    desc: t(
      'I recognised someone with a bounty. Not for allies. React to the amount: raise the alarm, arrest, attack, flee or just «hey, you\'re that wanted guy».',
      'Узнал того, за кого назначена награда. На союзников не срабатывает. Реагируйте по сумме: тревога, арест, атака, бегство или просто «эй, тебя же ищут».',
      '我认出了被悬赏的人。对盟友不触发。根据赏金多少作出反应：报警、逮捕、攻击、逃跑，或只是说“嘿，你就是那个通缉犯”。',
    ),
    target: t('the wanted person', 'разыскиваемый', '通缉犯'),
    group: 'see',
  },
  EV_ESCAPED_PRISONER_SPOTTED: {
    label: t('Spots an escaped prisoner', 'Видит сбежавшего пленника', '发现逃跑的囚犯'),
    desc: t('One of my prisoners is wandering around when they should be in their cage.', 'Мой пленник разгуливает на свободе, хотя должен сидеть в клетке.', '我的一个囚犯本该在笼子里，却在外面游荡。'),
    target: t('the prisoner', 'пленник', '囚犯'),
    group: 'captivity',
  },
  EV_PRISONER_FREE_TO_GO: {
    label: t('Releases a prisoner', 'Отпускает пленника', '释放囚犯'),
    desc: t('The prisoner\'s sentence is served; I am letting them out of the cage.', 'Срок пленника вышел, я выпускаю его из клетки.', '囚犯刑期已满，我正放他出笼。'),
    target: t('the prisoner', 'пленник', '囚犯'),
    group: 'captivity',
  },
  EV_ALMOST_WOKE_UP: {
    label: t('Almost woke up', 'Чуть не проснулся', '差点醒来'),
    desc: t('I am asleep, but something almost woke me: sleep talking or snoring.', 'Я сплю, но что-то меня чуть не разбудило: бормочу во сне или храплю.', '我在睡觉，但差点被吵醒：说梦话或打呼噜。'),
    target: null,
    group: 'life',
  },
  EV_ENTER_BIOME: unused(t('Enters a biome', 'Вход в биом', '进入生物群系'), 'place'),
  EV_ENTER_TOWN: unused(t('Enters a town', 'Вход в город', '进入城镇'), 'place'),
  EV_SQUAD_BROKEN: unused(t('Squad broken', 'Отряд разбит', '小队溃散'), 'fight'),
  EV_BOUGHT_ME_FROM_SLAVERY: {
    label: t('Bought from slavery', 'Его выкупили из рабства', '被买下脱离奴役'),
    desc: t('I am a slave and somebody just bought me. Not sure how to feel about my new owner.', 'Я раб, и меня только что купили. Не знаю, как относиться к новому хозяину.', '我是奴隶，刚被人买下。不知道该如何看待新主人。'),
    target: t('my new owner', 'новый хозяин', '我的新主人'),
    group: 'captivity',
  },
  EV_EATING_SOMETHING_SOUNDS: {
    label: t('Eats loudly', 'Громко ест', '大声进食'),
    desc: t('I am eating something very loudly.', 'Я очень громко что-то ем.', '我在很大声地吃东西。'),
    target: null,
    group: 'life',
  },
  EV_WORSHIPING_SOMETHING: {
    label: t('Worships', 'Молится', '礼拜'),
    desc: t('I am on my knees worshipping my god or another blessed object.', 'Я на коленях молюсь своему богу или другой святыне.', '我跪着礼拜我的神或其他圣物。'),
    target: null,
    group: 'life',
  },
  EV_SLAVE_ESCAPE_OPPORTUNITY_SAVIOR: {
    label: t('Masters down, someone helped', 'Хозяева повержены — спасли', '主人倒下——有人相救'),
    desc: t('I am a slave and see all my masters knocked out by someone.', 'Я раб и вижу, что всех моих хозяев кто-то вырубил.', '我是奴隶，看到我的主人全被人打倒了。'),
    target: t('the one who took down my masters', 'тот, кто вырубил хозяев', '打倒我主人的人'),
    group: 'captivity',
  },
  EV_SLAVE_ESCAPE_OPPORTUNITY_ALONE: {
    label: t('Masters down, nobody around', 'Хозяева повержены — никого', '主人倒下——无人在旁'),
    desc: t('I am a slave and notice all my masters are knocked out.', 'Я раб и замечаю, что все мои хозяева без сознания.', '我是奴隶，发现我的主人全都昏迷了。'),
    group: 'captivity',
  },
  EV_ASSASSINATION_FAILED: {
    label: t('Survived a knockout attempt', 'Пытались оглушить', '有人试图打晕我'),
    desc: t('Somebody just tried to knock me out from behind.', 'Кто-то только что пытался меня оглушить.', '有人刚试图把我打晕。'),
    target: t('the attacker', 'нападающий', '袭击者'),
    group: 'fight',
  },
  EV_EATING_MY_CROPS: {
    label: t('Pests eat my crops', 'Едят мой урожай', '有害兽吃我的庄稼'),
    desc: t('Pests are eating my crops!', 'Вредители едят мой урожай!', '害兽在吃我的庄稼！'),
    target: t('the hungry pest', 'голодный вредитель', '饥饿的害兽'),
    group: 'crime',
  },
  EV_KIDNAPPING_MY_ALLY: {
    label: t('Sees an ally carried off', 'Уносят союзника', '有人带走我的盟友'),
    desc: t('I saw someone pick up my ally\'s unconscious body.', 'Видел, как кто-то поднимает бессознательное тело моего союзника.', '我看到有人扛起了我昏迷的盟友。'),
    target: t('the kidnapper', 'похититель', '绑架者'),
    group: 'crime',
  },
  EV_USING_MY_TRAINING_EQUIPMENT: {
    label: t('Someone uses my training gear', 'Трогают мои тренажёры', '有人用我的训练器械'),
    desc: t('I am resting in my building and somebody came in and started using my stuff.', 'Я отдыхаю у себя, а кто-то зашёл и пользуется моими вещами.', '我在自己的建筑里休息，有人进来用我的东西。'),
    target: t('the one using it', 'тот, кто ими пользуется', '使用者'),
    group: 'crime',
  },
  EV_GIVE_UP_CHASE: {
    label: t('Gave up the chase', 'Бросил погоню', '放弃追击'),
    desc: t('I was chasing an enemy, but now I give up.', 'Я гнался за врагом, но бросаю погоню.', '我在追敌人，但现在放弃了。'),
    target: t('the one I chased', 'тот, за кем гнался', '我追的人'),
    group: 'fight',
  },
  EV_ACID_FEET: {
    label: t('Acid underfoot', 'Кислота под ногами', '脚下有酸'),
    desc: t('The ground is acidic, it burns my feet!', 'Земля кислотная, жжёт ноги!', '地面是酸性的，烧我的脚！'),
    target: null,
    group: 'place',
  },
  EV_ACID_RAIN: {
    label: t('Acid rain', 'Кислотный дождь', '酸雨'),
    desc: t('It is raining acid!', 'Идёт кислотный дождь!', '下酸雨了！'),
    target: null,
    group: 'place',
  },
  EV_ACID_WATER: {
    label: t('Acid water', 'Кислотная вода', '酸性水'),
    desc: t('The water I am swimming in is acidic!', 'Вода, в которой я плыву, кислотная!', '我游泳的水是酸性的！'),
    target: null,
    group: 'place',
  },
  EV_WINDY: {
    label: t('Dust storm', 'Пыльная буря', '沙尘暴'),
    desc: t('I cannot see anything, it is so dusty!', 'Ничего не видно, такая пыль!', '尘土太大，什么都看不见！'),
    target: null,
    group: 'place',
  },
  EV_POISON_GAS: {
    label: t('Poison gas', 'Ядовитый газ', '毒气'),
    desc: t('There is poison gas!', 'Здесь ядовитый газ!', '这里有毒气！'),
    target: null,
    group: 'place',
  },
  EV_I_SEE_ENEMY_PLAYER: {
    label: t('Sees an enemy squad', 'Видит вражеский отряд', '看到敌对小队'),
    desc: often(t('Every time I see an enemy squad, more likely on screen. Be specific: a beggar should not mug a police officer.', 'Каждый раз, когда вижу вражеский отряд, чаще — на экране. Уточняйте: нищий не должен грабить стражника.', '每次看到敌对小队时触发，屏幕内更常见。要具体：乞丐不该去抢警察。')),
    target: t('someone from the seen squad', 'кто-то из замеченного отряда', '被看到小队中的某人'),
    group: 'see',
  },
  EV_I_SEE_ALLY_PLAYER: {
    label: t('Sees an allied squad', 'Видит союзный отряд', '看到盟友小队'),
    desc: often(t('Every time I see an allied squad, more likely on screen.', 'Каждый раз, когда вижу союзный отряд, чаще — на экране.', '每次看到盟友小队时触发，屏幕内更常见。')),
    target: t('someone from the seen squad', 'кто-то из замеченного отряда', '被看到小队中的某人'),
    group: 'see',
  },
  EV_I_SEE_ILLEGAL_PLAYER_BUILDING: unused(t('Sees an illegal player building', 'Видит незаконную постройку игрока', '看到玩家的违规建筑'), 'see'),
  EV_BURNING: {
    label: t('On fire', 'Горит', '着火'),
    desc: t('Something is burning me!', 'Меня что-то жжёт!', '有东西在烧我！'),
    target: null,
    group: 'health',
  },
  EV_LOST_LEG: {
    label: t('Lost a leg', 'Отрубили ногу', '失去一条腿'),
    desc: t('My leg just got cut off!', 'Мне только что отрубили ногу!', '我的腿刚被砍掉了！'),
    target: null,
    group: 'health',
  },
  EV_LOST_ARM: {
    label: t('Lost an arm', 'Отрубили руку', '失去一条手臂'),
    desc: t('My arm just got cut off!', 'Мне только что отрубили руку!', '我的手臂刚被砍掉了！'),
    target: null,
    group: 'health',
  },
  EV_I_SEE_PLAYER_NICE_BUILDING: unused(t('Sees a nice player building', 'Видит красивую постройку игрока', '看到玩家的漂亮建筑'), 'see'),
  EV_TAKEN_OVER_PLAYER_TOWN: {
    label: t('Took over the player\'s town', 'Захватил город игрока', '占领了玩家的城镇'),
    desc: t('I raided a town and now I am taking it over: I live here now.', 'Я разорил город и теперь его занимаю: теперь я тут живу.', '我洗劫了一座城镇，现在要占领它：我住这儿了。'),
    target: null,
    group: 'fight',
  },
  EV_CROWD_TRIGGERED: unused(t('Crowd', 'Толпа', '人群'), 'talk'),
  EV_MAX: {
    label: t('End of the list', 'Конец списка', '列表末尾'),
    desc: t('Service value: the number of events. Not an event.', 'Служебное значение: число событий. Не событие.', '内部值：事件的数量。不是事件。'),
    group: 'service',
  },
};

/** Help of an `EventTriggerEnum` value by name. */
export function eventHelp(name: string): EventHelp | undefined {
  return EVENT_HELP[name];
}
