/**
 * Мост к игре (плагин Kenshi Bridge для RE_Kenshi): типы протокола v1 и формат ответов текстом.
 * Сам плагин — отдельный проект под GPLv3; здесь только описание того, что он присылает по сети.
 */

import type { Vec3 } from '../format/types.ts';

export const GAME_BRIDGE_PORT = 47801;
export const GAME_BRIDGE_PROTOCOL = 1;

export interface GamePing {
  plugin: string;
  version: string;
  protocol: number;
  inGame: boolean;
}

export interface GameSelected {
  name: string;
  template: { stringId: string; name: string } | null;
  faction: { name: string; stringId: string } | null;
  pos: Vec3;
}

export interface GameDialogueState {
  active: boolean;
  event: number;
  dialogue: string | null;
  line: string | null;
  target: string | null;
}

export interface GameState {
  paused: boolean;
  speed: number;
  /** Всего дней и всего часов с начала игры. */
  time: { days: number; hours: number };
  selected: GameSelected | null;
  selectedDialogue: GameDialogueState | null;
  selectedIsPlayer: boolean;
  camera: { center: Vec3 } | null;
  playerCharacters: number;
  /** Включена ли трассировка диалога. */
  trace: boolean;
  build: string;
}

export interface TraceActor {
  name: string;
  templateId: string;
  player: boolean;
}

export type TraceConditions = 'pass' | 'fail' | 'not_reached';

export interface TraceCandidate {
  id: string;
  name: string;
  score: number;
  scoreForTarget: number;
  interjection: boolean;
  chanceTemporary: number;
  chancePermanent: number;
  conditions: TraceConditions;
  chosen: boolean;
}

export interface TraceRecord {
  seq: number;
  event: number;
  wordswap: boolean;
  speaker: TraceActor | null;
  target: TraceActor | null;
  chosen: { dialogue: string; dialogueName: string; line: string } | null;
  candidates: TraceCandidate[];
  checks: { id: string; depth: number; pass: boolean }[];
}

export interface TracePage {
  next: number;
  items: TraceRecord[];
}

/** Команды, которые меняют игру (нужно явное согласие пользователя). */
export type GameAction =
  | { cmd: 'teleport'; args: { pos: Vec3 } }
  | { cmd: 'camera'; args: { pos: Vec3 } }
  | { cmd: 'speed'; args: { value: number } }
  | { cmd: 'pause'; args: { on: boolean } }
  | { cmd: 'borders'; args: { on: boolean; mult?: number } };

/** Город из команды `towns` плагина. */
export interface GameTown {
  stringId: string;
  name: string;
  type: number;
  typeName: string;
  /** Радиус границы города (с множителем из запроса). */
  radius: number;
  pos: Vec3;
}

export type GameErrorCode =
  | 'bad_json'
  | 'bad_request'
  | 'unknown_cmd'
  | 'bad_args'
  | 'not_in_game'
  | 'no_selection'
  | 'no_camera'
  | 'no_world'
  | 'no_renderer'
  | 'unsupported'
  | 'busy'
  | 'crash'
  | 'no_connection'
  | 'timeout';

const ERROR_TEXT: Record<GameErrorCode, string> = {
  bad_json: 'плагин не понял запрос',
  bad_request: 'неверный запрос',
  unknown_cmd: 'плагин не знает такой команды',
  bad_args: 'неверные аргументы команды',
  not_in_game: 'игра не в мире (меню или загрузка)',
  no_selection: 'в игре не выбран персонаж',
  no_camera: 'камера игры недоступна',
  no_world: 'мир ещё не загружен',
  no_renderer: 'рендерер игры не готов',
  unsupported: 'эта версия игры не поддерживает команду',
  busy: 'игра занята, повторите',
  crash: 'команда упала внутри игры (игра работает)',
  no_connection: 'игра не подключена: запустите Kenshi с RE_Kenshi и модом KenshiBridge',
  timeout: 'игра не ответила',
};

/** Понятное описание кода ошибки моста. */
export function gameErrorText(code: string): string {
  return (ERROR_TEXT as Record<string, string>)[code] ?? code;
}

const fmt = (v: number): string => (Math.round(v * 10) / 10).toString();
export const formatVec3 = (p: readonly number[]): string => p.map(fmt).join(', ');

/** Состояние игры строками (для MCP и логов). */
export function formatGameState(s: GameState): string[] {
  const out: string[] = [];
  const dayHours = ((s.time.hours % 24) + 24) % 24;
  const hours = Math.floor(dayHours);
  const mins = Math.floor((dayHours - hours) * 60);
  out.push(`день ${Math.floor(s.time.days)}, ${hours}:${String(mins).padStart(2, '0')}; ${s.paused ? 'пауза' : `скорость ×${fmt(s.speed)}`}; сборка ${s.build}`);
  if (s.selected) {
    const sel = s.selected;
    const tpl = sel.template ? ` [${sel.template.stringId} «${sel.template.name}»]` : '';
    const fac = sel.faction ? `, фракция «${sel.faction.name}» [${sel.faction.stringId}]` : '';
    out.push(`выбран: ${sel.name}${tpl}${fac}${s.selectedIsPlayer ? ' (отряд игрока)' : ''}`);
    out.push(`  позиция: ${formatVec3(sel.pos)}`);
  } else out.push('выбран: никто');
  const d = s.selectedDialogue;
  if (d?.active) out.push(`  в разговоре: событие ${d.event}, диалог ${d.dialogue ?? '—'}, реплика ${d.line ?? '—'}${d.target ? `, с ${d.target}` : ''}`);
  if (s.camera) out.push(`камера: ${formatVec3(s.camera.center)}`);
  out.push(`персонажей у игрока: ${s.playerCharacters}`);
  out.push(`трассировка диалога: ${s.trace ? 'включена' : 'выключена'}`);
  return out;
}

const STATUS: Record<TraceConditions, string> = { pass: 'прошёл', fail: 'отсеян условиями', not_reached: 'не дошла очередь' };

export function traceStatusText(c: TraceConditions): string {
  return STATUS[c];
}

const who = (a: TraceActor | null): string => (a ? `${a.name}${a.player ? ' (игрок)' : ''}` : '—');

/** Запись трассировки строками: событие, кто, выбор и соперники по порядку проверки. */
export function formatTraceRecord(r: TraceRecord): string[] {
  const out: string[] = [];
  out.push(`#${r.seq} событие ${r.event}${r.wordswap ? ' (подстановка слов)' : ''}: ${who(r.speaker)} → ${who(r.target)}`);
  out.push(r.chosen ? `  выбран: ${r.chosen.dialogue} «${r.chosen.dialogueName}», реплика ${r.chosen.line}` : '  ничего не выбрано');
  for (const c of r.candidates) {
    const chance = c.chanceTemporary < 100 || c.chancePermanent < 100 ? `, шанс ${c.chanceTemporary}/${c.chancePermanent}` : '';
    out.push(`  ${c.chosen ? '✓' : '·'} ${c.id} «${c.name}» вес ${c.score}${chance} — ${c.chosen ? 'выбран' : STATUS[c.conditions]}`);
  }
  return out;
}
