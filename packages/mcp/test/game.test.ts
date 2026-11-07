/**
 * Инструменты моста к игре на поддельном плагине (TCP на свободном порту).
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

describe('kenshi-mcp: мост к игре', () => {
  it('game_state читает состояние', async () => {
    const r = await call('game_state');
    expect(r.isError).toBe(false);
    expect(r.text).toContain('игра подключена: kenshi-bridge 0.1.0');
    expect(r.text).toContain('день 3, 8:00; пауза');
    expect(r.text).toContain('выбран: Мэгги [t1 «Maggie»]');
    expect(r.text).toContain('позиция: 10, 20, 30');
  });

  it('game_command без confirm ничего не шлёт игре', async () => {
    const r = await call('game_command', { cmd: 'camera', pos: [1, 2, 3] });
    expect(r.text).toContain('не выполнено: поставить камеру в 1, 2, 3');
    expect(seen).toEqual([]);
    const ok = await call('game_command', { cmd: 'camera', pos: [1, 2, 3], confirm: true });
    expect(ok.text).toContain('выполнено: поставить камеру');
    expect(seen).toEqual([{ cmd: 'camera', args: { pos: [1, 2, 3] } }]);
    expect((await call('game_command', { cmd: 'teleport', confirm: true })).isError).toBe(true);
  });

  it('game_towns читает города', async () => {
    const t = await call('game_towns', { near: [0, 0, 0], range: 9000 });
    expect(t.text).toContain('городов: 1');
    expect(t.text).toContain('Хаб [hub-1] — town, радиус 1500, центр -4000, 100, 5000');
    expect(seen).toEqual([{ cmd: 'towns', args: { near: [0, 0, 0], range: 9000 } }]);
  });

  it('game_trace: включить и прочитать новые записи', async () => {
    expect((await call('game_trace', { action: 'on' })).text).toContain('трассировка включена (игрок)');
    const first = await call('game_trace', { action: 'get' });
    expect(first.text).toContain('#1 событие 1: Мэгги → Бип (игрок)');
    expect(first.text).toContain('✓ d1 «Hello» вес 5 — выбран');
    expect((await call('game_trace', { action: 'get' })).text).toContain('новых записей нет');
  });

  it('без игры — понятная ошибка', async () => {
    const off = new GameBridge({ port: 1, connectTimeoutMs: 300 });
    const fx = makeFixture();
    const session = new Session({ kenshi: fx.game, workshop: defaultWorkshopDir(fx.game) }, fx.game);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(session, { game: off }).connect(a);
    const c = new Client({ name: 'test2', version: '0' });
    await c.connect(b);
    const r = (await c.callTool({ name: 'game_state', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('игра не подключена');
    await c.close();
  });
});
