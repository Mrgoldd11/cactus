/**
 * Schema extensions on disk: finding them in mod folders, the load order, which ones apply to
 * a mod, the schema cache and opening a mod with them. The game folder, the workshop and the
 * mods are small fixtures made in a temporary folder.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeText, FileType, firstDifference, readDataFile, writeDataFile, type DataFile } from '../src/index.ts';
import {
  clearSchemaCache,
  compareFolderNames,
  extensionDirOf,
  extensionsFor,
  findExtensions,
  loadGameSchema,
  loadModContext,
  normalizeExtensionChoice,
  readExtensionDir,
  readExtensionLayers,
  type GamePaths,
} from '../src/node/index.ts';

const BASE_DEF = ['[DIALOGUE_LINE]', 'text0:   "" looped', '', '[ITEM]', 'value:   1 "price"'].join('\r\n');
const BASE_LAYOUT = ['[FCS_LAYOUT]', 'Items: ITEM'].join('\r\n');

const COUNTERS_DEF = [
  '// enum itemType { COUNTER=900 }',
  '[COUNTER]',
  'amount:          0 "how much"',
  '',
  '[FCS_LAYOUT]',
  'Counters: COUNTER',
  '',
  '[DIALOGUE_LINE]',
  'counter equals:  COUNTER (0) "checks a counter"',
].join('\r\n');

let root: string;
let paths: GamePaths;
let mods: string;

function modBytes(dependencies = ''): Uint8Array {
  const b = encodeText;
  const file: DataFile = {
    fileType: FileType.Mod,
    header: { version: 3, author: b('me'), description: b(''), dependencies: b(dependencies), references: b('') },
    lastId: 0,
    records: [],
    tail: new Uint8Array(),
  };
  return writeDataFile(file);
}

/** Make a folder with files: a string is a text file, bytes are a binary one. */
function folder(dir: string, files: Record<string, string | Uint8Array>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kedit-ext-'));
  paths = { kenshi: join(root, 'game'), workshop: join(root, 'workshop') };
  mods = join(paths.kenshi, 'mods');
  folder(paths.kenshi, { 'fcs.def': BASE_DEF, 'fcs_layout.def': BASE_LAYOUT });
  // Mixed letter case of the names and a byte order mark, as an editor on Windows may leave them.
  folder(join(mods, 'Counters'), {
    'Counters.mod': modBytes(),
    'FCS.def': `\uFEFF${COUNTERS_DEF}`,
    'FCS_Extended.JSON': '{ "FCS_Plugins" : ["Counters_FCS.dll"] }',
  });
  folder(join(mods, 'beta'), { 'beta.mod': modBytes(), 'Fcs_Preload.DEF': ['[ITEM]', 'weight:   2 "from beta"'].join('\r\n') });
  folder(join(mods, 'Alpha'), { 'Alpha.mod': modBytes(), 'fcs.def.patch': ['price', 'cost'].join('\r\n') });
  folder(join(mods, 'Plain'), { 'Plain.mod': modBytes() });
  folder(join(mods, 'Plugins only'), { 'Plugins only.mod': modBytes(), 'FCS_extended.json': '{ "FCS_Plugins": ["Only.dll"] }' });
  folder(join(mods, 'User'), { 'User.mod': modBytes('Counters.mod,Fruit stand.mod') });
  folder(join(paths.workshop, '123'), {
    'Fruit stand.mod': modBytes(),
    'fcs.def': ['[ITEM]', 'weight:   "heavy" "from the workshop"', 'ripe:     1'].join('\r\n'),
  });
  folder(join(root, 'elsewhere', 'Loose'), { 'Loose.mod': modBytes(), 'fcs.def': ['[ITEM]', 'loose:    1'].join('\r\n') });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearSchemaCache();
});

describe('schema extensions on disk: finding', () => {
  it('extension files are found whatever the letter case of their names', () => {
    const ext = readExtensionDir(join(mods, 'Counters'), 'mods')!;
    expect(ext).toMatchObject({
      id: 'mods/Counters',
      name: 'Counters',
      source: 'mods',
      dir: join(mods, 'Counters'),
      def: join(mods, 'Counters', 'FCS.def'),
      config: join(mods, 'Counters', 'FCS_Extended.JSON'),
      plugins: ['Counters_FCS.dll'],
      patches: [],
      mods: ['Counters.mod'],
    });
    expect(ext.preload).toBeUndefined();
    expect(ext.configError).toBeUndefined();
    expect(ext.stamps.map((s) => s.path).sort()).toEqual([ext.config!, ext.def!].sort());
    expect(ext.stamps.every((s) => s.size > 0 && s.mtimeMs > 0)).toBe(true);

    expect(readExtensionDir(join(mods, 'beta'), 'mods')).toMatchObject({ preload: join(mods, 'beta', 'Fcs_Preload.DEF'), plugins: [] });
    expect(readExtensionDir(join(mods, 'Plain'), 'mods')).toBeUndefined();
    expect(readExtensionDir(join(mods, 'no such folder'), 'mods')).toBeUndefined();
  });

  it('a patch keeps the letter case of its target; the texts are read without the byte order mark', () => {
    const dir = folder(join(root, 'patches'), {
      'fcs.def.patch': 'a\r\nb',
      'FCS_Enums.DEF.PATCH': 'a\r\nb',
      'notes.txt': 'not an extension file',
    });
    const ext = readExtensionDir(dir)!;
    expect(ext.source).toBe('folder');
    expect(ext.id).toBe(dir);
    expect(ext.patches.map((p) => p.target).sort()).toEqual(['FCS_Enums.DEF', 'fcs.def']);

    const [layer] = readExtensionLayers([readExtensionDir(join(mods, 'Counters'), 'mods')!]);
    expect(layer!.name).toBe('Counters');
    expect(layer!.def!.text.startsWith('// enum itemType')).toBe(true);
    expect(layer!.plugins).toEqual(['Counters_FCS.dll']);
  });

  it('a broken FCS_extended.json is reported, the def file next to it still counts', () => {
    const dir = folder(join(root, 'broken'), { 'FCS_extended.json': '{ "FCS_Plugins": [', 'fcs.def': '[ITEM]' });
    const ext = readExtensionDir(dir)!;
    expect(ext.plugins).toEqual([]);
    expect(ext.configError).toContain('FCS_extended.json cannot be read');
    expect(ext.def).toBe(join(dir, 'fcs.def'));

    const odd = folder(join(root, 'odd'), { 'FCS_extended.json': '{ "FCS_Plugins": "one.dll" }' });
    expect(readExtensionDir(odd)).toMatchObject({ plugins: [], configError: 'FCS_Plugins in FCS_extended.json is not a list' });
  });

  it('all installed extensions come in the order of FCS Extended: mods by name, then the workshop', () => {
    // Without regard to letter case: plain code order would put "Counters" before "beta".
    expect(['beta', 'Counters', 'Alpha', 'alpha'].sort(compareFolderNames)).toEqual(['Alpha', 'alpha', 'beta', 'Counters']);

    const found = findExtensions(paths);
    expect(found.map((e) => e.id)).toEqual(['mods/Alpha', 'mods/beta', 'mods/Counters', 'mods/Plugins only', 'workshop/123']);
    // A workshop folder is a number: the extension is named after its mod.
    expect(found.at(-1)).toMatchObject({ name: 'Fruit stand', source: 'workshop', mods: ['Fruit stand.mod'] });
    expect(findExtensions({ kenshi: join(root, 'nowhere'), workshop: join(root, 'nowhere too') })).toEqual([]);
  });
});

describe('schema extensions on disk: which ones apply to a mod', () => {
  const ids = (modFiles: string[], choice?: Parameters<typeof extensionsFor>[2]): string[] => extensionsFor(paths, modFiles, choice).map((e) => e.id);
  const mod = (name: string): string => join(mods, name, `${name}.mod`);

  it('by default: the folder of the mod and the folders of the mods under it', () => {
    expect(ids([mod('Plain')])).toEqual([]);
    expect(ids([mod('Counters')])).toEqual(['mods/Counters']);
    // Load order, not the order of the list: mods by name, the workshop, folders from elsewhere.
    const loose = join(root, 'elsewhere', 'Loose');
    expect(ids([join(loose, 'Loose.mod'), join(paths.workshop, '123', 'Fruit stand.mod'), mod('Counters'), mod('beta'), mod('Counters')])).toEqual([
      'mods/beta',
      'mods/Counters',
      'workshop/123',
      loose,
    ]);
  });

  it('a choice adds, removes or turns the default off', () => {
    expect(ids([mod('Plain')], { enable: ['workshop/123', 'mods/Alpha', 'mods/no such mod'] })).toEqual(['mods/Alpha', 'workshop/123']);
    expect(ids([mod('Counters'), mod('beta')], { disable: ['mods/counters'] })).toEqual(['mods/beta']);
    expect(ids([mod('Counters'), mod('beta')], { auto: false })).toEqual([]);
    expect(ids([mod('Counters')], { auto: false, enable: ['mods/beta'] })).toEqual(['mods/beta']);
    expect(ids([], { enable: [join(root, 'elsewhere', 'Loose')] })).toEqual([join(root, 'elsewhere', 'Loose')]);
  });

  it('ids are folder names, not paths out of the folder', () => {
    expect(extensionDirOf(paths, 'mods/Counters')).toBe(join(mods, 'Counters'));
    expect(extensionDirOf(paths, 'workshop/123')).toBe(join(paths.workshop, '123'));
    expect(extensionDirOf(paths, 'mods/..')).toBeUndefined();
    expect(extensionDirOf(paths, 'mods/a/b')).toBeUndefined();
    expect(extensionDirOf(paths, 'mods/')).toBeUndefined();
    expect(extensionDirOf(paths, '')).toBeUndefined();
  });

  it('the fcs.def of the game itself is never an extension', () => {
    expect(ids([join(paths.kenshi, 'Stray.mod')])).toEqual([]);
    expect(ids([], { enable: [paths.kenshi] })).toEqual([]);
  });

  it('a choice from a settings file is cleaned', () => {
    expect(normalizeExtensionChoice(undefined)).toEqual({});
    expect(normalizeExtensionChoice('all')).toEqual({});
    expect(normalizeExtensionChoice({ auto: false, enable: ['mods/A', 7, ''], disable: 'x', other: 1 })).toEqual({ auto: false, enable: ['mods/A'] });
    expect(normalizeExtensionChoice({ auto: 'yes', enable: [], disable: ['workshop/1'] })).toEqual({ disable: ['workshop/1'] });
  });
});

describe('schema extensions on disk: the schema and its cache', () => {
  it('without extensions the schema is read once and given again while the files are the same', () => {
    const first = loadGameSchema(paths);
    expect(first.types.get('ITEM')!.fields.get('value')!.description).toBe('price');
    expect(first.itemTypes.extra.size).toBe(0);
    expect(first.extensions).toBeUndefined();
    expect(loadGameSchema(paths)).toBe(first);
    expect(loadGameSchema(paths, { extensions: [] })).toBe(first);
    // DLL plugins alone change nothing in the schema.
    expect(loadGameSchema(paths, { extensions: extensionsFor(paths, [join(mods, 'Plugins only', 'Plugins only.mod')]) })).toBe(first);
  });

  it('a changed file of the game gives a fresh schema', () => {
    const game = folder(join(root, 'game2'), { 'fcs.def': BASE_DEF });
    const p: GamePaths = { kenshi: game, workshop: join(root, 'no workshop') };
    const first = loadGameSchema(p);
    expect(first.layout).toEqual([]);
    appendFileSync(join(game, 'fcs.def'), '\r\nweight:  3');
    const second = loadGameSchema(p);
    expect(second).not.toBe(first);
    expect(second.types.get('ITEM')!.fields.has('weight')).toBe(true);
    // A file that appeared counts as a change too.
    writeFileSync(join(game, 'fcs_layout.def'), BASE_LAYOUT);
    expect(loadGameSchema(p).layout).toHaveLength(1);
    expect(() => loadGameSchema({ kenshi: join(root, 'nowhere'), workshop: p.workshop })).toThrow();
  });

  it('extensions are applied in load order and the result is cached by the state of their files', () => {
    const dir = folder(join(root, 'game', 'mods', 'Zed'), { 'Zed.mod': modBytes(), 'fcs.def': ['[ITEM]', 'zed:  1'].join('\r\n') });
    const pick = (): ReturnType<typeof extensionsFor> => extensionsFor(paths, [join(dir, 'Zed.mod'), join(mods, 'Counters', 'Counters.mod')]);
    const base = loadGameSchema(paths);
    const first = loadGameSchema(paths, { extensions: pick() });
    expect(first).not.toBe(base);
    expect(first.extensions).toEqual(['Counters', 'Zed']);
    expect(first.itemTypes.extra.get(900)).toBe('COUNTER');
    expect(first.types.get('ITEM')!.fields.get('zed')).toMatchObject({ kind: 'int', extension: 'Zed' });
    expect(first.warnings).toEqual(base.warnings);
    // The game's part is not touched and is still the cached object.
    expect(loadGameSchema(paths)).toBe(base);
    expect(base.types.has('COUNTER')).toBe(false);

    expect(loadGameSchema(paths, { extensions: pick() })).toBe(first);
    // Another set of extensions is another schema.
    expect(loadGameSchema(paths, { extensions: pick().slice(0, 1) }).extensions).toEqual(['Counters']);

    appendFileSync(join(dir, 'fcs.def'), '\r\nzed two:  2');
    const second = loadGameSchema(paths, { extensions: pick() });
    expect(second).not.toBe(first);
    expect(second.types.get('ITEM')!.fields.has('zed two')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('preload files, patches and the workshop: every kind of file reaches the schema', () => {
    const all = extensionsFor(paths, [], { enable: ['mods/Alpha', 'mods/beta', 'workshop/123'] });
    const schema = loadGameSchema(paths, { extensions: all });
    expect(schema.extensions).toEqual(['Alpha', 'beta', 'Fruit stand']);
    const item = schema.types.get('ITEM')!;
    // The patch of Alpha rewrote the text of the game's fcs.def.
    expect(item.fields.get('value')!.description).toBe('cost');
    // The preload file of beta is read before the game's files, so its field comes first and wins.
    expect(item.fields.get('weight')).toMatchObject({ default: 2, description: 'from beta', extension: 'beta' });
    expect(item.fields.get('ripe')).toMatchObject({ kind: 'int', extension: 'Fruit stand' });
    // The field of the workshop mod lost to the preload file; the warning names the file.
    expect(schema.warnings.filter((w) => w.extension === 'Fruit stand').map((w) => [w.source, w.line])).toEqual([[join(paths.workshop, '123', 'fcs.def'), 2]]);
  });
});

describe('schema extensions on disk: opening a mod', () => {
  const open = (name: string, extra: Partial<Parameters<typeof loadModContext>[0]> = {}): ReturnType<typeof loadModContext> =>
    loadModContext({ paths, modPath: join(mods, name, `${name}.mod`), vanilla: [], po: false, ...extra });

  it('a mod without extensions gets the cached schema of the game', () => {
    const loaded = open('Plain');
    expect(loaded.extensions).toEqual([]);
    expect(loaded.ctx.schema).toBe(loadGameSchema(paths));
    expect(loaded.ctx.typeName(900)).toBe('TYPE_900');
  });

  it('a mod gets its own extension and the extensions of its dependencies', () => {
    const own = open('Counters');
    expect(own.extensions.map((e) => e.id)).toEqual(['mods/Counters']);
    expect(own.extensions[0]!.plugins).toEqual(['Counters_FCS.dll']);
    expect(own.ctx.typeName(900)).toBe('COUNTER');
    expect(own.ctx.schema!.types.get('DIALOGUE_LINE')!.fields.get('counter equals')).toMatchObject({
      kind: 'reference',
      targetType: 'COUNTER',
      description: 'checks a counter',
      extension: 'Counters',
    });

    const user = open('User');
    expect(user.missingDependencies).toEqual([]);
    expect(user.extensions.map((e) => e.id)).toEqual(['mods/Counters', 'workshop/123']);
    expect(user.ctx.schema!.extensions).toEqual(['Counters', 'Fruit stand']);
    expect(user.ctx.typeId('COUNTER')).toBe(900);
    // The same set of extensions: the same schema object, nothing is parsed again.
    expect(open('User').ctx.schema).toBe(user.ctx.schema);

    const bytes = modBytes('Counters.mod,Fruit stand.mod');
    expect(firstDifference(bytes, writeDataFile(user.ctx.buildModFile()))).toBe(-1);
    const counter = user.ctx.createRecord(900, 'Days passed');
    const again = readDataFile(writeDataFile(user.ctx.buildModFile()));
    expect(again.records.map((r) => [r.type, r.stringId])).toEqual([[900, counter]]);
  });

  it('the choice of the caller: none, or more than the default', () => {
    const none = open('Counters', { extensions: false });
    expect(none.extensions).toEqual([]);
    expect(none.ctx.schema).toBe(loadGameSchema(paths));

    const more = open('Plain', { extensions: { enable: ['mods/Counters'] } });
    expect(more.extensions.map((e) => e.id)).toEqual(['mods/Counters']);
    expect(more.ctx.typeName(900)).toBe('COUNTER');

    const off = open('User', { extensions: { disable: ['workshop/123'] } });
    expect(off.ctx.schema!.extensions).toEqual(['Counters']);

    // A ready schema or no schema: extensions are not looked for.
    expect(open('Counters', { schema: false })).toMatchObject({ extensions: [] });
    const ready = loadGameSchema(paths);
    const given = open('Counters', { schema: ready });
    expect(given.extensions).toEqual([]);
    expect(given.ctx.schema).toBe(ready);
  });

  it('a new mod started in a folder that already has an fcs.def gets that extension', () => {
    const loaded = loadModContext({ paths, modPath: join(mods, 'Counters', 'Brand new.mod'), vanilla: [], po: false });
    expect(loaded.ctx.modName).toBe('Brand new.mod');
    expect(loaded.extensions.map((e) => e.id)).toEqual(['mods/Counters']);
    expect(loaded.ctx.typeName(900)).toBe('COUNTER');
  });
});
