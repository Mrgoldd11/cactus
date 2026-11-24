/** Strings of the transitions between dialogues (UI review G3): graph portals and the package list, merged into `i18n.ts`. */

function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Transition kinds (`model/dialogue-transitions.ts`): a verb shown next to the FCS code. */
type Kinds = Readonly<Record<string, string>>;

const kindsEn: Kinds = {
  interrupt: 'takes over the talk',
  'crowd trigger': 'calls the crowd',
  unlocks: 'unlocks',
  'unlock but keep me': 'unlocks, stays open',
  locks: 'locks',
};
const kindsRu: Kinds = {
  interrupt: 'перехватывает',
  'crowd trigger': 'зовёт толпу',
  unlocks: 'отпирает',
  'unlock but keep me': 'отпирает, сам остаётся',
  locks: 'запирает',
};
const kindsZh: Kinds = {
  interrupt: '接管对话',
  'crowd trigger': '呼叫群体',
  unlocks: '解锁',
  'unlock but keep me': '解锁，自身保留',
  locks: '锁定',
};

const tipsEn: Kinds = {
  interrupt: 'interrupt: the talk jumps into that dialogue at once.',
  'crowd trigger': 'crowd trigger: the other members of the squad start that dialogue (the number is the % of the squad).',
  unlocks: 'unlocks: that dialogue opens (the game can pick it), the dialogue with this line locks.',
  'unlock but keep me': 'unlock but keep me: that dialogue opens, the dialogue with this line stays open.',
  locks: 'locks: that dialogue locks — the game stops picking it until something unlocks it.',
};
const tipsRu: Kinds = {
  interrupt: 'interrupt: разговор сразу переходит в тот диалог.',
  'crowd trigger': 'crowd trigger: тот диалог начинают остальные в отряде (число — % отряда).',
  unlocks: 'unlocks: тот диалог отпирается (игра может его выбрать), а диалог с этой репликой запирается.',
  'unlock but keep me': 'unlock but keep me: тот диалог отпирается, а диалог с этой репликой остаётся открытым.',
  locks: 'locks: тот диалог запирается — игра его не выбирает, пока его кто-нибудь не отопрёт.',
};
const tipsZh: Kinds = {
  interrupt: 'interrupt：对话立即跳转到那个对话。',
  'crowd trigger': 'crowd trigger：小队其他成员开始那个对话（数字为小队百分比）。',
  unlocks: 'unlocks：那个对话被解锁（游戏可以选择它），含此台词的对话被锁定。',
  'unlock but keep me': 'unlock but keep me：那个对话被解锁，含此台词的对话保持开启。',
  locks: 'locks：那个对话被锁定——在被解锁前游戏不会选择它。',
};

export const dialoguePortalsEn = {
  dpEntry: 'ENTRY',
  dpEntrySub: 'from another dialogue',
  dpExit: 'EXIT',
  dpExitSub: 'to another dialogue',
  dpKind: (k: string): string => kindsEn[k] ?? k,
  dpKindTip: (k: string): string => tipsEn[k] ?? k,
  dpCrowd: (pct: number): string => `${pct}%`,
  dpOpen: 'open ↗',
  dpOpenTip: (name: string): string => `Open «${name}» in the graph`,
  dpLineTip: (sid: string): string => `Line ${sid}`,
  dpMoreLines: (n: number): string => `+ ${n} more line${n === 1 ? '' : 's'}`,
  dpMorePortals: (n: number): string => `${n} more dialogue${n === 1 ? '' : 's'}`,
  dpMorePortalsTip: 'Not all linked dialogues fit: they are listed on the «Line» panel of each line.',
  dpSpoken: (when: string): string => `spoken: ${when}`,
  pkLockedTip: 'Locked (locked): the game does not pick it until another dialogue unlocks it.',
  pkUnlockedBy: '← unlocked by',
  pkUnlockedByTip: (names: string): string => `Locked. Unlocked by: ${names}`,
  pkNobodyUnlocks: '← nobody unlocks',
  pkNobodyUnlocksTip: 'Locked, and no dialogue unlocks it: the game will never pick it.',
  pkUnlocks: '→ unlocks',
  pkUnlocksTip: (names: string): string => `Unlocks: ${names}`,
};

export const dialoguePortalsRu: typeof dialoguePortalsEn = {
  dpEntry: 'ВХОД',
  dpEntrySub: 'из другого диалога',
  dpExit: 'ВЫХОД',
  dpExitSub: 'в другой диалог',
  dpKind: (k: string): string => kindsRu[k] ?? k,
  dpKindTip: (k: string): string => tipsRu[k] ?? k,
  dpCrowd: (pct: number): string => `${pct}%`,
  dpOpen: 'открыть ↗',
  dpOpenTip: (name: string): string => `Открыть «${name}» в графе`,
  dpLineTip: (sid: string): string => `Реплика ${sid}`,
  dpMoreLines: (n: number): string => `+ ещё ${n} ${ruPlural(n, 'реплика', 'реплики', 'реплик')}`,
  dpMorePortals: (n: number): string => `ещё ${n} ${ruPlural(n, 'диалог', 'диалога', 'диалогов')}`,
  dpMorePortalsTip: 'Связанных диалогов больше, чем помещается: они есть в панели «Реплика» у каждой реплики.',
  dpSpoken: (when: string): string => `звучит: ${when}`,
  pkLockedTip: 'Заперт (locked): игра его не выбирает, пока другой диалог его не отопрёт.',
  pkUnlockedBy: '← отпирают',
  pkUnlockedByTip: (names: string): string => `Заперт. Отпирают: ${names}`,
  pkNobodyUnlocks: '← никто не отпирает',
  pkNobodyUnlocksTip: 'Заперт, и ни один диалог его не отпирает: игра его никогда не выберет.',
  pkUnlocks: '→ отпирает',
  pkUnlocksTip: (names: string): string => `Отпирает: ${names}`,
};

export const dialoguePortalsZh: typeof dialoguePortalsEn = {
  dpEntry: '入口',
  dpEntrySub: '来自另一个对话',
  dpExit: '出口',
  dpExitSub: '通往另一个对话',
  dpKind: (k: string): string => kindsZh[k] ?? k,
  dpKindTip: (k: string): string => tipsZh[k] ?? k,
  dpCrowd: (pct: number): string => `${pct}%`,
  dpOpen: '打开 ↗',
  dpOpenTip: (name: string): string => `在图中打开「${name}」`,
  dpLineTip: (sid: string): string => `台词 ${sid}`,
  dpMoreLines: (n: number): string => `+ 还有 ${n} 句台词`,
  dpMorePortals: (n: number): string => `还有 ${n} 个对话`,
  dpMorePortalsTip: '关联的对话太多放不下：可在每句台词的「台词」面板中查看。',
  dpSpoken: (when: string): string => `触发：${when}`,
  pkLockedTip: '已锁定（locked）：在另一个对话将其解锁前，游戏不会选择它。',
  pkUnlockedBy: '← 被解锁',
  pkUnlockedByTip: (names: string): string => `已锁定。解锁者：${names}`,
  pkNobodyUnlocks: '← 无人解锁',
  pkNobodyUnlocksTip: '已锁定，且没有对话解锁它：游戏永远不会选择它。',
  pkUnlocks: '→ 解锁',
  pkUnlocksTip: (names: string): string => `解锁：${names}`,
};
