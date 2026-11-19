/** Strings of the dialogue editor polish after the live check (UI review G8), merged into `i18n.ts`. */

function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const g8En = {
  dwEvent: 'EVENT',
  dwWho: 'WHO HAS IT',
  dwPkg: 'package',
  dwNobody: 'nobody — the package hangs on no one',
  dwUnused: 'the game does not raise it',
  dwMore: (n: number): string => `and ${n} more package${n === 1 ? '' : 's'}`,
  dwMoreTip: 'The full list is in the «Dialogue line» panel, «Plays when» block (click the dialogue).',
};

export const g8Ru: typeof g8En = {
  dwEvent: 'СОБЫТИЕ',
  dwWho: 'У КОГО',
  dwPkg: 'пакет',
  dwNobody: 'ни у кого — пакет ни на ком не висит',
  dwUnused: 'игра это событие не вызывает',
  dwMore: (n) => `и ещё ${n} ${ruPlural(n, 'пакет', 'пакета', 'пакетов')}`,
  dwMoreTip: 'Весь список — в панели «Реплика диалога», блок «Звучит, когда» (щёлкните диалог).',
};

export const g8Zh: typeof g8En = {
  dwEvent: '事件',
  dwWho: '谁说',
  dwPkg: '对话包',
  dwNobody: '无人——此对话包没有挂在任何人身上',
  dwUnused: '游戏不触发此事件',
  dwMore: (n) => `还有 ${n} 个对话包`,
  dwMoreTip: '完整列表见「对话台词」面板的「触发时机」部分（点击对话）。',
};
