/**
 * Enums built into FCS (C#) rather than described in `fcs_enums.def`: dialogue conditions
 * and effects, speaker, comparison, repetition, package events, personality traits.
 * Source — the FCS sources (`knowledge/_external/fcs_enums/*.cs`); a value's number is its position in
 * the C# enum. Numbers checked against vanilla data: event 1 — talk, 16 — attack, condition 17 —
 * IN_MY_BUILDING, repetition 5 — once only (`knowledge/KENSHI_INTERNALS.md`).
 *
 * `enum shared X` in `fcs_enums.def` (currently only EventTriggerEnum) is the same C# enum:
 * the file gives descriptions and display order, while numbers are taken by name from here. In the game file the values
 * come in a different order, and counting "as in C" would give wrong numbers.
 */

/** Value names by number. */
export const BUILTIN_ENUMS: Readonly<Record<string, readonly string[]>> = {
  DialogConditionEnum: ['DC_NONE','DC_RELATIONS','DC_PLAYERMONEY','DC_REPUTATION','DC_CARRYING_BOUNTY_ALIVE','DC_CARRYING_BOUNTY_DEAD','DC_FACTION_VARIABLE','DC_IMPRISONED_BY_TARGET','DC_IMPRISONED_BY_OTHER','DC_IS_A_TRADER','DC_FACTION_RANK','DC_BUILDING_IS_CLOSED_AND_SECURED','DC_PLAYER_TECH_LEVEL','DC_NUM_DIALOG_EVENT_REPEATS','DC_IS_IMPRISONED','DC_IMPRISONMENT_IS_DEATHROW','DC_TARGET_IN_TALKING_RANGE','DC_IN_MY_BUILDING','DC_TARGET_LAST_SEEN_X_HOURS_AGO','DC_IS_LEADER','DC_MET_TARGET_BEFORE','DC_WEAKER_THAN_ME','DC_STRONGER_THAN_ME','DC_HAS_TAG','DC_IS_ALLY','DC_IS_ENEMY','DC_PERSONALITY_TAG','DC_BROKEN_LEG','DC_BROKEN_ARM','DC_DAMAGED_HEAD','DC_NEARLY_KO','DC_IN_A_NON_PLAYER_TOWN','DC_IS_RUNNING','DC_COPS_AROUND','NULL_NULL_____DC_TARGET_SQUAD_SIZE','DC_SQUAD_SIZE','DC_IS_PLAYER','DC_NUM_BACKPACKS','DC_SQUAD_ONLY_ANIMALS','DC_IS_OUTNUMBERED','DC_BOUNTY_AMOUNT_PERCEIVED','DC_IS_KO','DC_IS_NEARLY_KO','DC_SQUAD_IS_DOWN','DC_IS_DEAD','DC_IS_FEMALE','DC_CARRYING_SOMEONE_TO_ENSLAVE','DC_BOUNTY_AMOUNT_ACTUAL','DC_IM_UNARMED','DC_TOWN_HAS_FORTIFICATIONS_WALLS','DC_TARGET_IS_MY_MISSION_TARGET','DC_MY_MISSION_IS_FRIENDLY','DC_I_LOVE_THIS_GUY','DC_I_HATE_THIS_GUY','DC_I_SHOULD_SCREW_THIS_GUY_OVER','DC_I_SHOULD_HELP_THIS_GUY','DC_IN_COMBAT','DC_WITHIN_TOWN_WALLS','DC_TOWN_WALLS_LOCKED_UP','DC_IS_SLAVE','DC_HAS_A_BASE_NEARBY','DC_TARGET_IS_SLAVE_OF_MY_FACTION','DC_IS_ESCAPED_SLAVE','DC_IS_IN_LOCKED_CAGE','DC_WEARING_LOCKED_SHACKLES','DC_IS_SAME_RACE_AS_ME','DC_CAN_AFFORD_BOUNTY','DC_IS_SNEAKING','DC_IS_INDOORS','DC_HAS_ILLEGAL_ITEM','DC_USING_MY_TRAINING_EQUIPMENT','DC_STARVING','DC_MIXED_GENDER_GROUP','DC_TOWN_LEVEL_CURRENT_LOCATION','DC_PLAYERS_BEST_TOWN_LEVEL','DC_IN_A_PLAYER_TOWN','DC_TARGET_CHARACTER_EXISTS','DC_IS_RECRUITABLE','DC_HAS_AI_CONTRACT','DC_HAS_ROBOT_LIMBS','DC_END'],
  TalkerEnum: ['T_ME','T_TARGET','T_TARGET_IF_PLAYER','T_INTERJECTOR1','T_INTERJECTOR2','T_INTERJECTOR3','T_WHOLE_SQUAD','T_TARGET_WITH_RACE'],
  ComparisonEnum: ['CE_EQUALS','CE_LESS_THAN','CE_MORE_THAN'],
  DialogRepetitionEnum: ['DR_NO_LIMIT','DR_SHORT_2','DR_MEDIUM_6','DR_LONG_48','DR_LONG_1WEEK','DR_ONCE_ONLY','DR_VSHORT_020'],
  EventTriggerEnum: ['EV_NONE','EV_PLAYER_TALK_TO_ME','EV_ANNOUNCEMENT','EV_I_SEE_NEUTRAL_SQUAD','EV_I_SEE_RAGDOLL','EV_______','EV_SOUND_THE_ALARM','EV_I_________','EV_THIEF_CAUGHT_STEALING_FROM_ME','EV_SHOO_FROM_MY_BUILDING','EV_MARKED_FOR_DEATH','EV_SCREAMING_TORTURE','EV_BAR_TALK','EV_UNLOCK_MY_CAGE_OR_SHACKLES','EV_UNLOCK_MY_CAGE_ATTEMPT','EV_I_DEFEATED_SQUAD','EV_LAUNCH_ATTACK','EV_INTRUDER_FOUND','EV_HEALING_OTHER_START','EV_BEING_HEALED_START','EV_HEALING_OTHER_FINISHED','EV_BEING_HEALED_FINISHED','EV_FIRSTAID_KIT_EMPTY','EV_GET_UP_PEACE','EV_GET_UP_FIGHT','EV_GET_UP_UNNECCESSARY_FIGHT','EV_HARRASSMENT_SHOUTS','EV_I_SEE_ANIMAL_SQUAD','EV_SPEECH_INTERRUPTED_ATTACKED_BY_TARGET','EV_SPEECH_INTERRUPTED_ATTACKED_BY_STRANGERS','EV_CONTRACT_JOB_ENDED','EV_BETRAYAL','EV_LOOTING_WEAPON_ONLY','EV_LOOTING_EVERYTHING','EV_I_SEE_UNIFORM_IMPOSTER','EV_INTRODUCING_NEW_SLAVE','EV_ESCAPING_SLAVE_SPOTTED','EV_RECAPTURED_A_SLAVE','EV_SHOUT_AT_SLAVE_WORKER','EV_SLAVE_DELIVERY','EV_ESCAPED_EX_SLAVE_SPOTTED','EV_WITNESS_GENERIC_ASSAULT','EV_WITNESS_LOOTING_ALLY','EV_WITNESS_THIEF_OR_LOCKPICK','EV_BOUNTY_SPOTTED','EV_ESCAPED_PRISONER_SPOTTED','EV_PRISONER_FREE_TO_GO','EV_ALMOST_WOKE_UP','EV_ENTER_BIOME','EV_ENTER_TOWN','EV_SQUAD_BROKEN','EV_BOUGHT_ME_FROM_SLAVERY','EV_EATING_SOMETHING_SOUNDS','EV_WORSHIPING_SOMETHING','EV_SLAVE_ESCAPE_OPPORTUNITY_SAVIOR','EV_SLAVE_ESCAPE_OPPORTUNITY_ALONE','EV_ASSASSINATION_FAILED','EV_EATING_MY_CROPS','EV_KIDNAPPING_MY_ALLY','EV_USING_MY_TRAINING_EQUIPMENT','EV_GIVE_UP_CHASE','EV_ACID_FEET','EV_ACID_RAIN','EV_ACID_WATER','EV_WINDY','EV_POISON_GAS','EV_I_SEE_ENEMY_PLAYER','EV_I_SEE_ALLY_PLAYER','EV_I_SEE_ILLEGAL_PLAYER_BUILDING','EV_BURNING','EV_LOST_LEG','EV_LOST_ARM','EV_I_SEE_PLAYER_NICE_BUILDING','EV_TAKEN_OVER_PLAYER_TOWN','EV_CROWD_TRIGGERED','EV_MAX'],
  DialogActionEnum: ['DA_NONE','DA_TRADE','DA_TALK_TO_LEADER','DA_JOIN_SQUAD_WITH_EDIT','DA_AFFECT_RELATIONS','DA_AFFECT_REPUTATION','DA_ATTACK_CHASE_FOREVER','DA_GO_HOME','DA_TAKE_MONEY','DA_GIVE_MONEY','DA_PAY_BOUNTY','DA_CHARACTER_EDITOR','DA_FORCE_SPEECH_TIMER','DA_DECLARE_WAR','DA_END_WAR','DA_CLEAR_AI','DA_FOLLOW_WHILE_TALKING','DA_THUG_HUNTER','DA_JOIN_SQUAD_FAST','DA_REMEMBER_CHARACTER','DA_FLAG_TEMP_ALLY','DA_FLAG_TEMP_ENEMY','DA_MATES_KILL_ME','DA_MAKE_TARGET_RUN_FASTER','DA_GIVE_TARGET_MY_SLAVES','DA_TAG_ESCAPED_SLAVE','DA_FREE_TARGET_SLAVE','DA_MERGE_WITH_SIMILAR_SQUADS','DA_SEPARATE_TO_MY_OWN_SQUAD','DA_ARREST_TARGET','DA_ARREST_TARGETS_CARRIED_PERSON','DA_ATTACK_TOWN','DA_ASSIGN_BOUNTY','DA_CRIME_ALARM','DA_RUN_AWAY','DA_INCREASE_FACTION_RANK','DA_LOCK_THIS_DIALOG','DA_ASSAULT_PHASE','DA_RETREAT_PHASE','DA_VICTORY_PHASE','DA_ENSLAVE_TARGETS_CARRIED_PERSON','CHOOSE_SLAVES_SELLING','CHOOSE_SLAVES_BUYING','CHOOSE_PRISONER_BAIL','CHOOSE_CONSCRIPTION','CHOOSE_RECRUITING','CHOOSE_HIRING_CONTRACT','SURRENDER_NON_HUMANS','CHOOSE_ANIMALS_BUYING','DA_CLEAR_BOUNTY','DA_PLAYER_SELL_PRISONERS','DA_PLAYER_SURRENDER_MEMBER_DIFFERENT_RACE','DA_SUMMON_MY_SQUAD','DA_REMOVE_SLAVE_STATUS','DA_OPEN_NEAREST_GATE','DA_ATTACK_STAY_NEAR_HOME','DA_MASSIVE_ALARM','DA_ATTACK_IF_NO_COEXIST','DA_KNOCKOUT','DA_END'],
  PersonalityTags: ['PT_NONE','PT_HONORABLE','PT_TRAITOROUS','PT___','PT__','PT_SMART','PT_DUMB','PT____','PT_____','PT_BRAVE','PT_FEARFUL','PT_WARM_KIND','PT_COLD_CRUEL','PT_NORMAL','PT_MANIACAL','PT_END'],
  CharacterTypeEnum: ['OT_NONE','OT_LAW_ENFORCEMENT','OT_MILITARY','OT_TRADER','OT_CIVILIAN','OT_DIPLOMAT','OT_SLAVE','OT_SLAVER','OT_BANDIT','OT_ADVENTURER','OT_END'],
  CharacterPerceptionTags_LongTerm: ['LT_NONE','LT_MY_INTRUDER','LT_MY_LIFESAVER','LT_FREED_ME','LT_STOLE_FROM_ME','LT_MY_CAPTOR','LT_FRIENDLY_AQUAINTANCE','LT_DEFEATED_MY_SQUAD_ONCE','LT_SQUAD_LOST_TO_ME_ONCE','LT_KILLED_MY_FRIEND','LT_I_SCREWED_THIS_GUY','LT_MAX'],
};

/** Short Russian labels (for the CLI and the editor); other values have no label. */
export const BUILTIN_ENUM_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  TalkerEnum: {
    T_ME: 'я',
    T_TARGET: 'собеседник',
    T_TARGET_IF_PLAYER: 'собеседник, если игрок',
    T_INTERJECTOR1: 'вмешавшийся 1',
    T_INTERJECTOR2: 'вмешавшийся 2',
    T_INTERJECTOR3: 'вмешавшийся 3',
    T_WHOLE_SQUAD: 'весь отряд',
    T_TARGET_WITH_RACE: 'собеседник нужной расы',
  },
  ComparisonEnum: { CE_EQUALS: '=', CE_LESS_THAN: '<', CE_MORE_THAN: '>' },
  DialogRepetitionEnum: {
    DR_NO_LIMIT: 'без ограничений',
    DR_SHORT_2: '2 ч',
    DR_MEDIUM_6: '6 ч',
    DR_LONG_48: '48 ч',
    DR_LONG_1WEEK: 'неделя',
    DR_ONCE_ONLY: 'один раз',
    DR_VSHORT_020: 'очень коротко',
  },
  EventTriggerEnum: {
    EV_PLAYER_TALK_TO_ME: 'разговор',
    EV_ANNOUNCEMENT: 'объявление',
    EV_I_SEE_NEUTRAL_SQUAD: 'вижу нейтральный отряд',
    EV_I_SEE_RAGDOLL: 'вижу лежащего',
    // The names are erased in the FCS sources; meaning is taken from vanilla dialogues.
    EV_______: 'вижу враждебный отряд',
    EV_I_________: 'упал товарищ',
    EV_I_DEFEATED_SQUAD: 'победил отряд',
    EV_LAUNCH_ATTACK: 'начинаю атаку',
    EV_GET_UP_PEACE: 'встал после боя',
    EV_GET_UP_FIGHT: 'встал в бою',
    EV_SPEECH_INTERRUPTED_ATTACKED_BY_TARGET: 'напали посреди разговора',
    EV_GIVE_UP_CHASE: 'бросил погоню',
    EV_I_SEE_ENEMY_PLAYER: 'вижу игрока-врага',
    EV_I_SEE_ALLY_PLAYER: 'вижу игрока-союзника',
    EV_CROWD_TRIGGERED: 'толпа',
  },
};

/** The same short labels in English and Chinese; the Russian ones above stay the parse aliases. */
export const BUILTIN_ENUM_LABELS_I18N: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  en: {
    TalkerEnum: {
      T_ME: 'me',
      T_TARGET: 'target',
      T_TARGET_IF_PLAYER: 'target if player',
      T_INTERJECTOR1: 'interjector 1',
      T_INTERJECTOR2: 'interjector 2',
      T_INTERJECTOR3: 'interjector 3',
      T_WHOLE_SQUAD: 'whole squad',
      T_TARGET_WITH_RACE: 'target of the race',
    },
    ComparisonEnum: { CE_EQUALS: '=', CE_LESS_THAN: '<', CE_MORE_THAN: '>' },
    DialogRepetitionEnum: {
      DR_NO_LIMIT: 'no limit',
      DR_SHORT_2: '2 h',
      DR_MEDIUM_6: '6 h',
      DR_LONG_48: '48 h',
      DR_LONG_1WEEK: 'a week',
      DR_ONCE_ONLY: 'once only',
      DR_VSHORT_020: 'very short',
    },
    EventTriggerEnum: {
      EV_PLAYER_TALK_TO_ME: 'talk',
      EV_ANNOUNCEMENT: 'announcement',
      EV_I_SEE_NEUTRAL_SQUAD: 'sees a neutral squad',
      EV_I_SEE_RAGDOLL: 'sees someone lying',
      EV_______: 'sees a hostile squad',
      EV_I_________: 'a comrade fell',
      EV_I_DEFEATED_SQUAD: 'defeated a squad',
      EV_LAUNCH_ATTACK: 'launching an attack',
      EV_GET_UP_PEACE: 'got up after a fight',
      EV_GET_UP_FIGHT: 'got up in a fight',
      EV_SPEECH_INTERRUPTED_ATTACKED_BY_TARGET: 'attacked mid-conversation',
      EV_GIVE_UP_CHASE: 'gave up the chase',
      EV_I_SEE_ENEMY_PLAYER: 'sees an enemy player',
      EV_I_SEE_ALLY_PLAYER: 'sees an allied player',
      EV_CROWD_TRIGGERED: 'crowd',
    },
  },
  zh: {
    TalkerEnum: {
      T_ME: '我',
      T_TARGET: '对方',
      T_TARGET_IF_PLAYER: '对方（如果是玩家）',
      T_INTERJECTOR1: '插话者 1',
      T_INTERJECTOR2: '插话者 2',
      T_INTERJECTOR3: '插话者 3',
      T_WHOLE_SQUAD: '整个小队',
      T_TARGET_WITH_RACE: '指定种族的对方',
    },
    ComparisonEnum: { CE_EQUALS: '=', CE_LESS_THAN: '<', CE_MORE_THAN: '>' },
    DialogRepetitionEnum: {
      DR_NO_LIMIT: '无限制',
      DR_SHORT_2: '2 小时',
      DR_MEDIUM_6: '6 小时',
      DR_LONG_48: '48 小时',
      DR_LONG_1WEEK: '一周',
      DR_ONCE_ONLY: '仅一次',
      DR_VSHORT_020: '很短',
    },
    EventTriggerEnum: {
      EV_PLAYER_TALK_TO_ME: '对话',
      EV_ANNOUNCEMENT: '公告',
      EV_I_SEE_NEUTRAL_SQUAD: '看到中立小队',
      EV_I_SEE_RAGDOLL: '看到倒地者',
      EV_______: '看到敌对小队',
      EV_I_________: '同伴倒下',
      EV_I_DEFEATED_SQUAD: '击败了小队',
      EV_LAUNCH_ATTACK: '发起进攻',
      EV_GET_UP_PEACE: '战斗后起身',
      EV_GET_UP_FIGHT: '战斗中起身',
      EV_SPEECH_INTERRUPTED_ATTACKED_BY_TARGET: '对话中遭到攻击',
      EV_GIVE_UP_CHASE: '放弃追击',
      EV_I_SEE_ENEMY_PLAYER: '看到敌对玩家',
      EV_I_SEE_ALLY_PLAYER: '看到盟友玩家',
      EV_CROWD_TRIGGERED: '人群',
    },
  },
};

/** Type fields absent from fcs.def (FCS shows them in its own windows): field → enum. */
export const BUILTIN_FIELD_ENUMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  DIALOG_ACTION: {
    'condition name': 'DialogConditionEnum',
    who: 'TalkerEnum',
    'compare by': 'ComparisonEnum',
    'action name': 'DialogActionEnum',
  },
};

/**
 * `DIALOG_ACTION.tag` depends on the condition: personality trait for DC_PERSONALITY_TAG, long-term
 * memory about the target for DC_HAS_TAG (checked against data: tag 1..14 / 2..9, reference v0 — 0/1).
 */
export const CONDITION_TAG_ENUMS: Readonly<Record<string, string>> = {
  DC_PERSONALITY_TAG: 'PersonalityTags',
  DC_HAS_TAG: 'CharacterPerceptionTags_LongTerm',
};

/** Reference values that mean an enum: `TYPE.category` → enum by value number (v0..v2). */
export const BUILTIN_REF_VALUE_ENUMS: Readonly<Record<string, readonly (string | undefined)[]>> = {
  'DIALOGUE_PACKAGE.dialogs': ['EventTriggerEnum'],
};

/** Labels of reference values where they are not enums (CLI and editor). */
export const BUILTIN_REF_VALUE_LABELS: Readonly<Record<string, readonly string[]>> = {
  'DIALOGUE.conditions': ['значение'],
  'DIALOGUE_LINE.conditions': ['значение'],
  'DIALOGUE_PACKAGE.dialogs': ['событие'],
};
