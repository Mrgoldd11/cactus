/**
 * Game bridge client: TCP 127.0.0.1, one JSON line per message (protocol v1 of the Kenshi Bridge plugin).
 * The connection opens on the first request and reconnects by itself after a drop.
 */
import { createConnection, type Socket } from 'node:net';
import {
  GAME_BRIDGE_PORT,
  gameErrorText,
  type GameAction,
  type GameDumpStatus,
  type GameFlyoverArgs,
  type GameFlyoverStatus,
  type GamePing,
  type GameState,
  type GameTown,
  type TracePage,
} from '../game/bridge.ts';
import type { Vec3 } from '../format/types.ts';

export class GameBridgeError extends Error {
  override name = 'GameBridgeError';
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ? `${gameErrorText(code)}: ${message}` : gameErrorText(code));
    this.code = code;
  }
}

export interface GameBridgeOptions {
  host?: string;
  /** Defaults to the KENSHI_BRIDGE_PORT variable or 47801. */
  port?: number;
  /** Response timeout, ms (default 5000). */
  timeoutMs?: number;
  /** Connect timeout, ms (default 1500). */
  connectTimeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_LINE = 1 << 20;

export function gameBridgePort(): number {
  const env = Number(process.env['KENSHI_BRIDGE_PORT']);
  return Number.isInteger(env) && env > 0 && env < 65536 ? env : GAME_BRIDGE_PORT;
}

export class GameBridge {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private socket: Socket | undefined;
  private connecting: Promise<Socket> | undefined;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(opts: GameBridgeOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? gameBridgePort();
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 1500;
  }

  get connected(): boolean {
    return this.socket !== undefined;
  }

  private open(): Promise<Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    this.connecting ??= new Promise<Socket>((resolve, reject) => {
      const s = createConnection({ host: this.host, port: this.port });
      s.setEncoding('utf8');
      s.setNoDelay(true);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new GameBridgeError('no_connection'));
      }, this.connectTimeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        this.socket = s;
        this.buf = '';
        resolve(s);
      });
      s.on('data', (d: string) => {
        this.onData(d);
      });
      s.on('error', () => {
        clearTimeout(timer);
        reject(new GameBridgeError('no_connection'));
      });
      s.on('close', () => {
        clearTimeout(timer);
        if (this.socket === s) this.socket = undefined;
        this.failAll(new GameBridgeError('no_connection', 'connection lost'));
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.onLine(line);
    }
    if (this.buf.length > MAX_LINE) this.socket?.destroy();
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new GameBridgeError(msg.error?.code ?? 'bad_request', msg.error?.message));
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  /** Send a command and wait for the reply. Error — GameBridgeError with the protocol code. */
  async request<T = unknown>(cmd: string, args: object = {}): Promise<T> {
    const s = await this.open();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GameBridgeError('timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      s.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }

  ping(): Promise<GamePing> {
    return this.request<GamePing>('ping');
  }

  state(): Promise<GameState> {
    return this.request<GameState>('state');
  }

  /** A command that changes the game (teleport, camera, speed, pause). */
  action(a: GameAction): Promise<Record<string, unknown>> {
    return this.request(a.cmd, a.args);
  }

  /** World towns with center and border radius (read only). */
  towns(args: { near?: Vec3; range?: number; mult?: number } = {}): Promise<{ towns: GameTown[]; count: number }> {
    return this.request('towns', args);
  }

  /** What the plugin has dumped of the loaded world (read only); `now` writes the files right away. */
  dump(args: { now?: boolean; near?: Vec3; range?: number; limit?: number } = {}): Promise<GameDumpStatus> {
    return this.request('dump', args);
  }

  /** Camera fly-over that gets zones dumped. start/resume move the game camera: ask the user first. */
  flyover(args: GameFlyoverArgs): Promise<GameFlyoverStatus> {
    return this.request('flyover', args);
  }

  setTrace(on: boolean, filter: 'player' | 'all' = 'player'): Promise<{ on: boolean; all: boolean }> {
    return this.request('trace', { on, filter });
  }

  traceGet(since = 0): Promise<TracePage> {
    return this.request<TracePage>('trace_get', { since });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
