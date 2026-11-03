/**
 * MCP-сервер через клиент SDK в памяти, на синтетической «папке игры» из тестов CLI.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeText } from '@kenshi-editor/core';
import { defaultWorkshopDir, readDataFileSync } from '@kenshi-editor/core/node';
import { createServer, Session } from '../src/index.ts';
import { makeFixture, type Fixture } from '../../cli/test/fixture.ts';

let fx: Fixture;
let client: Client;

beforeEach(async () => {
  fx = makeFixture();
  const session = new Session({ kenshi: fx.game, workshop: defaultWorkshopDir(fx.game) }, fx.game);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(session).connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

afterEach(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError ?? false };
}

describe('kenshi-mcp: чтение', () => {
  it('список инструментов и ресурсов', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining(['open_mod', 'find', 'show', 'tree', 'refs', 'diff', 'validate', 'edit', 'undo', 'redo', 'history', 'save', 'schema']),
    );
    const res = await client.listResources();
    expect(res.resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['kenshi://schema/types', 'kenshi://schema/type/CHARACTER']));
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual(expect.arrayContaining(['kenshi://schema/type/{name}', 'kenshi://schema/enum/{name}']));
  });

  it('без открытого мода — по ванили; open_mod, find, show, refs, tree', async () => {
    expect((await call('show', { id: 'A' })).text).toContain('int money = 15');
    const open = await call('open_mod', { mod: 'My' });
    expect(open.text).toContain('My.mod — ');
    expect(open.text).toContain('записей 2 (changed 1, new 1)');
    expect((await call('find', { text: 'разбой' })).text).toBe('A  CHARACTER  «Bandit» (Разбойник)  [changed]');
    const paged = await call('find', { type: 'ITEM', limit: 1 });
    expect(paged.text).toContain('дальше offset=1');
    expect((await call('find', { fields: ['weight<1'] })).text).toContain('1-My.mod  ITEM  «Magic hat»');
    const show = await call('show', { id: 'A', layers: true });
    expect(show.text).toContain('int money = 99');
    expect(show.text).toContain('→ Magic hat [1-My.mod]  3 0 0');
    expect((await call('refs', { id: '1-My.mod', direction: 'to' })).text).toBe('← Bandit [A] vendors  3 0 0');
    expect((await call('tree', { id: 'D1' })).text).toContain('↻ DIALOGUE_LINE L1');
    const missing = await call('show', { id: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe('Нет записи nope');
  });

  it('diff и validate', async () => {
    await call('open_mod', { mod: 'My' });
    const diff = await call('diff');
    expect(diff.text).toContain('~ int money: 15 → 99');
    expect(diff.text).toContain('+ ITEM 1-My.mod «Magic hat»');
    expect((await call('validate')).text).toBe('ошибок 0, предупреждений 0');
  });

  it('схема: инструмент и ресурсы', async () => {
    expect((await call('schema')).text).toContain('CHARACTER  полей 2, ссылок 1');
    expect((await call('schema', { type: 'item' })).text).toContain('kind: enum Kind = TOOL');
    expect((await call('schema', { enum: 'Kind' })).text).toContain('FOOD = 1');
    expect((await call('schema', { enum: 'Nope' })).isError).toBe(true);
    const type = await client.readResource({ uri: 'kenshi://schema/type/CHARACTER' });
    expect((type.contents[0] as { text: string }).text).toContain('money: int = 0 — how much money');
    const en = await client.readResource({ uri: 'kenshi://schema/enum/Kind' });
    expect((en.contents[0] as { text: string }).text).toContain('TOOL = 0');
  });
});

describe('kenshi-mcp: правка и сохранение', () => {
  it('edit пачкой с псевдонимом, undo/redo, history, save только изменений', async () => {
    await call('open_mod', { mod: 'My' });
    const edit = await call('edit', {
      label: 'кирка',
      ops: [
        { op: 'create', type: 'ITEM', name: 'Pick', as: '$p' },
        { op: 'set', id: '$p', field: 'weight', value: 3 },
        { op: 'addRef', id: 'A', category: 'vendors', target: '$p' },
      ],
    });
    expect(edit.isError, edit.text).toBe(false);
    expect(edit.text).toContain('псевдонимы: $p = 2-My.mod');
    expect(edit.text).toContain('#1 кирка');
    expect(edit.text).toContain('+ ITEM 2-My.mod «Pick»');
    expect((await call('undo')).text).toBe('отменено: #1 кирка');
    expect((await call('find', { text: 'pick' })).text).toBe('ничего не найдено');
    expect((await call('redo')).text).toBe('повторено: #1 кирка');
    const hist = await call('history');
    expect(hist.text).toContain('#1 кирка');
    expect(hist.text).toContain('есть несохранённые изменения');

    // Неверная операция — ошибка, мод не меняется.
    const bad = await call('edit', { ops: [{ op: 'rename', id: 'ghost', name: 'x' }] });
    expect(bad.isError).toBe(true);

    // Мод открыт из папки игры: без force туда не пишем.
    const refused = await call('save');
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('force: true');
    const out = join(fx.game, '..', `mcp-out-${Date.now()}.mod`);
    const saved = await call('save', { path: out });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.text).toContain('записей 3 (changed 1, new 2)');
    const f = readDataFileSync(out);
    expect(f.records.map((r) => decodeText(r.name))).toEqual(['Bandit', 'Magic hat', 'Pick']);
    expect((await call('history')).text).toContain('всё сохранено');
  });

  it('новый мод: save требует путь; force пишет в mods/', async () => {
    await call('open_mod', { name: 'Fresh.mod' });
    await call('edit', { ops: [{ op: 'rename', id: 'Y', name: 'Big shield' }] });
    expect((await call('save')).text).toBe('Мод новый: укажите path');
    const inGame = join(fx.game, 'mods', 'Fresh', 'Fresh.mod');
    expect((await call('save', { path: inGame })).isError).toBe(true);
    expect(existsSync(inGame)).toBe(false);
    expect((await call('save', { path: inGame, force: true })).isError).toBe(false);
    expect(readDataFileSync(inGame).records.map((r) => r.stringId)).toEqual(['Y']);
  });
});
