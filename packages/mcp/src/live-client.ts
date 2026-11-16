/**
 * Live link client: connecting MCP to the open editor (Node WebSocket, no dependencies).
 */
import type { LiveDiscovery, LiveRequestBody, LiveResponse } from '@kenshi-editor/core';

const TIMEOUT = 30_000;

export class LiveClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  closed = false;
  /** Reason for the drop (if the connection closed without us asking). */
  closeReason: string | undefined;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg: LiveResponse;
      try {
        msg = JSON.parse(String(ev.data)) as LiveResponse;
      } catch {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    ws.addEventListener('close', (ev) => {
      this.closed = true;
      this.closeReason ??= ev.reason || `code ${ev.code}`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`Connection to the editor was lost (${this.closeReason})`));
      }
      this.pending.clear();
    });
  }

  /** Connect and introduce ourselves with the token from the discovery file. */
  static async connect(d: LiveDiscovery, client = 'kenshi-mcp'): Promise<LiveClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}`);
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => { reject(new Error(`Could not connect to the editor on port ${d.port}`)); };
      ws.addEventListener('open', () => { resolve(); }, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    const c = new LiveClient(ws);
    await c.request({ method: 'hello', token: d.token, client });
    return c;
  }

  request<T = unknown>(body: LiveRequestBody): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`Connection to the editor was lost (${this.closeReason ?? 'closed'})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The editor did not answer within 30 s'));
      }, TIMEOUT);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, ...body }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closeReason = 'disconnected';
    this.ws.close(1000, 'bye');
  }
}
