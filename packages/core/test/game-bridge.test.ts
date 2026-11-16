import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { formatGameState, formatTraceRecord, type GameState, type TraceRecord } from '../src/index.ts';
import { GameBridge, GameBridgeError } from '../src/node/index.ts';

/** Fake plugin: answers from a command table, can stay silent and drop the connection. */
function fakeGame(handler: (cmd: string, args: Record<string, unknown>, sock: Socket) => unknown): Promise<{ server: Server; port: number; clients: Socket[] }> {
  const clients: Socket[] = [];
  const server = createServer((sock) => {
    clients.push(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i)) as { id: number; cmd: string; args: Record<string, unknown> };
        buf = buf.slice(i + 1);
        const r = handler(req.cmd, req.args, sock);
        if (r === undefined) continue;
        const reply = r instanceof Error ? { id: req.id, ok: false, error: { code: r.message, message: 'x' } } : { id: req.id, ok: true, result: r };
        sock.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, clients });
    });
  });
}

const STATE: GameState = {
  paused: false,
  speed: 1,
  time: { days: 12.5, hours: 300.5 },
  selected: { name: 'Мэгги', template: { stringId: '42-x.mod', name: 'Maggie' }, faction: { name: 'Нет', stringId: '1-f' }, pos: [1.25, 2, -3] },
  selectedDialogue: null,
  selectedIsPlayer: true,
  camera: { center: [0, 0, 0] },
  playerCharacters: 3,
  trace: false,
  build: 'Steam',
};

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

describe('GameBridge', () => {
  it('matches answers by id and passes arguments', async () => {
    const seen: unknown[] = [];
    const g = await fakeGame((cmd, args) => {
      seen.push([cmd, args]);
      if (cmd === 'ping') return { plugin: 'kenshi-bridge', version: '0.1.0', protocol: 1, inGame: true };
      if (cmd === 'state') return STATE;
      if (cmd === 'camera') return { pos: args['pos'] };
      return new Error('unknown_cmd');
    });
    const b = new GameBridge({ port: g.port });
    cleanup.push(() => { b.close(); }, () => g.server.close());
    const [ping, state, cam] = await Promise.all([b.ping(), b.state(), b.action({ cmd: 'camera', args: { pos: [1, 2, 3] } })]);
    expect(ping.inGame).toBe(true);
    expect(state.selected?.name).toBe('Мэгги');
    expect(cam).toEqual({ pos: [1, 2, 3] });
    expect(seen).toContainEqual(['camera', { pos: [1, 2, 3] }]);
    await expect(b.request('nope')).rejects.toMatchObject({ code: 'unknown_cmd' });
  });

  it('no game — no_connection, no answer — timeout', async () => {
    const g = await fakeGame(() => undefined);
    const b = new GameBridge({ port: g.port, timeoutMs: 100 });
    cleanup.push(() => { b.close(); }, () => g.server.close());
    await expect(b.state()).rejects.toMatchObject({ code: 'timeout' });

    const free = await fakeGame(() => undefined);
    const port = free.port;
    await new Promise((r) => free.server.close(r));
    const none = new GameBridge({ port, connectTimeoutMs: 300 });
    const err = await none.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GameBridgeError);
    expect((err as GameBridgeError).code).toBe('no_connection');
  });

  it('reconnects on its own after a drop', async () => {
    let calls = 0;
    const g = await fakeGame((cmd, _args, sock) => {
      calls++;
      if (calls === 1) {
        sock.destroy();
        return undefined;
      }
      return { plugin: 'kenshi-bridge', version: '0.1.0', protocol: 1, inGame: false };
    });
    const b = new GameBridge({ port: g.port });
    cleanup.push(() => { b.close(); }, () => g.server.close());
    await expect(b.ping()).rejects.toMatchObject({ code: 'no_connection' });
    await expect(b.ping()).resolves.toMatchObject({ inGame: false });
    expect(g.clients.length).toBe(2);
  });

  it('parses an answer that came in chunks and a batch of answers in one packet', async () => {
    const g = await fakeGame(() => undefined);
    const b = new GameBridge({ port: g.port });
    cleanup.push(() => { b.close(); }, () => g.server.close());
    const p1 = b.request('a');
    const p2 = b.request('b');
    await new Promise((r) => setTimeout(r, 50));
    const sock = g.clients[0]!;
    const one = JSON.stringify({ id: 1, ok: true, result: 'A' });
    sock.write(one.slice(0, 5));
    await new Promise((r) => setTimeout(r, 20));
    sock.write(`${one.slice(5)}\n${JSON.stringify({ id: 2, ok: true, result: 'B' })}\n`);
    await expect(p1).resolves.toBe('A');
    await expect(p2).resolves.toBe('B');
  });
});

describe('game answer format', () => {
  it('state: time of day, selected, position', () => {
    const lines = formatGameState(STATE);
    expect(lines[0]).toBe('day 12, 12:30; speed ×1; build Steam');
    expect(lines[1]).toContain('Мэгги [42-x.mod «Maggie»]');
    expect(lines[2]).toBe('  position: 1.3, 2, -3');
  });

  it('trace: the choice and why the rivals dropped out', () => {
    const r: TraceRecord = {
      seq: 3,
      event: 1,
      wordswap: false,
      speaker: { name: 'Мэгги', templateId: 't', player: false },
      target: { name: 'Бип', templateId: 'p', player: true },
      chosen: { dialogue: 'd2', dialogueName: 'Hi', line: 'l1' },
      candidates: [
        { id: 'd1', name: 'Top', score: 50, scoreForTarget: 50, interjection: false, chanceTemporary: 100, chancePermanent: 100, conditions: 'fail', chosen: false },
        { id: 'd2', name: 'Hi', score: 10, scoreForTarget: 10, interjection: false, chanceTemporary: 50, chancePermanent: 100, conditions: 'pass', chosen: true },
        { id: 'd3', name: 'Low', score: 1, scoreForTarget: 1, interjection: false, chanceTemporary: 100, chancePermanent: 100, conditions: 'not_reached', chosen: false },
      ],
      checks: [],
    };
    expect(formatTraceRecord(r)).toEqual([
      '#3 event 1: Мэгги → Бип (player)',
      '  chosen: d2 "Hi", line l1',
      '  · d1 "Top" weight 50 — dropped by conditions',
      '  ✓ d2 "Hi" weight 10, chance 50/100 — chosen',
      '  · d3 "Low" weight 1 — not reached its turn',
    ]);
  });
});
