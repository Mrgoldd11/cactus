import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyRecord, encodeText, FileType, itemTypeId, writeDataFile, type DataFile } from '../src/index.ts';
import {
  addBackup,
  autosaveDir,
  autosaveFile,
  autosaveInfo,
  backupDir,
  clearAutosave,
  findRecovery,
  keepAutosaveAsBackup,
  listBackups,
  modKey,
  readAutosave,
  readBackup,
  safeSaveMod,
  writeAutosave,
  writeFileAtomic,
  type FileOps,
} from '../src/node/backup.ts';

function modBytes(n: number): Uint8Array {
  const r = emptyRecord(itemTypeId('WEAPON')!, `${n}-test.mod`, encodeText(`Blade ${n}`));
  r.changeFlags = 0x80000002;
  r.ints.set('value', n);
  const f: DataFile = {
    fileType: FileType.Mod,
    header: { version: 1, author: encodeText('t'), description: encodeText(''), dependencies: encodeText(''), references: encodeText('') },
    lastId: n,
    records: [r],
    tail: new Uint8Array(),
  };
  return writeDataFile(f);
}

let root: string;
let data: string;
let game: string;
let modPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kedit-backup-'));
  data = join(root, 'userData');
  game = join(root, 'Kenshi');
  modPath = join(game, 'mods', 'Test', 'Test.mod');
  mkdirSync(join(game, 'mods', 'Test'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ls = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe('безопасное сохранение', () => {
  it('новый файл пишется, временных файлов не остаётся', () => {
    const r = safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5 });
    expect(r.backup).toBeUndefined();
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(1)));
    expect(ls(join(game, 'mods', 'Test'))).toEqual(['Test.mod']);
  });

  it('прежняя версия уходит в резервную копию, рядом с модом ничего не появляется', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5, now: 1000 });
    const r = safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 5, now: 2000 });
    expect(r.backup?.kind).toBe('backup');
    expect(readBackup(data, { path: modPath, modName: 'Test.mod' }, r.backup!.id)).toEqual(new Uint8Array(modBytes(1)));
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(2)));
    expect(ls(join(game, 'mods', 'Test'))).toEqual(['Test.mod']);
  });

  it('ротация: хранится не больше keep копий, самые новые', () => {
    for (let i = 1; i <= 9; i++) safeSaveMod(modPath, modBytes(i), { dataDir: data, keep: 3, now: i * 1000 });
    const list = listBackups(data, { path: modPath, modName: 'Test.mod' });
    expect(list).toHaveLength(3);
    expect(list.map((b) => b.time)).toEqual([9000, 8000, 7000]);
    // самая новая копия — версия 8 (9 сейчас в файле)
    expect(readBackup(data, { path: modPath, modName: 'Test.mod' }, list[0]!.id)).toEqual(new Uint8Array(modBytes(8)));
  });

  it('keep = 0 — копий нет, мод сохраняется', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 0 });
    const r = safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 0 });
    expect(r.backup).toBeUndefined();
    expect(existsSync(backupDir(data, { path: modPath, modName: 'Test.mod' }))).toBe(false);
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(2)));
  });

  it('одинаковая версия не плодит копии', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5, now: 1 });
    safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 5, now: 2 });
    safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 5, now: 3 });
    expect(listBackups(data, { path: modPath, modName: 'Test.mod' })).toHaveLength(1);
  });

  it('сбой при записи временного файла не портит исходный мод', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5 });
    const ops: FileOps = {
      writeFile(path, bytes) {
        writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
        throw new Error('disk full');
      },
      rename() {
        throw new Error('must not be reached');
      },
    };
    expect(() => safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 5, ops })).toThrow('disk full');
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(1)));
    expect(ls(join(game, 'mods', 'Test'))).toEqual(['Test.mod']);
    expect(listBackups(data, { path: modPath, modName: 'Test.mod' })).toHaveLength(0);
  });

  it('сбой при замене не портит исходный мод и убирает временный файл', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5 });
    const ops: FileOps = {
      writeFile: (path, bytes) => { writeFileSync(path, bytes); },
      rename() {
        throw Object.assign(new Error('locked'), { code: 'ENOENT' });
      },
    };
    expect(() => safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 5, ops })).toThrow('locked');
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(1)));
    expect(ls(join(game, 'mods', 'Test'))).toEqual(['Test.mod']);
  });

  it('записанное с искажением (проверка чтением) не заменяет мод', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5 });
    const ops: FileOps = {
      writeFile(path, bytes) {
        const bad = Buffer.from(bytes);
        bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
        writeFileSync(path, bad);
      },
      rename: () => {
        throw new Error('must not be reached');
      },
    };
    expect(() => safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 5, ops })).toThrow(/verification failed/);
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(1)));
  });

  it('байты, не читаемые как мод, не записываются вовсе', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5 });
    expect(() => safeSaveMod(modPath, new Uint8Array([1, 2, 3]), { dataDir: data, keep: 5 })).toThrow();
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(1)));
  });

  it('сбой копии не мешает сохранению, ошибка возвращается', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5 });
    // Вместо папки данных — файл: копию положить некуда.
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'x');
    const r = safeSaveMod(modPath, modBytes(2), { dataDir: blocked, keep: 5 });
    expect(r.backupError).toBeTruthy();
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(2)));
  });

  it('writeFileAtomic заменяет существующий файл', () => {
    const p = join(root, 'a.bin');
    writeFileSync(p, 'old');
    writeFileAtomic(p, new Uint8Array([1, 2, 3]));
    expect([...readFileSync(p)]).toEqual([1, 2, 3]);
    expect(ls(root).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('автосохранение', () => {
  const ref = (): { path: string; modName: string } => ({ path: modPath, modName: 'Test.mod' });

  it('пишет в папку данных, мод и его папка не меняются', () => {
    writeFileSync(modPath, modBytes(1));
    const before = readFileSync(modPath);
    writeAutosave(data, ref(), modBytes(2), { forbidden: [game] });
    expect(existsSync(autosaveFile(data, ref()))).toBe(true);
    expect(autosaveFile(data, ref()).startsWith(autosaveDir(data))).toBe(true);
    expect(readFileSync(modPath)).toEqual(before);
    expect(ls(join(game, 'mods', 'Test'))).toEqual(['Test.mod']);
    expect(ls(game)).toEqual(['mods']);
  });

  it('папка данных внутри игры или мастерской — отказ, ничего не записано', () => {
    const inGame = join(game, 'userData');
    expect(() => writeAutosave(inGame, ref(), modBytes(2), { forbidden: [game] })).toThrow(/refusing/);
    expect(existsSync(inGame)).toBe(false);
    const workshop = join(root, 'workshop', '233860');
    expect(() => writeAutosave(join(workshop, '1', 'data'), ref(), modBytes(2), { forbidden: [game, workshop] })).toThrow(/refusing/);
  });

  it('имя мода с путями и странными символами не выводит запись за папку автосохранений', () => {
    const evil = { modName: '..\\..\\evil:*?.mod' };
    writeAutosave(data, evil, modBytes(2));
    const f = autosaveFile(data, evil);
    expect(f.startsWith(autosaveDir(data))).toBe(true);
    expect(ls(autosaveDir(data))).toHaveLength(2);
    expect(ls(root).sort()).toEqual(['Kenshi', 'userData']);
  });

  it('не читаемые как мод байты не записываются', () => {
    expect(() => writeAutosave(data, ref(), new Uint8Array([9, 9, 9]))).toThrow();
    expect(autosaveInfo(data, ref())).toBeUndefined();
  });

  it('ключ: тот же мод — тот же ключ, другой путь — другой; новый мод по имени', () => {
    expect(modKey({ path: modPath, modName: 'Test.mod' })).toBe(modKey({ path: modPath, modName: 'Other name' }));
    expect(modKey({ path: join(root, 'other', 'Test.mod'), modName: 'Test.mod' })).not.toBe(modKey({ path: modPath, modName: 'Test.mod' }));
    expect(modKey({ modName: 'New.mod' })).toBe(modKey({ modName: 'new.MOD' }));
    expect(modKey({ modName: 'New.mod' })).toMatch(/^new-[0-9a-f]{8}$/);
  });

  it('очистка убирает файл и описание', () => {
    writeAutosave(data, ref(), modBytes(2));
    expect(clearAutosave(data, ref())).toBe(true);
    expect(ls(autosaveDir(data))).toEqual([]);
    expect(clearAutosave(data, ref())).toBe(false);
  });
});

describe('восстановление', () => {
  const ref = (): { path: string; modName: string } => ({ path: modPath, modName: 'Test.mod' });
  const setMtime = (p: string, ms: number): void => {
    utimesSync(p, ms / 1000, ms / 1000);
  };

  it('автосохранение новее мода — предлагается; байты возвращаются как записаны', () => {
    writeFileSync(modPath, modBytes(1));
    setMtime(modPath, Date.now() - 60_000);
    writeAutosave(data, ref(), modBytes(2));
    const r = findRecovery(data, ref());
    expect(r?.modExists).toBe(true);
    expect(r?.size).toBe(modBytes(2).length);
    expect(readAutosave(data, ref())).toEqual(new Uint8Array(modBytes(2)));
  });

  it('автосохранение старше мода (после сохранения) — не предлагается', () => {
    writeAutosave(data, ref(), modBytes(2));
    setMtime(autosaveFile(data, ref()), Date.now() - 120_000);
    writeFileSync(modPath, modBytes(3));
    expect(findRecovery(data, ref())).toBeUndefined();
  });

  it('копия, совпадающая с модом, не предлагается', () => {
    writeFileSync(modPath, modBytes(1));
    setMtime(modPath, Date.now() - 60_000);
    writeAutosave(data, ref(), modBytes(1));
    expect(findRecovery(data, ref())).toBeUndefined();
  });

  it('мода на диске нет (новый или удалён) — копия предлагается', () => {
    writeAutosave(data, ref(), modBytes(2));
    expect(findRecovery(data, ref())).toMatchObject({ modExists: false });
    writeAutosave(data, { modName: 'Fresh.mod' }, modBytes(2));
    expect(findRecovery(data, { modName: 'Fresh.mod' })).toMatchObject({ modExists: false });
    expect(findRecovery(data, { modName: 'Other.mod' })).toBeUndefined();
  });

  it('«открыть как есть»: автосохранение уходит в список копий и не пропадает', () => {
    writeFileSync(modPath, modBytes(1));
    setMtime(modPath, Date.now() - 60_000);
    writeAutosave(data, ref(), modBytes(2));
    const e = keepAutosaveAsBackup(data, ref(), 5);
    expect(e?.kind).toBe('autosave');
    expect(findRecovery(data, ref())).toBeUndefined();
    const list = listBackups(data, ref());
    expect(list).toHaveLength(1);
    expect(readBackup(data, ref(), list[0]!.id)).toEqual(new Uint8Array(modBytes(2)));
  });

  it('список копий: автосохранение сверху, потом копии по времени; id с путём отвергается', () => {
    addBackup(data, ref(), modBytes(1), 'backup', 5, 1000);
    addBackup(data, ref(), modBytes(2), 'restore-point', 5, 2000);
    writeAutosave(data, ref(), modBytes(3), { now: 3000 });
    const list = listBackups(data, ref());
    expect(list.map((b) => b.kind)).toEqual(['autosave', 'restore-point', 'backup']);
    expect(readBackup(data, ref(), 'autosave')).toEqual(new Uint8Array(modBytes(3)));
    expect(() => readBackup(data, ref(), '..\\..\\settings.json')).toThrow(/bad backup id/);
  });
});
