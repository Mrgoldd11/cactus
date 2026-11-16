import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canPublish,
  checkPublish,
  classifySteamError,
  dotNetDate,
  encodeMessage,
  excludeReason,
  formatWorkshopInfo,
  imageFormat,
  isPublishedId,
  LineSplitter,
  newWorkshopInfo,
  parseUploaderLine,
  parseWorkshopInfo,
  PUBLISH_ERROR_TEXTS,
  sizeText,
  workshopFileNames,
  workshopUrls,
  type PublishFacts,
  type PublishRequest,
  type UploaderMessage,
} from '../src/index.ts';
import {
  FAKE_ITEM_ID,
  fakeScenarioFromEnv,
  fakeSteam,
  listUploadFiles,
  previewInfo,
  readWorkshopInfo,
  runPublish,
  stageUploadFiles,
  type FakeSteamScenario,
  type SteamWorkshopApi,
} from '../src/node/index.ts';

const FCS_SAMPLE =
  '<?xml version="1.0"?>\r\n<ModData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\r\n' +
  '  <id>3835566412</id>\r\n  <mod>Cactus Info</mod>\r\n  <title>Cactus &amp; friends</title>\r\n  <tags>\r\n    <string>Environment/Map</string>\r\n    <string>GUI</string>\r\n  </tags>\r\n' +
  '  <visibility>0</visibility>\r\n  <lastUpdate>2026-11-07T22:38:27.6001766+03:00</lastUpdate>\r\n</ModData>';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('_<mod>.info format', () => {
  it('reads FCS output', () => {
    const f = parseWorkshopInfo(FCS_SAMPLE);
    expect(f.info).toEqual({ id: '3835566412', mod: 'Cactus Info', title: 'Cactus & friends', tags: ['Environment/Map', 'GUI'], visibility: 0, lastUpdate: '2026-11-07T22:38:27.6001766+03:00' });
    expect(f.eol).toBe('\r\n');
  });
  it('writes back byte for byte', () => {
    const f = parseWorkshopInfo(FCS_SAMPLE);
    expect(formatWorkshopInfo(f.info, f)).toBe(FCS_SAMPLE);
  });
  it('writes a new file the way FCS does (empty tags, nil date, no final newline)', () => {
    const text = formatWorkshopInfo(newWorkshopInfo('My <mod>'));
    expect(text).toBe(
      '<?xml version="1.0"?>\r\n<ModData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\r\n' +
        '  <id>0</id>\r\n  <mod>My &lt;mod&gt;</mod>\r\n  <title>My &lt;mod&gt;</title>\r\n  <tags />\r\n  <visibility>0</visibility>\r\n  <lastUpdate xsi:nil="true" />\r\n</ModData>',
    );
    expect(parseWorkshopInfo(text).info).toEqual(newWorkshopInfo('My <mod>'));
  });
  it('keeps unknown elements and their place; adds missing known ones', () => {
    const text = FCS_SAMPLE.replace('  <visibility>0</visibility>\r\n', '  <extra a="1">x</extra>\r\n').replace('  <id>3835566412</id>\r\n', '');
    const f = parseWorkshopInfo(text);
    expect(f.unknown['extra']).toBe('<extra a="1">x</extra>');
    const out = formatWorkshopInfo({ ...f.info, id: '7', visibility: 2 }, f);
    expect(out).toContain('</tags>\r\n  <visibility>2</visibility>\r\n  <extra a="1">x</extra>');
    expect(out.indexOf('<id>7</id>')).toBeLessThan(out.indexOf('<mod>'));
  });
  it('rejects non-ModData text', () => {
    expect(() => parseWorkshopInfo('<foo/>')).toThrow();
  });
  it('ids, names, dates, picture formats', () => {
    expect(isPublishedId('0')).toBe(false);
    expect(isPublishedId('')).toBe(false);
    expect(isPublishedId('123')).toBe(true);
    expect(workshopFileNames('My mod.mod')).toEqual({ info: '_My mod.info', img: '_My mod.img', mod: 'My mod' });
    expect(dotNetDate(new Date(2026, 10, 7, 22, 38, 27, 600))).toMatch(/^2026-11-07T22:38:27\.6000000[+-]\d\d:\d\d$/);
    expect(imageFormat(PNG)).toBe('png');
    expect(imageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(imageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif');
    expect(imageFormat(new Uint8Array([0x42, 0x4d, 0, 0]))).toBeUndefined();
  });
});

describe('upload file list', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kedit-ws-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exclusion rule', () => {
    const out = ['a.kedit-merge.json', 'a.kedit-origin.json', 'x.mod.bak', 'x.backup', 'x.old', 'x.orig', 'x.mod.bak-2', 'scene.blend1', 'f.tmp', 'f.mod.tmp-1234', '~$doc.docx', 'notes.txt~', '.~lock.x#', 'Thumbs.db', 'desktop.ini', '.DS_Store'];
    for (const n of out) expect(excludeReason(n, false), n).toBeDefined();
    for (const n of ['.git', '.svn', '.hg', '__MACOSX']) expect(excludeReason(n, true), n).toBe('vcs');
    for (const n of ['My mod.mod', '_My mod.info', '_My mod.img', 'mesh.mesh', 'tex.dds', 'scene.blend', 'readme.txt', 'fcs.def']) expect(excludeReason(n, false), n).toBeUndefined();
    expect(excludeReason('git', true)).toBeUndefined();
  });

  it('lists, excludes and stages', () => {
    writeFileSync(join(dir, 'm.mod'), 'abc');
    writeFileSync(join(dir, 'm.kedit-merge.json'), '{}');
    writeFileSync(join(dir, 'm.mod.bak'), 'old');
    mkdirSync(join(dir, 'data', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'data', 'sub', 't.dds'), '12345');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
    const list = listUploadFiles(dir);
    expect(list.files).toEqual([
      { rel: 'data/sub/t.dds', size: 5 },
      { rel: 'm.mod', size: 3 },
    ]);
    expect(list.excluded.map((e) => [e.rel, e.reason])).toEqual([
      ['.git/', 'vcs'],
      ['m.kedit-merge.json', 'cactus'],
      ['m.mod.bak', 'backup'],
    ]);
    expect(list.totalSize).toBe(8);
    const stage = `${dir}-stage`;
    stageUploadFiles(dir, list.files, stage);
    expect(readFileSync(join(stage, 'data', 'sub', 't.dds'), 'utf8')).toBe('12345');
    expect(existsSync(join(stage, 'm.kedit-merge.json'))).toBe(false);
    rmSync(stage, { recursive: true, force: true });
  });

  it('preview info reads only the header', () => {
    writeFileSync(join(dir, 'p.png'), PNG);
    expect(previewInfo(join(dir, 'p.png'))).toMatchObject({ size: PNG.length, format: 'png' });
    expect(previewInfo(join(dir, 'none.png'))).toBeUndefined();
  });
});

describe('pre-publish checks', () => {
  const ok: PublishFacts = {
    title: 'My mod',
    description: 'Does things.',
    changeNote: '',
    preview: { size: 1000, format: 'png' },
    dirty: false,
    location: 'mods',
    validation: { errors: 0, warnings: 0 },
    fileCount: 2,
    totalSize: 2048,
    modName: 'My mod',
  };
  const codes = (f: Partial<PublishFacts>): string[] => checkPublish({ ...ok, ...f }).map((p) => p.code);

  it('a good mod only gets the size note', () => {
    const p = checkPublish(ok);
    expect(p.map((x) => x.code)).toEqual(['total-size']);
    expect(canPublish(p)).toBe(true);
    expect(p[0]!.text.ru).toContain('2,0 КБ');
  });
  it('blocking problems', () => {
    expect(codes({ title: '  ' })).toContain('title-empty');
    expect(codes({ title: 'x'.repeat(129) })).toContain('title-long');
    expect(codes({ description: '' })).toContain('description-empty');
    expect(codes({ description: 'x'.repeat(8001) })).toContain('description-long');
    expect(codes({ preview: undefined })).toContain('preview-missing');
    expect(codes({ preview: { size: 2 * 1024 * 1024, format: 'png' } })).toContain('preview-large');
    expect(codes({ preview: { size: 10, format: undefined } })).toContain('preview-format');
    expect(codes({ dirty: true })).toContain('unsaved');
    expect(codes({ location: 'workshop' })).toContain('in-workshop');
    expect(codes({ location: 'other' })).toContain('not-in-mods');
    expect(codes({ location: 'unsaved' })).toContain('not-saved');
    expect(codes({ fileCount: 0 })).toContain('no-files');
    expect(codes({ descriptionPending: true })).toContain('description-pending');
    expect(canPublish(checkPublish({ ...ok, dirty: true }))).toBe(false);
  });
  it('validation errors warn but do not block; errors come first', () => {
    const p = checkPublish({ ...ok, validation: { errors: 3, warnings: 2 }, title: '' });
    expect(p.map((x) => x.level)).toEqual(['error', 'warning', 'info', 'info']);
    expect(canPublish(checkPublish({ ...ok, validation: { errors: 3, warnings: 0 } }))).toBe(true);
  });
  it('every text has all three languages', () => {
    const all = checkPublish({
      ...ok,
      title: '',
      description: '',
      preview: { size: 5e6, format: undefined },
      dirty: true,
      location: 'other',
      validation: { errors: 1, warnings: 1 },
      copyOf: { workshopId: '1' },
      infoUnreadable: true,
      infoModName: 'Other',
      totalSize: 6e8,
    });
    for (const p of all) {
      expect(p.text.ru, p.code).toBeTruthy();
      expect(p.text.zh, p.code).toBeTruthy();
    }
    expect(sizeText(1536).ru).toBe('1,5 КБ');
  });
});

describe('uploader protocol', () => {
  it('lines and parsing', () => {
    const s = new LineSplitter();
    const a = encodeMessage({ type: 'hello', protocol: 1, fake: true });
    expect(s.push(a.slice(0, 5))).toEqual([]);
    expect(s.push(`${a.slice(5)}garbage\r\n{"type":"cancel"}`)).toEqual([a.trim(), 'garbage']);
    expect(s.flush()).toEqual(['{"type":"cancel"}']);
    expect(parseUploaderLine('garbage')).toBeUndefined();
    expect(parseUploaderLine(a)).toEqual({ type: 'hello', protocol: 1, fake: true });
  });
  it('Steam error texts map to codes', () => {
    expect(classifySteamError('failed to init the steamworks API')).toBe('steam-init-failed');
    expect(classifySteamError('user not logged on')).toBe('not-logged-in');
    expect(classifySteamError('access denied')).toBe('not-owner');
    expect(classifySteamError('item deleted')).toBe('item-deleted');
    expect(classifySteamError('temporary rate limit exceeded')).toBe('rate-limit');
    expect(classifySteamError('limit exceeded')).toBe('limit-exceeded');
    expect(classifySteamError('operation timed out')).toBe('timeout');
    expect(classifySteamError('VAC2 banned')).toBe('banned');
    expect(classifySteamError("there isn't a network connection to steam, or the steam servers are down")).toBe('no-connection');
    expect(classifySteamError('a generic failure from the steamworks API')).toBe('unknown');
    for (const [code, t] of Object.entries(PUBLISH_ERROR_TEXTS)) {
      expect(t.ru, code).toBeTruthy();
      expect(t.zh, code).toBeTruthy();
    }
  });
  it('env and urls', () => {
    expect(fakeScenarioFromEnv(undefined)).toBeUndefined();
    expect(fakeScenarioFromEnv('0')).toBeUndefined();
    expect(fakeScenarioFromEnv('1')).toBe('success');
    expect(fakeScenarioFromEnv('rate-limit')).toBe('rate-limit');
    expect(workshopUrls('12')).toEqual({ steam: 'steam://url/CommunityFilePage/12', web: 'https://steamcommunity.com/sharedfiles/filedetails/?id=12' });
  });
});

describe('publish session with the fake Steam', () => {
  let root: string;
  let modPath: string;
  let req: PublishRequest;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kedit-pub-'));
    const dir = join(root, 'mods', 'My mod');
    mkdirSync(dir, { recursive: true });
    modPath = join(dir, 'My mod.mod');
    writeFileSync(modPath, 'MOD');
    writeFileSync(join(dir, 'My mod.kedit-merge.json'), '{}');
    writeFileSync(join(root, 'preview.png'), PNG);
    req = {
      modPath,
      title: 'My & mod',
      description: 'Desc',
      changeNote: 'first',
      tags: ['GUI'],
      visibility: 2,
      previewPath: join(root, 'preview.png'),
      expectedId: '0',
      stagingDir: join(root, 'stage'),
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (steam: SteamWorkshopApi, r = req, cancelled?: () => boolean): Promise<UploaderMessage[]> => {
    const out: UploaderMessage[] = [];
    await runPublish(r, steam, (m) => out.push(m), { ...(cancelled ? { cancelled } : {}), now: () => new Date(2026, 10, 16, 12, 0, 0) });
    return out;
  };

  it('creates an item, writes .info with the id before the upload, uploads only the clean files', async () => {
    const log: Record<string, unknown>[] = [];
    let infoAtUpload: string | undefined;
    const base = fakeSteam('success', { tickMs: 0, appendLog: (l) => log.push(JSON.parse(l) as Record<string, unknown>) });
    const steam: SteamWorkshopApi = {
      ...base,
      updateItem: (...a) => {
        infoAtUpload = readFileSync(join(dirname(modPath), '_My mod.info'), 'utf8');
        return base.updateItem(...a);
      },
    };
    const msgs = await run(steam);
    expect(msgs.at(-1)).toEqual({ type: 'done', id: FAKE_ITEM_ID, created: true, needsAgreement: false });
    expect(msgs.some((m) => m.type === 'created')).toBe(true);
    expect(msgs.filter((m) => m.type === 'progress').length).toBeGreaterThan(3);
    expect(infoAtUpload).toContain(`<id>${FAKE_ITEM_ID}</id>`);
    const info = readWorkshopInfo(modPath);
    expect(info.state === 'ok' && info.file.info).toMatchObject({ id: FAKE_ITEM_ID, mod: 'My mod', title: 'My & mod', tags: ['GUI'], visibility: 2 });
    expect(readFileSync(join(dirname(modPath), '_My mod.img'))).toEqual(Buffer.from(PNG));
    const upd = log.find((l) => l['call'] === 'updateItem')!;
    expect((upd['files'] as string[]).map((f) => f.split(':')[0])).toEqual(['My mod.mod', '_My mod.img', '_My mod.info']);
    expect(upd).toMatchObject({ itemId: FAKE_ITEM_ID, title: 'My & mod', visibility: 2, changeNote: 'first' });
    expect(existsSync(req.stagingDir)).toBe(false);
  });

  it('updates the item named in .info, keeping its layout', async () => {
    await run(fakeSteam('success', { tickMs: 0 }));
    const log: string[] = [];
    const msgs = await run(fakeSteam('success', { tickMs: 0, appendLog: (l) => log.push(l) }), { ...req, expectedId: FAKE_ITEM_ID, title: 'Renamed' });
    expect(msgs.at(-1)).toEqual({ type: 'done', id: FAKE_ITEM_ID, created: false, needsAgreement: false });
    expect(log.some((l) => l.includes('createItem'))).toBe(false);
    const info = readWorkshopInfo(modPath);
    expect(info.state === 'ok' && info.file.info.title).toBe('Renamed');
  });

  it('refuses when .info changed since the window opened', async () => {
    const msgs = await run(fakeSteam('success', { tickMs: 0 }), { ...req, expectedId: '123' });
    expect(msgs.at(-1)).toMatchObject({ type: 'error', code: 'info-changed' });
    expect(readWorkshopInfo(modPath).state).toBe('missing');
  });

  it('Steam not running vs refused', async () => {
    expect((await run(fakeSteam('not-running', { tickMs: 0 }))).at(-1)).toMatchObject({ type: 'error', code: 'steam-not-running' });
    expect((await run(fakeSteam('init-failed', { tickMs: 0 }))).at(-1)).toMatchObject({ type: 'error', code: 'steam-init-failed' });
    expect((await run(fakeSteam('no-license', { tickMs: 0 }))).at(-1)).toMatchObject({ type: 'error', code: 'no-license' });
    expect(readWorkshopInfo(modPath).state).toBe('missing');
  });

  it('errors during the upload keep the created id in .info', async () => {
    const msgs = await run(fakeSteam('timeout', { tickMs: 0 }));
    expect(msgs.at(-1)).toEqual({ type: 'error', code: 'timeout', detail: 'operation timed out', id: FAKE_ITEM_ID });
    const info = readWorkshopInfo(modPath);
    expect(info.state === 'ok' && info.file.info.id).toBe(FAKE_ITEM_ID);
  });

  it('each fake error scenario maps to its code', async () => {
    const expected: Partial<Record<FakeSteamScenario, string>> = {
      'not-logged-in': 'not-logged-in',
      'access-denied': 'not-owner',
      'item-deleted': 'item-deleted',
      'rate-limit': 'rate-limit',
      'no-connection': 'no-connection',
      banned: 'banned',
      'unknown-error': 'unknown',
    };
    for (const [scenario, code] of Object.entries(expected)) {
      rmSync(join(dirname(modPath), '_My mod.info'), { force: true });
      const msgs = await run(fakeSteam(scenario as FakeSteamScenario, { tickMs: 0 }));
      expect(msgs.at(-1), scenario).toMatchObject({ type: 'error', code });
    }
  });

  it('agreement flag reaches the result', async () => {
    expect((await run(fakeSteam('agreement', { tickMs: 0 }))).at(-1)).toMatchObject({ type: 'done', needsAgreement: true });
  });

  it('cancel before creating leaves nothing behind', async () => {
    let n = 0;
    const msgs = await run(fakeSteam('success', { tickMs: 0 }), req, () => ++n > 1);
    expect(msgs.at(-1)).toEqual({ type: 'cancelled', stage: 'init' });
    expect(readWorkshopInfo(modPath).state).toBe('missing');
  });
});

describe('uploader child process (fake Steam)', () => {
  const child = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'uploader-child.ts');
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kedit-child-'));
    mkdirSync(join(root, 'mods', 'C'), { recursive: true });
    writeFileSync(join(root, 'mods', 'C', 'C.mod'), 'MOD');
    writeFileSync(join(root, 'p.png'), PNG);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runChild = (env: Record<string, string>, cancelAt?: string): Promise<{ msgs: UploaderMessage[]; code: number | null }> =>
    new Promise((res, rej) => {
      const p = spawn(process.execPath, [child], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      const msgs: UploaderMessage[] = [];
      const split = new LineSplitter();
      let err = '';
      p.stderr.on('data', (d: Buffer) => (err += String(d)));
      p.stdout.on('data', (d: Buffer) => {
        for (const l of split.push(String(d))) {
          const m = parseUploaderLine(l);
          if (!m) continue;
          msgs.push(m);
          if (cancelAt !== undefined && m.type === 'progress' && m.phase === cancelAt) p.stdin.write(encodeMessage({ type: 'cancel' }));
        }
      });
      p.on('error', rej);
      p.on('exit', (code) => {
        if (msgs.length === 0) rej(new Error(`no output; stderr: ${err}`));
        else res({ msgs, code });
      });
      const request: PublishRequest = {
        modPath: join(root, 'mods', 'C', 'C.mod'),
        title: 'C',
        description: 'd',
        changeNote: '',
        tags: [],
        visibility: 2,
        previewPath: join(root, 'p.png'),
        expectedId: '0',
        stagingDir: join(root, 'stage'),
      };
      p.stdin.write(encodeMessage({ type: 'publish', request }));
    });

  it('success: hello, stages, progress, done, exit 0', async () => {
    const log = join(root, 'fake.log');
    const { msgs, code } = await runChild({ KEDIT_FAKE_STEAM: '1', KEDIT_FAKE_STEAM_TICK_MS: '1', KEDIT_FAKE_STEAM_LOG: log });
    expect(msgs[0]).toEqual({ type: 'hello', protocol: 1, fake: true });
    expect(msgs.at(-1)).toEqual({ type: 'done', id: FAKE_ITEM_ID, created: true, needsAgreement: false });
    expect(code).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('"call":"updateItem"');
  }, 20000);

  it('no fake asked and no real Steam → library-missing', async () => {
    const { msgs, code } = await runChild({ KEDIT_FAKE_STEAM: '0' });
    expect(msgs.at(-1)).toMatchObject({ type: 'error', code: 'library-missing' });
    expect(code).toBe(2);
  }, 20000);

  it('cancel during the upload ends the process at once', async () => {
    const { msgs, code } = await runChild({ KEDIT_FAKE_STEAM: 'slow', KEDIT_FAKE_STEAM_TICK_MS: '30' }, 'preparing-config');
    expect(msgs.at(-1)).toEqual({ type: 'cancelled', stage: 'uploading', id: FAKE_ITEM_ID });
    expect(code).toBe(3);
  }, 20000);

  it('crash mid-upload: no final line, non-zero exit', async () => {
    const { msgs, code } = await runChild({ KEDIT_FAKE_STEAM: 'crash', KEDIT_FAKE_STEAM_TICK_MS: '1' });
    expect(['done', 'error', 'cancelled']).not.toContain(msgs.at(-1)!.type);
    expect(code).toBe(70);
  }, 20000);
});
