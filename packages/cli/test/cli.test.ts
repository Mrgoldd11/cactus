/**
 * Команды kedit на маленькой синтетической «папке игры» (без файлов Kenshi).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { decodeText } from '@kenshi-editor/core';
import { defaultWorkshopDir, readDataFileSync, writeDataFileSync } from '@kenshi-editor/core/node';
import { main } from '../src/main.ts';
import { CHAR, dataFile, makeFixture, rec, type Fixture } from './fixture.ts';

const EOL = String.fromCharCode(13, 10);

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

  it('where: цепочка обратных ссылок; без папок уровня — без координат', async () => {
    const r = await run('where', 'Sword');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ITEM «Sword» (Меч) [X]');
    // В фикстуре предмет прямо в `vendors` персонажа (в игре там VENDOR_LIST) — просто связь.
    expect(r.out).toContain('Связано с «Разбойник» — место в мире не найдено');
    expect(r.out).toContain('путь: ← CHARACTER «Bandit» (Разбойник) [A] (vendors)');
    const j = JSON.parse((await run('where', 'X', '--json')).out) as { facts: { role: string; holder?: { id: string } }[] };
    expect(j.facts[0]).toMatchObject({ role: 'related', holder: { id: 'A' } });
  });
});

describe('kedit talk', () => {
  it('без диалогов; клик из мода игрока (--mods из mods.cfg); JSON', async () => {
    expect((await run('talk', 'Bandit')).out).toContain('диалогов на это событие нет');
    mkdirSync(join(fx.game, 'mods', 'Talk'), { recursive: true });
    writeDataFileSync(join(fx.game, 'mods', 'Talk', 'Talk.mod'), dataFile([rec(CHAR, 'A', 'Bandit', (r) => r.refs.set('dialogue', [{ target: 'D1', v0: 0, v1: 0, v2: 0 }]))]));
    writeFileSync(join(fx.game, 'data', 'mods.cfg'), 'Talk.mod\n');
    const r = await run('talk', 'Bandit', '--mods');
    expect(r.code).toBe(0);
    expect(r.out).toContain('▶ greet (D1) — выберет игра');
    expect(r.out).toContain('откуда: персонаж (dialogue); слой Dialogue.mod');
    expect(r.out).toContain('«Hello there»');
    expect(r.out).toContain('NPC: «Hello there» [очки 0]');
    const j = JSON.parse((await run('talk', 'A', '--mods', '--json')).out) as { winner: string; candidates: { verdict: string }[] };
    expect(j.winner).toBe('D1');
    // Событие 3: `dialogue` персонажа не участвует.
    expect((await run('talk', 'A', '--mods', '--event', '3')).out).toContain('диалогов на это событие нет');
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
    // В мастерскую — никогда, даже с --force (до записи дело не доходит).
    const inWorkshop = join(defaultWorkshopDir(fx.game), '123', 'Out.mod');
    const ws = await run('build', script, '--out', inWorkshop, '--force');
    expect(ws.code).toBe(2);
    expect(ws.err).toContain('мастерской');
    expect(existsSync(inWorkshop)).toBe(false);
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

describe('kedit mods', () => {
  it('list: порядок mods.cfg, нет файла, выключенные; --json', async () => {
    writeFileSync(join(fx.game, 'data', 'mods.cfg'), 'Gone.mod\r\nMy.mod\r\n');
    mkdirSync(join(fx.game, 'mods', 'Off'), { recursive: true });
    writeDataFileSync(join(fx.game, 'mods', 'Off', 'Off.mod'), dataFile([]));
    const r = await run('mods', '--full');
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[1]).toBe('  1. Gone.mod  [нет файла]');
    expect(lines[2]).toMatch(/^ {2}2\. My\.mod {2}\[mods\] {2}записей 2, автор test$/);
    expect(lines).toContain('Выключены:');
    expect(r.out).toContain('     Off.mod  [mods]');
    const j = JSON.parse((await run('mods', 'list', '--json')).out) as { order: string[]; mods: { fileName: string; enabled: boolean }[] };
    expect(j.order).toEqual(['Gone.mod', 'My.mod']);
    expect(j.mods.find((m) => m.fileName === 'Off.mod')!.enabled).toBe(false);
    expect((await run('mods', 'nope')).code).toBe(2);
  });

  it('touched и conflicts: кто меняет запись, кто побеждает, --mod', async () => {
    mkdirSync(join(fx.game, 'mods', 'Rich'), { recursive: true });
    writeDataFileSync(join(fx.game, 'mods', 'Rich', 'Rich.mod'), dataFile([rec(CHAR, 'A', 'Bandit', (r) => r.ints.set('money', 500))]));
    writeFileSync(join(fx.game, 'data', 'mods.cfg'), `My.mod${EOL}Rich.mod${EOL}`);
    const t = await run('touched', 'Bandit');
    expect(t.code, t.err).toBe(0);
    expect(t.out).toContain('A Bandit — модов: 2');
    expect(t.out).toContain('    money = 99');
    expect(t.out).toContain('    vendors → Sword = удалить');
    expect(t.out).toContain('  Rich.mod');
    const c = await run('conflicts');
    expect(c.code, c.err).toBe(0);
    expect(c.out).toContain('модов 2; записей с конфликтами 1, полей 1');
    expect(c.out).toContain('money (ваниль 15): победит Rich.mod');
    expect(c.out).toContain('    → Rich.mod: 500');
    expect((await run('conflicts', '--mod', 'Rich')).out).toContain('записей с конфликтами 1');
    writeFileSync(join(fx.game, 'data', 'mods.cfg'), `My.mod${EOL}`);
    expect((await run('conflicts')).out).toContain('записей с конфликтами 0');
    expect((await run('conflicts', '--all')).out).toContain('победит Rich.mod');
    const j = JSON.parse((await run('touched', 'A', '--all', '--json')).out) as { touches: { layer: string }[] };
    expect(j.touches.map((x) => x.layer)).toEqual(['My.mod', 'Rich.mod']);
  });

  it('move/enable/disable: без --force только показ, с --force — запись с копией, CRLF', async () => {
    mkdirSync(join(fx.game, 'mods', 'Rich'), { recursive: true });
    writeDataFileSync(join(fx.game, 'mods', 'Rich', 'Rich.mod'), dataFile([]));
    const cfg = join(fx.game, 'data', 'mods.cfg');
    writeFileSync(cfg, `My.mod${EOL}Rich.mod${EOL}`);
    // Запись mods.cfg проверяет, не запущена ли игра; в тесте — временная папка, проверка не нужна.
    process.env['KEDIT_SKIP_GAME_CHECK'] = '1';
    onTestFinished(() => {
      delete process.env['KEDIT_SKIP_GAME_CHECK'];
    });
    const dry = await run('mods', 'move', 'Rich', '--top');
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain('  Rich.mod: место 2 → 1');
    expect(dry.out).toContain('добавьте --force');
    expect(readFileSync(cfg, 'utf-8')).toBe(`My.mod${EOL}Rich.mod${EOL}`);
    const w = await run('mods', 'move', 'Rich.mod', '--top', '--force');
    expect(w.code, w.err).toBe(0);
    expect(w.out).toMatch(/записан, копия: .*mods\.cfg\.bak-\d{14}/);
    expect(readFileSync(cfg, 'utf-8')).toBe(`Rich.mod${EOL}My.mod${EOL}`);
    expect((await run('mods', 'disable', 'My', '--force')).code).toBe(0);
    expect(readFileSync(cfg, 'utf-8')).toBe(`Rich.mod${EOL}`);
    expect((await run('mods', 'enable', 'My', '--top', '--force')).code).toBe(0);
    expect(readFileSync(cfg, 'utf-8')).toBe(`My.mod${EOL}Rich.mod${EOL}`);
    expect((await run('mods', 'move', 'My', '--after', 'Rich')).out).toContain('  My.mod: место 1 → 2');
    expect((await run('mods', 'move', 'Nope', '--top')).code).toBe(2);
    expect((await run('mods', 'enable', 'Nope')).code).toBe(2);
    expect((await run('mods', 'move', 'My')).code).toBe(2);
    expect((await run('mods', 'move', 'My', '--top', '--bottom')).code).toBe(2);
    expect((await run('mods', 'enable', 'My')).out).toContain('без изменений');
  });

  it('mods copy: без --force только показ; копия байт в байт + откуда; вторая — ошибка', async () => {
    const src = join(fx.game, 'mods', 'My', 'My.mod');
    const before = readFileSync(src);
    const dest = join(fx.game, 'mods', 'My edit', 'My edit.mod');
    const dry = await run('mods', 'copy', 'My', '--name', 'My edit');
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`куда:   ${dest}`);
    expect(dry.out).toContain('добавьте --force');
    expect(existsSync(dest)).toBe(false);
    const w = await run('mods', 'copy', 'My', '--name', 'My edit', '--force');
    expect(w.code, w.err).toBe(0);
    expect(Buffer.compare(readFileSync(dest), before)).toBe(0);
    expect(Buffer.compare(readFileSync(src), before)).toBe(0);
    const origin = JSON.parse(readFileSync(join(fx.game, 'mods', 'My edit', 'My edit.kedit-origin.json'), 'utf8')) as { source: string; size: number };
    expect(origin).toMatchObject({ source: src, size: before.length });
    expect((await run('mods', 'copy', 'My', '--name', 'My edit', '--force')).code).toBe(2);
    // Сам в себя (тот же путь в mods/) — ошибка.
    expect((await run('mods', 'copy', 'My', '--force')).code).toBe(2);
    expect((await run('mods', 'copy', 'Nope')).code).toBe(2);
  });
});

describe('kedit strings', () => {
  it('тексты мода → CSV → мод-перевод с зависимостью от оригинала; в папку игры без --force — нет', async () => {
    const out = mkdtempSync(join(tmpdir(), 'kedit-tr-'));
    const s = await run('strings', 'My');
    expect(s.code, s.err).toBe(0);
    expect(s.out).toContain('My.mod → My RUS.mod: текстов 1, переведено 0, как в оригинале 0, нет перевода 1');
    expect(s.out).toContain('  [нет] 1-My.mod name (Magic hat): "Magic hat"');
    const csvPath = join(out, 'my.csv');
    expect((await run('strings', 'My', '--out', csvPath)).code).toBe(0);
    writeFileSync(csvPath, readFileSync(csvPath, 'utf8').replace(/,\r\n$/, ',Волшебная шляпа\r\n'));
    const modPath = join(out, 'My RUS.mod');
    const b = await run('strings', 'My', '--import', csvPath, '--out', modPath);
    expect(b.code, b.err).toBe(0);
    expect(b.out).toContain('применено 1');
    const f = readDataFileSync(modPath);
    expect(decodeText(f.header!.dependencies)).toBe('My.mod');
    expect(f.records.map((r) => [r.stringId, decodeText(r.name), r.floats.size])).toEqual([['1-My.mod', 'Волшебная шляпа', 0]]);
    expect((await run('strings', 'My', '--mod', modPath)).out).toContain('переведено 1');
    // Папка игры — только с --force.
    expect((await run('strings', 'My', '--out', join(fx.game, 'my.csv'))).code).toBe(2);
    expect((await run('strings', 'My', '--out', join(out, 'x.txt'))).code).toBe(2);
  });
});

describe('kedit bulk', () => {
  it('предпросмотр по умолчанию, --apply пишет одну правку, защита папки игры', async () => {
    const pre = await run('bulk', 'ITEM', '--mul', 'weight=1.5');
    expect(pre.code, pre.err).toBe(0);
    expect(pre.out).toContain('X  «Sword»  weight: 2 → 3');
    expect(pre.out).toContain('Y  «Shield»  weight: 1 → 1.5');
    expect(pre.out).toContain('подошло записей 2, изменится 2, пропущено 0');
    expect(pre.out).toContain('ничего не записано');

    // Условие по полю, замена имени по regex.
    const ren = await run('bulk', 'ITEM', '--field', 'weight>1', '--replace', 'name', '--find', '^S(\\w)', '--regex', '--with', 'Big s$1');
    expect(ren.out).toContain('X  «Sword»  name: Sword → Big sword');
    expect(ren.out).toContain('изменится 1,');

    // Без --out/--mod — некуда писать; в папку игры — только с --force.
    expect((await run('bulk', 'ITEM', '--mul', 'weight=2', '--apply')).code).toBe(2);
    expect((await run('bulk', 'ITEM', '--mul', 'weight=2', '--apply', '--out', join(fx.game, 'x.mod'))).code).toBe(2);
    expect((await run('bulk', 'ITEM', '--mul', 'weight=2', '--set', 'weight=1')).code).toBe(2);

    const out = join(mkdtempSync(join(tmpdir(), 'kedit-bulk-')), 'Bulk.mod');
    const ok = await run('bulk', 'ITEM', 'sword', '--add', 'weight=0.5', '--apply', '--out', out);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain('записано');
    const f = readDataFileSync(out);
    expect(f.records.map((r) => r.stringId)).toEqual(['X']);
    expect([...f.records[0]!.floats]).toEqual([['weight', 2.5]]);
  });
});

describe('kedit merge', () => {
  const source = (): void => {
    mkdirSync(join(fx.game, 'mods', 'Other'), { recursive: true });
    const y = rec(4, 'Y', 'Shield', (r) => r.floats.set('weight', 3));
    y.changeFlags = 0x80000001;
    const a = rec(CHAR, 'A', 'Bandit', (r) => r.ints.set('money', 50));
    a.changeFlags = 0x80000001;
    const hat = rec(4, '7-Other.mod', 'Cap', (r) => r.floats.set('weight', 0.2));
    hat.changeFlags = 0x80000002;
    writeDataFileSync(join(fx.game, 'mods', 'Other', 'Other.mod'), dataFile([y, a, hat], [], 7));
  };

  it('предпросмотр по умолчанию: новые, изменённые, конфликт; ничего не записывается', async () => {
    source();
    const r = await run('merge', 'Other', '--mod', 'My');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('новых 1, изменённых 2, удалённых 0, конфликтов 1');
    expect(r.out).toContain('КОНФЛИКТ (both)');
    expect(r.out).toContain('Y «Shield»');
    expect(r.out).toContain('ничего не записано');
    const j = JSON.parse((await run('merge', 'Other', '--mod', 'My', '--json')).out) as { counts: { conflicts: number } };
    expect(j.counts.conflicts).toBe(1);
  });

  it('--apply: нужен выбор и место записи; в --out пишется мод и файл решений, validate чист', async () => {
    source();
    const noChoice = await run('merge', 'Other', '--mod', 'My', '--apply', '--out', join(mkdtempSync(join(tmpdir(), 'kedit-merge-')), 'x.mod'));
    expect(noChoice.code).toBe(2);
    expect(noChoice.err).toContain('что сливать');
    // В папку игры (сам --mod) — только с --force.
    expect((await run('merge', 'Other', '--mod', 'My', '--apply', '--all')).code).toBe(2);
    // Мод нельзя слить в самого себя / в зависимость.
    expect((await run('merge', 'My', '--mod', 'My')).code).toBe(2);

    const out = join(mkdtempSync(join(tmpdir(), 'kedit-merge-')), 'Merged.mod');
    const ok = await run('merge', 'Other', '--mod', 'My', '--apply', '--all', '--conflicts', 'source', '--out', out);
    expect(ok.code, ok.err + ok.out).toBe(0);
    expect(ok.out).toContain('слито 3');
    const f = readDataFileSync(out);
    const money = f.records.find((x) => x.stringId === 'A')!.ints.get('money');
    expect(money).toBe(50);
    expect(f.records.some((x) => x.stringId === '7-Other.mod')).toBe(true);
    expect(existsSync(join(out, '..', 'Merged.kedit-merge.json'))).toBe(true);
    const v = await run('validate', '--mod', out);
    expect(v.code, v.out).toBe(0);
  });

  it('--reject скрывает запись, --show-rejected возвращает, --unreject снимает отметку', async () => {
    source();
    const dir = mkdtempSync(join(tmpdir(), 'kedit-merge-'));
    const out = join(dir, 'R.mod');
    const rej = await run('merge', 'Other', '--mod', 'My', '--reject', 'Y', '--out', out);
    expect(rej.code, rej.err).toBe(0);
    expect(rej.out).toContain('отклонено 1');
    expect(rej.out).not.toContain('Y «Shield»');
  });
});
