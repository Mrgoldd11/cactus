/**
 * MCP-сервер через клиент SDK в памяти, на синтетической «папке игры» из тестов CLI.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeText } from '@kenshi-editor/core';
import { defaultWorkshopDir, readDataFileSync, writeDataFileSync } from '@kenshi-editor/core/node';
import { createServer, Session } from '../src/index.ts';
import { CHAR, dataFile, makeFixture, rec, type Fixture } from '../../cli/test/fixture.ts';

const EOL = String.fromCharCode(13, 10);

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
      expect.arrayContaining(['open_mod', 'find', 'show', 'tree', 'refs', 'where', 'inspect', 'talk', 'diff', 'validate', 'edit', 'undo', 'redo', 'history', 'play', 'save', 'schema', 'touched', 'conflicts', 'merge']),
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
    expect(open.text).toContain('records 2 (changed 1, new 1)');
    expect((await call('find', { text: 'разбой' })).text).toBe('A  CHARACTER  «Bandit» (Разбойник)  [changed]');
    const paged = await call('find', { type: 'ITEM', limit: 1 });
    expect(paged.text).toContain('дальше offset=1');
    expect((await call('find', { fields: ['weight<1'] })).text).toContain('1-My.mod  ITEM  «Magic hat»');
    const show = await call('show', { id: 'A', layers: true });
    expect(show.text).toContain('int money = 99');
    expect(show.text).toContain('→ Magic hat [1-My.mod]  3 0 0');
    expect((await call('refs', { id: '1-My.mod', direction: 'to' })).text).toBe('← Bandit [A] vendors  3 0 0');
    expect((await call('where', { id: '1-My.mod' })).text).toContain('путь: ← CHARACTER «Bandit» (Разбойник) [A] (vendors)');
    expect((await call('tree', { id: 'D1' })).text).toContain('↻ DIALOGUE_LINE L1');
    const inside = (await call('inspect', { id: 'Bandit' })).text;
    expect(inside).toContain('CHARACTER «Bandit» (Разбойник) [A]');
    expect(inside).toContain('vendors (1):');
    expect(inside).toContain('ITEM «Magic hat» [1-My.mod]');
    expect((await call('inspect', { id: '1-My.mod' })).text).toContain('CHARACTER «Bandit» (Разбойник) [A]');
    expect((await call('talk', { id: 'Bandit' })).text).toContain('Разбойник (A), событие');
    expect((await call('talk', { id: 'Bandit' })).text).toContain('диалогов на это событие нет');
    expect((await call('talk', { id: 'D1' })).isError).toBe(true);
    const missing = await call('show', { id: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe('No record "nope" (neither an id nor a name)');
  });

  it('diff и validate', async () => {
    await call('open_mod', { mod: 'My' });
    const diff = await call('diff');
    expect(diff.text).toContain('~ int money: 15 → 99');
    expect(diff.text).toContain('+ ITEM 1-My.mod «Magic hat»');
    expect(diff.text).toContain('всего 2: новых 1, изменённых 1, удалённых 0');
    const changed = await call('diff', { status: ['changed'] });
    expect(changed.text).not.toContain('+ ITEM 1-My.mod');
    expect(changed.text).toContain('shown: changed');
    expect((await call('show', { id: 'Разбойник' })).text).toContain('int money = 99');
    const many = await call('show', { id: 'S' });
    expect(many.isError).toBe(true);
    expect(many.text).toContain('records match');
    expect((await call('validate')).text).toBe('errors 0, warnings 0');
  });

  it('схема: инструмент и ресурсы', async () => {
    expect((await call('schema')).text).toContain('CHARACTER  fields 2, references 1');
    expect((await call('schema', { type: 'item' })).text).toContain('kind: enum Kind = TOOL');
    expect((await call('schema', { enum: 'Kind' })).text).toContain('FOOD = 1');
    expect((await call('schema', { enum: 'Nope' })).isError).toBe(true);
    const type = await client.readResource({ uri: 'kenshi://schema/type/CHARACTER' });
    expect((type.contents[0] as { text: string }).text).toContain('money: int = 0 — how much money');
    const en = await client.readResource({ uri: 'kenshi://schema/enum/Kind' });
    expect((en.contents[0] as { text: string }).text).toContain('TOOL = 0');
  });

  it('the schema follows the opened mod: a schema extension in its folder adds a type and fields', async () => {
    writeFileSync(
      join(fx.game, 'mods', 'My', 'fcs.def'),
      ['// enum itemType { COUNTER=900 }', '[COUNTER]', 'amount:  0 "how much"', '', '[ITEM]', 'charges:  3 "from the extension"'].join(EOL),
    );
    // No mod is opened: the schema of the game alone.
    expect((await call('schema', { type: 'counter' })).isError).toBe(true);
    expect((await call('schema', { type: 'item' })).text).not.toContain('charges');

    expect((await call('schema')).text).not.toContain('extension');

    // open_mod says what the extension adds; a DLL plugin is named but not run.
    writeFileSync(join(fx.game, 'mods', 'My', 'FCS_extended.json'), '{ "FCS_Plugins": ["My_FCS.dll"] }');
    const opened = (await call('open_mod', { mod: 'My' })).text;
    expect(opened).toContain('schema extension My: types COUNTER=900; fields ITEM.charges');
    expect(opened).toContain('DLL plugins of FCS Extended, not run here: My_FCS.dll');
    expect((await call('schema', { type: 'counter' })).text).toContain('[COUNTER] — полей 1 [extension My]');
    expect((await call('schema', { type: 'counter' })).text).toContain('amount: int = 0 — how much');
    expect((await call('schema', { type: 'item' })).text).toContain('charges: int = 3 [extension My] — from the extension');
    // The type list starts with the extensions and marks their types and fields.
    const list = (await call('schema')).text;
    expect(list.split('\n')[0]).toBe('schema extension My: types COUNTER=900; fields ITEM.charges');
    expect(list).toContain('COUNTER  fields 1, references 0 [extension My]');
    expect(list).toMatch(/ITEM {2}fields \d+, references \d+ \[1 from extensions\]/);
    expect((await call('schema', { extension: 'my' })).text).toBe('schema extension My: types COUNTER=900; fields ITEM.charges');
    const none = await call('schema', { extension: 'Nope' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('No schema extension Nope; applied: My');
    const type = await client.readResource({ uri: 'kenshi://schema/type/COUNTER' });
    expect((type.contents[0] as { text: string }).text).toContain('amount: int = 0');
    const edit = await call('edit', { ops: [{ op: 'create', type: 'COUNTER', name: 'Days passed' }] });
    expect(edit.isError).toBe(false);
    expect((await call('find', { type: 'COUNTER' })).text).toContain('COUNTER  «Days passed»');

    // Another mod has no extension: its schema is the game's again.
    const other = await call('open_mod', { name: 'Other.mod' });
    expect(other.text).not.toContain('schema extension');
    expect((await call('schema', { type: 'counter' })).isError).toBe(true);
    expect((await call('schema', { extension: 'My' })).text).toContain('the opened mod has no schema extensions');
  });
});

describe('kenshi-mcp: конфликты модов', () => {
  it('touched и conflicts: моды mods.cfg и открытый мод с несохранёнными правками', async () => {
    mkdirSync(join(fx.game, 'mods', 'Rich'), { recursive: true });
    writeDataFileSync(join(fx.game, 'mods', 'Rich', 'Rich.mod'), dataFile([rec(CHAR, 'A', 'Bandit', (r) => r.ints.set('money', 500))]));
    writeFileSync(join(fx.game, 'data', 'mods.cfg'), `Rich.mod${EOL}My.mod${EOL}`);
    expect((await call('touched', { id: 'Bandit' })).text).toContain('A Bandit — mods: 2');
    const all = await call('conflicts');
    expect(all.text).toContain('money (ваниль 15): победит My.mod');
    expect((await call('conflicts', { mod_only: true })).isError).toBe(true);
    await call('open_mod', { mod: 'My' });
    await call('edit', { ops: [{ op: 'set', id: 'A', field: 'money', value: 500 }] });
    // Несохранённая правка открытого мода: значения совпали — конфликта нет.
    expect((await call('conflicts', { mod_only: true })).text).toContain('records with conflicts 0');
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
    expect(edit.text).toContain('aliases: $p = 2-My.mod');
    expect(edit.text).toContain('#1 кирка');
    expect(edit.text).toContain('+ ITEM 2-My.mod «Pick»');
    expect((await call('undo')).text).toBe('undone:\n  #1 кирка');
    expect((await call('find', { text: 'pick' })).text).toBe('ничего не найдено');
    expect((await call('redo')).text).toBe('redone:\n  #1 кирка');
    const hist = await call('history');
    expect(hist.text).toContain('#1 кирка');
    expect(hist.text).toContain('there are unsaved changes');

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
    expect(saved.text).toContain('records 3 (changed 1, new 2)');
    const f = readDataFileSync(out);
    expect(f.records.map((r) => decodeText(r.name))).toEqual(['Bandit', 'Magic hat', 'Pick']);
    expect((await call('history')).text).toContain('everything is saved');
  });

  it('bulk: предпросмотр ничего не меняет, apply — одна правка', async () => {
    const pre = await call('bulk', { type: 'ITEM', op: 'mul', field: 'weight', value: '2' });
    expect(pre.isError, pre.text).toBe(false);
    expect(pre.text).toContain('X  «Sword»  weight: 2 → 4');
    expect(pre.text).toContain('preview: nothing changed');
    expect((await call('history')).text).not.toContain('#1');
    const bad = await call('bulk', { type: 'ITEM', op: 'replace', field: 'name', value: 'x', find: '(', regex: true });
    expect(bad.isError).toBe(true);
    const ok = await call('bulk', { type: 'ITEM', fields: ['weight>1'], op: 'replace', field: 'name', find: 'sword', value: 'Sabre', apply: true });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).toContain('X  «Sword»  name: Sword → Sabre');
    expect(ok.text).toContain('applied: #1');
    expect((await call('undo')).text).toContain('undone:');
    expect((await call('find', { text: 'sabre' })).text).toBe('ничего не найдено');
  });

  it('merge: предпросмотр, слияние одной правкой, undo, save пишет мод и файл решений', async () => {
    mkdirSync(join(fx.game, 'mods', 'Other'), { recursive: true });
    const y = rec(4, 'Y', 'Shield', (r) => r.floats.set('weight', 3));
    y.changeFlags = 0x80000001;
    const a = rec(CHAR, 'A', 'Bandit', (r) => r.ints.set('money', 50));
    a.changeFlags = 0x80000001;
    writeDataFileSync(join(fx.game, 'mods', 'Other', 'Other.mod'), dataFile([y, a], [], 0));
    await call('open_mod', { mod: 'My' });
    const pre = await call('merge', { source: 'Other' });
    expect(pre.isError, pre.text).toBe(false);
    expect(pre.text).toContain('изменённых 2, удалённых 0, конфликтов 1');
    expect(pre.text).toContain('preview: nothing changed');
    expect((await call('history')).text).not.toContain('#1');
    // Без выбора слить нельзя; сам себя и неизвестный источник — понятная ошибка.
    expect((await call('merge', { source: 'Other', apply: true })).isError).toBe(true);
    expect((await call('merge', { source: 'My' })).text).toContain('into itself');
    expect((await call('merge', { source: 'Нет-такого' })).isError).toBe(true);

    const ok = await call('merge', { source: 'Other', apply: true, all: true, conflicts: 'source' });
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.text).toContain('слито 2');
    expect(ok.text).toContain('applied: #1');
    expect((await call('show', { id: 'A' })).text).toContain('int money = 50');
    expect((await call('merge', { source: 'Other' })).text).toContain('уже слито 2');
    expect((await call('undo')).text).toContain('undone:');
    expect((await call('merge', { source: 'Other' })).text).toContain('изменённых 2');
    await call('merge', { source: 'Other', apply: true, ids: ['Y'] });

    const out = join(fx.game, 'merged', 'My2.mod');
    const saved = await call('save', { path: out, force: true });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.text).toContain('merge decisions');
    expect(existsSync(join(fx.game, 'merged', 'My2.kedit-merge.json'))).toBe(true);
    expect(readDataFileSync(out).records.map((r) => r.stringId)).toContain('Y');
  });

  it('новый мод: save требует путь; force пишет в mods/', async () => {
    await call('open_mod', { name: 'Fresh.mod' });
    await call('edit', { ops: [{ op: 'rename', id: 'Y', name: 'Big shield' }] });
    expect((await call('save')).text).toBe('The mod is new: give a path');
    const inGame = join(fx.game, 'mods', 'Fresh', 'Fresh.mod');
    expect((await call('save', { path: inGame })).isError).toBe(true);
    expect(existsSync(inGame)).toBe(false);
    expect((await call('save', { path: inGame, force: true })).isError).toBe(false);
    expect(readDataFileSync(inGame).records.map((r) => r.stringId)).toEqual(['Y']);
    // Мастерская — никогда, даже с force.
    const inWorkshop = join(defaultWorkshopDir(fx.game), '123', 'Fresh.mod');
    const ws = await call('save', { path: inWorkshop, force: true });
    expect(ws.isError).toBe(true);
    expect(ws.text).toContain('Workshop');
    expect(existsSync(inWorkshop)).toBe(false);
  });
});

describe('kenshi-mcp: граф диалога и история', () => {
  it('операции графа, понятные шаги истории, undo/redo до шага', async () => {
    await call('open_mod', { name: 'Talk.mod' });
    const r1 = await call('edit', { ops: [{ op: 'addLine', parent: 'L1', speaker: 'player', text: 'Да', as: '$a' }] });
    expect(r1.isError, r1.text).toBe(false);
    const r2 = await call('edit', { ops: [{ op: 'insertLine', parent: 'L1', child: 'L2', text: 'Подожди', as: '$m' }] });
    expect(r2.isError, r2.text).toBe(false);
    const tree = (await call('tree', { id: 'D1' })).text;
    expect(tree).toContain('Да');
    expect(tree).toContain('Подожди');
    const sid = /\$m = (\S+)/.exec(r2.text)?.[1];
    expect(sid).toBeTruthy();
    const r3 = await call('edit', { ops: [{ op: 'setText', id: sid, text: 'Стой' }, { op: 'duplicateLine', id: sid, as: '$c' }] });
    expect(r3.isError, r3.text).toBe(false);
    const r4 = await call('edit', { ops: [{ op: 'unlink', parent: 'L1', child: sid }] });
    expect(r4.isError, r4.text).toBe(false);
    const bad = await call('edit', { ops: [{ op: 'addLine', parent: 'L1', speaker: 'T_NOPE' }] });
    expect(bad.isError).toBe(true);

    const hist = (await call('history')).text;
    expect(hist).toContain('#1 Added player answer „Да“');
    expect(hist).toContain('#2 Inserted player answer „Подожди“ between lines');
    expect(hist).toContain('#0 the mod as it was opened');
    expect(hist).toMatch(/#4 .*← you are here/);
    expect(hist).not.toMatch(/правок$/m);

    const back = await call('undo', { to: 2 });
    expect(back.text.split('\n')).toHaveLength(4);
    expect((await call('tree', { id: 'D1' })).text).not.toContain('Подожди');
    const h2 = (await call('history')).text;
    expect(h2).toMatch(/#1 .*← you are here/);
    expect(h2).toContain('undone (redo brings them back):');
    expect((await call('redo', { to: 3 })).text.split('\n')).toHaveLength(3);
    expect((await call('tree', { id: 'D1' })).text).toContain('Стой');
    await call('undo', { to: 0 });
    expect((await call('history')).text).toMatch(/#0 the mod as it was opened\s+← you are here|no edits/);
    expect((await call('tree', { id: 'D1' })).text).not.toContain('Да');
  });

  it('play: проигрыватель разговора', async () => {
    const r = await call('play', { id: 'Bandit' });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain('Разбойник (A), событие 1');
    expect((await call('play', { id: 'D1' })).isError).toBe(true);
  });
});
