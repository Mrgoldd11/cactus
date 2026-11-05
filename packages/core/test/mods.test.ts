/**
 * Установленные моды, порядок `mods.cfg`, моды контекста — на временной «папке игры».
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyModsCfgChange, describeOrderChange, emptyRecord, encodeText, FileType, itemTypeId, joinModList, formatModsCfg, parseModsCfg, placeMod, setModEnabled, type DataFile } from '../src/index.ts';
import {
  copyModForEditing,
  isInWorkshop,
  listInstalledMods,
  originChanged,
  planModCopy,
  planModLoad,
  readModOrigin,
  readModSummary,
  workshopIdOf,
  writeDataFileSync,
  writeModsCfg,
  type GamePaths,
} from '../src/node/index.ts';

const ITEM = itemTypeId('ITEM')!;

function mod(deps: string[] = [], records = 0, description = ''): DataFile {
  return {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('автор'), description: encodeText(description), dependencies: joinModList(deps), references: encodeText('') },
    lastId: records,
    records: Array.from({ length: records }, (_, i) => emptyRecord(ITEM, `${i}-x`, encodeText(`r${i}`))),
    tail: new Uint8Array(),
  };
}

function game(): GamePaths {
  const root = mkdtempSync(join(tmpdir(), 'kedit-mods-'));
  const kenshi = join(root, 'Kenshi');
  const workshop = join(root, 'workshop', '233860');
  mkdirSync(join(kenshi, 'data'), { recursive: true });
  const put = (dir: string, name: string, file: DataFile): void => {
    mkdirSync(dir, { recursive: true });
    writeDataFileSync(join(dir, name), file);
  };
  put(join(kenshi, 'mods', 'Mine'), 'Mine.mod', mod(['A.mod'], 2));
  put(join(kenshi, 'mods', 'A'), 'A.mod', mod());
  put(join(workshop, '111'), 'A.mod', mod());
  put(join(workshop, '222'), 'B.mod', mod(['A.mod'], 3, 'x'.repeat(100_000)));
  put(join(workshop, '333'), 'Off.mod', mod());
  writeFileSync(join(kenshi, 'data', 'mods.cfg'), 'A.mod\r\nGone.mod\r\n\r\nB.mod\r\nMine.mod\r\n');
  return { kenshi, workshop };
}

describe('порядок загрузки (mods.cfg) без диска', () => {
  it('разбор и запись: конец строки сохраняется, пустые строки убираются', () => {
    const crlf = parseModsCfg('A.mod\r\n\r\nB.mod\r\n');
    expect(crlf).toEqual({ names: ['A.mod', 'B.mod'], eol: '\r\n' });
    expect(formatModsCfg(crlf)).toBe('A.mod\r\nB.mod\r\n');
    expect(parseModsCfg('A.mod\nB.mod\n').eol).toBe('\n');
    expect(parseModsCfg('').eol).toBe('\r\n');
    expect(formatModsCfg({ names: [], eol: '\r\n' })).toBe('');
  });

  it('перестановка: в начало, в конец, после, перед, по номеру; регистр не важен', () => {
    const l = ['A.mod', 'B.mod', 'C.mod'];
    expect(placeMod(l, 'c.mod', { top: true })).toEqual(['C.mod', 'A.mod', 'B.mod']);
    expect(placeMod(l, 'A.mod', { bottom: true })).toEqual(['B.mod', 'C.mod', 'A.mod']);
    expect(placeMod(l, 'A.mod', { after: 'b.MOD' })).toEqual(['B.mod', 'A.mod', 'C.mod']);
    expect(placeMod(l, 'C.mod', { before: 'B.mod' })).toEqual(['A.mod', 'C.mod', 'B.mod']);
    expect(placeMod(l, 'A.mod', { index: 99 })).toEqual(['B.mod', 'C.mod', 'A.mod']);
    expect(placeMod(l, 'New.mod', { after: 'A.mod' })).toEqual(['A.mod', 'New.mod', 'B.mod', 'C.mod']);
    expect(() => placeMod(l, 'A.mod', { after: 'Nope.mod' })).toThrow(/Nope/);
    expect(setModEnabled(l, 'B.mod', false)).toEqual(['A.mod', 'C.mod']);
    expect(setModEnabled(l, 'D.mod', true)).toEqual([...l, 'D.mod']);
    expect(setModEnabled(l, 'b.mod', true)).toEqual(l);
  });

  it('изменения mods.cfg: move только для включённых, enable/disable, описание «было → стало»', () => {
    const l = ['A.mod', 'B.mod', 'C.mod'];
    expect(applyModsCfgChange(l, { op: 'move', name: 'C.mod', place: { top: true } })).toEqual(['C.mod', 'A.mod', 'B.mod']);
    expect(() => applyModsCfgChange(l, { op: 'move', name: 'D.mod', place: { top: true } })).toThrow(/включите/);
    expect(applyModsCfgChange(l, { op: 'enable', name: 'D.mod' })).toEqual([...l, 'D.mod']);
    expect(applyModsCfgChange(l, { op: 'enable', name: 'D.mod', place: { after: 'A.mod' } })).toEqual(['A.mod', 'D.mod', 'B.mod', 'C.mod']);
    expect(applyModsCfgChange(l, { op: 'enable', name: 'b.mod' })).toEqual(l);
    expect(applyModsCfgChange(l, { op: 'disable', name: 'b.mod' })).toEqual(['A.mod', 'C.mod']);
    expect(describeOrderChange(l, ['C.mod', 'A.mod', 'D.mod'])).toEqual([
      '  C.mod: место 3 → 1',
      '  A.mod: место 1 → 2',
      '+ D.mod: включён, место 3',
      '- B.mod: выключен',
    ]);
  });
});

describe('установленные моды', () => {
  it('список: источник, номер мастерской, место в mods.cfg, затенённые и отсутствующие', () => {
    const g = game();
    const { mods, missing, order } = listInstalledMods(g);
    expect(order).toEqual(['A.mod', 'Gone.mod', 'B.mod', 'Mine.mod']);
    const by = (name: string, source: string): (typeof mods)[number] => mods.find((m) => m.fileName === name && m.source === source)!;
    expect(by('Mine.mod', 'mods')).toMatchObject({ name: 'Mine', enabled: true, loadIndex: 3 });
    expect(by('B.mod', 'workshop')).toMatchObject({ workshopId: '222', enabled: true, loadIndex: 2 });
    expect(by('Off.mod', 'workshop')).toMatchObject({ enabled: false });
    expect(by('Off.mod', 'workshop').loadIndex).toBeUndefined();
    // A.mod есть и в mods/, и в мастерской: игра берёт mods/.
    expect(by('A.mod', 'mods').shadowedBy).toBeUndefined();
    expect(by('A.mod', 'workshop').shadowedBy).toBe(by('A.mod', 'mods').path);
    expect(missing).toEqual([{ fileName: 'Gone.mod', loadIndex: 1 }]);
    expect(workshopIdOf(g, by('B.mod', 'workshop').path)).toBe('222');
    expect(workshopIdOf(g, by('Mine.mod', 'mods').path)).toBeUndefined();
  });

  it('заголовок по началу файла; длинное описание — по всему файлу', () => {
    const g = game();
    const { mods } = listInstalledMods(g);
    const mine = readModSummary(mods.find((m) => m.fileName === 'Mine.mod')!.path);
    expect(mine).toMatchObject({ author: 'автор', dependencies: ['A.mod'], recordCount: 2, version: 1 });
    const b = readModSummary(mods.find((m) => m.fileName === 'B.mod')!.path);
    expect(b.recordCount).toBe(3);
    expect(b.description).toHaveLength(100_000);
    const bad = join(g.kenshi, 'mods', 'bad.mod');
    writeFileSync(bad, new Uint8Array([16, 0, 0, 0, 1]));
    expect(readModSummary(bad).error).toBeTruthy();
  });

  it('моды контекста: на местах по mods.cfg, в заголовок не идут, отсутствующие не считаются ошибкой', () => {
    const g = game();
    const plan = planModLoad(g, { modPath: join(g.kenshi, 'mods', 'Mine', 'Mine.mod'), context: ['B.mod', 'Off.mod', 'A.mod', 'Nope.mod', 'Mine.mod'] });
    // A — зависимость; B (место 2), Off (не в mods.cfg — в конец) — контекст; сам мод и отсутствующий — нет.
    expect(plan.dependencies.map((d) => d.name)).toEqual(['A.mod', 'B.mod', 'Off.mod']);
    expect(plan.context).toEqual(['B.mod', 'Off.mod']);
    expect(plan.missingDependencies).toEqual([]);
    expect([...plan.mod!.header!.dependencies]).toEqual([...joinModList(['A.mod'])]);
  });
});

describe('запись mods.cfg', () => {
  it('копия перед записью, CRLF как было, без изменений — не пишет', () => {
    const g = game();
    const cfg = join(g.kenshi, 'data', 'mods.cfg');
    const before = readFileSync(cfg, 'utf-8');
    const r = writeModsCfg(g, ['Mine.mod', 'A.mod', 'B.mod'], { checkGame: false, now: new Date(2026, 10, 5, 12, 30, 15) });
    expect(r.changed).toBe(true);
    expect(r.backup).toBe(`${cfg}.bak-20261105123015`);
    expect(readFileSync(r.backup!, 'utf-8')).toBe(before);
    expect(readFileSync(cfg, 'utf-8')).toBe('Mine.mod\r\nA.mod\r\nB.mod\r\n');
    const again = writeModsCfg(g, ['Mine.mod', 'A.mod', 'B.mod'], { checkGame: false });
    expect(again).toMatchObject({ changed: false });
    expect(readdirSync(join(g.kenshi, 'data')).filter((f) => f.includes('.bak-'))).toHaveLength(1);
    expect(existsSync(join(g.kenshi, 'data', '__mods.list'))).toBe(false);
  });
});

describe('копия чужого мода для правки', () => {
  it('из мастерской в mods/<имя>/<имя>.mod байт в байт + файл происхождения; оригинал не тронут', () => {
    const g = game();
    const src = join(g.workshop, '222', 'B.mod');
    const before = readFileSync(src);
    expect(isInWorkshop(g, src)).toBe(true);
    expect(isInWorkshop(g, join(g.kenshi, 'mods', 'B', 'B.mod'))).toBe(false);

    const plan = planModCopy(g, src);
    expect(plan.error).toBeUndefined();
    expect(plan.dest).toBe(join(g.kenshi, 'mods', 'B', 'B.mod'));
    expect(plan.shadowsOriginal).toBe(true);
    expect(plan.enabled).toBe(true);
    expect(plan.origin).toMatchObject({ workshopId: '222', sourceFileName: 'B.mod', author: 'автор', size: before.length });
    expect(plan.warnings.join(' ')).toMatch(/закроет оригинал/);
    expect(existsSync(plan.dest)).toBe(false);

    copyModForEditing(g, src);
    expect(Buffer.compare(readFileSync(plan.dest), before)).toBe(0);
    expect(Buffer.compare(readFileSync(src), before)).toBe(0);
    const origin = readModOrigin(plan.dest)!;
    expect(origin).toMatchObject({ source: src, workshopId: '222', sha256: plan.origin.sha256 });
    expect(originChanged(origin)).toBe(false);
    // Игра и редактор теперь берут копию: оригинал затенён.
    const b = listInstalledMods(g).mods.filter((m) => m.fileName === 'B.mod');
    expect(b.find((m) => m.source === 'workshop')!.shadowedBy).toBe(plan.dest);
    // Вторая копия в ту же папку — ошибка, ничего не перезаписывается.
    expect(() => copyModForEditing(g, src)).toThrow(/уже есть/);
    writeFileSync(src, Buffer.concat([before, Buffer.from([0])]));
    expect(originChanged(origin)).toBe(true);
  });

  it('под другим именем: не закрывает оригинал, предупреждает про mods.cfg; плохие имена — ошибка', () => {
    const g = game();
    const src = join(g.workshop, '222', 'B.mod');
    const plan = copyModForEditing(g, src, { name: 'B (правка).mod' });
    expect(plan.dest).toBe(join(g.kenshi, 'mods', 'B (правка)', 'B (правка).mod'));
    expect(plan.shadowsOriginal).toBe(false);
    expect(plan.warnings.join(' ')).toMatch(/включить отдельно/);
    expect(existsSync(join(g.kenshi, 'mods', 'B (правка)', 'B (правка).kedit-origin.json'))).toBe(true);
    expect(planModCopy(g, src, { name: 'a/b' }).error).toMatch(/Плохое имя/);
    expect(planModCopy(g, src, { name: 'a\\b' }).error).toMatch(/Плохое имя/);
    expect(planModCopy(g, src, { name: `a${String.fromCharCode(9)}b` }).error).toMatch(/Плохое имя/);
    expect(planModCopy(g, src, { name: '  ' }).error).toMatch(/Плохое имя/);
    // Мод из mods/ под тем же именем — это он сам.
    expect(planModCopy(g, join(g.kenshi, 'mods', 'Mine', 'Mine.mod')).error).toMatch(/другое имя/);
    expect(readModOrigin(join(g.kenshi, 'mods', 'Mine', 'Mine.mod'))).toBeUndefined();
  });
});
