/**
 * Validation fixes and mod cleanup on synthetic mods: each new check, each fix, one undo per batch,
 * save → reload gives the expected result, an untouched mod saves byte for byte, a clean mod has nothing to clean.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCleanup,
  applyFixPlan,
  buildGameSchema,
  cleanupOps,
  describeChangeset,
  emptyRecord,
  encodeText,
  firstDifference,
  FileType,
  issueFixes,
  issueKey,
  itemTypeId,
  ModContext,
  parseFcsDef,
  parseIgnoreList,
  planFixes,
  readDataFile,
  removalMarker,
  scanCleanup,
  serializeIgnoreList,
  validateMod,
  writeDataFile,
  type DataFile,
  type GameRecord,
  type Layer,
  type Reference,
  type ValidationIssue,
} from '../src/index.ts';

const CHAR = itemTypeId('CHARACTER')!;
const ITEM = itemTypeId('ITEM')!;
const DIALOGUE = itemTypeId('DIALOGUE')!;
const LINE = itemTypeId('DIALOGUE_LINE')!;
const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): Reference => ({ target, v0, v1, v2 });
const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });

function rec(type: number, sid: string, name: string, fill?: (r: GameRecord) => void): GameRecord {
  const r = emptyRecord(type, sid, encodeText(name));
  fill?.(r);
  return r;
}

const schema = buildGameSchema(
  parseFcsDef(
    [
      '[CHARACTER]',
      'money: 0',
      'unique: False',
      'vendors: ITEM (1,0,0)',
      'leader: CHARACTER SINGLE "the one leader"',
      '[ITEM]',
      'value: 0',
      '[DIALOGUE]',
      'lines: DIALOGUE_LINE',
      'OWNED: lines',
      '[DIALOGUE_LINE]',
      'text0: ""',
      'lines: DIALOGUE_LINE',
      '',
    ].join('\n'),
  ),
);

function layers(): Layer[] {
  return [
    {
      name: 'gamedata.base',
      file: file([
        rec(CHAR, 'A', 'Bandit', (r) => {
          r.ints.set('money', 10);
          r.refs.set('vendors', [ref('X', 1)]);
        }),
        rec(CHAR, 'B', 'Boss'),
        rec(ITEM, 'X', 'Sword', (r) => r.ints.set('value', 5)),
        rec(ITEM, 'Y', 'Shield'),
        rec(ITEM, 'G', 'Gone'),
      ]),
    },
    { name: 'dep.mod', file: file([removalMarker(rec(ITEM, 'G', 'Gone'))]) },
  ];
}

const make = (mod?: DataFile): ModContext => new ModContext({ layers: layers(), modName: 'fix.mod', schema, ...(mod ? { mod } : {}) });
const codes = (ctx: ModContext): string[] => validateMod(ctx, { inferFromLayers: false }).map((i) => `${i.code}:${i.stringId}:${i.key ?? ''}`).sort();
const reload = (ctx: ModContext): ModContext => make(readDataFile(writeDataFile(ctx.buildModFile())));
const only = (ctx: ModContext, code: string): ValidationIssue[] => validateMod(ctx, { inferFromLayers: false }).filter((i) => i.code === code);

describe('fcs.def modifiers', () => {
  it('SINGLE sets a limit of one, REQUIRED is kept, both case-insensitive', () => {
    const def = parseFcsDef(['[CHARACTER]', 'leader: CHARACTER SINGLE REQUIRED "x"', 'other: ITEM single', 'many: ITEM looped', ''].join('\n'));
    expect(def.warnings).toEqual([]);
    const f = def.sections[0]!.fields;
    expect(f.find((x) => x.name === 'leader')).toMatchObject({ limit: 1, required: true, description: 'x' });
    expect(f.find((x) => x.name === 'other')?.limit).toBe(1);
    expect(f.find((x) => x.name === 'many')?.limit).toBeUndefined();
  });
});

describe('new checks', () => {
  it('too many references: found, the extra ones are removed, one undo', () => {
    const ctx = make();
    ctx.addReference('A', 'leader', 'B');
    ctx.addReference('A', 'leader', 'A');
    expect(codes(ctx)).toEqual(['too-many-refs:A:leader']);
    const plan = planFixes(ctx, only(ctx, 'too-many-refs'));
    expect(plan.fixed.map((f) => f.fix.kind)).toEqual(['remove-ref']);
    const steps = ctx.history().undo.length;
    applyFixPlan(ctx, plan);
    expect(ctx.history().undo.length).toBe(steps + 1);
    expect(ctx.get('A')!.refs.get('leader')!.map((r) => r.target)).toEqual(['B']);
    expect(codes(ctx)).toEqual([]);
    expect(describeChangeset(ctx, ctx.history().undo.at(-1)!).text).toEqual({ ru: 'Исправлены ошибки проверки: 1', en: 'Fixed validation problems: 1', zh: '修复了检查问题：1' });
    ctx.undo();
    expect(codes(ctx)).toEqual(['too-many-refs:A:leader']);
  });

  it('type changed between layers: found, revert drops the change', () => {
    const ctx = make();
    ctx.editRecord('X', (d) => {
      d.type = CHAR;
    });
    expect(codes(ctx)).toContain('type-changed:X:');
    const fixes = issueFixes(ctx, only(ctx, 'type-changed')[0]!);
    expect(fixes.map((f) => f.kind)).toEqual(['revert']);
    applyFixPlan(ctx, planFixes(ctx, only(ctx, 'type-changed')));
    expect(ctx.status('X')).toBe('base');
    expect(only(ctx, 'type-changed')).toEqual([]);
  });

  it('id taken by a lower layer: a record saved as new; new id moves it and the mod references', () => {
    const base = make();
    base.createRecord(CHAR, 'Mine', { stringId: 'Own' });
    base.addReference('Own', 'vendors', 'X');
    const header = base.buildModFile();
    // The mod (format 16) creates "Y" — an id gamedata.base already has; its own record "Own" references it.
    const mine = rec(ITEM, 'Y', 'My shield', (r) => r.ints.set('value', 77));
    mine.changeFlags = 0x80000002;
    const own = header.records.find((r) => r.stringId === 'Own')!;
    own.refs.set('vendors', [ref('X'), ref('Y', 3)]);
    own.changeFlags = 0x80000002;
    const mod = readDataFile(writeDataFile({ ...header, fileType: FileType.Mod, records: [own, mine] }));
    const ctx = make(mod);
    expect(only(ctx, 'id-taken').map((i) => i.stringId)).toEqual(['Y']);
    expect(only(ctx, 'id-taken')[0]!.message).toContain('gamedata.base');
    const fixes = issueFixes(ctx, only(ctx, 'id-taken')[0]!);
    expect(fixes.map((f) => f.kind)).toEqual(['new-id', 'revert']);

    applyFixPlan(ctx, planFixes(ctx, only(ctx, 'id-taken')));
    const fresh = `${mod.lastId + 1}-fix.mod`;
    expect(ctx.get(fresh)!.ints.get('value')).toBe(77);
    expect(ctx.status(fresh)).toBe('new');
    expect(ctx.status('Y')).toBe('base');
    expect(ctx.get('Own')!.refs.get('vendors')).toEqual([ref('X'), ref(fresh, 3)]);
    expect(ctx.info.lastId).toBe(mod.lastId + 1);
    expect(only(ctx, 'id-taken')).toEqual([]);

    const back = reload(ctx);
    expect(back.get(fresh)!.ints.get('value')).toBe(77);
    expect(only(back, 'id-taken')).toEqual([]);
    ctx.undo();
    expect(only(ctx, 'id-taken').length).toBe(1);
  });

  it('records created in the editor are never "id taken"', () => {
    const ctx = make();
    ctx.putRecord('Y', rec(ITEM, 'Y', 'Shield', (r) => r.ints.set('value', 1)));
    expect(only(ctx, 'id-taken')).toEqual([]);
  });

  it('on vanilla-like data without SINGLE the new checks are silent', () => {
    const ctx = make();
    ctx.addReference('A', 'vendors', 'Y');
    ctx.setField('A', 'ints', 'money', 3);
    expect(codes(ctx)).toEqual([]);
  });
});

describe('fixes of the existing checks', () => {
  it('broken reference: remove it (recommended) or delete the new record', () => {
    const ctx = make();
    const n = ctx.createRecord(CHAR, 'New guy');
    ctx.addReference(n, 'vendors', 'nowhere');
    ctx.addReference('A', 'vendors', 'nowhere');
    const issues = only(ctx, 'broken-ref');
    expect(issues.map((i) => i.stringId).sort()).toEqual(['A', n].sort());
    expect(issueFixes(ctx, issues.find((i) => i.stringId === n)!).map((f) => f.kind)).toEqual(['remove-ref', 'remove-record']);
    expect(issueFixes(ctx, issues.find((i) => i.stringId === 'A')!).map((f) => f.kind)).toEqual(['remove-ref']);
    applyFixPlan(ctx, planFixes(ctx, issues));
    expect(only(ctx, 'broken-ref')).toEqual([]);
    expect(ctx.has(n)).toBe(true);
    // "Delete the record" for the new one; the other issue has no such fix and is skipped.
    ctx.undo();
    const plan = planFixes(ctx, only(ctx, 'broken-ref'), 'remove-record');
    expect(plan.fixed.map((f) => f.issue.stringId)).toEqual([n]);
    expect(plan.skipped.map((i) => i.stringId)).toEqual(['A']);
    applyFixPlan(ctx, plan);
    expect(ctx.has(n)).toBe(false);
  });

  it('a broken placed object is removed', () => {
    const ctx = make();
    ctx.setInstance('B', 'i1', { target: 'nowhere', position: [0, 0, 0], rotation: [1, 0, 0, 0], states: [] });
    const issues = only(ctx, 'broken-ref');
    expect(issues[0]!.key).toBe('instance:i1');
    applyFixPlan(ctx, planFixes(ctx, issues));
    expect(ctx.get('B')!.instances.size).toBe(0);
    expect(ctx.status('B')).toBe('base');
  });

  it('reference to a record the mod deleted: remove the reference or restore the target', () => {
    const ctx = make();
    ctx.addReference('B', 'vendors', 'Y');
    ctx.deleteRecord('Y');
    ctx.deleteRecord('X');
    // B (mod change) references Y; A (vanilla vendors) references X.
    const del = only(ctx, 'deleted-ref');
    const onB = del.find((i) => i.stringId === 'B')!;
    const onA = del.find((i) => i.stringId === 'A')!;
    expect(issueFixes(ctx, onB).map((f) => f.kind)).toEqual(['remove-ref', 'revert']);
    // The vanilla reference is not touched: only the mod's deletion can be undone.
    expect(issueFixes(ctx, onA).map((f) => f.kind)).toEqual(['revert']);
    applyFixPlan(ctx, planFixes(ctx, del));
    expect(ctx.has('X')).toBe(true);
    expect(ctx.get('B')!.refs.get('vendors') ?? []).toEqual([]);
    expect(only(ctx, 'deleted-ref')).toEqual([]);
  });

  it('wrong kind and unknown field: reset; unknown category on a new record is dropped', () => {
    const ctx = make();
    ctx.setField('A', 'floats', 'unique', 1);
    ctx.setField('A', 'ints', 'strange', 1);
    const n = ctx.createRecord(ITEM, 'Thing');
    ctx.addReference(n, 'weird', 'X');
    const issues = validateMod(ctx, { inferFromLayers: false }).filter((i) => i.code === 'wrong-kind' || i.code === 'unknown-field');
    expect(issues.map((i) => `${i.code}:${i.key}:${i.dict ?? ''}`).sort()).toEqual(['unknown-field:strange:ints', 'unknown-field:weird:', 'wrong-kind:unique:floats']);
    applyFixPlan(ctx, planFixes(ctx, issues));
    expect(codes(ctx)).toEqual([]);
    expect(ctx.status('A')).toBe('base');
    expect(ctx.get(n)!.refs.has('weird')).toBe(false);
  });

  it('warnings about the game\'s choice have no fix; ignore keys and the list round-trip', () => {
    const ctx = make();
    const d = ctx.createRecord(DIALOGUE, 'Silent');
    const issue = only(ctx, 'empty-dialogue').find((i) => i.stringId === d)!;
    expect(issueFixes(ctx, issue)).toEqual([]);
    const key = issueKey(issue);
    expect(key).toBe(`empty-dialogue|${d}|lines|`);
    const list = parseIgnoreList(serializeIgnoreList({ version: 1, ignored: [key, key] }));
    expect(list.ignored).toEqual([key]);
    expect(parseIgnoreList('not json').ignored).toEqual([]);
    expect(parseIgnoreList('{"version":2,"ignored":["x"]}').ignored).toEqual([]);
  });

  it('a fix batch saves and reloads as expected', () => {
    const ctx = make();
    ctx.addReference('A', 'vendors', 'nowhere');
    ctx.setField('A', 'ints', 'money', 99);
    applyFixPlan(ctx, planFixes(ctx, only(ctx, 'broken-ref')));
    const back = reload(ctx);
    expect(back.get('A')!.ints.get('money')).toBe(99);
    expect(back.get('A')!.refs.get('vendors')!.map((r) => r.target)).toEqual(['X']);
    expect(codes(back)).toEqual([]);
  });
});

describe('cleanup', () => {
  /** A mod with one item of every group. */
  function dirty(): { ctx: ModContext; line: string; used: string; odd: string } {
    const ctx = make();
    ctx.setField('A', 'ints', 'money', 50);
    ctx.setField('A', 'ints', 'strange', 1);
    const dlg = ctx.createRecord(DIALOGUE, 'Talk');
    const used = ctx.createRecord(LINE, 'used');
    ctx.addReference(dlg, 'lines', used);
    const line = ctx.createRecord(LINE, 'lost');
    ctx.addReference('B', 'vendors', 'nowhere');
    const odd = ctx.createRecord(itemTypeId('WEAPON')!, 'Untyped');
    return { ctx, line, used, odd };
  }

  it('a clean mod: nothing to clean', () => {
    const ctx = make();
    ctx.setField('A', 'ints', 'money', 5);
    const dlg = ctx.createRecord(DIALOGUE, 'Talk');
    ctx.addReference(dlg, 'lines', ctx.createRecord(LINE, 'hi'));
    expect(scanCleanup(ctx).items).toEqual([]);
    expect(applyCleanup(ctx, [])).toBeUndefined();
  });

  it('finds every group; the scan changes nothing', () => {
    const { ctx, line, used, odd } = dirty();
    // No-op values: written equal to the lower layer (as FCS does when a field is touched and put back).
    const mod = ctx.buildModFile();
    const a = mod.records.find((r) => r.stringId === 'A')!;
    a.ints.set('money', 10);
    a.ints.set('strange', 1);
    a.refs.set('vendors', [ref('X', 1)]);
    mod.records.push(rec(ITEM, 'G', 'Gone', (r) => r.ints.set('value', 3)));
    const loaded = make(readDataFile(writeDataFile(mod)));
    const before = writeDataFile(loaded.buildModFile());
    const scan = scanCleanup(loaded);
    expect(firstDifference(writeDataFile(loaded.buildModFile()), before)).toBe(-1);
    const by = (g: string): string[] => scan.items.filter((i) => i.group === g).map((i) => `${i.stringId}:${i.key ?? ''}`).sort();
    expect(by('obsolete-field')).toEqual(['A:strange']);
    expect(by('no-op')).toEqual(['A:money', 'A:vendors']);
    expect(by('deleted-base')).toEqual(['G:']);
    expect(by('orphaned')).toEqual([`${line}:DIALOGUE_LINE`]);
    expect(by('invalid-refs')).toEqual(['B:vendors']);
    expect(by('undefined-type')).toEqual([`${odd}:WEAPON`]);
    expect(scan.items.some((i) => i.stringId === used)).toBe(false);
    expect(scan.counts['no-op']).toBe(2);
  });

  it('applies only the chosen items, as one step; undo brings all back', () => {
    const { ctx, line, odd } = dirty();
    const scan = scanCleanup(ctx);
    const chosen = scan.items.filter((i) => i.group === 'orphaned' || i.group === 'invalid-refs');
    const steps = ctx.history().undo.length;
    const bytes = writeDataFile(ctx.buildModFile());
    applyCleanup(ctx, chosen);
    expect(ctx.history().undo.length).toBe(steps + 1);
    expect(describeChangeset(ctx, ctx.history().undo.at(-1)!).text.en).toBe('Mod cleanup: removed 2 items');
    expect(ctx.has(line)).toBe(false);
    expect(ctx.get('B')!.refs.get('vendors') ?? []).toEqual([]);
    // Not chosen — untouched.
    expect(ctx.has(odd)).toBe(true);
    expect(ctx.get('A')!.ints.get('strange')).toBe(1);
    const left = scanCleanup(ctx);
    expect(left.items.map((i) => i.group).sort()).toEqual(['obsolete-field', 'undefined-type']);
    ctx.undo();
    expect(firstDifference(writeDataFile(ctx.buildModFile()), bytes)).toBe(-1);
  });

  it('everything at once: field ops on a deleted record are dropped, save → reload is clean', () => {
    const { ctx } = dirty();
    const scan = scanCleanup(ctx);
    const ops = cleanupOps(scan.items);
    expect(ops.at(-1)!.op).toBe('delete');
    applyCleanup(ctx, scan.items);
    const back = reload(ctx);
    expect(scanCleanup(back).items).toEqual([]);
    expect(back.get('A')!.ints.get('money')).toBe(50);
  });

  it('an untouched loaded mod writes byte for byte', () => {
    const { ctx } = dirty();
    const bytes = writeDataFile(ctx.buildModFile());
    const loaded = make(readDataFile(bytes));
    scanCleanup(loaded);
    validateMod(loaded);
    for (const i of validateMod(loaded)) issueFixes(loaded, i);
    planFixes(loaded, validateMod(loaded));
    expect(firstDifference(writeDataFile(loaded.buildModFile()), bytes)).toBe(-1);
  });
});
