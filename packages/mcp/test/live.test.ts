/**
 * Живая связь: «редактор» (LiveHost + startLiveServer над своей сессией) и MCP-сервер,
 * подключённый к нему через connect_editor.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyOps, decodeText, LiveHost, type ModContext } from '@kenshi-editor/core';
import { defaultWorkshopDir, startLiveServer, type LiveServer } from '@kenshi-editor/core/node';
import { createServer, Session } from '../src/index.ts';
import { makeFixture, type Fixture } from '../../cli/test/fixture.ts';

let fx: Fixture;
let client: Client;
let server: LiveServer;
let host: LiveHost;
let editorCtx: ModContext;
let version = 0;
const sessionNo = 1;
const prevEnv = process.env.KEDIT_LIVE_FILE;

beforeEach(async () => {
  fx = makeFixture();
  const paths = { kenshi: fx.game, workshop: defaultWorkshopDir(fx.game) };
  // Сторона редактора: свой контекст, версия растёт при каждой правке.
  const editorSide = new Session(paths, fx.game);
  editorCtx = editorSide.open({ name: 'Live.mod' }).ctx;
  editorCtx.subscribe(() => version++);
  host = new LiveHost(() => ({ ctx: editorCtx, version, session: sessionNo, dependencies: [] }));
  const live = join(mkdtempSync(join(tmpdir(), 'kedit-live-')), 'live.json');
  process.env.KEDIT_LIVE_FILE = live;
  server = await startLiveServer({ handle: (req) => host.handle(req), discoveryPath: live, app: 'test' });

  const session = new Session(paths, fx.game);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(session).connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

afterEach(async () => {
  await client.close();
  await server.close();
  if (prevEnv === undefined) delete process.env.KEDIT_LIVE_FILE;
  else process.env.KEDIT_LIVE_FILE = prevEnv;
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError ?? false };
}

describe('живая связь с редактором', () => {
  it('connect_editor, правка набором изменений, принять / откатить, правки в окне видны ИИ', async () => {
    const c = await call('connect_editor');
    expect(c.isError, c.text).toBe(false);
    expect(c.text).toContain('подключено к редактору: Live.mod');
    expect(server.clients().map((x) => x.name)).toEqual(['kenshi-mcp']);

    // Правка ИИ — сразу в окне, одной правкой истории, ждёт решения.
    const e = await call('edit', { label: 'тяжелее', ops: [{ op: 'set', id: 'X', field: 'weight', value: 7 }] });
    expect(e.isError, e.text).toBe(false);
    expect(e.text).toContain('«тяжелее» — ждёт решения');
    expect(e.text).toContain('weight');
    expect(editorCtx.get('X')?.floats.get('weight')).toBe(7);
    expect(editorCtx.history().undo.at(-1)?.label).toBe('ИИ: тяжелее');
    expect(host.pending).toBe(1);
    expect((await call('show', { id: 'X' })).text).toContain('7');

    // undo / open_mod / save — дело пользователя.
    expect((await call('undo')).isError).toBe(true);
    expect((await call('open_mod', { mod: 'Other' })).isError).toBe(true);

    // Пользователь правит в окне — ИИ видит это при следующей команде.
    applyOps(editorCtx, [{ op: 'rename', id: 'Y', name: 'Tower shield' }], 'руками');
    expect((await call('find', { text: 'tower' })).text).toContain('Tower shield');

    // Второй набор — пользователь откатывает; первый принимает.
    const e2 = await call('edit', { label: 'имя', ops: [{ op: 'rename', id: 'X', name: 'Long sword' }] });
    const id2 = host.changesets[1]!.id;
    expect(e2.text).toContain(`#${id2}`);
    host.accept(host.changesets[0]!.id);
    host.rollback(id2);
    expect(decodeText(editorCtx.get('X')!.name)).toBe('Sword');
    expect(editorCtx.get('X')?.floats.get('weight')).toBe(7);
    const list = await call('editor_changes');
    expect(list.text).toContain('«тяжелее» — принят');
    expect(list.text).toContain('«имя» — откачен');
    expect((await call('show', { id: 'X' })).text).toContain('Sword');

    // Ctrl+Z в окне — набор помечается «отменён».
    // История: #1 тяжелее, #2 руками, #3 имя, #4 откат имени.
    for (let i = 0; i < 4; i++) editorCtx.undo();
    expect((await call('editor_changes')).text).toContain('«тяжелее» — отменён в окне');

    expect((await call('connect_editor', { disconnect: true })).text).toContain('отключено');
    expect((await call('open_mod', { mod: 'Other' })).isError).toBe(false);
  });

  it('bulk в режиме редактора: предпросмотр по окну, apply — набор изменений', async () => {
    await call('connect_editor');
    applyOps(editorCtx, [{ op: 'set', id: 'Y', field: 'weight', value: 5 }], 'руками');
    const pre = await call('bulk', { type: 'ITEM', op: 'add', field: 'weight', value: '1' });
    expect(pre.text).toContain('Y  «Shield»  weight: 5 → 6');
    expect(host.pending).toBe(0);
    const r = await call('bulk', { type: 'ITEM', op: 'add', field: 'weight', value: '1', apply: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('ждёт решения пользователя');
    expect(host.pending).toBe(1);
    expect(editorCtx.get('X')?.floats.get('weight')).toBe(3);
    expect(editorCtx.get('Y')?.floats.get('weight')).toBe(6);
  });

  it('редактор закрылся — понятная ошибка, дальше без него', async () => {
    await call('connect_editor');
    await server.close();
    expect(existsSync(process.env.KEDIT_LIVE_FILE!)).toBe(false);
    const r = await call('find', { text: 'sword' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('connect_editor');
    expect((await call('find', { text: 'sword' })).text).toContain('Sword');
    expect((await call('connect_editor')).text).toContain('Редактор не запущен');
  });

  it('из браузера (заголовок Origin) и без токена — отказ', async () => {
    const status = await new Promise<number | undefined>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port: server.port,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'https://evil.example' },
      });
      req.on('response', (res) => { resolve(res.statusCode); });
      req.on('upgrade', () => { resolve(101); });
      req.on('error', () => { resolve(undefined); });
      req.end();
    });
    expect(status).toBe(403);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const closed = await new Promise<{ code: number; msg: string }>((resolve) => {
      let msg = '';
      ws.addEventListener('open', () => { ws.send(JSON.stringify({ id: 1, method: 'snapshot' })); });
      ws.addEventListener('message', (ev) => (msg = String(ev.data)));
      ws.addEventListener('close', (ev) => { resolve({ code: ev.code, msg }); });
    });
    expect(closed.code).toBe(1008);
    expect(closed.msg).toContain('Неверный токен');
    expect(server.clients()).toEqual([]);
  });
});
