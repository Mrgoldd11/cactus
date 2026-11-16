/**
 * Live link: an "editor" (LiveHost + startLiveServer over its own session) and the MCP server
 * connected to it via connect_editor.
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
  // Editor side: its own context, the version grows with each edit.
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

describe('live link with the editor', () => {
  it('connect_editor, edit as a change set, accept / revert, window edits are visible to the AI', async () => {
    const c = await call('connect_editor');
    expect(c.isError, c.text).toBe(false);
    expect(c.text).toContain('connected to the editor: Live.mod');
    expect(server.clients().map((x) => x.name)).toEqual(['kenshi-mcp']);

    // An AI edit goes straight into the window, as one history edit, and waits for a decision.
    const e = await call('edit', { label: 'тяжелее', ops: [{ op: 'set', id: 'X', field: 'weight', value: 7 }] });
    expect(e.isError, e.text).toBe(false);
    expect(e.text).toContain('"тяжелее" is waiting for the user decision');
    expect(e.text).toContain('weight');
    expect(editorCtx.get('X')?.floats.get('weight')).toBe(7);
    expect(editorCtx.history().undo.at(-1)?.label).toBe('ИИ: тяжелее');
    expect(host.pending).toBe(1);
    expect((await call('show', { id: 'X' })).text).toContain('7');

    // undo / open_mod / save are up to the user.
    expect((await call('undo')).isError).toBe(true);
    expect((await call('open_mod', { mod: 'Other' })).isError).toBe(true);

    // The user edits in the window — the AI sees it on the next command.
    applyOps(editorCtx, [{ op: 'rename', id: 'Y', name: 'Tower shield' }], 'руками');
    expect((await call('find', { text: 'tower' })).text).toContain('Tower shield');

    // The second set — the user reverts it; the first one is accepted.
    const e2 = await call('edit', { label: 'имя', ops: [{ op: 'rename', id: 'X', name: 'Long sword' }] });
    const id2 = host.changesets[1]!.id;
    expect(e2.text).toContain(`#${id2}`);
    host.accept(host.changesets[0]!.id);
    host.rollback(id2);
    expect(decodeText(editorCtx.get('X')!.name)).toBe('Sword');
    expect(editorCtx.get('X')?.floats.get('weight')).toBe(7);
    const list = await call('editor_changes');
    expect(list.text).toContain('"тяжелее" — accepted');
    expect(list.text).toContain('"имя" — rolled back');
    expect((await call('show', { id: 'X' })).text).toContain('Sword');

    // Ctrl+Z in the window — the set is marked "undone".
    // History: #1 heavier, #2 by hand, #3 name, #4 name revert.
    for (let i = 0; i < 4; i++) editorCtx.undo();
    expect((await call('editor_changes')).text).toContain('"тяжелее" — undone in the window');

    expect((await call('connect_editor', { disconnect: true })).text).toContain('disconnected');
    expect((await call('open_mod', { mod: 'Other' })).isError).toBe(false);
  });

  it('bulk in editor mode: preview from the window, apply — a change set', async () => {
    await call('connect_editor');
    applyOps(editorCtx, [{ op: 'set', id: 'Y', field: 'weight', value: 5 }], 'руками');
    const pre = await call('bulk', { type: 'ITEM', op: 'add', field: 'weight', value: '1' });
    expect(pre.text).toContain('Y  «Shield»  weight: 5 → 6');
    expect(host.pending).toBe(0);
    const r = await call('bulk', { type: 'ITEM', op: 'add', field: 'weight', value: '1', apply: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('is waiting for the user decision');
    expect(host.pending).toBe(1);
    expect(editorCtx.get('X')?.floats.get('weight')).toBe(3);
    expect(editorCtx.get('Y')?.floats.get('weight')).toBe(6);
  });

  it('the editor closed — a clear error, then without it', async () => {
    await call('connect_editor');
    await server.close();
    expect(existsSync(process.env.KEDIT_LIVE_FILE!)).toBe(false);
    const r = await call('find', { text: 'sword' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('connect_editor');
    expect((await call('find', { text: 'sword' })).text).toContain('Sword');
    expect((await call('connect_editor')).text).toContain('The editor is not running');
  });

  it('from a browser (Origin header) and without a token — refused', async () => {
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
