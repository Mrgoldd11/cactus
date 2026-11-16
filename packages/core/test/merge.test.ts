/**
 * Mod merging: change list (new / changed / deleted), field conflicts,
 * recursive selection and "fix references", "reject and hide", repeated merging,
 * undo as one edit, sidecar file and writing only the diff into the mod.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMerge,
  checkMergeSource,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  formatMergePlan,
  itemTypeId,
  MergeError,
  MergeLedger,
  mergeClosure,
  mergeFixReferences,
  ModContext,
  parseMergeStore,
  planMerge,
  readDataFile,
  recordFingerprint,
  rejectMerge,
  removalMarker,
  serializeMergeStore,
  unrejectMerge,
  writeDataFile,
  type DataFile,
  type GameRecord,
  type MergeSource,
} from '../src/index.ts';

const WEAPON = itemTypeId('WEAPON')!;
const DIALOGUE = itemTypeId('DIALOGUE')!;
const LINE = itemTypeId('DIALOGUE_LINE')!;

const NEW = 0x80000002;
const CHANGED = 0x80000001;

const modFile = (records: GameRecord[], deps = ''): DataFile => ({
  fileType: FileType.Mod,
  header: { version: 1, author: encodeText('src'), description: encodeText(''), dependencies: encodeText(deps), references: encodeText('') },
  lastId: 0,
  records,
  tail: new Uint8Array(),
});

function weapon(sid: string, name: string, value: number, flags = 0): GameRecord {
  const r = emptyRecord(WEAPON, sid, encodeText(name));
  r.ints.set('value', value);
  r.floats.set('cut damage multiplier', 1);
  r.changeFlags = flags;
  return r;
}

/** Change to a vanilla record in the source: only what changed. */
function weaponDelta(sid: string, name: string, fields: Record<string, number>): GameRecord {
  const r = emptyRecord(WEAPON, sid, encodeText(name));
  for (const [k, v] of Object.entries(fields)) r.ints.set(k, v);
  r.changeFlags = CHANGED;
  return r;
}

function line(sid: string, text: string, to: string[] = []): GameRecord {
  const r = emptyRecord(LINE, sid, encodeText(sid));
  r.strings.set('text0', encodeText(text));
  r.changeFlags = NEW;
  if (to.length) r.refs.set('lines', to.map((t) => ({ target: t, v0: 0, v1: 0, v2: 0 })));
  return r;
}

function dialogue(sid: string, to: string[]): GameRecord {
  const r = emptyRecord(DIALOGUE, sid, encodeText(sid));
  r.changeFlags = NEW;
  r.refs.set('lines', to.map((t) => ({ target: t, v0: 0, v1: 0, v2: 0 })));
  return r;
}

const vanilla = (): DataFile => ({
  fileType: FileType.Data,
  lastId: 0,
  records: [weapon('k', 'Katana', 100), weapon('s', 'Sabre', 80), weapon('c', 'Club', 10)],
  tail: new Uint8Array(),
});

function sourceMod(): MergeSource {
  return {
    name: 'Source.mod',
    file: modFile([
      weaponDelta('k', 'Katana', { value: 150 }),
      weaponDelta('s', 'Sabre', { value: 90 }),
      weapon('n1-Source.mod', 'Spear', 40, NEW),
      dialogue('d1-Source.mod', ['l1-Source.mod', 'l2-Source.mod']),
      line('l1-Source.mod', 'Hello', ['l2-Source.mod']),
      line('l2-Source.mod', 'Bye'),
      { ...removalMarker(weapon('c', 'Club', 10)), changeFlags: CHANGED },
    ]),
  };
}

function make(opts: { mine?: (ctx: ModContext) => void } = {}): { ctx: ModContext; ledger: MergeLedger } {
  const ctx = new ModContext({ layers: [{ name: 'gamedata.base', file: vanilla() }], modName: 'Mine.mod' });
  opts.mine?.(ctx);
  return { ctx, ledger: new MergeLedger() };
}

const kinds = (ctx: ModContext, src: MergeSource, ledger: MergeLedger, showRejected = false) =>
  planMerge(ctx, src, ledger, { showRejected }).changes.map((c) => `${c.kind}:${c.sid}`);

describe('merge: change list', () => {
  it('new, changed and deleted records; no conflicts if your mod is empty', () => {
    const { ctx, ledger } = make();
    const plan = planMerge(ctx, sourceMod(), ledger);
    expect(kinds(ctx, sourceMod(), ledger)).toEqual([
      'changed:k',
      'changed:s',
      'new:n1-Source.mod',
      'new:d1-Source.mod',
      'new:l1-Source.mod',
      'new:l2-Source.mod',
      'deleted:c',
    ]);
    expect(plan.counts).toMatchObject({ new: 4, changed: 2, deleted: 1, conflicts: 0 });
    const k = plan.changes[0]!;
    expect(k.fields).toHaveLength(1);
    expect(k.fields[0]).toMatchObject({ key: 'ints:value', before: '100', after: '150', conflict: false });
    // The preview changes nothing.
    expect(ctx.dirty).toBe(false);
    expect(ctx.get('k')!.ints.get('value')).toBe(100);
  });

  it('a source record equal to yours does not get into the list', () => {
    const { ctx, ledger } = make({ mine: (c) => { c.setField('k', 'ints', 'value', 150); } });
    expect(kinds(ctx, sourceMod(), ledger)).not.toContain('changed:k');
    expect(planMerge(ctx, sourceMod(), ledger).counts.identical).toBe(1);
  });

  it('the text report contains "was → will be" fields', () => {
    const { ctx, ledger } = make();
    const text = formatMergePlan(planMerge(ctx, sourceMod(), ledger)).join('\n');
    expect(text).toContain('new 4, changed 2, deleted 1');
    expect(formatMergePlan(planMerge(ctx, sourceMod(), ledger, { lang: 'ru' }), 30, 'ru').join('\n')).toContain('новых 4, изменённых 2, удалённых 1');
    expect(text).toContain('~ int value: 100 → 150');
  });
});

describe('merge: conflicts', () => {
  const edited = (c: ModContext): void => { c.setField('k', 'ints', 'value', 120); };

  it('both you and the source changed a field — conflict with both values', () => {
    const { ctx, ledger } = make({ mine: edited });
    const k = planMerge(ctx, sourceMod(), ledger).changes.find((c) => c.sid === 'k')!;
    expect(k.conflict).toBe('both');
    expect(k.fields[0]).toMatchObject({ before: '120', after: '150', conflict: true });
    // Another field of the same kind — not a conflict.
    const s = planMerge(ctx, sourceMod(), ledger).changes.find((c) => c.sid === 's')!;
    expect(s.conflict).toBeUndefined();
  });

  it('without a choice your value stays, with choice source — the source value', () => {
    const a = make({ mine: edited });
    const r1 = applyMerge(a.ctx, sourceMod(), a.ledger, { accept: ['k'] });
    expect(a.ctx.get('k')!.ints.get('value')).toBe(120);
    expect(r1).toMatchObject({ keptMine: 1, tookSource: 0 });

    const b = make({ mine: edited });
    const r2 = applyMerge(b.ctx, sourceMod(), b.ledger, { accept: ['k'], resolutions: { k: { 'ints:value': 'source' } } });
    expect(b.ctx.get('k')!.ints.get('value')).toBe(150);
    expect(r2).toMatchObject({ keptMine: 0, tookSource: 1 });

    const c = make({ mine: edited });
    applyMerge(c.ctx, sourceMod(), c.ledger, { accept: ['k'], conflicts: 'source' });
    expect(c.ctx.get('k')!.ints.get('value')).toBe(150);
  });

  it('you deleted a record, the source changes it — mine-deleted conflict; source brings the record back with the edit', () => {
    const { ctx, ledger } = make({ mine: (c) => { c.deleteRecord('s'); } });
    const s = planMerge(ctx, sourceMod(), ledger).changes.find((c) => c.sid === 's')!;
    expect(s.conflict).toBe('mine-deleted');
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: ['s'] });
    expect(r.keptMine).toBe(1);
    expect(ctx.has('s')).toBe(false);
    const b = make({ mine: (c) => { c.deleteRecord('s'); } });
    applyMerge(b.ctx, sourceMod(), b.ledger, { accept: ['s'], conflicts: 'source' });
    expect(b.ctx.get('s')!.ints.get('value')).toBe(90);
  });

  it('the source deletes a record you changed — source-deleted conflict', () => {
    const { ctx, ledger } = make({ mine: (c) => { c.setField('c', 'ints', 'value', 11); } });
    const c = planMerge(ctx, sourceMod(), ledger).changes.find((x) => x.sid === 'c')!;
    expect(c.conflict).toBe('source-deleted');
    applyMerge(ctx, sourceMod(), ledger, { accept: ['c'] });
    expect(ctx.has('c')).toBe(true);
    const b = make({ mine: (x) => { x.setField('c', 'ints', 'value', 11); } });
    applyMerge(b.ctx, sourceMod(), b.ledger, { accept: ['c'], conflicts: 'source' });
    expect(b.ctx.has('c')).toBe(false);
  });
});

describe('merge: record selection', () => {
  it('recursive selection of a dialogue takes all its lines', () => {
    const { ctx, ledger } = make();
    const plan = planMerge(ctx, sourceMod(), ledger);
    expect(mergeClosure(plan, ['d1-Source.mod'])).toEqual(['d1-Source.mod', 'l1-Source.mod', 'l2-Source.mod']);
    expect(mergeClosure(plan, ['l2-Source.mod'])).toEqual(['l2-Source.mod']);
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: ['d1-Source.mod'], recursive: true });
    expect(r.accepted).toEqual(['d1-Source.mod', 'l1-Source.mod', 'l2-Source.mod']);
    expect(r.addedByClosure).toEqual(['l1-Source.mod', 'l2-Source.mod']);
    expect(ctx.get('d1-Source.mod')!.refs.get('lines')!.map((x) => x.target)).toEqual(['l1-Source.mod', 'l2-Source.mod']);
  });

  it('"fix references" adds new records the accepted ones refer to', () => {
    const { ctx, ledger } = make();
    const plan = planMerge(ctx, sourceMod(), ledger);
    expect(mergeFixReferences(plan, ['d1-Source.mod'])).toEqual(['l1-Source.mod', 'l2-Source.mod']);
    // Changed records are not added via references: only new ones.
    expect(mergeFixReferences(plan, ['k'])).toEqual([]);
    const without = make();
    const r = applyMerge(without.ctx, sourceMod(), without.ledger, { accept: ['d1-Source.mod'] });
    expect(r.dangling).toEqual(['l1-Source.mod', 'l2-Source.mod']);
    const fixed = make();
    const r2 = applyMerge(fixed.ctx, sourceMod(), fixed.ledger, { accept: ['d1-Source.mod'], fixReferences: true });
    expect(r2.dangling).toEqual([]);
    expect(fixed.ctx.has('l2-Source.mod')).toBe(true);
  });

  it('unknown ids are skipped with a reason instead of breaking the merge', () => {
    const { ctx, ledger } = make();
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: ['k', 'нет-такой'] });
    expect(r.accepted).toEqual(['k']);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.sid).toBe('нет-такой');
  });
});

describe('merge: applying', () => {
  it('one undo for the whole merge; a clear step name; only the diff goes into the mod', () => {
    const { ctx, ledger } = make();
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: ['k', 's', 'n1-Source.mod', 'c'] });
    expect(r).toMatchObject({ created: 1, changed: 2, deleted: 1 });
    expect(ctx.history().undo).toHaveLength(1);
    const cs = ctx.history().undo[0]!;
    expect(describeChangeset(ctx, cs).text.ru).toBe('Слияние с «Source.mod»: записей 4');
    expect(describeChangeset(ctx, cs).text.en).toBe('Merge from “Source.mod”: 4 records');
    // Changed vanilla record in the mod — only the value field.
    const delta = ctx.delta('k')!;
    expect([...delta.ints.keys()]).toEqual(['value']);
    expect(delta.floats.size).toBe(0);
    expect(ctx.status('c')).toBe('deleted');
    expect(ctx.status('n1-Source.mod')).toBe('new');
    // Undo brings everything back.
    ctx.undo();
    expect(ctx.dirty).toBe(false);
    expect(ctx.modRecords()).toHaveLength(0);
    expect(ctx.get('k')!.ints.get('value')).toBe(100);
    // Redo — everything again.
    ctx.redo();
    expect(ctx.get('k')!.ints.get('value')).toBe(150);
  });

  it('a repeated merge changes nothing', () => {
    const { ctx, ledger } = make();
    const all = planMerge(ctx, sourceMod(), ledger).changes.map((c) => c.sid);
    applyMerge(ctx, sourceMod(), ledger, { accept: all });
    const before = JSON.stringify(ctx.modRecords().map((r) => recordFingerprint(r)));
    const again = planMerge(ctx, sourceMod(), ledger);
    expect(again.changes).toEqual([]);
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: all });
    expect(r.accepted).toEqual([]);
    expect(ctx.history().undo).toHaveLength(1);
    expect(JSON.stringify(ctx.modRecords().map((x) => recordFingerprint(x)))).toBe(before);
  });

  it('your own edits after a merge do not count as divergence while the source has not changed', () => {
    const { ctx, ledger } = make();
    applyMerge(ctx, sourceMod(), ledger, { accept: ['k'] });
    ctx.setField('k', 'ints', 'value', 175);
    expect(kinds(ctx, sourceMod(), ledger)).not.toContain('changed:k');
    // The source was updated — the record is in the list again, and it is a conflict (you changed it too).
    const updated: MergeSource = { name: 'Source.mod', file: modFile([weaponDelta('k', 'Katana', { value: 160 })]) };
    const k = planMerge(ctx, updated, ledger).changes.find((c) => c.sid === 'k')!;
    expect(k.conflict).toBe('both');
    expect(k.fields[0]).toMatchObject({ before: '175', after: '160' });
  });

  it('undoing a merge also undoes the "merged" mark', () => {
    const { ctx, ledger } = make();
    applyMerge(ctx, sourceMod(), ledger, { accept: ['k'] });
    expect(kinds(ctx, sourceMod(), ledger)).not.toContain('changed:k');
    ctx.undo();
    expect(kinds(ctx, sourceMod(), ledger)).toContain('changed:k');
    ctx.redo();
    expect(kinds(ctx, sourceMod(), ledger)).not.toContain('changed:k');
  });

  it('the result is written and read byte for byte, the values are the same', () => {
    const { ctx, ledger } = make();
    applyMerge(ctx, sourceMod(), ledger, { accept: planMerge(ctx, sourceMod(), ledger).changes.map((c) => c.sid) });
    const bytes = writeDataFile(ctx.buildModFile());
    const back = readDataFile(bytes);
    expect(Array.from(writeDataFile(back))).toEqual(Array.from(bytes));
    const ctx2 = new ModContext({ layers: [{ name: 'gamedata.base', file: vanilla() }], mod: back, modName: 'Mine.mod' });
    for (const sid of ['k', 's', 'n1-Source.mod', 'l1-Source.mod']) {
      expect(recordFingerprint(ctx2.get(sid)!)).toBe(recordFingerprint(ctx.get(sid)!));
    }
    expect(ctx2.has('c')).toBe(false);
  });

  it('a record that only changes another mod cannot be accepted', () => {
    const src: MergeSource = { name: 'Other.mod', file: modFile([weaponDelta('zzz-Dep.mod', 'Ghost', { value: 5 })], 'Dep.mod') };
    const { ctx, ledger } = make();
    const plan = planMerge(ctx, src, ledger);
    expect(plan.changes[0]!.blocked).toBeDefined();
    expect(plan.missingDependencies).toEqual(['Dep.mod']);
    const r = applyMerge(ctx, src, ledger, { accept: ['zzz-Dep.mod'] });
    expect(r.accepted).toEqual([]);
    expect(ctx.has('zzz-Dep.mod')).toBe(false);
  });

  it('level data is not merged: refused in the report, files are not touched', () => {
    const { ctx, ledger } = make();
    const levelData = { dir: 'x/leveldata', files: ['leveldata.level', 'zone.1.1.zone'] };
    const plan = planMerge(ctx, sourceMod(), ledger, { levelData });
    expect(plan.levelData?.files).toHaveLength(2);
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: ['k'], levelData: true }, { levelData });
    expect(r.notes.join(' ')).toContain('is not merged');
    expect(r.accepted).toEqual(['k']);
  });
});

describe('merge: reject and hide', () => {
  it('a rejected record is hidden, "show skipped" brings it back, unreject clears the mark', () => {
    const { ctx, ledger } = make();
    const src = sourceMod();
    expect(rejectMerge(ctx, src, ledger, ['s', 'нет-такой'])).toEqual(['s']);
    expect(kinds(ctx, src, ledger)).not.toContain('changed:s');
    expect(planMerge(ctx, src, ledger).counts.rejected).toBe(1);
    const shown = planMerge(ctx, src, ledger, { showRejected: true }).changes.find((c) => c.sid === 's')!;
    expect(shown.rejected).toBe(true);
    // A rejected one cannot be accepted until it is brought back.
    expect(applyMerge(ctx, src, ledger, { accept: ['s'] }, { showRejected: true }).skipped).toHaveLength(1);
    unrejectMerge(ledger, src, ['s']);
    expect(kinds(ctx, src, ledger)).toContain('changed:s');
  });

  it('if the source record changed after rejection, it shows in "show skipped" mode', () => {
    const { ctx, ledger } = make();
    rejectMerge(ctx, sourceMod(), ledger, ['s']);
    const updated: MergeSource = { name: 'Source.mod', file: modFile([weaponDelta('s', 'Sabre', { value: 95 })]) };
    expect(planMerge(ctx, updated, ledger).changes).toEqual([]);
    const shown = planMerge(ctx, updated, ledger, { showRejected: true }).changes[0]!;
    expect(shown.rejectedStale).toBe(true);
  });
});

describe('merge: source eligibility and sidecar file', () => {
  it('a dependency of the active mod and the mod itself cannot be merged — a clear message', () => {
    const { ctx } = make({ mine: (c) => { c.setModInfo({ dependencies: ['Dep.mod'] }); } });
    expect(() => { checkMergeSource(ctx, 'Dep.mod'); }).toThrow(MergeError);
    expect(() => { checkMergeSource(ctx, 'dep.MOD'); }).toThrow(/open as a dependency/);
    expect(() => { checkMergeSource(ctx, 'Mine.mod'); }).toThrow(/into itself/);
    expect(() => { checkMergeSource(ctx, 'gamedata.base'); }).toThrow(/dependency/);
    expect(() => { checkMergeSource(ctx, 'Free.mod'); }).not.toThrow();
    expect(() => planMerge(ctx, { name: 'Dep.mod', file: modFile([]) }, new MergeLedger())).toThrow(MergeError);
  });

  it('sidecar file: rejections and the log are saved, a broken file — a clear error', () => {
    const { ctx, ledger } = make();
    rejectMerge(ctx, sourceMod(), ledger, ['s']);
    applyMerge(ctx, sourceMod(), ledger, { accept: ['k'] });
    // Before saving the merge is not permanent yet.
    const store = ledger.commit(ctx);
    const text = serializeMergeStore(store);
    const back = parseMergeStore(text);
    expect(back.sources['source.mod']!.rejected['s']).toBeDefined();
    expect(Object.keys(back.sources['source.mod']!.baseline)).toEqual(['k']);
    expect(back.log).toHaveLength(1);
    expect(back.log[0]).toMatchObject({ source: 'Source.mod', accepted: 1, changed: 1 });
    // A reopened mod remembers the decisions.
    const fresh = new MergeLedger(back);
    expect(fresh.state(ctx, 'SOURCE.mod').rejected['s']).toBeDefined();
    expect(() => parseMergeStore('{не json')).toThrow(MergeError);
    expect(() => parseMergeStore('{"version":2,"sources":{}}')).toThrow(MergeError);
  });

  it('an undone merge does not get into the sidecar file on save', () => {
    const { ctx, ledger } = make();
    applyMerge(ctx, sourceMod(), ledger, { accept: ['k'] });
    ctx.undo();
    const store = ledger.commit(ctx);
    expect(store.log).toHaveLength(0);
    expect(store.sources['source.mod']?.baseline ?? {}).toEqual({});
  });
});
