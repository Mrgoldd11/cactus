/**
 * Schema extensions on the files of the installed game and on two real extensions
 * (WorldStates and DialogueExtensions, read from the folder next to the repository; they are
 * not copied into it). Without the game, or without that folder, the tests are skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyExtensionLayers,
  fieldRows,
  firstDifference,
  formatTypeSchema,
  ModContext,
  parseDefFile,
  parseFcsDef,
  parseFcsEnums,
  parseFcsLayout,
  parseGameSchema,
  prepareSchemaBase,
  readDataFile,
  refGroups,
  summarizeExtensions,
  writeDataFile,
  type ExtensionLayer,
  type SchemaSources,
} from '../src/index.ts';
import { findExtensions, hasGame, loadGameSchema, loadModContext, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const EXAMPLES = join(import.meta.dirname, '../../../../kenshi-bridge/_downloads/examples');
const WORLD_STATES = join(EXAMPLES, 'WorldStates/WorldStates/FCS.def');
const WORLD_STATES_MOD = join(EXAMPLES, 'WorldStates/WorldStates/WorldStates.mod');
const DIALOGUE_EXT = join(EXAMPLES, 'Dialogue/DialogueExtensions/fcs.def');
const examples = existsSync(WORLD_STATES) && existsSync(DIALOGUE_EXT);

function sources(): SchemaSources {
  const read = (name: string): string => readFileSync(join(paths.kenshi, name), 'utf8');
  return { fcsDef: read('fcs.def'), fcsEnums: read('fcs_enums.def'), fcsLayout: read('fcs_layout.def') };
}

describe.skipIf(!game)('schema extensions: files of the game', () => {
  it('the files of the game go through the mixed-file parser unchanged', () => {
    const s = sources();
    const def = parseDefFile('fcs.def', s.fcsDef);
    expect(def.def).toEqual(parseFcsDef(s.fcsDef));
    expect(def.enums).toBeUndefined();
    expect(def.layout).toBeUndefined();

    const enums = parseDefFile('fcs_enums.def', s.fcsEnums!);
    expect(enums.enums).toEqual(parseFcsEnums(s.fcsEnums!));
    expect(enums.def).toBeUndefined();
    expect(enums.layout).toBeUndefined();

    const layout = parseDefFile('fcs_layout.def', s.fcsLayout!);
    expect(layout.layout).toEqual(parseFcsLayout(s.fcsLayout!));
    expect(layout.def).toBeUndefined();
    expect(layout.enums).toBeUndefined();
  });

  it('without extensions the schema is the one the game loader builds', () => {
    const base = prepareSchemaBase(sources());
    const schema = applyExtensionLayers(base, []);
    for (const plain of [parseGameSchema(sources()), loadGameSchema(paths)]) {
      expect(schema.warnings).toEqual(plain.warnings);
      expect(schema.types).toEqual(plain.types);
      expect(schema.enums).toEqual(plain.enums);
      expect(schema.layout).toEqual(plain.layout);
    }
    expect(schema.itemTypes.extra.size).toBe(0);
  });

  it('opening a mod without extensions: the schema of the game, read once', () => {
    const plain = loadGameSchema(paths);
    expect(loadGameSchema(paths)).toBe(plain);
    const loaded = loadModContext({ paths, vanilla: [], po: false });
    expect(loaded.extensions).toEqual([]);
    expect(loaded.ctx.schema).toBe(plain);
    // The installed extensions, whatever they are, come with their files and in a fixed order.
    const found = findExtensions(paths);
    expect(found.every((e) => e.stamps.length > 0)).toBe(true);
    expect(found.map((e) => e.id)).toEqual(findExtensions(paths).map((e) => e.id));
  });
});

describe.skipIf(!game || !examples)('schema extensions: real extensions', () => {
  const layer = (name: string, path: string): ExtensionLayer => ({ name, def: { path, text: readFileSync(path, 'utf8') } });

  it('WorldStates: the VARIABLE type gets number 900, its fields get names and descriptions', () => {
    const base = prepareSchemaBase(sources());
    const schema = applyExtensionLayers(base, [layer('WorldStates', WORLD_STATES)]);

    expect(schema.itemTypes.extra.get(900)).toBe('VARIABLE');
    expect(schema.itemTypes.extraByName.get('VARIABLE')).toBe(900);
    expect(schema.types.get('VARIABLE')!.fields.get('value')).toMatchObject({ kind: 'int', default: 0, extension: 'WorldStates' });

    for (const type of ['DIALOGUE', 'DIALOGUE_LINE', 'WORD_SWAPS']) {
      expect(schema.types.get(type)!.fields.get('variable equals'), type).toMatchObject({
        kind: 'reference',
        targetType: 'VARIABLE',
        refDefaults: [0],
        description: 'checks the value of a variable',
        extension: 'WorldStates',
      });
      expect(schema.types.get(type)!.fields.get('add to variable')!.description).toContain('value can also be negative');
    }
    expect(schema.types.get('WORLD_EVENT_STATE')!.fields.get('variable greater than')).toMatchObject({
      kind: 'reference',
      targetType: 'VARIABLE',
      refDefaults: [1],
    });

    const node = schema.layout.at(-1)!;
    expect(node).toMatchObject({ label: 'Variables', type: 'VARIABLE', extension: 'WorldStates' });
    // Nothing new to complain about: the warnings are those of the game alone.
    expect(schema.warnings).toEqual(base.schema.warnings);
    // The game's own part of the schema is untouched.
    expect(base.schema.types.has('VARIABLE')).toBe(false);
    expect(base.schema.types.get('DIALOGUE')!.fields.has('variable equals')).toBe(false);
  });

  it('WorldStates.mod with its extension: type 900 is VARIABLE, the file is written byte for byte', () => {
    const schema = applyExtensionLayers(prepareSchemaBase(sources()), [layer('WorldStates', WORLD_STATES)]);
    const bytes = readFileSync(WORLD_STATES_MOD);
    const ctx = new ModContext({ layers: [], mod: readDataFile(bytes), modName: 'WorldStates.mod', schema });
    expect(ctx.typeName(900)).toBe('VARIABLE');
    expect(ctx.typeId('VARIABLE')).toBe(900);
    // The published mod is only a header: its records are made by the mods that use it.
    expect([...ctx.modRecords()]).toHaveLength(0);
    expect(firstDifference(bytes, writeDataFile(ctx.buildModFile()))).toBe(-1);

    // A record of the new type, made the way a mod author would.
    const variable = ctx.createRecord(ctx.typeId('VARIABLE')!, 'Days passed');
    const line = ctx.createRecord(ctx.typeId('DIALOGUE_LINE')!, 'line');
    ctx.addReference(line, 'variable equals', variable);
    expect(fieldRows(ctx, variable).find((r) => r.key === 'value')).toMatchObject({ def: { kind: 'int', extension: 'WorldStates' } });
    const group = refGroups(ctx, line).find((g) => g.category === 'variable equals')!;
    expect(group).toMatchObject({ targetType: 'VARIABLE', def: { description: 'checks the value of a variable' } });
    expect(group.rows[0]).toMatchObject({ ref: { target: variable, v0: 0 }, targetType: 'VARIABLE' });
    const again = readDataFile(writeDataFile(ctx.buildModFile()));
    expect(again.records.map((r) => r.type)).toEqual([900, ctx.typeId('DIALOGUE_LINE')]);
  });

  it('WorldStates.mod opened from its folder: the extension next to it is found and applied', () => {
    const loaded = loadModContext({ paths, modPath: WORLD_STATES_MOD });
    expect(loaded.extensions).toHaveLength(1);
    expect(loaded.extensions[0]).toMatchObject({ name: 'WorldStates', source: 'folder', def: WORLD_STATES, plugins: ['WorldStates_FCS.dll'], patches: [] });
    const { ctx } = loaded;
    expect(ctx.schema!.extensions).toEqual(['WorldStates']);
    expect(ctx.typeName(900)).toBe('VARIABLE');
    // What the extension adds, as MCP and CLI show it.
    const [summary, ...others] = summarizeExtensions(ctx.schema!);
    expect(others).toEqual([]);
    expect(summary).toMatchObject({ name: 'WorldStates', types: [{ name: 'VARIABLE', id: 900 }], enums: [], warnings: [] });
    expect(summary!.fields).toContain('DIALOGUE_LINE.variable equals');
    expect(formatTypeSchema(ctx.schema!.types.get('VARIABLE')!)[0]).toContain('[VARIABLE]');
    expect(formatTypeSchema(ctx.schema!.types.get('VARIABLE')!)[0]).toContain('[extension WorldStates]');
    expect(ctx.schema!.types.get('VARIABLE')!.fields.get('value')).toMatchObject({ kind: 'int', extension: 'WorldStates' });
    expect(ctx.schema!.types.get('DIALOGUE_LINE')!.fields.get('variable equals')).toMatchObject({
      targetType: 'VARIABLE',
      description: 'checks the value of a variable',
    });
    expect(ctx.schema!.warnings).toEqual(loadGameSchema(paths).warnings);
    expect(firstDifference(readFileSync(WORLD_STATES_MOD), writeDataFile(ctx.buildModFile()))).toBe(-1);

    // The same mod again: the schema comes from memory. Without extensions: the game's schema.
    expect(loadModContext({ paths, modPath: WORLD_STATES_MOD, vanilla: [], po: false }).ctx.schema).toBe(ctx.schema);
    const off = loadModContext({ paths, modPath: WORLD_STATES_MOD, vanilla: [], po: false, extensions: false });
    expect(off.ctx.schema).toBe(loadGameSchema(paths));
    expect(off.ctx.typeName(900)).toBe('TYPE_900');
  });

  it('DialogueExtensions: conditions are appended to the enum built into FCS', () => {
    const base = prepareSchemaBase(sources());
    const before = base.schema.enums.get('DialogConditionEnum')!.values.length;
    const schema = applyExtensionLayers(base, [layer('DialogueExtensions', DIALOGUE_EXT)]);

    const dc = schema.enums.get('DialogConditionEnum')!;
    expect(dc.values).toHaveLength(before + 7);
    expect(dc.values.slice(before).map((v) => [v.name, v.value])).toEqual([
      ['DC_IS_SLEEPING', 900],
      ['DC_HAS_SHORT_TERM_TAG', 901],
      ['DC_IS_ALLY_BECAUSE_OF_DISGUISE', 902],
      ['DC_STAT_LEVEL_UNMODIFIED', 903],
      ['DC_STAT_LEVEL_MODIFIED', 904],
      ['DC_WEAPON_LEVEL', 905],
      ['DC_ARMOUR_LEVEL', 906],
    ]);
    expect(dc.values.slice(before).every((v) => v.extension === 'DialogueExtensions')).toBe(true);
    expect(base.schema.enums.get('DialogConditionEnum')!.values).toHaveLength(before);

    expect(schema.types.get('DIALOGUE_LINE')!.fields.get('take item')).toMatchObject({
      kind: 'reference',
      targetType: 'ITEM',
      refDefaults: [1],
      extension: 'DialogueExtensions',
    });
    expect(schema.warnings).toEqual(base.schema.warnings);
  });

  it('both extensions together, in either order', () => {
    const base = prepareSchemaBase(sources());
    const a = layer('WorldStates', WORLD_STATES);
    const b = layer('DialogueExtensions', DIALOGUE_EXT);
    for (const layers of [
      [a, b],
      [b, a],
    ]) {
      const schema = applyExtensionLayers(base, layers);
      expect(schema.extensions).toEqual(layers.map((l) => l.name));
      expect(schema.itemTypes.extra.get(900)).toBe('VARIABLE');
      expect(schema.enums.get('DialogConditionEnum')!.values.at(-1)).toMatchObject({ name: 'DC_ARMOUR_LEVEL', value: 906 });
      expect(schema.types.get('DIALOGUE')!.fields.has('set variable')).toBe(true);
      expect(schema.types.get('DIALOGUE')!.fields.has('destroy item')).toBe(true);
      expect(schema.warnings).toEqual(base.schema.warnings);
    }
  });
});
