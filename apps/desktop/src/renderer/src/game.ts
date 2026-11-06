/**
 * Связь окна с игрой (плагин Kenshi Bridge через main): состояние связи, команды и общий
 * журнал трассировки диалога, который читают панель «Игра» и проигрыватель разговора.
 * Тексты — здесь же (en/ru), чтобы не трогать общий словарь.
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

export type GameStrings = typeof en;
export const GAME_STRINGS: Record<Lang, GameStrings> = { en, ru };

export function useGameT(): GameStrings {
  return GAME_STRINGS[useLang()];
}

/** Ошибка ответа плагина понятным текстом (на русском — из ядра, иначе код). */
export function replyError(r: Extract<GameReply, { ok: false }>, lang: Lang): string {
  return lang === 'ru' ? gameErrorText(r.code) : `${r.code}${r.message ? `: ${r.message}` : ''}`;
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
export const teleportTo = (pos: Vec3): Promise<GameReply> => gameRequest('teleport', { pos });

// ── Общий журнал трассировки: читается, пока на него кто-то подписан ──

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
  if (page.next < since) records = []; // игра перезапущена — номера пошли заново
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

/** Записи трассировки и включена ли она (подписка опрашивает игру раз в 2 с). */
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

/** Последний выбор игры для персонажа-шаблона `sid` на событие `event`. */
export function lastTraceFor(list: readonly TraceRecord[], sid: string, event: number): TraceRecord | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i]!;
    if (r.event === event && r.speaker?.templateId === sid) return r;
  }
  return undefined;
}
