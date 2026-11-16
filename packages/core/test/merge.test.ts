/**
 * Слияние модов: список изменений (новые / изменённые / удалённые), конфликты по полям,
 * рекурсивный выбор и «исправить ссылки», «отклонить и не показывать», повторное слияние,
 * отмена одной правкой, файл-спутник и запись в мод только разницы.
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

/** Изменение записи ванили в источнике: только то, что поменялось. */
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

describe('слияние: список изменений', () => {
  it('новые, изменённые и удалённые записи; конфликтов нет, если ваш мод пуст', () => {
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
    // Предпросмотр ничего не меняет.
    expect(ctx.dirty).toBe(false);
    expect(ctx.get('k')!.ints.get('value')).toBe(100);
  });

  it('запись источника, совпадающая с вашей, в список не попадает', () => {
    const { ctx, ledger } = make({ mine: (c) => { c.setField('k', 'ints', 'value', 150); } });
    expect(kinds(ctx, sourceMod(), ledger)).not.toContain('changed:k');
    expect(planMerge(ctx, sourceMod(), ledger).counts.identical).toBe(1);
  });

  it('текстовый отчёт содержит поля «было → станет»', () => {
    const { ctx, ledger } = make();
    const text = formatMergePlan(planMerge(ctx, sourceMod(), ledger)).join('\n');
    expect(text).toContain('new 4, changed 2, deleted 1');
    expect(formatMergePlan(planMerge(ctx, sourceMod(), ledger, { lang: 'ru' }), 30, 'ru').join('\n')).toContain('новых 4, изменённых 2, удалённых 1');
    expect(text).toContain('~ int value: 100 → 150');
  });
});

describe('слияние: конфликты', () => {
  const edited = (c: ModContext): void => { c.setField('k', 'ints', 'value', 120); };

  it('поле меняли и вы, и источник — конфликт с обоими значениями', () => {
    const { ctx, ledger } = make({ mine: edited });
    const k = planMerge(ctx, sourceMod(), ledger).changes.find((c) => c.sid === 'k')!;
    expect(k.conflict).toBe('both');
    expect(k.fields[0]).toMatchObject({ before: '120', after: '150', conflict: true });
    // Другое поле того же рода — не конфликт.
    const s = planMerge(ctx, sourceMod(), ledger).changes.find((c) => c.sid === 's')!;
    expect(s.conflict).toBeUndefined();
  });

  it('без выбора остаётся ваше значение, с выбором source — значение источника', () => {
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

  it('вы удалили запись, источник её меняет — конфликт mine-deleted; source возвращает запись с правкой', () => {
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

  it('источник удаляет запись, которую вы меняли — конфликт source-deleted', () => {
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

describe('слияние: выбор записей', () => {
  it('рекурсивный выбор диалога берёт все его реплики', () => {
    const { ctx, ledger } = make();
    const plan = planMerge(ctx, sourceMod(), ledger);
    expect(mergeClosure(plan, ['d1-Source.mod'])).toEqual(['d1-Source.mod', 'l1-Source.mod', 'l2-Source.mod']);
    expect(mergeClosure(plan, ['l2-Source.mod'])).toEqual(['l2-Source.mod']);
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: ['d1-Source.mod'], recursive: true });
    expect(r.accepted).toEqual(['d1-Source.mod', 'l1-Source.mod', 'l2-Source.mod']);
    expect(r.addedByClosure).toEqual(['l1-Source.mod', 'l2-Source.mod']);
    expect(ctx.get('d1-Source.mod')!.refs.get('lines')!.map((x) => x.target)).toEqual(['l1-Source.mod', 'l2-Source.mod']);
  });

  it('«исправить ссылки» добавляет новые записи, на которые ссылаются принятые', () => {
    const { ctx, ledger } = make();
    const plan = planMerge(ctx, sourceMod(), ledger);
    expect(mergeFixReferences(plan, ['d1-Source.mod'])).toEqual(['l1-Source.mod', 'l2-Source.mod']);
    // Изменённые записи по ссылкам не добавляются: только новые.
    expect(mergeFixReferences(plan, ['k'])).toEqual([]);
    const without = make();
    const r = applyMerge(without.ctx, sourceMod(), without.ledger, { accept: ['d1-Source.mod'] });
    expect(r.dangling).toEqual(['l1-Source.mod', 'l2-Source.mod']);
    const fixed = make();
    const r2 = applyMerge(fixed.ctx, sourceMod(), fixed.ledger, { accept: ['d1-Source.mod'], fixReferences: true });
    expect(r2.dangling).toEqual([]);
    expect(fixed.ctx.has('l2-Source.mod')).toBe(true);
  });

  it('неизвестные id пропускаются с причиной, а не ломают слияние', () => {
    const { ctx, ledger } = make();
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: ['k', 'нет-такой'] });
    expect(r.accepted).toEqual(['k']);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.sid).toBe('нет-такой');
  });
});

describe('слияние: применение', () => {
  it('одна отмена на всё слияние; название шага понятное; в мод пишется только разница', () => {
    const { ctx, ledger } = make();
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: ['k', 's', 'n1-Source.mod', 'c'] });
    expect(r).toMatchObject({ created: 1, changed: 2, deleted: 1 });
    expect(ctx.history().undo).toHaveLength(1);
    const cs = ctx.history().undo[0]!;
    expect(describeChangeset(ctx, cs).text.ru).toBe('Слияние с «Source.mod»: записей 4');
    expect(describeChangeset(ctx, cs).text.en).toBe('Merge from “Source.mod”: 4 records');
    // Изменённая запись ванили в моде — только поле value.
    const delta = ctx.delta('k')!;
    expect([...delta.ints.keys()]).toEqual(['value']);
    expect(delta.floats.size).toBe(0);
    expect(ctx.status('c')).toBe('deleted');
    expect(ctx.status('n1-Source.mod')).toBe('new');
    // Отмена возвращает всё.
    ctx.undo();
    expect(ctx.dirty).toBe(false);
    expect(ctx.modRecords()).toHaveLength(0);
    expect(ctx.get('k')!.ints.get('value')).toBe(100);
    // Повтор — снова всё.
    ctx.redo();
    expect(ctx.get('k')!.ints.get('value')).toBe(150);
  });

  it('повторное слияние ничего не меняет', () => {
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

  it('свои правки после слияния не считаются расхождением, пока источник не менялся', () => {
    const { ctx, ledger } = make();
    applyMerge(ctx, sourceMod(), ledger, { accept: ['k'] });
    ctx.setField('k', 'ints', 'value', 175);
    expect(kinds(ctx, sourceMod(), ledger)).not.toContain('changed:k');
    // Источник обновился — запись снова в списке, и это конфликт (вы тоже её меняли).
    const updated: MergeSource = { name: 'Source.mod', file: modFile([weaponDelta('k', 'Katana', { value: 160 })]) };
    const k = planMerge(ctx, updated, ledger).changes.find((c) => c.sid === 'k')!;
    expect(k.conflict).toBe('both');
    expect(k.fields[0]).toMatchObject({ before: '175', after: '160' });
  });

  it('отмена слияния отменяет и пометку «слито»', () => {
    const { ctx, ledger } = make();
    applyMerge(ctx, sourceMod(), ledger, { accept: ['k'] });
    expect(kinds(ctx, sourceMod(), ledger)).not.toContain('changed:k');
    ctx.undo();
    expect(kinds(ctx, sourceMod(), ledger)).toContain('changed:k');
    ctx.redo();
    expect(kinds(ctx, sourceMod(), ledger)).not.toContain('changed:k');
  });

  it('результат записывается и читается байт в байт, значения те же', () => {
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

  it('запись, которая лишь меняет чужой мод, принять нельзя', () => {
    const src: MergeSource = { name: 'Other.mod', file: modFile([weaponDelta('zzz-Dep.mod', 'Ghost', { value: 5 })], 'Dep.mod') };
    const { ctx, ledger } = make();
    const plan = planMerge(ctx, src, ledger);
    expect(plan.changes[0]!.blocked).toBeDefined();
    expect(plan.missingDependencies).toEqual(['Dep.mod']);
    const r = applyMerge(ctx, src, ledger, { accept: ['zzz-Dep.mod'] });
    expect(r.accepted).toEqual([]);
    expect(ctx.has('zzz-Dep.mod')).toBe(false);
  });

  it('данные уровня не сливаются: отказ в отчёте, файлы не трогаются', () => {
    const { ctx, ledger } = make();
    const levelData = { dir: 'x/leveldata', files: ['leveldata.level', 'zone.1.1.zone'] };
    const plan = planMerge(ctx, sourceMod(), ledger, { levelData });
    expect(plan.levelData?.files).toHaveLength(2);
    const r = applyMerge(ctx, sourceMod(), ledger, { accept: ['k'], levelData: true }, { levelData });
    expect(r.notes.join(' ')).toContain('is not merged');
    expect(r.accepted).toEqual(['k']);
  });
});

describe('слияние: отклонить и не показывать', () => {
  it('отклонённая запись скрыта, «показать пропущенные» её возвращает, unreject — снимает отметку', () => {
    const { ctx, ledger } = make();
    const src = sourceMod();
    expect(rejectMerge(ctx, src, ledger, ['s', 'нет-такой'])).toEqual(['s']);
    expect(kinds(ctx, src, ledger)).not.toContain('changed:s');
    expect(planMerge(ctx, src, ledger).counts.rejected).toBe(1);
    const shown = planMerge(ctx, src, ledger, { showRejected: true }).changes.find((c) => c.sid === 's')!;
    expect(shown.rejected).toBe(true);
    // Принять отклонённую нельзя, пока её не вернули.
    expect(applyMerge(ctx, src, ledger, { accept: ['s'] }, { showRejected: true }).skipped).toHaveLength(1);
    unrejectMerge(ledger, src, ['s']);
    expect(kinds(ctx, src, ledger)).toContain('changed:s');
  });

  it('если запись источника изменилась после отклонения, это видно в режиме «показать пропущенные»', () => {
    const { ctx, ledger } = make();
    rejectMerge(ctx, sourceMod(), ledger, ['s']);
    const updated: MergeSource = { name: 'Source.mod', file: modFile([weaponDelta('s', 'Sabre', { value: 95 })]) };
    expect(planMerge(ctx, updated, ledger).changes).toEqual([]);
    const shown = planMerge(ctx, updated, ledger, { showRejected: true }).changes[0]!;
    expect(shown.rejectedStale).toBe(true);
  });
});

describe('слияние: допустимость источника и файл-спутник', () => {
  it('зависимость активного мода и сам мод слить нельзя — понятное сообщение', () => {
    const { ctx } = make({ mine: (c) => { c.setModInfo({ dependencies: ['Dep.mod'] }); } });
    expect(() => { checkMergeSource(ctx, 'Dep.mod'); }).toThrow(MergeError);
    expect(() => { checkMergeSource(ctx, 'dep.MOD'); }).toThrow(/open as a dependency/);
    expect(() => { checkMergeSource(ctx, 'Mine.mod'); }).toThrow(/into itself/);
    expect(() => { checkMergeSource(ctx, 'gamedata.base'); }).toThrow(/dependency/);
    expect(() => { checkMergeSource(ctx, 'Free.mod'); }).not.toThrow();
    expect(() => planMerge(ctx, { name: 'Dep.mod', file: modFile([]) }, new MergeLedger())).toThrow(MergeError);
  });

  it('файл-спутник: отклонённые и журнал сохраняются, битый файл — понятная ошибка', () => {
    const { ctx, ledger } = make();
    rejectMerge(ctx, sourceMod(), ledger, ['s']);
    applyMerge(ctx, sourceMod(), ledger, { accept: ['k'] });
    // До сохранения слияние ещё не постоянное.
    const store = ledger.commit(ctx);
    const text = serializeMergeStore(store);
    const back = parseMergeStore(text);
    expect(back.sources['source.mod']!.rejected['s']).toBeDefined();
    expect(Object.keys(back.sources['source.mod']!.baseline)).toEqual(['k']);
    expect(back.log).toHaveLength(1);
    expect(back.log[0]).toMatchObject({ source: 'Source.mod', accepted: 1, changed: 1 });
    // Заново открытый мод помнит решения.
    const fresh = new MergeLedger(back);
    expect(fresh.state(ctx, 'SOURCE.mod').rejected['s']).toBeDefined();
    expect(() => parseMergeStore('{не json')).toThrow(MergeError);
    expect(() => parseMergeStore('{"version":2,"sources":{}}')).toThrow(MergeError);
  });

  it('отменённое слияние не попадает в файл-спутник при сохранении', () => {
    const { ctx, ledger } = make();
    applyMerge(ctx, sourceMod(), ledger, { accept: ['k'] });
    ctx.undo();
    const store = ledger.commit(ctx);
    expect(store.log).toHaveLength(0);
    expect(store.sources['source.mod']?.baseline ?? {}).toEqual({});
  });
});
