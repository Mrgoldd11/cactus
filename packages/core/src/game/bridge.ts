/**
 * Bridge to the game (the Kenshi Bridge plugin for RE_Kenshi): protocol v1 types and text formatting of replies.
 * The plugin itself is a separate GPLv3 project; this only describes what it sends over the network.
 */

import type { Vec3 } from '../format/types.ts';
import { uiText, type UiText } from '../ui-text.ts';

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
  /** Total days and total hours since the start of the game. */
  time: { days: number; hours: number };
  selected: GameSelected | null;
  selectedDialogue: GameDialogueState | null;
  selectedIsPlayer: boolean;
  camera: { center: Vec3 } | null;
  playerCharacters: number;
  /** Whether dialogue tracing is on. */
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

/** Commands that change the game (explicit user consent required). */
export type GameAction =
  | { cmd: 'teleport'; args: { pos: Vec3 } }
  | { cmd: 'camera'; args: { pos: Vec3 } }
  | { cmd: 'speed'; args: { value: number } }
  | { cmd: 'pause'; args: { on: boolean } }
  | { cmd: 'spawn'; args: { id: string; pos?: Vec3; faction?: string } };

/** A town from the plugin's `towns` command. */
export interface GameTown {
  stringId: string;
  name: string;
  type: number;
  typeName: string;
  /** Town border radius (with the multiplier from the request). */
  radius: number;
  pos: Vec3;
}

/** Answer of the `dump` command: what the plugin has recorded of the loaded world. */
export interface GameDumpStatus {
  /** Folder with the zone files. */
  dir: string;
  /** Foliage is recorded (false: the hook is not available in this game build). */
  foliageHook: boolean;
  zoneReloadHook: boolean;
  /** Zones that have a file on disk. */
  foliageFiles: number;
  buildingFiles: number;
  filesWritten: number;
  lastError?: string;
  /** Zones loaded in the game now; null = nothing recorded for the zone. */
  loaded: { zone: [number, number]; foliage: number | null; buildings: number | null; pending?: boolean; foliageFile: boolean }[];
  foliage: number;
  buildings: number;
  /** Only with `near`: what stands around the point. */
  near?: {
    foliage: { id: string; p: Vec3; yaw: number; scale: number }[];
    buildings: { id: string; name: string; p: Vec3; q: [number, number, number, number]; f: number }[];
  };
}

/** Answer of the `flyover` command. */
export interface GameFlyoverStatus {
  running: boolean;
  /** Zone rectangle x0, y0, x1, y1. */
  rect: [number, number, number, number];
  index: number;
  total: number;
  visited: number;
  skipped: number;
  timeouts: number;
  zone?: [number, number];
  stopped?: string;
  foliageFiles: number;
  buildingFiles: number;
}

export interface GameFlyoverArgs {
  action: 'start' | 'stop' | 'resume' | 'status';
  rect?: [number, number, number, number];
  force?: boolean;
  /** Milliseconds to stand over a loaded zone. */
  dwell?: number;
  /** Seconds to wait for a zone before moving on. */
  timeout?: number;
}

/** Dump status as text lines (MCP and logs). */
export function formatDumpStatus(s: GameDumpStatus): string[] {
  const out = [
    `dump folder: ${s.dir}`,
    `on disk: foliage of ${s.foliageFiles} zones, buildings of ${s.buildingFiles} zones (4096 zones in the world)`,
    `foliage recording: ${s.foliageHook ? 'on' : 'NOT available in this game build'}`,
    `loaded now: ${s.loaded.length} zones, ${s.foliage} foliage instances, ${s.buildings} buildings`,
  ];
  if (s.lastError) out.push(`last error: ${s.lastError}`);
  for (const z of s.loaded) {
    const fol = z.foliage === null ? 'foliage not recorded (zone was loaded before the plugin saw it; reload the zone)' : `foliage ${z.foliage}`;
    out.push(`  zone ${z.zone[0]}.${z.zone[1]}: ${fol}, buildings ${z.buildings ?? 'not read yet'}${z.pending ? ' (being written)' : ''}`);
  }
  if (s.near) {
    out.push(`foliage near the point: ${s.near.foliage.length}`);
    for (const f of s.near.foliage) out.push(`  ${f.id} at ${f.p.map((v) => v.toFixed(1)).join(', ')}, yaw ${f.yaw.toFixed(1)}, scale ${f.scale.toFixed(2)}`);
    out.push(`buildings near the point: ${s.near.buildings.length}`);
    for (const b of s.near.buildings) out.push(`  ${b.id} "${b.name}" at ${b.p.map((v) => v.toFixed(1)).join(', ')}${b.f ? `, flags ${b.f}` : ''}`);
  }
  return out;
}

/** Fly-over status as text lines. */
export function formatFlyoverStatus(s: GameFlyoverStatus): string[] {
  const out = [
    `fly-over: ${s.running ? 'running' : `not running${s.stopped ? ` (${s.stopped})` : ''}`}`,
    `zones ${s.rect[0]}.${s.rect[1]} – ${s.rect[2]}.${s.rect[3]}: ${s.index} of ${s.total} done (visited ${s.visited}, already dumped ${s.skipped}, not loaded in time ${s.timeouts})`,
    `on disk: foliage of ${s.foliageFiles} zones, buildings of ${s.buildingFiles} zones`,
  ];
  if (s.running && s.zone) out.push(`camera is over zone ${s.zone[0]}.${s.zone[1]}`);
  return out;
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
  | 'nothing_to_resume'
  | 'crash'
  | 'no_connection'
  | 'timeout';

const ERROR_TEXT: Record<GameErrorCode, UiText> = {
  bad_json: { en: 'the plugin did not understand the request', ru: 'плагин не понял запрос', zh: '插件无法理解该请求' },
  bad_request: { en: 'invalid request', ru: 'неверный запрос', zh: '无效请求' },
  unknown_cmd: { en: 'the plugin does not know this command', ru: 'плагин не знает такой команды', zh: '插件不认识这个命令' },
  bad_args: { en: 'invalid command arguments', ru: 'неверные аргументы команды', zh: '命令参数无效' },
  not_in_game: { en: 'the game is not in a world (menu or loading)', ru: 'игра не в мире (меню или загрузка)', zh: '游戏不在世界中（菜单或加载中）' },
  no_selection: { en: 'no character is selected in the game', ru: 'в игре не выбран персонаж', zh: '游戏中没有选中角色' },
  no_camera: { en: 'the game camera is unavailable', ru: 'камера игры недоступна', zh: '游戏摄像机不可用' },
  no_world: { en: 'the world is not loaded yet', ru: 'мир ещё не загружен', zh: '世界尚未加载' },
  no_renderer: { en: 'the game renderer is not ready', ru: 'рендерер игры не готов', zh: '游戏渲染器尚未就绪' },
  unsupported: { en: 'this game version does not support the command', ru: 'эта версия игры не поддерживает команду', zh: '此游戏版本不支持该命令' },
  busy: { en: 'the game is busy, try again', ru: 'игра занята, повторите', zh: '游戏正忙，请重试' },
  nothing_to_resume: { en: 'there is no stopped fly-over to resume', ru: 'нет остановленного облёта, который можно продолжить', zh: '没有可继续的已停止飞越' },
  crash: { en: 'the command crashed inside the game (the game keeps running)', ru: 'команда упала внутри игры (игра работает)', zh: '命令在游戏内部崩溃（游戏仍在运行）' },
  no_connection: { en: 'the game is not connected: start Kenshi with RE_Kenshi and the KenshiBridge mod (the plugin is optional, download: https://github.com/Mrgoldd11/Kenshi-Bridge)', ru: 'игра не подключена: запустите Kenshi с RE_Kenshi и модом KenshiBridge (плагин необязателен, скачать: https://github.com/Mrgoldd11/Kenshi-Bridge)', zh: '游戏未连接：请用 RE_Kenshi 和 KenshiBridge 模组启动 Kenshi（插件可选，下载：https://github.com/Mrgoldd11/Kenshi-Bridge）' },
  timeout: { en: 'the game did not answer', ru: 'игра не ответила', zh: '游戏没有响应' },
};

/** Readable description of a bridge error code. */
export function gameErrorText(code: string, lang = 'en'): string {
  const t = (ERROR_TEXT as Record<string, UiText | undefined>)[code];
  return t ? uiText(t, lang) : code;
}

const fmt = (v: number): string => (Math.round(v * 10) / 10).toString();
export const formatVec3 = (p: readonly number[]): string => p.map(fmt).join(', ');

/** Game state as lines (for MCP and logs). */
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

/** Trace entry as lines: event, who, the pick and the rivals in check order. */
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
