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

describe('safe save', () => {
  it('a new file is written, no temp files are left', () => {
    const r = safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5 });
    expect(r.backup).toBeUndefined();
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(1)));
    expect(ls(join(game, 'mods', 'Test'))).toEqual(['Test.mod']);
  });

  it('the previous version goes to a backup, nothing appears next to the mod', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5, now: 1000 });
    const r = safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 5, now: 2000 });
    expect(r.backup?.kind).toBe('backup');
    expect(readBackup(data, { path: modPath, modName: 'Test.mod' }, r.backup!.id)).toEqual(new Uint8Array(modBytes(1)));
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(2)));
    expect(ls(join(game, 'mods', 'Test'))).toEqual(['Test.mod']);
  });

  it('rotation: no more than keep copies are kept, the newest ones', () => {
    for (let i = 1; i <= 9; i++) safeSaveMod(modPath, modBytes(i), { dataDir: data, keep: 3, now: i * 1000 });
    const list = listBackups(data, { path: modPath, modName: 'Test.mod' });
    expect(list).toHaveLength(3);
    expect(list.map((b) => b.time)).toEqual([9000, 8000, 7000]);
    // the newest copy is version 8 (9 is in the file now)
    expect(readBackup(data, { path: modPath, modName: 'Test.mod' }, list[0]!.id)).toEqual(new Uint8Array(modBytes(8)));
  });

  it('keep = 0 — no copies, the mod is saved', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 0 });
    const r = safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 0 });
    expect(r.backup).toBeUndefined();
    expect(existsSync(backupDir(data, { path: modPath, modName: 'Test.mod' }))).toBe(false);
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(2)));
  });

  it('an identical version does not multiply copies', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5, now: 1 });
    safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 5, now: 2 });
    safeSaveMod(modPath, modBytes(2), { dataDir: data, keep: 5, now: 3 });
    expect(listBackups(data, { path: modPath, modName: 'Test.mod' })).toHaveLength(1);
  });

  it('a failure writing the temp file does not corrupt the original mod', () => {
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

  it('a failure on replace does not corrupt the original mod and removes the temp file', () => {
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

  it('data written corrupted (checked by reading back) does not replace the mod', () => {
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

  it('bytes not readable as a mod are not written at all', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5 });
    expect(() => safeSaveMod(modPath, new Uint8Array([1, 2, 3]), { dataDir: data, keep: 5 })).toThrow();
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(1)));
  });

  it('a copy failure does not prevent saving, the error is returned', () => {
    safeSaveMod(modPath, modBytes(1), { dataDir: data, keep: 5 });
    // A file instead of the data folder: there is nowhere to put the copy.
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'x');
    const r = safeSaveMod(modPath, modBytes(2), { dataDir: blocked, keep: 5 });
    expect(r.backupError).toBeTruthy();
    expect(readFileSync(modPath)).toEqual(Buffer.from(modBytes(2)));
  });

  it('writeFileAtomic replaces an existing file', () => {
    const p = join(root, 'a.bin');
    writeFileSync(p, 'old');
    writeFileAtomic(p, new Uint8Array([1, 2, 3]));
    expect([...readFileSync(p)]).toEqual([1, 2, 3]);
    expect(ls(root).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('autosave', () => {
  const ref = (): { path: string; modName: string } => ({ path: modPath, modName: 'Test.mod' });

  it('writes into the data folder, the mod and its folder do not change', () => {
    writeFileSync(modPath, modBytes(1));
    const before = readFileSync(modPath);
    writeAutosave(data, ref(), modBytes(2), { forbidden: [game] });
    expect(existsSync(autosaveFile(data, ref()))).toBe(true);
    expect(autosaveFile(data, ref()).startsWith(autosaveDir(data))).toBe(true);
    expect(readFileSync(modPath)).toEqual(before);
    expect(ls(join(game, 'mods', 'Test'))).toEqual(['Test.mod']);
    expect(ls(game)).toEqual(['mods']);
  });

  it('data folder inside the game or Workshop — refused, nothing written', () => {
    const inGame = join(game, 'userData');
    expect(() => writeAutosave(inGame, ref(), modBytes(2), { forbidden: [game] })).toThrow(/refusing/);
    expect(existsSync(inGame)).toBe(false);
    const workshop = join(root, 'workshop', '233860');
    expect(() => writeAutosave(join(workshop, '1', 'data'), ref(), modBytes(2), { forbidden: [game, workshop] })).toThrow(/refusing/);
  });

  it('a mod name with paths and odd characters does not take the write outside the autosave folder', () => {
    const evil = { modName: '..\\..\\evil:*?.mod' };
    writeAutosave(data, evil, modBytes(2));
    const f = autosaveFile(data, evil);
    expect(f.startsWith(autosaveDir(data))).toBe(true);
    expect(ls(autosaveDir(data))).toHaveLength(2);
    expect(ls(root).sort()).toEqual(['Kenshi', 'userData']);
  });

  it('bytes not readable as a mod are not written', () => {
    expect(() => writeAutosave(data, ref(), new Uint8Array([9, 9, 9]))).toThrow();
    expect(autosaveInfo(data, ref())).toBeUndefined();
  });

  it('key: same mod — same key, other path — other key; new mod by name', () => {
    expect(modKey({ path: modPath, modName: 'Test.mod' })).toBe(modKey({ path: modPath, modName: 'Other name' }));
    expect(modKey({ path: join(root, 'other', 'Test.mod'), modName: 'Test.mod' })).not.toBe(modKey({ path: modPath, modName: 'Test.mod' }));
    expect(modKey({ modName: 'New.mod' })).toBe(modKey({ modName: 'new.MOD' }));
    expect(modKey({ modName: 'New.mod' })).toMatch(/^new-[0-9a-f]{8}$/);
  });

  it('cleanup removes the file and the description', () => {
    writeAutosave(data, ref(), modBytes(2));
    expect(clearAutosave(data, ref())).toBe(true);
    expect(ls(autosaveDir(data))).toEqual([]);
    expect(clearAutosave(data, ref())).toBe(false);
  });
});

describe('restore', () => {
  const ref = (): { path: string; modName: string } => ({ path: modPath, modName: 'Test.mod' });
  const setMtime = (p: string, ms: number): void => {
    utimesSync(p, ms / 1000, ms / 1000);
  };

  it('autosave newer than the mod — offered; bytes come back as written', () => {
    writeFileSync(modPath, modBytes(1));
    setMtime(modPath, Date.now() - 60_000);
    writeAutosave(data, ref(), modBytes(2));
    const r = findRecovery(data, ref());
    expect(r?.modExists).toBe(true);
    expect(r?.size).toBe(modBytes(2).length);
    expect(readAutosave(data, ref())).toEqual(new Uint8Array(modBytes(2)));
  });

  it('autosave older than the mod (after saving) — not offered', () => {
    writeAutosave(data, ref(), modBytes(2));
    setMtime(autosaveFile(data, ref()), Date.now() - 120_000);
    writeFileSync(modPath, modBytes(3));
    expect(findRecovery(data, ref())).toBeUndefined();
  });

  it('a copy equal to the mod is not offered', () => {
    writeFileSync(modPath, modBytes(1));
    setMtime(modPath, Date.now() - 60_000);
    writeAutosave(data, ref(), modBytes(1));
    expect(findRecovery(data, ref())).toBeUndefined();
  });

  it('no mod on disk (new or deleted) — the copy is offered', () => {
    writeAutosave(data, ref(), modBytes(2));
    expect(findRecovery(data, ref())).toMatchObject({ modExists: false });
    writeAutosave(data, { modName: 'Fresh.mod' }, modBytes(2));
    expect(findRecovery(data, { modName: 'Fresh.mod' })).toMatchObject({ modExists: false });
    expect(findRecovery(data, { modName: 'Other.mod' })).toBeUndefined();
  });

  it('"open as is": the autosave goes to the copy list and is not lost', () => {
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

  it('copy list: autosave on top, then copies by time; an id with a path is rejected', () => {
    addBackup(data, ref(), modBytes(1), 'backup', 5, 1000);
    addBackup(data, ref(), modBytes(2), 'restore-point', 5, 2000);
    writeAutosave(data, ref(), modBytes(3), { now: 3000 });
    const list = listBackups(data, ref());
    expect(list.map((b) => b.kind)).toEqual(['autosave', 'restore-point', 'backup']);
    expect(readBackup(data, ref(), 'autosave')).toEqual(new Uint8Array(modBytes(3)));
    expect(() => readBackup(data, ref(), '..\\..\\settings.json')).toThrow(/bad backup id/);
  });
});
