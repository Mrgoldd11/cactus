/**
 * Schema extensions (FCS Extended): mixed def files, patches, layers. All fixtures are small
 * texts written for these tests.
 */
import { describe, expect, it } from 'vitest';
import {
  applyExtensionLayers,
  compileDotnetRegex,
  parseExtendedSchema,
  parsePatchFile,
  prepareSchemaBase,
  splitDefText,
  type ExtensionLayer,
  type SchemaSources,
} from '../src/index.ts';

const BASE: SchemaSources = {
  fcsDef: ['[DIALOGUE,DIALOGUE_LINE]', 'text0:   "" looped', '', '[ITEM]', 'value:   1 "price"', 'kind:    Fruit.APPLE'].join('\r\n'),
  fcsEnums: ['enum Fruit { APPLE, PEAR }'].join('\r\n'),
  fcsLayout: ['[FCS_LAYOUT]', 'Items: ITEM', '\tDialogue: DIALOGUE'].join('\r\n'),
};

const COUNTERS_DEF = [
  '// enum itemType { COUNTER=900 }', // 1
  'enum Fruit { PLUM=10, FIG }', // 2
  'enum DialogConditionEnum { }', // 3
  'enum DialogConditionEnum {', // 4
  '    DC_TEST_ONE=900, // first', // 5
  '    DC_TEST_TWO', // 6
  '}', // 7
  '[COUNTER]', // 8
  'amount:          0 "how much"', // 9
  '', // 10
  '[FCS_LAYOUT]', // 11
  'Counters: COUNTER', // 12
  '', // 13
  '[DIALOGUE,DIALOGUE_LINE] ', // 14
  'counter equals:  COUNTER (0) "checks a counter"', // 15
].join('\r\n');

const counters: ExtensionLayer = { name: 'Counters', def: { path: 'mods/Counters/fcs.def', text: COUNTERS_DEF } };

function regex(pattern: string): { replace(input: string, replacement: string): string } {
  const r = compileDotnetRegex(pattern);
  if (!r.ok) throw new Error(`${pattern}: ${r.reason}`);
  return r.regex;
}

describe('splitDefText', () => {
  it('cuts a mixed file into three texts with the original line numbers', () => {
    const s = splitDefText(COUNTERS_DEF);
    const lines = (t: string): string[] => t.split('\n');
    expect(lines(s.def)).toHaveLength(15);
    expect(lines(s.enums)).toHaveLength(15);
    expect(lines(s.layout)).toHaveLength(15);
    expect(lines(s.enums).flatMap((l, i) => (l === '' ? [] : [i + 1]))).toEqual([2, 3, 4, 5, 6, 7]);
    expect(lines(s.def).flatMap((l, i) => (l === '' ? [] : [i + 1]))).toEqual([8, 9, 14, 15]);
    expect(lines(s.layout).flatMap((l, i) => (l === '' ? [] : [i + 1]))).toEqual([11, 12]);
    expect(s.itemTypeHints).toEqual([{ name: 'COUNTER', value: 900, line: 1 }]);
    expect([s.hasDef, s.hasEnums, s.hasLayout]).toEqual([true, true, true]);
  });

  it('reports which kinds of content a file has', () => {
    expect(splitDefText('enum A { X }')).toMatchObject({ hasDef: false, hasEnums: true, hasLayout: false });
    expect(splitDefText('[ITEM]\nfoo: 1')).toMatchObject({ hasDef: true, hasEnums: false, hasLayout: false });
    expect(splitDefText('// only a comment\n')).toMatchObject({ hasDef: false, hasEnums: false, hasLayout: false });
  });

  it('returns to the section it was in after an enum', () => {
    const s = splitDefText(['[FCS_LAYOUT]', 'A: ITEM', 'enum E { X }', 'B: ITEM', '[ITEM]', 'enum F {', 'Y', '}', 'foo: 1'].join('\n'));
    expect(s.layout.split('\n').filter((l) => l !== '')).toEqual(['[FCS_LAYOUT]', 'A: ITEM', 'B: ITEM']);
    expect(s.def.split('\n').filter((l) => l !== '')).toEqual(['[ITEM]', 'foo: 1']);
    expect(s.enums.split('\n').filter((l) => l !== '')).toEqual(['enum E { X }', 'enum F {', 'Y', '}']);
  });
});

describe('applyExtensionLayers', () => {
  const base = prepareSchemaBase(BASE);

  it('returns the cached base schema when there are no layers', () => {
    expect(applyExtensionLayers(base, [])).toBe(base.schema);
    expect(base.schema.extensions).toBeUndefined();
    expect(base.schema.itemTypes.extra.size).toBe(0);
    expect(base.schema.warnings).toEqual([]);
  });

  it('adds types and fields with names, descriptions and the extension they come from', () => {
    const schema = applyExtensionLayers(base, [counters]);
    expect(schema.extensions).toEqual(['Counters']);
    expect(schema.warnings).toEqual([]);

    const counter = schema.types.get('COUNTER')!;
    expect(counter.extension).toBe('Counters');
    expect(counter.fields.get('amount')).toMatchObject({ kind: 'int', default: 0, description: 'how much', line: 9, extension: 'Counters' });

    for (const typeName of ['DIALOGUE', 'DIALOGUE_LINE']) {
      const t = schema.types.get(typeName)!;
      expect(t.extension).toBeUndefined();
      expect([...t.fields.keys()]).toEqual(['text0', 'counter equals']);
      expect(t.fields.get('counter equals')).toMatchObject({
        kind: 'reference',
        targetType: 'COUNTER',
        refDefaults: [0],
        description: 'checks a counter',
        extension: 'Counters',
      });
      expect(t.fields.get('text0')!.extension).toBeUndefined();
    }
  });

  it('registers the record type from the comment hint', () => {
    const schema = applyExtensionLayers(base, [counters]);
    expect([...schema.itemTypes.extra]).toEqual([[900, 'COUNTER']]);
    expect(schema.itemTypes.extraByName.get('COUNTER')).toBe(900);
    expect(schema.enums.has('itemType')).toBe(false);
  });

  it('appends enum values, to enums of the game and to enums built into FCS', () => {
    const schema = applyExtensionLayers(base, [counters]);
    expect(schema.enums.get('Fruit')!.values.map((v) => [v.name, v.value, v.extension])).toEqual([
      ['APPLE', 0, undefined],
      ['PEAR', 1, undefined],
      ['PLUM', 10, 'Counters'],
      ['FIG', 11, 'Counters'],
    ]);
    const dc = schema.enums.get('DialogConditionEnum')!;
    expect(dc.builtin).toBe(true);
    expect(dc.values.length).toBeGreaterThan(10);
    expect(dc.values[0]!.extension).toBeUndefined();
    expect(dc.values.slice(-2)).toEqual([
      { name: 'DC_TEST_ONE', value: 900, description: 'first', extension: 'Counters' },
      { name: 'DC_TEST_TWO', value: 901, extension: 'Counters' },
    ]);
  });

  it('does not change the cached base schema', () => {
    applyExtensionLayers(base, [counters]);
    expect(base.schema.enums.get('Fruit')!.values.map((v) => v.name)).toEqual(['APPLE', 'PEAR']);
    expect(base.parsed.enums!.enums.get('Fruit')!.values).toHaveLength(2);
    expect([...base.schema.types.get('DIALOGUE')!.fields.keys()]).toEqual(['text0']);
    expect(base.schema.layout).toHaveLength(1);
    expect(base.schema.types.has('COUNTER')).toBe(false);
  });

  it('concatenates layout trees', () => {
    const schema = applyExtensionLayers(base, [counters]);
    expect(schema.layout.map((n) => [n.label, n.type, n.extension])).toEqual([
      ['Items', 'ITEM', undefined],
      ['Counters', 'COUNTER', 'Counters'],
    ]);
    expect(schema.layout[0]).toBe(base.schema.layout[0]);
    expect(schema.layout[0]!.children.map((n) => n.label)).toEqual(['Dialogue']);
  });

  it('creates a new enum and warns about one that stays empty', () => {
    const schema = applyExtensionLayers(base, [
      { name: 'E', def: { path: 'mods/E/fcs.def', text: ['enum Mood { CALM, ANGRY=5 }', 'enum Unknown { }', '[ITEM]', 'mood: Mood.CALM'].join('\n') } },
    ]);
    expect(schema.enums.get('Mood')).toMatchObject({ extension: 'E', values: [{ name: 'CALM', value: 0 }, { name: 'ANGRY', value: 5 }] });
    expect(schema.types.get('ITEM')!.fields.get('mood')).toMatchObject({ kind: 'enum', enumName: 'Mood', default: 'CALM' });
    expect(schema.warnings).toHaveLength(1);
    expect(schema.warnings[0]).toMatchObject({ source: 'mods/E/fcs.def', extension: 'E', line: 2 });
    expect(schema.warnings[0]!.message).toContain('enum Unknown has no values');
  });

  describe('layer order', () => {
    const first: ExtensionLayer = {
      name: 'First',
      def: { path: 'mods/First/fcs.def', text: ['enum Fruit { KIWI=20 }', '[ITEM]', 'weight: 1.5 "from First"', '[FCS_LAYOUT]', 'First: ITEM'].join('\n') },
    };
    const second: ExtensionLayer = {
      name: 'Second',
      def: {
        path: 'mods/Second/fcs.def',
        text: ['enum Fruit { KIWI=21, LIME=10 }', '[ITEM]', 'weight: "heavy" "from Second"', 'value: 2 "from Second"', '[FCS_LAYOUT]', 'Second: ITEM'].join('\n'),
      },
    };

    it('the first definition of a field wins, a different kind is reported with file and line', () => {
      const schema = applyExtensionLayers(base, [first, second]);
      const item = schema.types.get('ITEM')!;
      expect(item.fields.get('weight')).toMatchObject({ kind: 'float', description: 'from First', extension: 'First' });
      // The game's own field stays; the same kind is not a conflict.
      expect(item.fields.get('value')).toMatchObject({ description: 'price' });
      expect(item.fields.get('value')!.extension).toBeUndefined();
      const w = schema.warnings.filter((x) => x.message.includes('ITEM.weight'));
      expect(w).toHaveLength(1);
      expect(w[0]).toMatchObject({ source: 'mods/Second/fcs.def', extension: 'Second', line: 3 });
      expect(w[0]!.message).toContain('mods/First/fcs.def, line 3');

      const swapped = applyExtensionLayers(base, [second, first]);
      expect(swapped.types.get('ITEM')!.fields.get('weight')).toMatchObject({ kind: 'string', extension: 'Second' });
    });

    it('enum values: a repeated name takes the last number, a shared number is reported', () => {
      const schema = applyExtensionLayers(base, [first, second]);
      expect(schema.enums.get('Fruit')!.values.map((v) => [v.name, v.value, v.extension])).toEqual([
        ['APPLE', 0, undefined],
        ['PEAR', 1, undefined],
        ['KIWI', 21, 'Second'],
        ['LIME', 10, 'Second'],
      ]);
      const messages = schema.warnings.filter((x) => x.message.startsWith('Fruit.')).map((x) => `${x.source}:${String(x.line)} ${x.message}`);
      expect(messages).toEqual(['mods/Second/fcs.def:1 Fruit.KIWI: already defined with number 20; the number 21 from this file replaces it']);

      const clash = applyExtensionLayers(base, [counters, second]);
      expect(clash.warnings.map((x) => x.message)).toContain('Fruit.LIME=10: the number is already used by PLUM');
    });

    it('layout trees follow the order of layers', () => {
      expect(applyExtensionLayers(base, [first, second]).layout.map((n) => n.label)).toEqual(['Items', 'First', 'Second']);
      expect(applyExtensionLayers(base, [second, first]).layout.map((n) => n.label)).toEqual(['Items', 'Second', 'First']);
    });

    it('fcs_preload.def is loaded before the files of the game', () => {
      const schema = applyExtensionLayers(base, [
        { name: 'Pre', preload: { path: 'mods/Pre/fcs_preload.def', text: ['[ITEM]', 'value: "text" "from preload"', '[FCS_LAYOUT]', 'Pre: ITEM'].join('\n') } },
      ]);
      expect(schema.types.get('ITEM')!.fields.get('value')).toMatchObject({ kind: 'string', extension: 'Pre' });
      expect(schema.layout.map((n) => n.label)).toEqual(['Pre', 'Items']);
      // The conflict is now in the game's file.
      expect(schema.warnings.map((w) => [w.source, w.line])).toEqual([['fcs.def', 5]]);
    });
  });

  describe('record types', () => {
    const layer = (name: string, lines: string[]): ExtensionLayer => ({ name, def: { path: `mods/${name}/fcs.def`, text: lines.join('\n') } });

    it('a real enum itemType block wins over a comment hint', () => {
      const schema = applyExtensionLayers(base, [
        layer('Hint', ['// enum itemType { GADGET=950, WIDGET=951 }', '[GADGET]', 'a: 1', '[WIDGET]', 'b: 1']),
        layer('Real', ['enum itemType { }', 'enum itemType { GADGET=1200 }']),
      ]);
      expect([...schema.itemTypes.extraByName]).toEqual([
        ['GADGET', 1200],
        ['WIDGET', 951],
      ]);
      expect(schema.itemTypes.extra.get(1200)).toBe('GADGET');
      expect(schema.itemTypes.extra.has(950)).toBe(false);
      expect(schema.warnings).toEqual([]);
    });

    it('a type without a number is reported with a way to fix it', () => {
      const schema = applyExtensionLayers(base, [layer('NoNumber', ['[GIZMO]', 'a: 1', '[ITEM]', 'gizmo: GIZMO (0)'])]);
      expect(schema.itemTypes.extra.size).toBe(0);
      expect(schema.types.has('GIZMO')).toBe(true);
      expect(schema.warnings[0]).toMatchObject({ source: 'mods/NoNumber/fcs.def', extension: 'NoNumber', line: 1 });
      expect(schema.warnings[0]!.message).toContain('enum itemType { GIZMO=<number> }');
    });

    it('built-in types cannot be renamed or renumbered; conflicts between extensions are reported', () => {
      const schema = applyExtensionLayers(base, [
        layer('Bad', ['enum itemType { ITEM=900, MY_BUILDING=0, DIALOGUE=18 }']),
        layer('A', ['enum itemType { ALPHA=1500 }']),
        layer('B', ['enum itemType { BETA=1500, ALPHA=1501 }']),
      ]);
      expect(schema.warnings.map((w) => `${w.extension!}: ${w.message}`)).toEqual([
        'Bad: itemType ITEM=900: ITEM is a built-in record type with number 4; ignored',
        'Bad: itemType MY_BUILDING=0: number 0 is the built-in record type BUILDING; ignored',
        'B: itemType BETA=1500: number 1500 is also used by ALPHA; records with this number are shown as BETA',
        'B: itemType ALPHA=1501: ALPHA was already declared with number 1500; the last declaration wins',
      ]);
      expect([...schema.itemTypes.extra]).toEqual([
        [1500, 'BETA'],
        [1501, 'ALPHA'],
      ]);
    });
  });
});

describe('def patches', () => {
  it('reads pairs of lines until the first empty line', () => {
    expect(parsePatchFile('a\r\nb\r\nc\r\nd\r\n')).toEqual({
      rules: [
        { line: 1, pattern: 'a', replacement: 'b' },
        { line: 3, pattern: 'c', replacement: 'd' },
      ],
    });
    expect(parsePatchFile('a')).toEqual({ rules: [{ line: 1, pattern: 'a', replacement: '' }] });
    expect(parsePatchFile('a\nb\n\nc\nd')).toEqual({ rules: [{ line: 1, pattern: 'a', replacement: 'b' }], ignoredFrom: 4 });
    // An empty replacement is fine, a line of spaces is a regex.
    expect(parsePatchFile('a\n\n \nx').rules).toEqual([
      { line: 1, pattern: 'a', replacement: '' },
      { line: 3, pattern: ' ', replacement: 'x' },
    ]);
    expect(parsePatchFile('')).toEqual({ rules: [] });
  });

  const patchLayer = (target: string, lines: string[], extra: Partial<ExtensionLayer> = {}): ExtensionLayer => ({
    name: 'Patch',
    patches: [{ path: `mods/Patch/${target}.patch`, target, text: lines.join('\r\n') }],
    ...extra,
  });

  it('patches the text of a game file and parses it again', () => {
    const base = prepareSchemaBase(BASE);
    const schema = applyExtensionLayers(base, [patchLayer('fcs.def', ['(value:\\s+)1 "price"', '$1 7 "new price"'])]);
    expect(schema.types.get('ITEM')!.fields.get('value')).toMatchObject({ default: 7, description: 'new price' });
    expect(schema.warnings).toEqual([]);
    expect(schema.extensions).toEqual(['Patch']);
    expect(base.schema.types.get('ITEM')!.fields.get('value')).toMatchObject({ default: 1, description: 'price' });
  });

  it('patches enums and layout files', () => {
    const schema = parseExtendedSchema(BASE, [
      {
        name: 'Patch',
        patches: [
          { path: 'mods/Patch/fcs_enums.def.patch', target: 'fcs_enums.def', text: 'PEAR\nPEAR, QUINCE' },
          { path: 'mods/Patch/fcs_layout.def.patch', target: 'fcs_layout.def', text: 'Items:\nThings:' },
        ],
      },
    ]);
    expect(schema.enums.get('Fruit')!.values.map((v) => v.name)).toEqual(['APPLE', 'PEAR', 'QUINCE']);
    expect(schema.layout.map((n) => n.label)).toEqual(['Things']);
    expect(schema.warnings).toEqual([]);
  });

  it('a patch for fcs.def also applies to fcs.def of extensions, from any layer', () => {
    const schema = parseExtendedSchema(BASE, [counters, patchLayer('fcs.def', ['"how much"', '"patched"'])]);
    expect(schema.types.get('COUNTER')!.fields.get('amount')!.description).toBe('patched');
    expect(schema.warnings).toEqual([]);
  });

  it('a broken or unsupported regex is a warning with file and line; other patches still apply', () => {
    const schema = parseExtendedSchema(BASE, [
      patchLayer('fcs.def', ['(?>atomic)', 'x', '(unclosed', 'y', 'APPLE', 'PEAR', 'no such text', 'z']),
    ]);
    expect(schema.types.get('ITEM')!.fields.get('kind')!.default).toBe('PEAR');
    expect(schema.warnings.map((w) => [w.source, w.extension, w.line, w.text])).toEqual([
      ['mods/Patch/fcs.def.patch', 'Patch', 1, '(?>atomic)'],
      ['mods/Patch/fcs.def.patch', 'Patch', 3, '(unclosed'],
      ['mods/Patch/fcs.def.patch', 'Patch', 7, 'no such text'],
    ]);
    expect(schema.warnings[0]!.message).toContain('atomic groups');
    expect(schema.warnings[2]!.message).toBe('the patch matched nothing in fcs.def');
  });

  it('a target that FCS Extended would never match is reported', () => {
    const wrongCase = parseExtendedSchema(BASE, [patchLayer('FCS.def', ['APPLE', 'PEAR'])]);
    expect(wrongCase.types.get('ITEM')!.fields.get('kind')!.default).toBe('APPLE');
    expect(wrongCase.warnings).toHaveLength(1);
    expect(wrongCase.warnings[0]!.message).toContain('letter case');

    const other = parseExtendedSchema(BASE, [patchLayer('settings.def', ['a', 'b'])]);
    expect(other.warnings.map((w) => w.message)).toEqual(['patch target "settings.def" is not a schema file; Cactus does not use this patch']);
  });
});

describe('.NET regular expressions', () => {
  it('"." matches a carriage return but not a line feed', () => {
    expect(regex('a.b').replace('a\rb a\nb', 'X')).toBe('X a\nb');
    expect(regex('(?s)a.b').replace('a\rb a\nb', 'X')).toBe('X X');
    expect(regex('value:.*').replace('value: 1\r\nnext', 'gone')).toBe('gone\nnext');
  });

  it('"^" and "$" look at the whole text unless (?m) is given', () => {
    expect(regex('^a').replace('a\na', 'X')).toBe('X\na');
    expect(regex('a$').replace('a\na', 'X')).toBe('a\nX');
    // "$" also matches before a final line feed.
    expect(regex('a$').replace('a\na\n', 'X')).toBe('a\nX\n');
    expect(regex('(?m)^a$').replace('a\na\nab', 'X')).toBe('X\nX\nab');
    // Under (?m) "$" does not match before a carriage return.
    expect(regex('(?m)a$').replace('a\r\na', 'X')).toBe('a\r\nX');
  });

  it('\\A, \\Z and \\z', () => {
    expect(regex('\\Aa').replace('aa', 'X')).toBe('Xa');
    expect(regex('a\\Z').replace('a\na\n', 'X')).toBe('a\nX\n');
    expect(regex('a\\z').replace('a\na\n', 'X')).toBe('a\na\n');
    expect(regex('\\z').replace('a', '!')).toBe('a!');
  });

  it('inline options at the start, named groups in both spellings', () => {
    expect(regex('(?i)apple').replace('Apple APPLE', 'x')).toBe('x x');
    expect(regex("(?'key'\\w+)=(?<val>\\d+)").replace('a=1', '${val}=${key}')).toBe('1=a');
    expect(regex("(?<q>['\"])x\\k'q'").replace('"x" \'x\' "x\'', '-')).toBe('- - "x\'');
  });

  it('numbers unnamed groups before named ones, as .NET does', () => {
    expect(regex('(?<n>a)(b)').replace('ab', '[$1][$2][${n}]')).toBe('[b][a][a]');
    expect(regex('(?<n>a)(b)\\1\\2').replace('abba', 'ok')).toBe('ok');
  });

  it('replacement patterns', () => {
    expect(regex('(b)').replace('abc', '<$1$1>')).toBe('a<bb>c');
    expect(regex('b').replace('abc', '[$&][$`][$\'][$_][$$]')).toBe('a[b][a][c][abc][$]c');
    expect(regex('(b)(c)').replace('abc', '$+')).toBe('ac');
    // A number that is not a group, a lone "$" and an unknown name stay as written.
    expect(regex('(b)').replace('abc', '$2 $10 ${x} $ $')).toBe('a$2 $10 ${x} $ $c');
    expect(regex('(b)').replace('abc', '${1}0')).toBe('ab0c');
    // No JS-only substitutions.
    expect(regex('(?<n>b)').replace('abc', '$<n>')).toBe('a$<n>c');
  });

  it('other translated constructs', () => {
    expect(regex('[]a]+').replace('x]a]y', '-')).toBe('x-y');
    expect(regex('a(?#comment)b').replace('ab', 'X')).toBe('X');
    expect(regex('\\x41\\u0042\\e').replace('AB\x1b', 'X')).toBe('X');
    expect(regex('b*').replace('abc', 'X')).toBe('XaXXcX');
    expect(regex('(?<=a)b(?!d)').replace('abc abd', 'X')).toBe('aXc abd');
  });

  it('reports what it cannot translate instead of throwing', () => {
    const reason = (p: string): string => {
      const r = compileDotnetRegex(p);
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason('(?>a)')).toContain('atomic');
    expect(reason('\\p{L}')).toContain('Unicode category');
    expect(reason('[a-z-[aeiou]]')).toContain('subtraction');
    expect(reason('(?x) a')).toContain('inline option "x"');
    expect(reason('a(?i)b')).toContain('only at the start');
    expect(reason('(?(1)a|b)')).toContain('conditional');
    expect(reason('(?<a-b>x)')).toContain('balancing');
    expect(reason('\\G')).toContain('\\G');
    expect(reason('(a)\\2')).toContain('undefined group 2');
    expect(reason('(')).not.toBe('ok');
    expect(reason('a{2,1}')).not.toBe('ok');
    expect(reason('\\y')).toContain('unknown escape');
  });
});
