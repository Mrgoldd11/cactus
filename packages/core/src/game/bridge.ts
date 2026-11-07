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
  | { cmd: 'pause'; args: { on: boolean } };

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
  bad_json: 'the plugin did not understand the request',
  bad_request: 'invalid request',
  unknown_cmd: 'the plugin does not know this command',
  bad_args: 'invalid command arguments',
  not_in_game: 'the game is not in a world (menu or loading)',
  no_selection: 'no character is selected in the game',
  no_camera: 'the game camera is unavailable',
  no_world: 'the world is not loaded yet',
  no_renderer: 'the game renderer is not ready',
  unsupported: 'this game version does not support the command',
  busy: 'the game is busy, try again',
  crash: 'the command crashed inside the game (the game keeps running)',
  no_connection: 'the game is not connected: start Kenshi with RE_Kenshi and the KenshiBridge mod (the plugin is optional, download: https://github.com/Mrgoldd11/Kenshi-Bridge)',
  timeout: 'the game did not answer',
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
  out.push(`day ${Math.floor(s.time.days)}, ${hours}:${String(mins).padStart(2, '0')}; ${s.paused ? 'paused' : `speed ×${fmt(s.speed)}`}; build ${s.build}`);
  if (s.selected) {
    const sel = s.selected;
    const tpl = sel.template ? ` [${sel.template.stringId} «${sel.template.name}»]` : '';
    const fac = sel.faction ? `, faction "${sel.faction.name}" [${sel.faction.stringId}]` : '';
    out.push(`selected: ${sel.name}${tpl}${fac}${s.selectedIsPlayer ? ' (player squad)' : ''}`);
    out.push(`  position: ${formatVec3(sel.pos)}`);
  } else out.push('selected: nobody');
  const d = s.selectedDialogue;
  if (d?.active) out.push(`  in conversation: event ${d.event}, dialogue ${d.dialogue ?? '—'}, line ${d.line ?? '—'}${d.target ? `, with ${d.target}` : ''}`);
  if (s.camera) out.push(`camera: ${formatVec3(s.camera.center)}`);
  out.push(`player characters: ${s.playerCharacters}`);
  out.push(`dialogue trace: ${s.trace ? 'on' : 'off'}`);
  return out;
}

const STATUS: Record<TraceConditions, string> = { pass: 'passed', fail: 'dropped by conditions', not_reached: 'not reached its turn' };

export function traceStatusText(c: TraceConditions): string {
  return STATUS[c];
}

const who = (a: TraceActor | null): string => (a ? `${a.name}${a.player ? ' (player)' : ''}` : '—');

/** Запись трассировки строками: событие, кто, выбор и соперники по порядку проверки. */
export function formatTraceRecord(r: TraceRecord): string[] {
  const out: string[] = [];
  out.push(`#${r.seq} event ${r.event}${r.wordswap ? ' (word swap)' : ''}: ${who(r.speaker)} → ${who(r.target)}`);
  out.push(r.chosen ? `  chosen: ${r.chosen.dialogue} "${r.chosen.dialogueName}", line ${r.chosen.line}` : '  nothing chosen');
  for (const c of r.candidates) {
    const chance = c.chanceTemporary < 100 || c.chancePermanent < 100 ? `, chance ${c.chanceTemporary}/${c.chancePermanent}` : '';
    out.push(`  ${c.chosen ? '✓' : '·'} ${c.id} "${c.name}" weight ${c.score}${chance} — ${c.chosen ? 'chosen' : STATUS[c.conditions]}`);
  }
  return out;
}
