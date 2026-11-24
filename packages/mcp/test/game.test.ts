/**
 * Game bridge tools on a fake plugin (TCP on a free port).
 */
import { createServer as createTcp, type Server } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultWorkshopDir, GameBridge } from '@kenshi-editor/core/node';
import { createServer, Session } from '../src/index.ts';
import { makeFixture } from '../../cli/test/fixture.ts';

let tcp: Server;
let bridge: GameBridge;
let client: Client;
const seen: { cmd: string; args: unknown }[] = [];

const STATE = {
  paused: true,
  speed: 0,
  time: { days: 3, hours: 80 },
  selected: { name: 'Мэгги', template: { stringId: 't1', name: 'Maggie' }, faction: null, pos: [10, 20, 30] },
  selectedDialogue: null,
  selectedIsPlayer: false,
  camera: null,
  playerCharacters: 1,
  trace: true,
  build: 'Steam',
};
const TRACE = {
  seq: 1,
  event: 1,
  wordswap: false,
  speaker: { name: 'Мэгги', templateId: 't1', player: false },
  target: { name: 'Бип', templateId: 'p', player: true },
  chosen: { dialogue: 'd1', dialogueName: 'Hello', line: 'l1' },
  candidates: [{ id: 'd1', name: 'Hello', score: 5, scoreForTarget: 5, interjection: false, chanceTemporary: 100, chancePermanent: 100, conditions: 'pass', chosen: true }],
  checks: [],
};

function reply(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'ping':
      return { plugin: 'kenshi-bridge', version: '0.1.0', protocol: 1, inGame: true };
    case 'state':
      return STATE;
    case 'trace':
      return { on: args['on'], all: args['filter'] === 'all' };
    case 'trace_get':
      return Number(args['since']) >= 1 ? { next: 1, items: [] } : { next: 1, items: [TRACE] };
    case 'towns':
      return { towns: [{ stringId: 'hub-1', name: 'Хаб', type: 2, typeName: 'town', radius: 1500.4, pos: [-4000, 100, 5000] }], count: 1 };
    case 'dump':
      return {
        dir: 'C:\\dump',
        foliageHook: true,
        zoneReloadHook: true,
        foliageFiles: 3,
        buildingFiles: 4,
        filesWritten: 7,
        loaded: [
          { zone: [14, 21], foliage: 120, buildings: 9, foliageFile: true },
          { zone: [14, 22], foliage: null, buildings: null, foliageFile: false },
        ],
        foliage: 120,
        buildings: 9,
        ...(args['near']
          ? { near: { foliage: [{ id: 'tree-1', p: [1, 2, 3], yaw: 90, scale: 1.5 }], buildings: [{ id: 'torch-1', name: 'Torch', p: [4, 5, 6], q: [1, 0, 0, 0], f: 0 }] } }
          : {}),
      };
    case 'flyover':
      return { running: args['action'] !== 'stop', rect: [0, 0, 63, 63], index: 5, total: 4096, visited: 3, skipped: 2, timeouts: 0, zone: [5, 0], foliageFiles: 3, buildingFiles: 4 };
    default:
      return { ok: cmd };
  }
}

beforeEach(async () => {
  seen.length = 0;
  tcp = createTcp((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i)) as { id: number; cmd: string; args: Record<string, unknown> };
        buf = buf.slice(i + 1);
        seen.push({ cmd: req.cmd, args: req.args });
        sock.write(`${JSON.stringify({ id: req.id, ok: true, result: reply(req.cmd, req.args) })}\n`);
      }
    });
  });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  const addr = tcp.address();
  bridge = new GameBridge({ port: typeof addr === 'object' && addr ? addr.port : 0 });
  const fx = makeFixture();
  const session = new Session({ kenshi: fx.game, workshop: defaultWorkshopDir(fx.game) }, fx.game);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(session, { game: bridge }).connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

afterEach(async () => {
  await client.close();
  bridge.close();
  await new Promise((r) => tcp.close(r));
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError ?? false };
}

describe('kenshi-mcp: game bridge', () => {
  it('game_state reads the state', async () => {
    const r = await call('game_state');
    expect(r.isError).toBe(false);
    expect(r.text).toContain('game connected: kenshi-bridge 0.1.0');
    expect(r.text).toContain('day 3, 8:00; paused');
    expect(r.text).toContain('selected: Мэгги [t1 «Maggie»]');
    expect(r.text).toContain('position: 10, 20, 30');
  });

  it('game_command without confirm sends nothing to the game', async () => {
    const r = await call('game_command', { cmd: 'camera', pos: [1, 2, 3] });
    expect(r.text).toContain('not done: move the camera to 1, 2, 3');
    expect(seen).toEqual([]);
    const ok = await call('game_command', { cmd: 'camera', pos: [1, 2, 3], confirm: true });
    expect(ok.text).toContain('done: move the camera');
    expect(seen).toEqual([{ cmd: 'camera', args: { pos: [1, 2, 3] } }]);
    expect((await call('game_command', { cmd: 'teleport', confirm: true })).isError).toBe(true);
  });

  it('game_spawn sends nothing without confirm', async () => {
    const r = await call('game_spawn', { id: '1-bull.mod', faction: 'player' });
    expect(r.text).toContain('not done: spawn «1-bull.mod» at the camera (faction player)');
    expect(seen).toEqual([]);
    const ok = await call('game_spawn', { id: '1-bull.mod', pos: [1, 2, 3], confirm: true });
    expect(ok.text).toContain('done: spawn «1-bull.mod» at 1, 2, 3');
    expect(seen).toEqual([{ cmd: 'spawn', args: { id: '1-bull.mod', pos: [1, 2, 3] } }]);
  });

  it('game_towns reads towns', async () => {
    const t = await call('game_towns', { near: [0, 0, 0], range: 9000 });
    expect(t.text).toContain('towns: 1');
    expect(t.text).toContain('Хаб [hub-1] — town, radius 1500, center -4000, 100, 5000');
    expect(seen).toEqual([{ cmd: 'towns', args: { near: [0, 0, 0], range: 9000 } }]);
  });

  it('game_dump shows what is dumped', async () => {
    const t = await call('game_dump', { near: [1, 2, 3], range: 200 });
    expect(t.text).toContain('on disk: foliage of 3 zones, buildings of 4 zones');
    expect(t.text).toContain('zone 14.21: foliage 120, buildings 9');
    expect(t.text).toContain('zone 14.22: foliage not recorded');
    expect(t.text).toContain('tree-1 at 1.0, 2.0, 3.0, yaw 90.0, scale 1.50');
    expect(t.text).toContain('torch-1 "Torch" at 4.0, 5.0, 6.0');
    expect(seen).toEqual([{ cmd: 'dump', args: { near: [1, 2, 3], range: 200 } }]);
  });

  it('game_flyover moves the camera only with confirm', async () => {
    const no = await call('game_flyover', { action: 'start', rect: [14, 21, 15, 22] });
    expect(no.text).toContain('not done: start the camera fly-over of zones 14.21 – 15.22');
    expect(seen).toEqual([]);
    const yes = await call('game_flyover', { action: 'start', rect: [14, 21, 15, 22], confirm: true });
    expect(yes.text).toContain('fly-over: running');
    expect(yes.text).toContain('5 of 4096 done');
    expect((await call('game_flyover', { action: 'stop' })).text).toContain('fly-over: not running');
    expect(seen).toEqual([
      { cmd: 'flyover', args: { action: 'start', rect: [14, 21, 15, 22] } },
      { cmd: 'flyover', args: { action: 'stop' } },
    ]);
  });

  it('game_trace: enable and read new entries', async () => {
    expect((await call('game_trace', { action: 'on' })).text).toContain('trace on (player)');
    const first = await call('game_trace', { action: 'get' });
    expect(first.text).toContain('#1 event 1: Мэгги → Бип (player)');
    expect(first.text).toContain('✓ d1 "Hello" weight 5 — chosen');
    expect((await call('game_trace', { action: 'get' })).text).toContain('no new entries');
  });

  it('without the game — a clear error', async () => {
    const off = new GameBridge({ port: 1, connectTimeoutMs: 300 });
    const fx = makeFixture();
    const session = new Session({ kenshi: fx.game, workshop: defaultWorkshopDir(fx.game) }, fx.game);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(session, { game: off }).connect(a);
    const c = new Client({ name: 'test2', version: '0' });
    await c.connect(b);
    const r = (await c.callTool({ name: 'game_state', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('the game is not connected');
    await c.close();
  });
});
