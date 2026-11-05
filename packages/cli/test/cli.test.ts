/**
 * Команды kedit на маленькой синтетической «папке игры» (без файлов Kenshi).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeText } from '@kenshi-editor/core';
import { readDataFileSync } from '@kenshi-editor/core/node';
import { main } from '../src/main.ts';
import { makeFixture, type Fixture } from './fixture.ts';

let fx: Fixture;
const run = async (...argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  fx.io.lines.length = 0;
  fx.io.errors.length = 0;
  const code = await main([argv[0]!, '--game', fx.game, ...argv.slice(1)], fx.io);
  return { code, out: fx.io.lines.join('\n'), err: fx.io.errors.join('\n') };
};

beforeEach(() => {
  fx = makeFixture();
});

describe('kedit: поиск и просмотр', () => {
  it('find: по-русски, по типу номером (как kdata.py), по полю, страницами, JSON', async () => {
    expect((await run('find', 'разбой')).out).toContain('A  CHARACTER  «Bandit» (Разбойник)');
    const items = await run('find', '', '4');
    expect(items.out.split('\n')).toEqual(['X  ITEM  «Sword» (Меч)', 'Y  ITEM  «Shield»']);
    expect((await run('find', '--field', 'weight>1')).out).toBe('X  ITEM  «Sword» (Меч)');
    const paged = await run('find', '--limit', '1');
    expect(paged.out).toContain('дальше offset=1');
    const json = JSON.parse((await run('find', 'sword', '--json')).out) as { total: number; items: { stringId: string }[] };
    expect(json.total).toBe(1);
    expect(json.items[0]!.stringId).toBe('X');
    expect((await run('find', 'hat', '--mod', 'My', '--status', 'new')).out).toContain('1-My.mod  ITEM  «Magic hat»  [new]');
  });

  it('show: итог слоёв, ссылки с именами, слои; нет записи — код 2', async () => {
    const r = await run('show', 'A', '--mod', 'My', '--layers');
    expect(r.out).toContain('CHARACTER A «Bandit» (Разбойник) — changed');
    expect(r.out).toContain('слои: gamedata.base → rebirth.mod → My.mod');
    expect(r.out).toContain('int money = 99');
    expect(r.out).toContain('→ Magic hat [1-My.mod]  3 0 0');
    expect(r.out).not.toContain('Sword [X]');
    expect((await run('show', 'A')).out).toContain('int money = 15');
    const j = JSON.parse((await run('show', 'A', '--json')).out) as { refs: Record<string, { name: string }[]> };
    expect(j.refs['vendors']![0]!.name).toBe('Sword');
    expect((await run('show', 'nope')).code).toBe(2);
  });

  it('tree: цикл не разворачивается; --full — все поля', async () => {
    const r = await run('tree', 'D1');
    expect(r.out.split('\n')).toEqual([
      'DIALOGUE D1 «greet»',
      '  DIALOGUE_LINE L1 «DIALOGUE_LINE»',
      '    "Hello there"',
      '    DIALOGUE_LINE L2 «DIALOGUE_LINE»',
      '      "Bye"',
      '      ↻ DIALOGUE_LINE L1 «DIALOGUE_LINE» (уже выше)',
    ]);
    expect((await run('tree', 'D1', '--full')).out).toContain('str text0 = "Hello there"');
  });

  it('mod: записи файла, фильтр по подстроке, кратко', async () => {
    const r = await run('mod', fx.modPath, '--brief');
    expect(r.out.split('\n')).toEqual(['CHARACTER A «Bandit» (Разбойник) — changed', 'ITEM 1-My.mod «Magic hat» — new']);
    expect((await run('mod', 'My.mod', 'magic')).out).toContain('float weight = 0.5');
    // В файле мода — маркер снятия ссылки на X.
    expect((await run('mod', 'My', 'bandit')).out).toContain('→ Sword [X]  удалить');
  });

  it('refs: из записи и на неё', async () => {
    const to = await run('refs', '1-My.mod', '--mod', 'My', '--to');
    expect(to.out).toBe('← Bandit [A] vendors  3 0 0');
    expect((await run('refs', 'A', '--from')).out).toBe('→ vendors: Sword [X]  1 0 0');
  });
});

describe('kedit: разница, проверка, схема', () => {
  it('diff мода и двух файлов', async () => {
    const r = await run('diff', '--mod', 'My');
    expect(r.out).toContain('~ CHARACTER A «Bandit»');
    expect(r.out).toContain('~ int money: 15 → 99');
    expect(r.out).toContain('− ref vendors → Sword [X]');
    expect(r.out).toContain('+ ITEM 1-My.mod «Magic hat»');
    const two = await run('diff', join(fx.game, 'data', 'gamedata.base'), join(fx.game, 'data', 'rebirth.mod'));
    expect(two.out).toContain('~ int money: 10 → 15');
  });

  it('validate: код 1 при битой ссылке', async () => {
    expect((await run('validate', '--mod', 'My')).code).toBe(0);
    const f = readDataFileSync(fx.modPath);
    f.records[0]!.refs.get('vendors')!.push({ target: 'ghost', v0: 1, v1: 0, v2: 0 });
    writeFileSync(fx.modPath, (await import('@kenshi-editor/core')).writeDataFile(f));
    const r = await run('validate', 'My');
    expect(r.code).toBe(1);
    expect(r.out).toContain('broken-ref A');
  });

  it('schema: типы, поля с описанием, перечисление', async () => {
    expect((await run('schema')).out).toContain('CHARACTER  полей 2, ссылок 1');
    expect((await run('schema', 'character')).out).toContain('money: int = 0 — how much money');
    expect((await run('schema', '--enum', 'Kind')).out).toContain('FOOD = 1');
  });

  it('ошибки использования — код 2', async () => {
    expect((await run('bogus')).code).toBe(2);
    expect((await run('find', '--nope')).code).toBe(2);
    expect((await run('help')).out).toContain('kedit');
  });
});

describe('kedit build', () => {
  it('JSON-план поверх мода: пишет только изменения', async () => {
    const plan = join(fx.game, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        mod: 'mods/My/My.mod',
        info: { author: 'kedit' },
        ops: [
          { op: 'create', type: 'ITEM', name: 'Pick', as: '$p' },
          { op: 'set', id: '$p', field: 'weight', value: 3 },
          { op: 'addRef', id: 'A', category: 'vendors', target: '$p' },
        ],
      }),
    );
    const out = join(fx.game, '..', `kedit-out-${Date.now()}.mod`);
    const r = await run('build', plan, '--out', out);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/записей 3 \(changed 1, new 2\)/);
    const f = readDataFileSync(out);
    expect(f.records.map((x) => decodeText(x.name))).toEqual(['Bandit', 'Magic hat', 'Pick']);
    expect(decodeText(f.header!.author)).toBe('kedit');
    // Ссылка по умолчанию из схемы: vendors: ITEM (1,0,0).
    expect(f.records[0]!.refs.get('vendors')!.at(-1)).toMatchObject({ target: '2-My.mod', v0: 1 });
  });

  it('скрипт .ts и защита папки игры', async () => {
    const script = join(fx.game, 'build.ts');
    writeFileSync(
      script,
      [
        '// Скрипт вне пакета: типы описаны на месте.',
        'type Env = { modName: string; args: string[]; open(o: object): { ctx: { renameRecord(id: string, name: string): void } } };',
        'export default (env: Env) => {',
        '  const { ctx } = env.open({ name: env.modName });',
        "  ctx.renameRecord('Y', env.args[0] ?? 'none');",
        '  return ctx;',
        '};',
      ].join('\n'),
    );
    const inGame = join(fx.game, 'mods', 'Out', 'Out.mod');
    const refused = await run('build', script, '--out', inGame);
    expect(refused.code).toBe(2);
    expect(existsSync(inGame)).toBe(false);
    const ok = await run('build', script, '--out', inGame, '--force', '--', 'Big shield');
    expect(ok.code, ok.err).toBe(0);
    const f = readDataFileSync(inGame);
    expect(f.records.map((x) => [x.stringId, decodeText(x.name)])).toEqual([['Y', 'Big shield']]);
    expect(readFileSync(inGame).length).toBeGreaterThan(0);
  });
});

describe('kedit: этап 2', () => {
  it('show/refs по имени; diff --status и итог', async () => {
    expect((await run('show', 'Sword')).out).toContain('ITEM X «Sword» (Меч)');
    expect((await run('show', 'разбойник')).out).toContain('CHARACTER A «Bandit»');
    const many = await run('show', 'S');
    expect(many.code).toBe(2);
    expect(many.err).toContain('подходит записей');
    expect((await run('refs', 'Sword')).out).toContain('Bandit');
    const added = await run('diff', '--mod', 'My', '--status', 'added');
    expect(added.out).toContain('+ ITEM 1-My.mod «Magic hat»');
    expect(added.out).not.toContain('~ CHARACTER A');
    expect(added.out).toContain('всего 2: новых 1, изменённых 1, удалённых 0; показаны: added');
  });

  it('build: env.stableId — номер по имени, ids.json рядом со скриптом, сироты', async () => {
    const script = join(fx.game, 'ids-build.ts');
    writeFileSync(
      script,
      [
        'type Env = { modName: string; args: string[]; stableId(n: string): string; open(o: object): { ctx: { createRecord(t: number, n: string, o: { stringId: string }): string } } };',
        'export default (env: Env) => {',
        '  const { ctx } = env.open({ name: env.modName });',
        '  for (const n of env.args) ctx.createRecord(4, n, { stringId: env.stableId(n) });',
        '  return ctx;',
        '};',
      ].join('\n'),
    );
    const out = join(fx.game, '..', `kedit-ids-${Date.now()}.mod`);
    const first = await run('build', script, '--out', out, '--name', 'Ids.mod', '--', 'a', 'b');
    expect(first.code, first.err).toBe(0);
    expect(first.err).toContain('ids.json: добавлено 2 id');
    const table = JSON.parse(readFileSync(join(fx.game, 'ids.json'), 'utf8')) as { next: number; ids: Record<string, number> };
    expect(table).toEqual({ next: 102, ids: { a: 100, b: 101 } });
    const second = await run('build', script, '--out', out, '--name', 'Ids.mod', '--', 'b', 'c');
    expect(second.code, second.err).toBe(0);
    expect(second.err).toContain('больше не собираются');
    expect(readDataFileSync(out).records.map((r) => r.stringId)).toEqual(['101-Ids.mod', '102-Ids.mod']);
  });
});
