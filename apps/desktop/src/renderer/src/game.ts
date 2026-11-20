/**
 * Window link to the game (Kenshi Bridge plugin via main): link state, commands and the shared
 * dialogue trace log read by the «Game» panel and the conversation player.
 * Texts live here too (en/ru), so the shared dictionary stays untouched.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { gameErrorText, type GameState, type TracePage, type TraceRecord, type Vec3 } from '@kenshi-editor/core';
import type { GameCommand, GameLinkStatus, GameReply, Lang } from '../../shared/api.ts';
import { useLang } from './i18n.ts';

const en = {
  panel: 'Game',
  panelHint: 'The running game through the Kenshi Bridge plugin: selected character, time, dialogue trace',
  off: 'Game not connected',
  offHint: 'Start Kenshi with RE_Kenshi and enable the KenshiBridge mod',
  menu: 'Game: in menu',
  on: 'Game connected',
  selected: 'Selected',
  nobody: 'nobody selected',
  position: 'Position',
  faction: 'Faction',
  day: 'Day',
  paused: 'paused',
  speed: 'speed',
  pause: 'Pause',
  resume: 'Resume',
  refresh: 'Refresh',
  traceOn: 'Trace dialogue',
  traceOff: 'Stop trace',
  traceHint: 'Records which dialogue the game picks and why the others drop out',
  traceEmpty: 'No records yet: talk to someone in the game',
  showInGame: 'Show in game',
  showInGameTip: 'Move the game camera here',
  teleport: 'Teleport here',
  teleportTip: 'Move the character selected in the game here',
  teleportAsk: (pos: string) => `Move the character selected in the game to ${pos}?`,
  copyCoords: 'Copy coordinates',
  copied: 'Copied',
  coordsHelp: 'Coordinates can be copied here and pasted into the field "Teleport to a point" in the Game panel. Formats: x, y, z or [x, y, z].',
  gotoLabel: 'Teleport to a point',
  gotoPlaceholder: 'x, y, z',
  gotoButton: 'Teleport',
  badCoords: 'Expected three numbers: x, y, z',
  spawnLabel: 'Place a creature',
  spawnPlaceholder: 'record id (character or animal)',
  spawnButton: 'Place at the camera',
  spawnAsk: (id: string) => `Place "${id}" at the camera in the game?`,
  asInGame: 'As it was in the game',
  asInGameNone: 'The game has not chosen dialogue for this character on this event yet (trace is on — talk to them in the game).',
  asInGameOff: 'Turn on the trace and talk to this character in the game to compare.',
  chosen: 'chosen',
  nothing: 'nothing chosen',
  st_pass: 'passed',
  st_fail: 'conditions failed',
  st_not_reached: 'not reached',
  same: 'matches the editor',
  differs: 'the editor picks another dialogue',
  speaker: 'speaker',
  event: 'event',
  done: 'Done',
  weight: 'weight',
};

const ru: typeof en = {
  panel: 'Игра',
  panelHint: 'Запущенная игра через плагин Kenshi Bridge: выбранный персонаж, время, трассировка диалога',
  off: 'Игра не подключена',
  offHint: 'Запустите Kenshi с RE_Kenshi и включённым модом KenshiBridge',
  menu: 'Игра: в меню',
  on: 'Игра подключена',
  selected: 'Выбран',
  nobody: 'никто не выбран',
  position: 'Позиция',
  faction: 'Фракция',
  day: 'День',
  paused: 'пауза',
  speed: 'скорость',
  pause: 'Пауза',
  resume: 'Продолжить',
  refresh: 'Обновить',
  traceOn: 'Следить за диалогами',
  traceOff: 'Не следить',
  traceHint: 'Записывать, какой диалог выбирает игра и почему выпадают остальные',
  traceEmpty: 'Записей пока нет: поговорите с кем-нибудь в игре',
  showInGame: 'Показать в игре',
  showInGameTip: 'Поставить камеру игры в эту точку',
  teleport: 'Перенести сюда',
  teleportTip: 'Перенести сюда персонажа, выбранного в игре',
  teleportAsk: (pos: string) => `Перенести выбранного в игре персонажа в точку ${pos}?`,
  copyCoords: 'Копировать координаты',
  copied: 'Скопировано',
  coordsHelp: 'Координаты можно скопировать здесь и вставить в поле «Телепорт в точку» на панели «Игра». Форматы: x, y, z или [x, y, z].',
  gotoLabel: 'Телепорт в точку',
  gotoPlaceholder: 'x, y, z',
  gotoButton: 'Телепорт',
  badCoords: 'Нужны три числа: x, y, z',
  spawnLabel: 'Поставить существо',
  spawnPlaceholder: 'id записи (персонаж или животное)',
  spawnButton: 'Поставить у камеры',
  spawnAsk: (id: string) => `Поставить «${id}» в игре у камеры?`,
  asInGame: 'Как было в игре',
  asInGameNone: 'Игра ещё не выбирала диалог этому персонажу на это событие (трассировка включена — поговорите с ним в игре).',
  asInGameOff: 'Включите трассировку и поговорите с этим персонажем в игре — будет видно, совпадает ли с редактором.',
  chosen: 'выбран',
  nothing: 'ничего не выбрано',
  st_pass: 'прошёл',
  st_fail: 'отсеян условиями',
  st_not_reached: 'не дошла очередь',
  same: 'совпадает с редактором',
  differs: 'редактор выбирает другой диалог',
  speaker: 'говорит',
  event: 'событие',
  done: 'Готово',
  weight: 'вес',
};

const zh: typeof en = {
  panel: '游戏',
  panelHint: '通过 Kenshi Bridge 插件连接运行中的游戏：所选角色、时间、对话追踪',
  off: '游戏未连接',
  offHint: '请使用 RE_Kenshi 启动 Kenshi，并启用 KenshiBridge Mod',
  menu: '游戏：在菜单中',
  on: '游戏已连接',
  selected: '已选择',
  nobody: '没有选中任何人',
  position: '位置',
  faction: '阵营',
  day: '第几天',
  paused: '已暂停',
  speed: '速度',
  pause: '暂停',
  resume: '继续',
  refresh: '刷新',
  traceOn: '追踪对话',
  traceOff: '停止追踪',
  traceHint: '记录游戏选择了哪个对话，以及其余对话为何被淘汰',
  traceEmpty: '还没有记录：请在游戏中与某人交谈',
  showInGame: '在游戏中显示',
  showInGameTip: '把游戏镜头移到这里',
  teleport: '传送到这里',
  teleportTip: '把游戏中选中的角色传送到这里',
  teleportAsk: (pos: string) => `要把游戏中选中的角色传送到 ${pos} 吗？`,
  copyCoords: '复制坐标',
  copied: '已复制',
  coordsHelp: '可以在这里复制坐标，并粘贴到「游戏」面板的「传送到坐标」输入框。格式：x, y, z 或 [x, y, z]。',
  gotoLabel: '传送到坐标',
  gotoPlaceholder: 'x, y, z',
  gotoButton: '传送',
  badCoords: '需要三个数字：x, y, z',
  spawnLabel: '放置生物',
  spawnPlaceholder: '记录 id（角色或动物）',
  spawnButton: '放在镜头处',
  spawnAsk: (id: string) => `要把「${id}」放在游戏镜头处吗？`,
  asInGame: '游戏中的实际情况',
  asInGameNone: '游戏还没有为这个角色在此事件下选择过对话（追踪已开启——请在游戏中与其交谈）。',
  asInGameOff: '请开启追踪并在游戏中与这个角色交谈，即可对比。',
  chosen: '已选中',
  nothing: '什么都没选',
  st_pass: '通过',
  st_fail: '条件不满足',
  st_not_reached: '未轮到',
  same: '与编辑器一致',
  differs: '编辑器会选择另一个对话',
  speaker: '说话者',
  event: '事件',
  done: '完成',
  weight: '权重',
};

export type GameStrings = typeof en;
export const GAME_STRINGS: Record<Lang, GameStrings> = { en, ru, zh };

export function useGameT(): GameStrings {
  return GAME_STRINGS[useLang()];
}

/** Plugin reply error as text: the core's wording of the code in the UI language, then the plugin's message. */
export function replyError(r: Extract<GameReply, { ok: false }>, lang: Lang): string {
  return `${gameErrorText(r.code, lang)}${r.message ? `: ${r.message}` : ''}`;
}

const OFF: GameLinkStatus = { connected: false, inGame: false };

export function useGameLink(): GameLinkStatus {
  const [s, setS] = useState<GameLinkStatus>(OFF);
  useEffect(() => {
    let alive = true;
    void window.kedit.getGameStatus().then((v) => {
      if (alive) setS(v);
    });
    const off = window.kedit.onGameStatus(setS);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return s;
}

export function gameRequest(cmd: GameCommand, args?: object): Promise<GameReply> {
  return window.kedit.gameRequest(cmd, args);
}

export async function gameState(): Promise<GameState | GameReply> {
  const r = await gameRequest('state');
  return r.ok ? (r.result as GameState) : r;
}

export const cameraTo = (pos: Vec3): Promise<GameReply> => gameRequest('camera', { pos });
export const spawnAt = (id: string): Promise<GameReply> => gameRequest('spawn', { id });
export const teleportTo = (pos: Vec3): Promise<GameReply> => gameRequest('teleport', { pos });

// ── Shared trace log: read while someone is subscribed to it ──

const KEEP = 300;
let records: readonly TraceRecord[] = [];
let traceOn = false;
let since = 0;
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
let snapshot = { records, on: traceOn };

function emit(): void {
  snapshot = { records, on: traceOn };
  for (const l of listeners) l();
}

async function pull(): Promise<void> {
  const r = await gameRequest('trace_get', { since });
  if (!r.ok) return;
  const page = r.result as TracePage;
  if (page.next < since) records = []; // game restarted — numbering started over
  since = page.next;
  if (page.items.length) {
    records = [...records, ...page.items].slice(-KEEP);
    emit();
  }
}

async function syncOn(): Promise<void> {
  const r = await gameRequest('state');
  if (!r.ok) return;
  const on = (r.result as GameState).trace;
  if (on !== traceOn) {
    traceOn = on;
    emit();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (subscribers++ === 0) {
    void syncOn().then(pull);
    timer = setInterval(() => {
      if (traceOn) void pull();
    }, 2000);
  }
  return () => {
    listeners.delete(cb);
    if (--subscribers === 0 && timer) clearInterval(timer);
  };
}

/** Trace records and whether tracing is on (the subscription polls the game every 2 s). */
export function useGameTrace(): { records: readonly TraceRecord[]; on: boolean } {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export async function setGameTrace(on: boolean): Promise<GameReply> {
  const r = await gameRequest('trace', { on, filter: 'player' });
  if (r.ok) {
    traceOn = (r.result as { on: boolean }).on;
    emit();
    if (traceOn) void pull();
  }
  return r;
}

/** The game's last pick for template character `sid` on event `event`. */
export function lastTraceFor(list: readonly TraceRecord[], sid: string, event: number): TraceRecord | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i]!;
    if (r.event === event && r.speaker?.templateId === sid) return r;
  }
  return undefined;
}
