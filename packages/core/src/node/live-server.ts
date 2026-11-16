/**
 * Editor live-link server: WebSocket (RFC 6455, text frames only) on 127.0.0.1,
 * no external dependencies. The client's first message is `hello` with the token from the
 * discovery file; requests from browsers (an Origin header is present) are rejected.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { LIVE_PROTOCOL, type LiveDiscovery, type LiveRequest, type LiveRequestBody, type LiveResponse } from '../live/protocol.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Limit for one client message. */
const MAX_MESSAGE = 16 * 1024 * 1024;

/** Discovery file: `KEDIT_LIVE_FILE` or `<temp>/kenshi-mod-editor/live.json`. */
export function liveDiscoveryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.KEDIT_LIVE_FILE ?? join(tmpdir(), 'kenshi-mod-editor', 'live.json');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the discovery file; undefined — no file or the editor is already closed. */
export function readLiveDiscovery(path = liveDiscoveryPath()): LiveDiscovery | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const d = JSON.parse(readFileSync(path, 'utf-8')) as LiveDiscovery;
    if (typeof d.port !== 'number' || typeof d.token !== 'string') return undefined;
    if (typeof d.pid === 'number' && !processAlive(d.pid)) return undefined;
    return d;
  } catch {
    return undefined;
  }
}

export interface LiveClientInfo {
  id: number;
  name: string;
  since: number;
}

export interface LiveServerOptions {
  /** Run a request (except `hello`); an error is thrown. */
  handle: (req: LiveRequestBody) => unknown;
  /** Connected clients changed. */
  onClients?: (clients: LiveClientInfo[]) => void;
  /** Where to write the discovery file; false — do not write. */
  discoveryPath?: string | false;
  token?: string;
  port?: number;
  app?: string;
}

export interface LiveServer {
  port: number;
  token: string;
  discoveryPath?: string;
  clients(): LiveClientInfo[];
  close(): Promise<void>;
}

export async function startLiveServer(options: LiveServerOptions): Promise<LiveServer> {
  const token = options.token ?? randomBytes(24).toString('hex');
  const conns = new Set<Connection>();
  let nextId = 1;
  const clients = (): LiveClientInfo[] => [...conns].filter((c) => c.info).map((c) => c.info!);
  const changed = (): void => options.onClients?.(clients());

  const http = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('kenshi-mod-editor: WebSocket only');
  });
  http.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.origin !== undefined || typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new Connection(socket, (text) => {
      void onMessage(conn, text);
    });
    conns.add(conn);
    socket.on('close', () => {
      const had = conn.info !== undefined;
      conns.delete(conn);
      if (had) changed();
    });
    socket.on('error', () => socket.destroy());
  });

  const onMessage = async (conn: Connection, text: string): Promise<void> => {
    let req: LiveRequest;
    try {
      req = JSON.parse(text) as LiveRequest;
    } catch {
      conn.close(1007, 'bad json');
      return;
    }
    const reply = (r: LiveResponse): void => { conn.send(JSON.stringify(r)); };
    if (!conn.info) {
      if (req.method !== 'hello' || !sameToken(req.token, token)) {
        reply({ id: req.id, ok: false, error: 'Неверный токен: подключитесь заново (файл live.json)' });
        conn.close(1008, 'auth');
        return;
      }
      conn.info = { id: nextId++, name: req.client ?? 'client', since: Date.now() };
      reply({ id: req.id, ok: true, result: { protocol: LIVE_PROTOCOL, app: options.app } });
      changed();
      return;
    }
    try {
      reply({ id: req.id, ok: true, result: await options.handle(req) });
    } catch (e) {
      reply({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  await new Promise<void>((res, rej) => {
    http.once('error', rej);
    http.listen(options.port ?? 0, '127.0.0.1', () => { res(); });
  });
  const port = (http.address() as AddressInfo).port;
  const discoveryPath = options.discoveryPath === false ? undefined : (options.discoveryPath ?? liveDiscoveryPath());
  if (discoveryPath !== undefined) {
    const d: LiveDiscovery = { protocol: LIVE_PROTOCOL, port, token, pid: process.pid, ...(options.app !== undefined ? { app: options.app } : {}) };
    mkdirSync(dirname(discoveryPath), { recursive: true });
    writeFileSync(discoveryPath, JSON.stringify(d, null, 2));
  }

  return {
    port,
    token,
    ...(discoveryPath !== undefined ? { discoveryPath } : {}),
    clients,
    close: async () => {
      for (const c of conns) c.close(1001, 'editor closed');
      // Remove the file only if it is still ours (a second editor window may have opened).
      if (discoveryPath !== undefined && readLiveDiscovery(discoveryPath)?.token === token) rmSync(discoveryPath, { force: true });
      await new Promise<void>((res) => {
        http.close(() => { res(); });
        http.closeAllConnections();
      });
    },
  };
}

function sameToken(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** One connection: parse client frames (always masked), replies unmasked. */
class Connection {
  info: LiveClientInfo | undefined;
  private readonly socket: Duplex;
  private readonly onText: (text: string) => void;
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentSize = 0;
  private closed = false;

  constructor(socket: Duplex, onText: (text: string) => void) {
    this.socket = socket;
    this.onText = onText;
    socket.on('data', (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.parse();
    });
  }

  private parse(): void {
    while (!this.closed && this.buf.length >= 2) {
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if ((b1 & 0x80) === 0) {
        this.close(1002, 'unmasked frame');
        return;
      }
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) {
          this.close(1009, 'too big');
          return;
        }
        len = Number(big);
        off = 10;
      }
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.buf = this.buf.subarray(off + 4 + len);
      this.frame(fin, op, payload);
    }
  }

  private frame(fin: boolean, op: number, payload: Buffer): void {
    switch (op) {
      case 0x0:
      case 0x1:
        if (op === 0x1 && this.fragments.length > 0) {
          this.close(1002, 'unexpected text frame');
          return;
        }
        if (op === 0x0 && this.fragments.length === 0) {
          this.close(1002, 'unexpected continuation');
          return;
        }
        this.fragments.push(payload);
        this.fragmentSize += payload.length;
        if (this.fragmentSize > MAX_MESSAGE) {
          this.close(1009, 'too big');
          return;
        }
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf-8');
          this.fragments = [];
          this.fragmentSize = 0;
          this.onText(text);
        }
        return;
      case 0x8:
        this.close(1000, '');
        return;
      case 0x9:
        this.write(0xa, payload);
        return;
      case 0xa:
        return;
      default:
        this.close(1003, 'text only');
    }
  }

  private write(op: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const n = payload.length;
    let head: Buffer;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 0x10000) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  send(text: string): void {
    if (!this.closed) this.write(0x1, Buffer.from(text, 'utf-8'));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.write(0x8, body);
    this.socket.end();
  }
}
