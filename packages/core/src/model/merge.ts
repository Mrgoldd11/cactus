/**
 * Mod merging (like "Merge" in FCS): carrying changes from another mod into the edited one.
 *
 * The source is a whole mod (or .base) file. For each of its records we compute what it
 * would change in your mod: the source record is a layer overlaid on top of your
 * resulting data (`applyLayer`), and the difference with the current state is the "change":
 *  - `new`: the record is neither in your mod nor in its dependencies;
 *  - `changed`: the record exists and its fields differ (list of fields "was → will be");
 *  - `deleted`: the source deletes a record you have.
 *
 * The selected changes are applied as one edit (`ctx.transaction`: one undo, one step
 * title); only the difference with the lower layers is written into the mod, via `ModContext.putRecord`.
 *
 * Decisions are stored separately from the .mod, in a sidecar file (`MergeStore`, see `node/merge-store.ts`):
 *  - "reject": the record is no longer shown in later merges of this mod;
 *  - "merged": a fingerprint of the source record at merge time: if the source record has not
 *    changed since, your edits to it do not count as a divergence;
 *  - log: with which mod and when it was merged.
 * "Accept" and "ignore" (default) are decisions of one session; they are passed to `applyMerge`.
 *
 * A conflict is a field changed both by your mod (relative to the lower layers) and by the source: both values
 * are visible, `source` or `mine` is chosen; an unchosen one counts as `mine` (your data is not lost).
 *
 * The editor can neither read level data (`leveldata/*.zone`, `leveldata.level`, `interiors.level`)
 * for writing nor write it: merging only detects it and honestly refuses
 * (`MERGE_LEVEL_DATA_NOTE`); the files are not touched.
 */
import { bytesEqual, decodeText } from '../text.ts';
import { splitModList } from '../format/helpers.ts';
import { FileType, type DataFile, type GameRecord } from '../format/types.ts';
import type { ModContext } from './context.ts';
import { diffRecordStates, type FieldChange } from './diff.ts';
import { formatFieldChange, formatFieldValue, formatRefValues, refLabel } from './present.ts';
import { applyLayer, cloneRecord, isRemovalMarker, isRemovedRef, refValuesEqual, SCALAR_DICTS, scalarEqual, scalarMap } from './record-ops.ts';
import { UiTextError } from '../ui-text.ts';

/** Merge error with a readable message (this mod cannot be merged, bad sidecar file…). */
export class MergeError extends UiTextError {
  override name = 'MergeError';
}

export type MergeKind = 'new' | 'changed' | 'deleted';
export const MERGE_KINDS: readonly MergeKind[] = ['new', 'changed', 'deleted'];

/** Why the change is a conflict. */
export type MergeConflictReason =
  /** Both your mod and the source changed the field, the values differ. */
  | 'both'
  /** You deleted the record, the source changes it. */
  | 'mine-deleted'
  /** The source deletes a record you changed. */
  | 'source-deleted';

export type MergeChoice = 'source' | 'mine';

/** Source mod: file name (`Other mod.mod`) and the read file. */
export interface MergeSource {
  name: string;
  file: DataFile;
}

/** Level data next to the source (determined by `node/merge-store.ts`). */
export interface LevelDataInfo {
  /** The source's `leveldata` folder. */
  dir: string;
  /** Files: `leveldata.level`, `interiors.level`, `zone.25.50.zone`… */
  files: string[];
}

/** Words of the merge texts in one interface language. */
interface MergeWords {
  levelNote: string;
  order: string;
  missingDeps: (list: string) => string;
  blockedNoLayer: string;
  skipNotListed: string;
  skipRejected: string;
  planHead: (source: string, n: number, ch: number, del: number, conf: number) => string;
  rejected: (n: number) => string;
  already: (n: number) => string;
  identical: (n: number) => string;
  blocked: (n: number) => string;
  more: (n: number) => string;
  conflict: (why: string) => string;
  rejectedFlag: string;
  blockedFlag: (why: string) => string;
  yoursDiffer: (after: string) => string;
  none: string;
  levelData: (n: number, dir: string) => string;
  nothing: string;
  merged: (n: number, created: number, changed: number, deleted: number) => string;
  conflicts: (src: number, mine: number) => string;
  byRefs: (n: number) => string;
  skipped: (sid: string, why: string) => string;
  dangling: (list: string) => string;
}

const MERGE_EN: MergeWords = {
  levelNote: 'Level data (zones, leveldata.level, interiors.level) is not merged: the editor cannot write it yet. The files are untouched — move them by hand or merge them in FCS.',
  order: 'order',
  missingDeps: (l) => `The source depends on mods that are not among your mod's dependencies: ${l}. Records that only change their data cannot be accepted.`,
  blockedNoLayer: "the record only changes data of a mod that is not among your layers (the source's dependency is not connected)",
  skipNotListed: 'not in the change list (already merged, same as yours or rejected)',
  skipRejected: 'rejected — bring it back to the list first',
  planHead: (s, n, ch, del, conf) => `merge “${s}”: new ${n}, changed ${ch}, deleted ${del}, conflicts ${conf}`,
  rejected: (n) => `, rejected (hidden) ${n}`,
  already: (n) => `, already merged ${n}`,
  identical: (n) => `, identical ${n}`,
  blocked: (n) => `, cannot accept ${n}`,
  more: (n) => `… ${n} more`,
  conflict: (w) => `CONFLICT (${w})`,
  rejectedFlag: 'rejected',
  blockedFlag: (w) => `cannot: ${w}`,
  yoursDiffer: (a) => `   (yours differs: source → ${a})`,
  none: 'none',
  levelData: (n, d) => `level data: ${n} files in ${d}`,
  nothing: 'nothing accepted',
  merged: (n, c, ch, d) => `merged ${n}: new ${c}, changed ${ch}, deleted ${d}`,
  conflicts: (s, m) => `; conflicts: from the source ${s}, yours kept ${m}`,
  byRefs: (n) => `records added by references: ${n}`,
  skipped: (s, w) => `skipped ${s}: ${w}`,
  dangling: (l) => `! references to records that exist nowhere: ${l} (merge them too or fix the references)`,
};

const MERGE_RU: MergeWords = {
  levelNote: 'Данные уровня (зоны, leveldata.level, interiors.level) не слиты: редактор пока не умеет их записывать. Файлы не тронуты — перенесите их вручную или слейте в FCS.',
  order: 'порядок',
  missingDeps: (l) => `Источник зависит от модов, которых нет в зависимостях вашего мода: ${l}. Записи, которые только меняют их данные, принять нельзя.`,
  blockedNoLayer: 'запись только меняет данные мода, которого нет среди ваших слоёв (зависимость источника не подключена)',
  skipNotListed: 'нет в списке изменений (уже слита, совпадает с вашей или отклонена)',
  skipRejected: 'отклонена — сначала верните её в список',
  planHead: (s, n, ch, del, conf) => `слияние «${s}»: новых ${n}, изменённых ${ch}, удалённых ${del}, конфликтов ${conf}`,
  rejected: (n) => `, отклонённых (скрыто) ${n}`,
  already: (n) => `, уже слито ${n}`,
  identical: (n) => `, совпадает ${n}`,
  blocked: (n) => `, нельзя принять ${n}`,
  more: (n) => `… ещё ${n}`,
  conflict: (w) => `КОНФЛИКТ (${w})`,
  rejectedFlag: 'отклонена',
  blockedFlag: (w) => `нельзя: ${w}`,
  yoursDiffer: (a) => `   (у вас иначе: источник → ${a})`,
  none: 'нет',
  levelData: (n, d) => `данные уровня: ${n} файлов в ${d}`,
  nothing: 'ничего не принято',
  merged: (n, c, ch, d) => `слито ${n}: новых ${c}, изменённых ${ch}, удалённых ${d}`,
  conflicts: (s, m) => `; конфликты: из источника ${s}, оставлено ваших ${m}`,
  byRefs: (n) => `по ссылкам добавлено записей: ${n}`,
  skipped: (s, w) => `пропущено ${s}: ${w}`,
  dangling: (l) => `! ссылки на записи, которых нет: ${l} (слейте и их или исправьте ссылки)`,
};

const MERGE_ZH: MergeWords = {
  levelNote: '关卡数据（区域、leveldata.level、interiors.level）未合并：编辑器暂时无法写入它们。文件未被改动——请手动移动，或在 FCS 中合并。',
  order: '顺序',
  missingDeps: (l) => `来源依赖于你的 Mod 依赖项中没有的 Mod：${l}。只修改这些 Mod 数据的记录无法接受。`,
  blockedNoLayer: '该记录只修改了不在你的图层中的 Mod 的数据（来源的依赖项未连接）',
  skipNotListed: '不在更改列表中（已合并、与你的相同或已拒绝）',
  skipRejected: '已拒绝——请先把它放回列表',
  planHead: (s, n, ch, del, conf) => `合并 “${s}”：新增 ${n}，修改 ${ch}，删除 ${del}，冲突 ${conf}`,
  rejected: (n) => `，已拒绝（隐藏）${n}`,
  already: (n) => `，已合并 ${n}`,
  identical: (n) => `，相同 ${n}`,
  blocked: (n) => `，无法接受 ${n}`,
  more: (n) => `… 还有 ${n} 个`,
  conflict: (w) => `冲突（${w}）`,
  rejectedFlag: '已拒绝',
  blockedFlag: (w) => `无法接受：${w}`,
  yoursDiffer: (a) => `   （你的不同：来源 → ${a}）`,
  none: '无',
  levelData: (n, d) => `关卡数据：${d} 中有 ${n} 个文件`,
  nothing: '未接受任何内容',
  merged: (n, c, ch, d) => `已合并 ${n}：新增 ${c}，修改 ${ch}，删除 ${d}`,
  conflicts: (s, m) => `；冲突：取自来源 ${s}，保留你的 ${m}`,
  byRefs: (n) => `按引用添加的记录：${n}`,
  skipped: (s, w) => `已跳过 ${s}：${w}`,
  dangling: (l) => `! 指向不存在记录的引用：${l}（请一并合并它们或修正引用）`,
};

const MERGE_WORDS: Record<string, MergeWords> = { en: MERGE_EN, ru: MERGE_RU, zh: MERGE_ZH };
const mergeWords = (lang: string | undefined): MergeWords => MERGE_WORDS[lang ?? 'en'] ?? MERGE_EN;

/** Why level data is not merged (English; `mergeLevelDataNote` for other languages). */
export const MERGE_LEVEL_DATA_NOTE = MERGE_EN.levelNote;

/** Why level data is not merged, in the interface language. */
export function mergeLevelDataNote(lang = 'en'): string {
  return mergeWords(lang).levelNote;
}

// ---------------------------------------------------------------- sidecar file

/** What the active mod remembers about one source. */
export interface MergeSourceState {
  /** Source file name as it was at the last merge. */
  name: string;
  /** Fingerprint of the source record at the moment it was accepted: `sid → fingerprint`. */
  baseline: Record<string, string>;
  /** Rejected records: `sid → fingerprint of the source record at the moment of rejection`. */
  rejected: Record<string, string>;
}

export interface MergeLogEntry {
  /** Source file name. */
  source: string;
  /** ISO time of the merge. */
  at: string;
  accepted: number;
  created: number;
  changed: number;
  deleted: number;
  /** Conflicts resolved in favour of the source / kept as yours. */
  tookSource: number;
  keptMine: number;
  /** Fingerprint of the source file (for the log label, not for logic). */
  sourceRecords: number;
}

export interface MergeStore {
  version: 1;
  /** Key: source file name in lower case. */
  sources: Record<string, MergeSourceState>;
  log: MergeLogEntry[];
}

export const MERGE_STORE_SUFFIX = '.kedit-merge.json';
const LOG_MAX = 50;

export function emptyMergeStore(): MergeStore {
  return { version: 1, sources: {}, log: [] };
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** Parse the sidecar file; a broken file gives `MergeError` (rejected records must not be lost silently). */
export function parseMergeStore(text: string): MergeStore {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MergeError({ en: 'The merge file (.kedit-merge.json) is damaged: it does not read as JSON. Fix or delete it — then the rejected records show again.', ru: 'Файл слияния (.kedit-merge.json) повреждён: не читается как JSON. Исправьте или удалите его — тогда отклонённые записи покажутся снова.', zh: '合并文件（.kedit-merge.json）已损坏：无法作为 JSON 读取。请修复或删除它——之后被拒绝的记录会重新显示。' });
  }
  const o = (typeof raw === 'object' ? raw : null) as { version?: unknown; sources?: unknown; log?: unknown } | null;
  if (o === null || o.version !== 1 || typeof o.sources !== 'object' || o.sources === null) {
    throw new MergeError({ en: 'The merge file (.kedit-merge.json) has another format or is damaged.', ru: 'Файл слияния (.kedit-merge.json) другого формата или повреждён.', zh: '合并文件（.kedit-merge.json）格式不同或已损坏。' });
  }
  const out = emptyMergeStore();
  for (const [k, s] of Object.entries(o.sources)) {
    const st = s as Partial<MergeSourceState> | undefined;
    if (!st || typeof st.name !== 'string' || !isRecordOfStrings(st.baseline ?? {}) || !isRecordOfStrings(st.rejected ?? {})) {
      throw new MergeError({ en: `The merge file (.kedit-merge.json): the entry about source “${k}” is damaged.`, ru: `Файл слияния (.kedit-merge.json): повреждена запись об источнике «${k}».`, zh: `合并文件（.kedit-merge.json）：关于来源 “${k}” 的条目已损坏。` });
    }
    out.sources[k] = { name: st.name, baseline: { ...(st.baseline ?? {}) }, rejected: { ...(st.rejected ?? {}) } };
  }
  if (Array.isArray(o.log)) out.log = (o.log as unknown[]).filter((e): e is MergeLogEntry => typeof e === 'object' && e !== null && typeof (e as MergeLogEntry).source === 'string' && typeof (e as MergeLogEntry).at === 'string');
  return out;
}

export function serializeMergeStore(store: MergeStore): string {
  return `${JSON.stringify(store, null, 1)}\n`;
}

function cloneStore(store: MergeStore): MergeStore {
  return {
    version: 1,
    sources: Object.fromEntries(Object.entries(store.sources).map(([k, s]) => [k, { name: s.name, baseline: { ...s.baseline }, rejected: { ...s.rejected } }])),
    log: store.log.map((e) => ({ ...e })),
  };
}

const sourceKey = (name: string): string => name.toLowerCase();

interface PendingMerge {
  /** Edit in the history: while it is active, the merge counts as done. undefined: there was nothing to change. */
  changesetId: number | undefined;
  source: string;
  baseline: Record<string, string>;
  log: MergeLogEntry;
}

/**
 * Merge decisions of the active mod. "Reject" is remembered at once (undo does not cancel it);
 * "merged" only together with the edit: if the merge was undone (undo), it does not count as done;
 * when the mod is saved, `commit` turns active merges into permanent ones.
 */
export class MergeLedger {
  private committed: MergeStore;
  private pending: PendingMerge[] = [];
  private touched = false;

  constructor(store: MergeStore = emptyMergeStore()) {
    this.committed = cloneStore(store);
  }

  private livePending(ctx: ModContext): PendingMerge[] {
    return this.pending.filter((p) => p.changesetId === undefined || ctx.findChangeset(p.changesetId) !== undefined);
  }

  /** Decisions including unsaved but active merges. */
  store(ctx: ModContext): MergeStore {
    const out = cloneStore(this.committed);
    for (const p of this.livePending(ctx)) foldPending(out, p);
    return out;
  }

  /**
   * Transfer into a new context (dependencies changed: the edit history is lost): active
   * merges become ordinary decisions, and "something to write" is preserved.
   */
  carry(ctx: ModContext): MergeLedger {
    const next = new MergeLedger(this.store(ctx));
    next.touched = this.hasChanges(ctx);
    return next;
  }

  /** State of one source (empty if there were no merges yet). */
  state(ctx: ModContext, source: string): MergeSourceState {
    return this.store(ctx).sources[sourceKey(source)] ?? { name: source, baseline: {}, rejected: {} };
  }

  /** Reject source records: `sid → record fingerprint`. */
  reject(source: string, rejects: Readonly<Record<string, string>>): void {
    const st = this.ensure(source);
    Object.assign(st.rejected, rejects);
    this.touched = true;
  }

  /** Return rejected records to the list. */
  unreject(source: string, sids: readonly string[]): void {
    const st = this.committed.sources[sourceKey(source)];
    if (!st) return;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    for (const sid of sids) delete st.rejected[sid];
    this.touched = true;
  }

  /** Remember a merge together with its edit in the history. */
  addPending(p: PendingMerge): void {
    this.pending.push(p);
  }

  private ensure(source: string): MergeSourceState {
    const k = sourceKey(source);
    return (this.committed.sources[k] ??= { name: source, baseline: {}, rejected: {} });
  }

  /** There is something to write into the sidecar file. */
  hasChanges(ctx: ModContext): boolean {
    return this.touched || this.livePending(ctx).length > 0;
  }

  /** Accept active merges as permanent and return what has to be written into the sidecar file. */
  commit(ctx: ModContext): MergeStore {
    for (const p of this.livePending(ctx)) foldPending(this.committed, p);
    this.pending = [];
    this.touched = false;
    return cloneStore(this.committed);
  }
}

function foldPending(store: MergeStore, p: PendingMerge): void {
  const k = sourceKey(p.source);
  const st = (store.sources[k] ??= { name: p.source, baseline: {}, rejected: {} });
  st.name = p.source;
  Object.assign(st.baseline, p.baseline);
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  for (const sid of Object.keys(p.baseline)) delete st.rejected[sid];
  store.log.push({ ...p.log });
  if (store.log.length > LOG_MAX) store.log.splice(0, store.log.length - LOG_MAX);
}

// ---------------------------------------------------------------- fingerprints

/** 53-bit string hash (cyrb53): enough to notice that a source record has changed. */
function hashText(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function bytesKey(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return s;
}

/** Fingerprint of the record content (without service lead/id/flags): key order does not matter. */
export function recordFingerprint(rec: GameRecord): string {
  const parts: string[] = [`t${rec.type}`, `n${bytesKey(rec.name)}`];
  for (const dict of SCALAR_DICTS) {
    const entries = [...scalarMap(rec, dict)].map(([k, v]) => {
      const val = v instanceof Uint8Array ? bytesKey(v) : Array.isArray(v) ? v.join(',') : String(v);
      return `${k}=${val}`;
    });
    entries.sort();
    parts.push(`${dict}:${entries.join('\u0001')}`);
  }
  const cats = [...rec.refs.keys()].sort();
  for (const c of cats) parts.push(`r${c}:${rec.refs.get(c)!.map((r) => `${r.target}/${r.v0}/${r.v1}/${r.v2}`).join('\u0001')}`);
  const inst = [...rec.instances.keys()].sort();
  for (const k of inst) {
    const i = rec.instances.get(k)!;
    parts.push(`i${k}:${i.target}/${i.position.join(',')}/${i.rotation.join(',')}/${i.states.map(bytesKey).join('|')}`);
  }
  return hashText(parts.join('\u0002'));
}

// ---------------------------------------------------------------- change list

export interface MergeFieldView {
  /** Stable field key for choosing on a conflict: `name`, `ints:damage`, `ref:items:123-X.mod`. */
  key: string;
  kind: FieldChange['kind'];
  /** Short label: `damage`, `items → Katana [id]`. */
  label: string;
  /** Your current value (absent: you have no such field). */
  before?: string;
  /** Value from the source (absent: the source removes the field). */
  after?: string;
  /** The whole line, as in `diff` (`~ int damage: 10 → 20`). */
  text: string;
  /** Both your mod and the source changed the field. */
  conflict: boolean;
}

export interface MergeChange {
  sid: string;
  kind: MergeKind;
  type: number;
  typeName: string;
  /** Record name (in the source version; for a deleted one, yours). */
  name: string;
  /** Russian name from gamedata.po, if any. */
  localizedName?: string;
  /** For `changed`: fields "was → will be". Empty for `new` and `deleted`. */
  fields: MergeFieldView[];
  conflict?: MergeConflictReason;
  conflictCount: number;
  /** Other records of the list (new / changed) that the source version references. */
  links: string[];
  /** References of the source version to records that are neither yours nor in the change list. */
  dangling: string[];
  /** The record is rejected (present only in "show skipped" mode). */
  rejected: boolean;
  /** The source record changed after rejection. */
  rejectedStale?: boolean;
  /** Why the record cannot be accepted. */
  blocked?: string;
  /** Fingerprint of the source record. */
  fingerprint: string;
}

export interface MergeCounts {
  new: number;
  changed: number;
  deleted: number;
  conflicts: number;
  /** Hidden as rejected. */
  rejected: number;
  /** Source records identical to yours. */
  identical: number;
  /** Not changed in the source since the last merge. */
  alreadyMerged: number;
  blocked: number;
}

export interface MergePlan {
  source: string;
  changes: MergeChange[];
  counts: MergeCounts;
  warnings: string[];
  /** Source dependencies that are not among your mod's dependencies. */
  missingDependencies: string[];
  levelData?: LevelDataInfo;
}

export interface MergePlanOptions {
  /** Also show rejected records (marked `rejected`). */
  showRejected?: boolean;
  /** Source level data (determined by the caller: the core has no file system). */
  levelData?: LevelDataInfo;
  /** Interface language of the texts in the plan and the result (English by default). */
  lang?: string;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Can this mod be merged. Throws `MergeError` if the source is the same mod, a dependency
 * of the active mod or vanilla: their records are already part of your layers.
 */
export function checkMergeSource(ctx: ModContext, sourceName: string): void {
  if (same(sourceName, ctx.modName)) throw new MergeError({ en: `Cannot merge mod “${sourceName}” into itself.`, ru: `Нельзя слить мод «${sourceName}» сам в себя.`, zh: `不能将 Mod “${sourceName}” 合并到它自身。` });
  const layer = ctx.layers.find((l) => same(l.name, sourceName)) ?? ctx.info.dependencies.find((d) => same(d, sourceName));
  if (layer !== undefined) {
    const name = typeof layer === 'string' ? layer : layer.name;
    throw new MergeError({
      en:
        `Mod «${name}» is open as a dependency of «${ctx.modName}» (or is part of the game): its records are already loaded as a layer and cannot be merged. ` +
        'Remove it from the dependencies in the mod header if you want to move its data into your mod.',
      ru:
        `Мод «${name}» открыт как зависимость «${ctx.modName}» (или входит в игру): его записи уже подключены слоем и сливать их нельзя. ` +
        'Уберите его из зависимостей в заголовке мода, если хотите перенести его данные в свой мод.',
      zh:
        `Mod «${name}» 已作为 «${ctx.modName}» 的依赖项打开（或属于游戏本体）：它的记录已作为图层载入，不能合并。` +
        '如果想把它的数据移到你的 Mod 中，请从 Mod 头部的依赖项中移除它。',
    });
  }
}

/** Stable field key for choosing on a conflict. */
export function mergeFieldKey(f: FieldChange): string {
  switch (f.kind) {
    case 'name':
      return 'name';
    case 'type':
      return 'type';
    case 'flags':
      return 'flags';
    case 'field':
      return `${f.dict}:${f.key}`;
    case 'ref':
      return `ref:${f.category}:${f.target.replace(/#\d+$/, '')}`;
    case 'refOrder':
      return `order:${f.category}`;
    case 'instance':
      return `inst:${f.key}`;
  }
}

/** Did your mod change this field relative to the lower layers. */
function mineTouched(f: FieldChange, mine: GameRecord, lower: GameRecord | undefined): boolean {
  if (!lower) return true; // the record was created by your mod — the whole field is "yours"
  switch (f.kind) {
    case 'name':
      return !bytesEqual(mine.name, lower.name);
    case 'type':
      return mine.type !== lower.type;
    case 'flags':
      return false;
    case 'field':
      return scalarMap(mine, f.dict).has(f.key) && !scalarEqual(scalarMap(mine, f.dict).get(f.key), scalarMap(lower, f.dict).get(f.key));
    case 'ref': {
      const target = f.target.replace(/#\d+$/, '');
      const r = mine.refs.get(f.category)?.find((x) => x.target === target);
      if (!r) return false;
      const lo = lower.refs.get(f.category)?.find((x) => x.target === target);
      return isRemovedRef(r) ? lo !== undefined : lo === undefined || !refValuesEqual(r, lo);
    }
    case 'refOrder':
      return mine.refs.has(f.category);
    case 'instance':
      return mine.instances.has(f.key);
  }
}

function fieldView(ctx: ModContext, f: FieldChange, rec: GameRecord, conflict: boolean, lang = 'en'): MergeFieldView {
  const key = mergeFieldKey(f);
  const text = formatFieldChange(ctx, f, rec, lang);
  const view: MergeFieldView = { key, kind: f.kind, label: key, text, conflict };
  switch (f.kind) {
    case 'name':
      view.label = 'name';
      view.before = decodeText(f.before);
      view.after = decodeText(f.after);
      break;
    case 'type':
      view.before = ctx.typeName(f.before);
      view.after = ctx.typeName(f.after);
      break;
    case 'field':
      view.label = f.key;
      if (f.before !== undefined) view.before = formatFieldValue(ctx, rec, f.dict, f.key, f.before, lang);
      if (f.after !== undefined) view.after = formatFieldValue(ctx, rec, f.dict, f.key, f.after, lang);
      break;
    case 'ref':
      view.label = `${f.category} → ${refLabel(ctx, f.target.replace(/#\d+$/, ''), lang)}`;
      if (f.before) view.before = formatRefValues(f.before, lang);
      if (f.after) view.after = formatRefValues(f.after, lang);
      break;
    case 'refOrder':
      view.label = `${f.category}: ${mergeWords(lang).order}`;
      view.before = f.before.join(', ');
      view.after = f.after.join(', ');
      break;
    case 'instance':
      view.label = `inst ${f.key}`;
      if (f.before) view.before = `${refLabel(ctx, f.before.target, lang)} (${f.before.position.join(', ')})`;
      if (f.after) view.after = `${refLabel(ctx, f.after.target, lang)} (${f.after.position.join(', ')})`;
      break;
    case 'flags':
      break;
  }
  return view;
}

interface Internal {
  current: GameRecord | undefined;
  desired: GameRecord | undefined;
  diff: FieldChange[];
  mineDeleted: boolean;
}

interface Computed {
  plan: MergePlan;
  internals: Map<string, Internal>;
}

/** Change record state by the source's `changeFlags`: `true` = the source record only changes someone else's (from a dependency). */
function flaggedAsChange(file: DataFile, rec: GameRecord): boolean {
  if (file.fileType === FileType.MergeMod) {
    const st = rec.changeFlags & 15;
    return st === 1 || st === 3;
  }
  if (file.fileType === FileType.Mod) {
    const st = rec.changeFlags & 0x7fffffff;
    return st === 1 || st === 3;
  }
  return false;
}

function compute(ctx: ModContext, source: MergeSource, state: MergeSourceState, options: MergePlanOptions): Computed {
  checkMergeSource(ctx, source.name);
  const w = mergeWords(options.lang);
  const counts: MergeCounts = { new: 0, changed: 0, deleted: 0, conflicts: 0, rejected: 0, identical: 0, alreadyMerged: 0, blocked: 0 };
  const warnings: string[] = [];
  const known = new Set([...ctx.layers.map((l) => l.name), ...ctx.info.dependencies, ctx.modName].map((n) => n.toLowerCase()));
  const missingDependencies = (source.file.header ? splitModList(source.file.header.dependencies) : []).filter((d) => !known.has(d.toLowerCase()));
  if (missingDependencies.length > 0) {
    warnings.push(w.missingDeps(missingDependencies.join(', ')));
  }

  const changes: MergeChange[] = [];
  const internals = new Map<string, Internal>();
  const seen = new Set<string>();
  for (const delta of source.file.records) {
    const sid = delta.stringId;
    if (seen.has(sid)) continue;
    seen.add(sid);
    const fingerprint = recordFingerprint(delta);
    const rejectedFp = state.rejected[sid];
    const isRejected = rejectedFp !== undefined;
    if (isRejected && !options.showRejected) {
      counts.rejected++;
      continue;
    }
    if (state.baseline[sid] === fingerprint) {
      counts.alreadyMerged++;
      continue;
    }
    const mine = ctx.delta(sid);
    const lower = ctx.lower(sid);
    const base = ctx.get(sid);
    let kind: MergeKind;
    let conflict: MergeConflictReason | undefined;
    let current = base;
    let desired: GameRecord | undefined;
    let fields: FieldChange[] = [];
    let blocked: string | undefined;
    let mineDeleted = false;
    if (isRemovalMarker(delta)) {
      if (!base) {
        counts.identical++;
        continue;
      }
      kind = 'deleted';
      if (mine && !isRemovalMarker(mine)) conflict = 'source-deleted';
    } else {
      if (!base && lower) {
        // You deleted the lower-layer record, the source edits it.
        kind = 'changed';
        mineDeleted = true;
        conflict = 'mine-deleted';
        current = lower;
      } else kind = base ? 'changed' : 'new';
      desired = applyLayer(current, delta);
      if (!desired) {
        counts.identical++;
        continue;
      }
      if (kind === 'new' && flaggedAsChange(source.file, delta)) blocked = w.blockedNoLayer;
      if (kind === 'changed') {
        const d = diffRecordStates(current, desired);
        if (!d && !mineDeleted) {
          counts.identical++;
          continue;
        }
        fields = d?.fields ?? [];
      }
    }
    const shown = (desired ?? current)!;
    const views: MergeFieldView[] = [];
    let conflictCount = 0;
    for (const f of fields) {
      const isConflict = !mineDeleted && mine !== undefined && !isRemovalMarker(mine) && mineTouched(f, mine, lower);
      if (isConflict) conflictCount++;
      views.push(fieldView(ctx, f, shown, isConflict, options.lang));
    }
    if (conflictCount > 0 && !conflict) conflict = 'both';
    if (conflict) conflictCount = Math.max(conflictCount, 1);
    const change: MergeChange = {
      sid,
      kind,
      type: shown.type,
      typeName: ctx.typeName(shown.type),
      name: decodeText(shown.name),
      fields: views,
      conflictCount,
      links: [],
      dangling: [],
      rejected: isRejected,
      fingerprint,
    };
    const ru = ctx.localizedName(sid);
    if (ru !== undefined) change.localizedName = ru;
    if (conflict) change.conflict = conflict;
    if (isRejected && rejectedFp !== fingerprint) change.rejectedStale = true;
    if (blocked) change.blocked = blocked;
    changes.push(change);
    internals.set(sid, { current, desired, diff: fields, mineDeleted });
  }

  // Links between changes: which records of the list the source version references.
  const inPlan = new Set(changes.filter((c) => c.kind !== 'deleted').map((c) => c.sid));
  for (const c of changes) {
    const desired = internals.get(c.sid)!.desired;
    if (!desired) continue;
    const links = new Set<string>();
    const dangling = new Set<string>();
    const targets: string[] = [];
    for (const list of desired.refs.values()) for (const r of list) if (!isRemovedRef(r)) targets.push(r.target);
    for (const i of desired.instances.values()) targets.push(i.target);
    for (const t of targets) {
      if (t === c.sid) continue;
      if (inPlan.has(t)) links.add(t);
      else if (!ctx.has(t)) dangling.add(t);
    }
    c.links = [...links];
    c.dangling = [...dangling];
  }
  for (const c of changes) {
    counts[c.kind]++;
    if (c.conflict) counts.conflicts++;
    if (c.blocked) counts.blocked++;
  }
  const plan: MergePlan = { source: source.name, changes, counts, warnings, missingDependencies };
  if (options.levelData && options.levelData.files.length > 0) plan.levelData = options.levelData;
  return { plan, internals };
}

/** What merging gives: the list of source changes relative to your mod. Changes nothing. */
export function planMerge(ctx: ModContext, source: MergeSource, ledger: MergeLedger, options: MergePlanOptions = {}): MergePlan {
  return compute(ctx, source, ledger.state(ctx, source.name), options).plan;
}

// ---------------------------------------------------------------- selection

/** The record and everything it references (via the source version) among the changes: a whole dialogue with its lines. */
export function mergeClosure(plan: MergePlan, sids: Iterable<string>): string[] {
  const bySid = new Map(plan.changes.map((c) => [c.sid, c]));
  const out = new Set<string>();
  const queue = [...sids];
  while (queue.length > 0) {
    const sid = queue.pop()!;
    const c = bySid.get(sid);
    if (!c || out.has(sid)) continue;
    out.add(sid);
    for (const t of c.links) queue.push(t);
  }
  return plan.changes.filter((c) => out.has(c.sid)).map((c) => c.sid);
}

/**
 * "Fix references": add to the accepted ones the new records referenced from the accepted ones
 * (and further down the chain of new ones). Returns the added ids.
 */
export function mergeFixReferences(plan: MergePlan, accepted: Iterable<string>): string[] {
  const bySid = new Map(plan.changes.map((c) => [c.sid, c]));
  const have = new Set(accepted);
  const added: string[] = [];
  const queue = [...have];
  while (queue.length > 0) {
    const c = bySid.get(queue.pop()!);
    if (!c) continue;
    for (const t of c.links) {
      const target = bySid.get(t);
      if (!target || target.kind !== 'new' || target.rejected || target.blocked || have.has(t)) continue;
      have.add(t);
      added.push(t);
      queue.push(t);
    }
  }
  return plan.changes.filter((c) => added.includes(c.sid)).map((c) => c.sid);
}

// ---------------------------------------------------------------- applying

export interface MergeSelection {
  /** Accepted records (ids). The rest are "ignore". */
  accept: readonly string[];
  /** Choice per conflict field: `sid → field key → source | mine`. */
  resolutions?: Readonly<Record<string, Readonly<Record<string, MergeChoice>>>>;
  /** How to resolve conflicts without a choice (default `mine`: your data is not lost). */
  conflicts?: MergeChoice;
  /** With each accepted record, accept everything it references. */
  recursive?: boolean;
  /** Also accept new records that accepted references point to. */
  fixReferences?: boolean;
  /** The user asked to merge level data too (merging cannot do that, see `MERGE_LEVEL_DATA_NOTE`). */
  levelData?: boolean;
}

export interface MergeSkip {
  sid: string;
  reason: string;
}

export interface MergeResult {
  /** Edit in the history (undefined: it turned out there was nothing to change). */
  changesetId: number | undefined;
  label: string;
  accepted: string[];
  created: number;
  changed: number;
  deleted: number;
  /** Conflict fields taken from the source / kept as yours. */
  tookSource: number;
  keptMine: number;
  /** Accepted whole for "fix references" or recursive selection. */
  addedByClosure: string[];
  skipped: MergeSkip[];
  /** References of accepted records to records that exist nowhere. */
  dangling: string[];
  notes: string[];
}

/** Return a field to "as yours" (`before` of the change). */
function keepMine(desired: GameRecord, f: FieldChange): void {
  switch (f.kind) {
    case 'name':
      desired.name = f.before;
      break;
    case 'type':
      desired.type = f.before;
      break;
    case 'flags':
      break;
    case 'field': {
      const map = scalarMap(desired, f.dict);
      if (f.before === undefined) map.delete(f.key);
      else map.set(f.key, f.before);
      break;
    }
    case 'ref': {
      const target = f.target.replace(/#\d+$/, '');
      const list = desired.refs.get(f.category) ?? [];
      const i = list.findIndex((r) => r.target === target);
      if (f.before) {
        if (i >= 0) list[i] = { ...f.before };
        else list.push({ ...f.before });
      } else if (i >= 0) list.splice(i, 1);
      desired.refs.set(f.category, list);
      break;
    }
    case 'refOrder': {
      const list = desired.refs.get(f.category) ?? [];
      const rank = new Map(f.before.map((t, i) => [t, i]));
      list.sort((a, b) => (rank.get(a.target) ?? Infinity) - (rank.get(b.target) ?? Infinity));
      desired.refs.set(f.category, list);
      break;
    }
    case 'instance':
      if (f.before) desired.instances.set(f.key, f.before);
      else desired.instances.delete(f.key);
      break;
  }
}

/** Title of the history step: parsed by `step-title.ts`. */
export function mergeLabel(sourceName: string, count: number): string {
  return `слияние: ${sourceName} (${count} записей)`;
}

/**
 * Apply the selected changes as one edit. The list is recomputed from the mod's current state,
 * so the result always matches what is visible now. What was accepted is remembered in `ledger`
 * together with the edit (undoing the edit also undoes "merged").
 */
export function applyMerge(ctx: ModContext, source: MergeSource, ledger: MergeLedger, selection: MergeSelection, options: MergePlanOptions = {}): MergeResult {
  const { plan, internals } = compute(ctx, source, ledger.state(ctx, source.name), options);
  const w = mergeWords(options.lang);
  const bySid = new Map(plan.changes.map((c) => [c.sid, c]));
  const skipped: MergeSkip[] = [];
  const notes: string[] = [];
  let accept: string[] = [];
  for (const sid of selection.accept) {
    if (!bySid.has(sid)) skipped.push({ sid, reason: w.skipNotListed });
    else if (!accept.includes(sid)) accept.push(sid);
  }
  const base = new Set(accept);
  if (selection.recursive) accept = mergeClosure(plan, accept);
  if (selection.fixReferences) {
    const extra = mergeFixReferences(plan, accept);
    accept = plan.changes.filter((c) => accept.includes(c.sid) || extra.includes(c.sid)).map((c) => c.sid);
  }
  const addedByClosure = accept.filter((s) => !base.has(s));
  const ok = accept.filter((sid) => {
    const c = bySid.get(sid)!;
    if (c.rejected) {
      skipped.push({ sid, reason: w.skipRejected });
      return false;
    }
    if (c.blocked) {
      skipped.push({ sid, reason: c.blocked });
      return false;
    }
    return true;
  });
  const ordered = plan.changes.filter((c) => ok.includes(c.sid));
  if (selection.levelData) notes.push(w.levelNote);
  const result: MergeResult = {
    changesetId: undefined,
    label: mergeLabel(source.name, ordered.length),
    accepted: ordered.map((c) => c.sid),
    created: 0,
    changed: 0,
    deleted: 0,
    tookSource: 0,
    keptMine: 0,
    addedByClosure,
    skipped,
    dangling: [],
    notes,
  };
  if (ordered.length === 0) return result;

  const fallback = selection.conflicts ?? 'mine';
  const before = ctx.history().undo.at(-1)?.id;
  const dangling = new Set<string>();
  ctx.transaction(result.label, () => {
    for (const c of ordered) {
      const it = internals.get(c.sid)!;
      if (c.kind === 'deleted') {
        if (c.conflict && (selection.resolutions?.[c.sid]?.['record'] ?? fallback) === 'mine') {
          result.keptMine++;
          continue;
        }
        if (c.conflict) result.tookSource++;
        ctx.deleteRecord(c.sid);
        result.deleted++;
        continue;
      }
      let desired = cloneRecord(it.desired!);
      if (it.mineDeleted) {
        const choice = selection.resolutions?.[c.sid]?.['record'] ?? fallback;
        if (choice === 'mine') {
          result.keptMine++;
          continue;
        }
        result.tookSource++;
        ctx.restoreRecord(c.sid);
        desired = cloneRecord(it.desired!);
      } else {
        for (const [i, f] of it.diff.entries()) {
          const view = c.fields[i]!;
          if (!view.conflict) continue;
          const choice = selection.resolutions?.[c.sid]?.[view.key] ?? fallback;
          if (choice === 'mine') {
            keepMine(desired, f);
            result.keptMine++;
          } else result.tookSource++;
        }
      }
      if (c.kind === 'new') result.created++;
      else result.changed++;
      ctx.putRecord(c.sid, desired);
    }
  });
  // References of accepted records to things the mod lacks (neither among accepted nor its own).
  for (const c of ordered) for (const t of [...c.links, ...c.dangling]) if (!ctx.has(t)) dangling.add(t);
  const after = ctx.history().undo.at(-1)?.id;
  result.changesetId = after !== undefined && after !== before ? after : undefined;
  result.dangling = [...dangling].sort();
  const baseline: Record<string, string> = {};
  for (const c of ordered) baseline[c.sid] = c.fingerprint;
  ledger.addPending({
    changesetId: result.changesetId,
    source: source.name,
    baseline,
    log: {
      source: source.name,
      at: new Date().toISOString(),
      accepted: ordered.length,
      created: result.created,
      changed: result.changed,
      deleted: result.deleted,
      tookSource: result.tookSource,
      keptMine: result.keptMine,
      sourceRecords: source.file.records.length,
    },
  });
  return result;
}

/** Reject records: they no longer show when merging this mod (the "Show skipped" button brings them back). */
export function rejectMerge(ctx: ModContext, source: MergeSource, ledger: MergeLedger, sids: readonly string[], options: MergePlanOptions = {}): string[] {
  const { plan } = compute(ctx, source, ledger.state(ctx, source.name), options);
  const rejects: Record<string, string> = {};
  for (const sid of sids) {
    const c = plan.changes.find((x) => x.sid === sid);
    if (c && !c.rejected) rejects[sid] = c.fingerprint;
  }
  ledger.reject(source.name, rejects);
  return Object.keys(rejects);
}

/** Return rejected records to the list. */
export function unrejectMerge(ledger: MergeLedger, source: MergeSource | string, sids: readonly string[]): void {
  ledger.unreject(typeof source === 'string' ? source : source.name, sids);
}

// ---------------------------------------------------------------- report

const KIND_MARK: Record<MergeKind, string> = { new: '+', changed: '~', deleted: '−' };

/** List of changes as text (CLI, MCP): one line per record, its fields below it. */
export function formatMergePlan(plan: MergePlan, limit = Infinity, lang = 'en'): string[] {
  const w = mergeWords(lang);
  const c = plan.counts;
  const lines = [
    w.planHead(plan.source, c.new, c.changed, c.deleted, c.conflicts) +
      (c.rejected ? w.rejected(c.rejected) : '') +
      (c.alreadyMerged ? w.already(c.alreadyMerged) : '') +
      (c.identical ? w.identical(c.identical) : '') +
      (c.blocked ? w.blocked(c.blocked) : ''),
  ];
  for (const w of plan.warnings) lines.push(`! ${w}`);
  let shown = 0;
  for (const ch of plan.changes) {
    if (shown >= limit) {
      lines.push(w.more(plan.changes.length - shown));
      break;
    }
    shown++;
    const flags = [ch.conflict ? w.conflict(ch.conflict) : '', ch.rejected ? w.rejectedFlag : '', ch.blocked ? w.blockedFlag(ch.blocked) : ''].filter((x) => x !== '');
    lines.push(`${KIND_MARK[ch.kind]} ${ch.typeName} ${ch.sid} «${ch.name}»${ch.localizedName ? ` (${ch.localizedName})` : ''}${flags.length ? `  [${flags.join('; ')}]` : ''}`);
    for (const f of ch.fields) lines.push(`    ${f.conflict ? '! ' : ''}${f.text}${f.conflict ? w.yoursDiffer(f.after ?? w.none) : ''}`);
  }
  if (plan.levelData) lines.push(`${w.levelData(plan.levelData.files.length, plan.levelData.dir)} — ${w.levelNote}`);
  return lines;
}

/** Apply result as text. */
export function formatMergeResult(r: MergeResult, lang = 'en'): string[] {
  const w = mergeWords(lang);
  const lines = [
    r.accepted.length === 0
      ? w.nothing
      : w.merged(r.accepted.length, r.created, r.changed, r.deleted) + (r.tookSource + r.keptMine > 0 ? w.conflicts(r.tookSource, r.keptMine) : ''),
  ];
  if (r.addedByClosure.length) lines.push(w.byRefs(r.addedByClosure.length));
  for (const s of r.skipped) lines.push(w.skipped(s.sid, s.reason));
  if (r.dangling.length) lines.push(w.dangling(`${r.dangling.slice(0, 10).join(', ')}${r.dangling.length > 10 ? '…' : ''}`));
  lines.push(...r.notes);
  return lines;
}

// ---------------------------------------------------------------- selection for CLI / MCP

export interface MergeFilter {
  /** Specific record ids. */
  ids?: readonly string[];
  /** Types: name (`WEAPON`) or number. */
  types?: readonly string[];
  /** Kind of change. */
  kinds?: readonly MergeKind[];
  /** All records of the list (conflicts are resolved separately: by default your values stay). */
  all?: boolean;
}

/** Which list records the filter selects (by id / type / kind / "all"). Empty filter selects nothing. */
export function selectMergeChanges(plan: MergePlan, f: MergeFilter): string[] {
  const ids = new Set(f.ids ?? []);
  const types = new Set((f.types ?? []).map((t) => t.trim().toUpperCase()));
  const kinds = new Set(f.kinds ?? []);
  const any = ids.size > 0 || types.size > 0 || kinds.size > 0 || f.all === true;
  if (!any) return [];
  return plan.changes
    .filter((c) => {
      if (c.rejected || c.blocked) return false;
      if (ids.size > 0 && !ids.has(c.sid)) return false;
      if (types.size > 0 && !types.has(c.typeName.toUpperCase()) && !types.has(String(c.type))) return false;
      if (kinds.size > 0 && !kinds.has(c.kind)) return false;
      return true;
    })
    .map((c) => c.sid);
}
