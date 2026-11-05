/**
 * Смысловая разница двух состояний записи (или двух файлов): какие поля, ссылки и объекты
 * добавлены, изменены или убраны. Порядок ключей не важен; порядок ссылок в категории не
 * считается изменением, если набор ссылок и их значения те же.
 */
import { bytesEqual } from '../text.ts';
import { emptyRecord, type DataFile, type GameRecord, type Instance, type Reference } from '../format/types.ts';
import { instanceEqual, refValuesEqual, SCALAR_DICTS, scalarEqual, scalarMap, type ScalarDict, type ScalarValue } from './record-ops.ts';

export type FieldChange =
  | { kind: 'name'; before: Uint8Array; after: Uint8Array }
  | { kind: 'type'; before: number; after: number }
  | { kind: 'flags'; before: number; after: number }
  | { kind: 'field'; dict: ScalarDict; key: string; before?: ScalarValue; after?: ScalarValue }
  | { kind: 'ref'; category: string; target: string; before?: Reference; after?: Reference }
  | { kind: 'refOrder'; category: string; before: string[]; after: string[] }
  | { kind: 'instance'; key: string; before?: Instance; after?: Instance };

export interface RecordDiff {
  stringId: string;
  /** added — записи не было; removed — запись исчезла; changed — поменялось содержимое. */
  change: 'added' | 'removed' | 'changed';
  before?: GameRecord;
  after?: GameRecord;
  fields: FieldChange[];
}

/** Разница двух состояний записи; undefined, если они одинаковы. */
export function diffRecordStates(before: GameRecord | undefined, after: GameRecord | undefined): RecordDiff | undefined {
  if (!before && !after) return undefined;
  const stringId = (after ?? before)!.stringId;
  const a = before ?? emptyRecord(after!.type, stringId);
  const b = after ?? emptyRecord(before!.type, stringId);
  const fields: FieldChange[] = [];
  if (!bytesEqual(a.name, b.name)) fields.push({ kind: 'name', before: a.name, after: b.name });
  if (before && after && a.type !== b.type) fields.push({ kind: 'type', before: a.type, after: b.type });
  for (const dict of SCALAR_DICTS) {
    const x = scalarMap(a, dict);
    const y = scalarMap(b, dict);
    for (const [k, v] of y) {
      const old = x.get(k);
      if (!scalarEqual(old, v)) fields.push(old === undefined ? { kind: 'field', dict, key: k, after: v } : { kind: 'field', dict, key: k, before: old, after: v });
    }
    for (const [k, v] of x) if (!y.has(k)) fields.push({ kind: 'field', dict, key: k, before: v });
  }
  const cats = new Set([...a.refs.keys(), ...b.refs.keys()]);
  for (const cat of cats) {
    const x = a.refs.get(cat) ?? [];
    const y = b.refs.get(cat) ?? [];
    const xm = firstByTarget(x);
    const ym = firstByTarget(y);
    let setChanged = false;
    for (const [t, r] of ym) {
      const old = xm.get(t);
      if (!old) {
        fields.push({ kind: 'ref', category: cat, target: t, after: r });
        setChanged = true;
      } else if (!refValuesEqual(old, r)) fields.push({ kind: 'ref', category: cat, target: t, before: old, after: r });
    }
    for (const [t, r] of xm) {
      if (!ym.has(t)) {
        fields.push({ kind: 'ref', category: cat, target: t, before: r });
        setChanged = true;
      }
    }
    const xo = x.map((r) => r.target);
    const yo = y.map((r) => r.target);
    if (!setChanged && (xo.length !== yo.length || xo.some((t, i) => t !== yo[i]))) {
      fields.push({ kind: 'refOrder', category: cat, before: xo, after: yo });
    }
  }
  for (const [k, v] of b.instances) {
    const old = a.instances.get(k);
    if (!old || !instanceEqual(old, v)) fields.push(old ? { kind: 'instance', key: k, before: old, after: v } : { kind: 'instance', key: k, after: v });
  }
  for (const [k, v] of a.instances) if (!b.instances.has(k)) fields.push({ kind: 'instance', key: k, before: v });
  if (before && after && fields.length === 0) return undefined;
  const out: RecordDiff = { stringId, change: !before ? 'added' : !after ? 'removed' : 'changed', fields };
  if (before) out.before = before;
  if (after) out.after = after;
  return out;
}

/** Ссылки категории по цели; повторы одной цели отмечаются отдельно как изменение порядка/набора. */
function firstByTarget(list: readonly Reference[]): Map<string, Reference> {
  const m = new Map<string, Reference>();
  const counts = new Map<string, number>();
  for (const r of list) {
    const n = (counts.get(r.target) ?? 0) + 1;
    counts.set(r.target, n);
    m.set(n === 1 ? r.target : `${r.target}#${n}`, r);
  }
  return m;
}

/**
 * Смысловая разница двух файлов (по записям с одинаковым строковым id), включая флаги изменения. Сравниваются записи как
 * они лежат в файлах (изменения мода, а не итог наложения). Порядок — как во втором файле, затем
 * исчезнувшие записи из первого.
 */
export function diffDataFiles(a: DataFile, b: DataFile): RecordDiff[] {
  const am = new Map(a.records.map((r) => [r.stringId, r]));
  const bm = new Map(b.records.map((r) => [r.stringId, r]));
  const out: RecordDiff[] = [];
  for (const [sid, r] of bm) {
    const old = am.get(sid);
    let d = diffRecordStates(old, r);
    if (old && old.changeFlags !== r.changeFlags) {
      d ??= { stringId: sid, change: 'changed', before: old, after: r, fields: [] };
      d.fields.unshift({ kind: 'flags', before: old.changeFlags, after: r.changeFlags });
    }
    if (d) out.push(d);
  }
  for (const [sid, r] of am) if (!bm.has(sid)) out.push(diffRecordStates(r, undefined)!);
  return out;
}

export type DiffChange = RecordDiff['change'];
export const DIFF_CHANGES: readonly DiffChange[] = ['added', 'changed', 'removed'];

const DIFF_CHANGE_ALIASES: Record<string, DiffChange> = {
  added: 'added',
  new: 'added',
  changed: 'changed',
  removed: 'removed',
  deleted: 'removed',
};

/** `added,changed` (или new/deleted, как статусы записей) → список изменений. */
export function parseDiffStatuses(text: string): DiffChange[] {
  return text
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '')
    .map((s) => {
      const c = DIFF_CHANGE_ALIASES[s];
      if (!c) throw new Error(`Неизвестный статус разницы «${s}»: added, changed, removed`);
      return c;
    });
}

export function filterDiffs(diffs: readonly RecordDiff[], changes?: readonly DiffChange[]): RecordDiff[] {
  if (!changes || changes.length === 0) return [...diffs];
  const set = new Set(changes);
  return diffs.filter((d) => set.has(d.change));
}

export function countDiffs(diffs: readonly RecordDiff[]): Record<DiffChange, number> {
  const out: Record<DiffChange, number> = { added: 0, changed: 0, removed: 0 };
  for (const d of diffs) out[d.change]++;
  return out;
}

/** `всего 2950: новых 2628, изменённых 322, удалённых 0`. */
export function formatDiffSummary(diffs: readonly RecordDiff[]): string {
  const n = countDiffs(diffs);
  return `всего ${diffs.length}: новых ${n.added}, изменённых ${n.changed}, удалённых ${n.removed}`;
}
