import { describe, expect, it } from 'vitest';
import {
  findField,
  indexPoByRecord,
  parseFcsDef,
  parseFcsEnums,
  parseFcsLayout,
  parseGameSchema,
  parsePo,
  parsePoReference,
  poTranslationMap,
  walkLayout,
} from '../src/index.ts';

const FCS_DEF = [
  '[AI_TASK]',
  'general:',
  'enabled:      True "включено"',
  'priority:     5',
  'speed:        1.5 "скорость\\nв м/с"',
  'name:         "" multiline "текст с "кавычками" внутри"',
  'mesh:         "Ogre mesh|*.mesh" "модель"',
  'tex:          TEXTURE_DDS',
  'tint:         #FF8000',
  'kind:         taskType.IDLE "тип"',
  'next:         AI_TASK (0, 24,0) "следующая"',
  'lights:       LIGHT (0,0,0) (1,0,0,0) "свет"',
  'text0:        "" looped',
  'hidden:       null',
  'condition "speed" if "kind" not taskType.IDLE or taskType.WANDER',
  'OWNED:        next',
  '// комментарий',
  '[CHARACTER, ANIMAL_CHARACTER]',
  'TRANSLATE:    NAME if named is false',
].join('\r\n');

describe('fcs.def', () => {
  const def = parseFcsDef(FCS_DEF);
  const fields = new Map(def.sections[0]!.fields.map((f) => [f.name, f]));

  it('parses all kinds of values', () => {
    expect(def.warnings).toEqual([]);
    expect(fields.get('enabled')).toMatchObject({ kind: 'bool', default: true, category: 'general', description: 'включено' });
    expect(fields.get('priority')).toMatchObject({ kind: 'int', default: 5 });
    expect(fields.get('speed')).toMatchObject({ kind: 'float', default: 1.5, description: 'скорость\nв м/с' });
    expect(fields.get('name')).toMatchObject({ kind: 'string', default: '', multiline: true, description: 'текст с "кавычками" внутри' });
    expect(fields.get('mesh')).toMatchObject({ kind: 'file', fileFilter: 'Ogre mesh|*.mesh' });
    expect(fields.get('tex')).toMatchObject({ kind: 'file', fileFilter: 'TEXTURE_DDS' });
    expect(fields.get('tint')).toMatchObject({ kind: 'color', default: 0xff8000 });
    expect(fields.get('kind')).toMatchObject({ kind: 'enum', enumName: 'taskType', default: 'IDLE' });
    expect(fields.get('next')).toMatchObject({ kind: 'reference', targetType: 'AI_TASK', refDefaults: [0, 24, 0] });
    expect(fields.get('lights')).toMatchObject({ kind: 'instance', targetType: 'LIGHT', instanceDefaults: { position: [0, 0, 0], rotation: [1, 0, 0, 0] } });
    expect(fields.get('text0')).toMatchObject({ kind: 'string', looped: true });
    expect(fields.get('hidden')).toMatchObject({ kind: 'null' });
  });

  it('conditions, OWNED, TRANSLATE, sections for several types', () => {
    const s = def.sections[0]!;
    expect(s.conditions).toEqual([{ field: 'speed', dependsOn: 'kind', negate: true, values: ['taskType.IDLE', 'taskType.WANDER'], line: 15 }]);
    expect(s.owned).toEqual([{ category: 'next', line: 16 }]);
    expect(def.sections[1]!.types).toEqual(['CHARACTER', 'ANIMAL_CHARACTER']);
    expect(def.sections[1]!.translate).toEqual([{ mode: 'NAME', condition: 'named is false', line: 19 }]);
  });

  it('warns about unparsed lines', () => {
    const bad = parseFcsDef('[ITEM]\nfoo: ???\nbar baz\n');
    expect(bad.warnings.map((w) => w.line)).toEqual([2, 3]);
  });
});

describe('fcs_enums.def', () => {
  it('values, =N, groups, descriptions, one-line enums', () => {
    const e = parseFcsEnums(
      [
        'enum Axis { X, Y, Z }',
        'enum shared taskType {',
        '    //BASIC',
        '    NULL_TASK = -1,',
        '    IDLE,           // стоять',
        '    WANDER,',
        '    //OTHER',
        '    FAR=100,',
        '};',
        'enum SquadFormation   { RANDOM, CARAVAN. MILITARY }',
      ].join('\n'),
    );
    expect(e.enums.get('Axis')!.values.map((v) => [v.name, v.value])).toEqual([['X', 0], ['Y', 1], ['Z', 2]]);
    const t = e.enums.get('taskType')!;
    expect(t.shared).toBe(true);
    expect(t.values).toEqual([
      { name: 'NULL_TASK', value: -1, group: 'BASIC' },
      { name: 'IDLE', value: 0, group: 'BASIC', description: 'стоять' },
      { name: 'WANDER', value: 1, group: 'BASIC' },
      { name: 'FAR', value: 100, group: 'OTHER' },
    ]);
    expect(e.enums.get('SquadFormation')!.values.map((v) => v.name)).toEqual(['RANDOM', 'CARAVAN', 'MILITARY']);
    expect(e.warnings).toHaveLength(1);
  });
});

describe('fcs_layout.def', () => {
  it('tree by tabs and filters', () => {
    const l = parseFcsLayout(
      '[FCS_LAYOUT]\r\nBuildings :   BUILDING "building category!=DOORS;is node=false"\r\n\tDoors:  BUILDING "building category==DOORS"\r\n\t\tParts:  BUILDING_PART\r\n\tLights: LIGHT\r\n\r\nEverything: NULL_ITEM\r\n',
    );
    expect(l.warnings).toEqual([]);
    expect(l.roots.map((r) => r.label)).toEqual(['Buildings', 'Everything']);
    const b = l.roots[0]!;
    expect(b.filters).toEqual([
      { field: 'building category', op: '!=', value: 'DOORS' },
      { field: 'is node', op: '==', value: 'false' },
    ]);
    expect(b.children.map((c) => c.label)).toEqual(['Doors', 'Lights']);
    expect(b.children[0]!.children[0]!.type).toBe('BUILDING_PART');
    expect([...walkLayout(l.roots)]).toHaveLength(5);
  });
});

describe('gamedata.po', () => {
  const po = parsePo(
    [
      'msgid ""',
      'msgstr ""',
      '"Language: ru_RU\\n"',
      '"Plural-Forms: nplurals=3;\\n"',
      '',
      '#. Type: BUILDING',
      '#. Name: Ancient Citadel',
      '#: 5316-TwoStorey.mod:0 96391-Dialogue.mod:6',
      '#, fuzzy',
      'msgid "A bad "',
      '"place"',
      'msgstr "Скверное \\"место\\""',
      '',
      '#: 5316-TwoStorey.mod',
      'msgid "Ancient Citadel"',
      'msgstr "Древняя цитадель"',
      '',
      '#~ msgid "Old"',
      '#~ msgstr "Старое"',
      '#~| msgid "Older"',
      '',
    ].join('\n'),
  );

  it('records, multi-line strings, escaping, obsolete ones', () => {
    expect(po.warnings).toEqual([]);
    expect(po.headers.get('Language')).toBe('ru_RU');
    expect(po.entries).toHaveLength(3);
    const [first, second, old] = po.entries;
    expect(first).toMatchObject({ msgid: 'A bad place', msgstr: ['Скверное "место"'], flags: ['fuzzy'], line: 6 });
    expect(first!.references).toEqual(['5316-TwoStorey.mod:0', '96391-Dialogue.mod:6']);
    expect(second!.msgstr).toEqual(['Древняя цитадель']);
    expect(old).toMatchObject({ msgid: 'Old', obsolete: true });
    expect(poTranslationMap(po).get('Old')).toBeUndefined();
  });

  it('index by record string ids', () => {
    expect(parsePoReference('5316-TwoStorey.mod:12')).toEqual({ stringId: '5316-TwoStorey.mod', field: 12 });
    const idx = indexPoByRecord(po);
    const rec = idx.get('5316-TwoStorey.mod')!;
    expect(rec.type).toBe('BUILDING');
    expect(rec.name?.msgstr[0]).toBe('Древняя цитадель');
    expect(rec.fields.get(0)?.msgid).toBe('A bad place');
    expect(idx.get('96391-Dialogue.mod')!.fields.has(6)).toBe(true);
  });
});

describe('schema assembly', () => {
  it('merges sections, finds repeated fields, checks enums and filters', () => {
    const s = parseGameSchema({
      fcsDef: `${FCS_DEF}\n[AI_TASK]\nextra: 1\nkind: NoSuchEnum.X\n`,
      fcsEnums: 'enum taskType { IDLE, WANDER }',
      fcsLayout: 'Tasks: AI_TASK "enabled==true;nofield==1"\n',
    });
    const t = s.types.get('AI_TASK')!;
    expect(t.sectionLines).toHaveLength(2);
    expect(t.fields.has('extra')).toBe(true);
    expect(findField(t, 'text7')?.name).toBe('text0');
    expect(findField(t, 'priority7')).toBeUndefined();
    expect(s.types.get('ANIMAL_CHARACTER')!.translate).toHaveLength(1);
    const messages = s.warnings.map((w) => w.message);
    expect(messages.some((m) => m.includes('kind: повтор поля'))).toBe(true);
    expect(messages.some((m) => m.includes('nofield'))).toBe(true);
    expect(s.externalEnums.size).toBe(0);
  });
});
