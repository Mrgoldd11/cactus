/**
 * Мост к игре в главном процессе: окно не открывает сокеты само, а просит main.
 * Main раз в 3 с проверяет связь (ping плагина Kenshi Bridge) и рассылает окнам состояние.
 * Окно может отправить только перечисленные команды (`GAME_COMMANDS`).
 */
import { BrowserWindow, ipcMain } from 'electron';
import { GameBridge, GameBridgeError } from '@kenshi-editor/core/node';
import { GAME_COMMANDS, IPC, type GameLinkStatus, type GameReply } from '../shared/api.ts';

const POLL_MS = 3000;

let bridge: GameBridge | undefined;
let status: GameLinkStatus = { connected: false, inGame: false };
let timer: ReturnType<typeof setInterval> | undefined;

function push(next: GameLinkStatus): void {
  const same = next.connected === status.connected && next.inGame === status.inGame && next.version === status.version;
  status = next;
  if (same) return;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.gameStatus, status);
}

async function poll(): Promise<void> {
  if (!bridge) return;
  try {
    const p = await bridge.ping();
    push({ connected: true, inGame: p.inGame, version: p.version });
  } catch {
    push({ connected: false, inGame: false });
  }
}

async function request(cmd: string, args: object): Promise<GameReply> {
  if (!bridge) return { ok: false, code: 'no_connection', message: 'off' };
  if (!(GAME_COMMANDS as readonly string[]).includes(cmd)) return { ok: false, code: 'unknown_cmd', message: cmd };
  try {
    return { ok: true, result: await bridge.request(cmd, args) };
  } catch (e) {
    if (e instanceof GameBridgeError) {
      if (e.code === 'no_connection') void poll();
      return { ok: false, code: e.code, message: e.message };
    }
    return { ok: false, code: 'crash', message: e instanceof Error ? e.message : String(e) };
  }
}

/** `KEDIT_GAME=0` — не подключаться к игре (тесты окна). */
export function startGameLink(): void {
  ipcMain.handle(IPC.getGameStatus, () => status);
  ipcMain.handle(IPC.gameRequest, (_e, cmd: string, args: object) => request(cmd, args));
  if (process.env['KEDIT_GAME'] === '0') return;
  bridge = new GameBridge({ timeoutMs: 5000, connectTimeoutMs: 800 });
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
}

export function stopGameLink(): void {
  if (timer) clearInterval(timer);
  bridge?.close();
  bridge = undefined;
}
