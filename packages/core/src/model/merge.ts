/**
 * Слияние модов (как «Merge» в FCS): перенос изменений из другого мода в редактируемый.
 *
 * Источник — файл мода (или .base) целиком. Для каждой его записи считается, что она
 * изменила бы в вашем моде: запись источника — это слой, который накладывается поверх ваших
 * итоговых данных (`applyLayer`), разница с текущим состоянием и есть «изменение»:
 *  - `new` — записи нет ни в вашем моде, ни в его зависимостях;
 *  - `changed` — запись есть, у неё отличаются поля (список полей «было → станет»);
 *  - `deleted` — источник удаляет запись, которая у вас есть.
 *
 * Применяются выбранные изменения одной правкой (`ctx.transaction`: одна отмена, одно название
 * шага); в мод пишется только разница с нижними слоями — через `ModContext.putRecord`.
 *
 * Решения хранятся отдельно от .mod, в файле-спутнике (`MergeStore`, см. `node/merge-store.ts`):
 *  - «отклонить» — запись больше не показывается при следующих слияниях этого мода;
 *  - «слито» — отпечаток записи источника на момент слияния: если запись источника с тех пор
 *    не менялась, её правки у вас не считаются расхождением;
 *  - журнал: с каким модом и когда слито.
 * «Принять» и «игнор» (по умолчанию) — решения одного сеанса, они передаются в `applyMerge`.
 *
 * Конфликт — поле, которое менял и ваш мод (относительно нижних слоёв), и источник: оба значения
 * видны, выбирается `source` или `mine`; не выбранное считается `mine` (ваши данные не теряются).
 *
 * Данные уровня (`leveldata/*.zone`, `leveldata.level`, `interiors.level`) редактор не умеет
 * ни читать для записи, ни писать: слияние их только обнаруживает и честно отказывается
 * (`MERGE_LEVEL_DATA_NOTE`), файлы не трогаются.
 */
import { bytesEqual, decodeText } from '../text.ts';
import { splitModList } from '../format/helpers.ts';
import { FileType, type DataFile, type GameRecord } from '../format/types.ts';
import type { ModContext } from './context.ts';
import { diffRecordStates, type FieldChange } from './diff.ts';
import { formatFieldChange, formatFieldValue, formatRefValues, refLabel } from './present.ts';
import { applyLayer, cloneRecord, isRemovalMarker, isRemovedRef, refValuesEqual, SCALAR_DICTS, scalarEqual, scalarMap } from './record-ops.ts';

/** Ошибка слияния с понятным сообщением (нельзя слить этот мод, плохой файл-спутник…). */
export class MergeError extends Error {
  override name = 'MergeError';
}

export type MergeKind = 'new' | 'changed' | 'deleted';
export const MERGE_KINDS: readonly MergeKind[] = ['new', 'changed', 'deleted'];

/** Почему изменение — конфликт. */
export type MergeConflictReason =
  /** Поле менял и ваш мод, и источник, значения разные. */
  | 'both'
  /** У вас запись удалена, источник её меняет. */
  | 'mine-deleted'
  /** Источник удаляет запись, которую вы меняли. */
  | 'source-deleted';

export type MergeChoice = 'source' | 'mine';

/** Мод-источник: имя файла (`Чужой мод.mod`) и прочитанный файл. */
export interface MergeSource {
  name: string;
  file: DataFile;
}

/** Данные уровня рядом с источником (определяет `node/merge-store.ts`). */
export interface LevelDataInfo {
  /** Папка `leveldata` источника. */
  dir: string;
  /** Файлы: `leveldata.level`, `interiors.level`, `zone.25.50.zone`… */
  files: string[];
}

export const MERGE_LEVEL_DATA_NOTE =
  'Данные уровня (зоны, leveldata.level, interiors.level) не слиты: редактор пока не умеет их записывать. Файлы не тронуты — перенесите их вручную или слейте в FCS.';

// ---------------------------------------------------------------- файл-спутник

/** Что помнит активный мод об одном источнике. */
export interface MergeSourceState {
  /** Имя файла источника как оно было при последнем слиянии. */
  name: string;
  /** Отпечаток записи источника на момент, когда её приняли: `sid → отпечаток`. */
  baseline: Record<string, string>;
  /** Отклонённые записи: `sid → отпечаток записи источника на момент отклонения`. */
  rejected: Record<string, string>;
}

export interface MergeLogEntry {
  /** Имя файла источника. */
  source: string;
  /** ISO-время слияния. */
  at: string;
  accepted: number;
  created: number;
  changed: number;
  deleted: number;
  /** Конфликтов решено в пользу источника / оставлено вашим. */
  tookSource: number;
  keptMine: number;
  /** Отпечаток файла источника (для подписи в журнале, не для логики). */
  sourceRecords: number;
}

export interface MergeStore {
  version: 1;
  /** Ключ — имя файла источника в нижнем регистре. */
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

/** Разбор файла-спутника; битый файл — `MergeError` (молча терять отклонённые записи нельзя). */
export function parseMergeStore(text: string): MergeStore {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MergeError('Файл слияния (.kedit-merge.json) повреждён: не читается как JSON. Исправьте или удалите его — тогда отклонённые записи покажутся снова.');
  }
  const o = (typeof raw === 'object' ? raw : null) as { version?: unknown; sources?: unknown; log?: unknown } | null;
  if (o === null || o.version !== 1 || typeof o.sources !== 'object' || o.sources === null) {
    throw new MergeError('Файл слияния (.kedit-merge.json) другого формата или повреждён.');
  }
  const out = emptyMergeStore();
  for (const [k, s] of Object.entries(o.sources)) {
    const st = s as Partial<MergeSourceState> | undefined;
    if (!st || typeof st.name !== 'string' || !isRecordOfStrings(st.baseline ?? {}) || !isRecordOfStrings(st.rejected ?? {})) {
      throw new MergeError(`Файл слияния (.kedit-merge.json): повреждена запись об источнике «${k}».`);
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
  /** Правка в истории: пока она действует, слияние считается состоявшимся. undefined — менять было нечего. */
  changesetId: number | undefined;
  source: string;
  baseline: Record<string, string>;
  log: MergeLogEntry;
}

/**
 * Решения слияния активного мода. «Отклонить» запоминается сразу (его не отменяет undo);
 * «слито» — только вместе с правкой: отменили слияние (undo) — оно не считается состоявшимся;
 * сохранили мод — `commit` переносит действующие слияния в постоянные.
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

  /** Решения с учётом несохранённых, но действующих слияний. */
  store(ctx: ModContext): MergeStore {
    const out = cloneStore(this.committed);
    for (const p of this.livePending(ctx)) foldPending(out, p);
    return out;
  }

  /**
   * Перенос в новый контекст (смена зависимостей: история правок теряется): действующие
   * слияния становятся обычными решениями, а «есть что записать» сохраняется.
   */
  carry(ctx: ModContext): MergeLedger {
    const next = new MergeLedger(this.store(ctx));
    next.touched = this.hasChanges(ctx);
    return next;
  }

  /** Состояние одного источника (пустое, если слияний ещё не было). */
  state(ctx: ModContext, source: string): MergeSourceState {
    return this.store(ctx).sources[sourceKey(source)] ?? { name: source, baseline: {}, rejected: {} };
  }

  /** Отклонить записи источника: `sid → отпечаток записи`. */
  reject(source: string, rejects: Readonly<Record<string, string>>): void {
    const st = this.ensure(source);
    Object.assign(st.rejected, rejects);
    this.touched = true;
  }

  /** Вернуть отклонённые записи в список. */
  unreject(source: string, sids: readonly string[]): void {
    const st = this.committed.sources[sourceKey(source)];
    if (!st) return;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    for (const sid of sids) delete st.rejected[sid];
    this.touched = true;
  }

  /** Запомнить слияние вместе с его правкой в истории. */
  addPending(p: PendingMerge): void {
    this.pending.push(p);
  }

  private ensure(source: string): MergeSourceState {
    const k = sourceKey(source);
    return (this.committed.sources[k] ??= { name: source, baseline: {}, rejected: {} });
  }

  /** Есть что записать в файл-спутник. */
  hasChanges(ctx: ModContext): boolean {
    return this.touched || this.livePending(ctx).length > 0;
  }

  /** Принять действующие слияния как постоянные и вернуть то, что надо записать в файл-спутник. */
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

// ---------------------------------------------------------------- отпечатки

/** 53-битный строковый хэш (cyrb53): хватает, чтобы заметить, что запись источника изменилась. */
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

/** Отпечаток содержимого записи (без служебных lead/id/флагов): порядок ключей не важен. */
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

// ---------------------------------------------------------------- список изменений

export interface MergeFieldView {
  /** Устойчивый ключ поля для выбора при конфликте: `name`, `ints:damage`, `ref:items:123-X.mod`. */
  key: string;
  kind: FieldChange['kind'];
  /** Короткая подпись: `damage`, `items → Катана [id]`. */
  label: string;
  /** Значение у вас сейчас (нет — поля у вас нет). */
  before?: string;
  /** Значение из источника (нет — источник поле убирает). */
  after?: string;
  /** Строка целиком, как в `diff` (`~ int damage: 10 → 20`). */
  text: string;
  /** Поле менял и ваш мод, и источник. */
  conflict: boolean;
}

export interface MergeChange {
  sid: string;
  kind: MergeKind;
  type: number;
  typeName: string;
  /** Имя записи (в версии источника; у удаляемой — у вас). */
  name: string;
  /** Русское название из gamedata.po, если есть. */
  localizedName?: string;
  /** Для `changed`: поля «было → станет». У `new` и `deleted` пусто. */
  fields: MergeFieldView[];
  conflict?: MergeConflictReason;
  conflictCount: number;
  /** Другие записи списка (new / changed), на которые ссылается версия источника. */
  links: string[];
  /** Ссылки версии источника на записи, которых нет ни у вас, ни в списке изменений. */
  dangling: string[];
  /** Запись отклонена (есть только в режиме «показать пропущенные»). */
  rejected: boolean;
  /** После отклонения запись источника изменилась. */
  rejectedStale?: boolean;
  /** Почему запись нельзя принять. */
  blocked?: string;
  /** Отпечаток записи источника. */
  fingerprint: string;
}

export interface MergeCounts {
  new: number;
  changed: number;
  deleted: number;
  conflicts: number;
  /** Скрыто как отклонённое. */
  rejected: number;
  /** Записей источника, совпадающих с вашими. */
  identical: number;
  /** Не менялись в источнике с прошлого слияния. */
  alreadyMerged: number;
  blocked: number;
}

export interface MergePlan {
  source: string;
  changes: MergeChange[];
  counts: MergeCounts;
  warnings: string[];
  /** Зависимости источника, которых нет среди зависимостей вашего мода. */
  missingDependencies: string[];
  levelData?: LevelDataInfo;
}

export interface MergePlanOptions {
  /** Показать и отклонённые записи (с пометкой `rejected`). */
  showRejected?: boolean;
  /** Данные уровня источника (определяет вызывающий: у ядра нет файловой системы). */
  levelData?: LevelDataInfo;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Можно ли сливать этот мод. Бросает `MergeError`, если источник — тот же мод, зависимость
 * активного мода или ваниль: их записи уже входят в ваши слои.
 */
export function checkMergeSource(ctx: ModContext, sourceName: string): void {
  if (same(sourceName, ctx.modName)) throw new MergeError(`Нельзя слить мод «${sourceName}» сам в себя.`);
  const layer = ctx.layers.find((l) => same(l.name, sourceName)) ?? ctx.info.dependencies.find((d) => same(d, sourceName));
  if (layer !== undefined) {
    const name = typeof layer === 'string' ? layer : layer.name;
    throw new MergeError(
      `Мод «${name}» открыт как зависимость «${ctx.modName}» (или входит в игру): его записи уже подключены слоем и сливать их нельзя. ` +
        'Уберите его из зависимостей в заголовке мода, если хотите перенести его данные в свой мод.',
    );
  }
}

/** Устойчивый ключ поля для выбора при конфликте. */
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

/** Менял ли ваш мод это поле относительно нижних слоёв. */
function mineTouched(f: FieldChange, mine: GameRecord, lower: GameRecord | undefined): boolean {
  if (!lower) return true; // запись создана вашим модом — всё поле «ваше»
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

function fieldView(ctx: ModContext, f: FieldChange, rec: GameRecord, conflict: boolean): MergeFieldView {
  const key = mergeFieldKey(f);
  const text = formatFieldChange(ctx, f, rec);
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
      if (f.before !== undefined) view.before = formatFieldValue(ctx, rec, f.dict, f.key, f.before);
      if (f.after !== undefined) view.after = formatFieldValue(ctx, rec, f.dict, f.key, f.after);
      break;
    case 'ref':
      view.label = `${f.category} → ${refLabel(ctx, f.target.replace(/#\d+$/, ''))}`;
      if (f.before) view.before = formatRefValues(f.before);
      if (f.after) view.after = formatRefValues(f.after);
      break;
    case 'refOrder':
      view.label = `${f.category}: порядок`;
      view.before = f.before.join(', ');
      view.after = f.after.join(', ');
      break;
    case 'instance':
      view.label = `inst ${f.key}`;
      if (f.before) view.before = `${refLabel(ctx, f.before.target)} (${f.before.position.join(', ')})`;
      if (f.after) view.after = `${refLabel(ctx, f.after.target)} (${f.after.position.join(', ')})`;
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

/** Состояние записи изменения по `changeFlags` источника: `true` — запись источника лишь меняет чужую (из зависимости). */
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
  const counts: MergeCounts = { new: 0, changed: 0, deleted: 0, conflicts: 0, rejected: 0, identical: 0, alreadyMerged: 0, blocked: 0 };
  const warnings: string[] = [];
  const known = new Set([...ctx.layers.map((l) => l.name), ...ctx.info.dependencies, ctx.modName].map((n) => n.toLowerCase()));
  const missingDependencies = (source.file.header ? splitModList(source.file.header.dependencies) : []).filter((d) => !known.has(d.toLowerCase()));
  if (missingDependencies.length > 0) {
    warnings.push(`Источник зависит от модов, которых нет в зависимостях вашего мода: ${missingDependencies.join(', ')}. Записи, которые только меняют их данные, принять нельзя.`);
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
        // У вас запись нижних слоёв удалена, источник её правит.
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
      if (kind === 'new' && flaggedAsChange(source.file, delta)) blocked = 'запись только меняет данные мода, которого нет среди ваших слоёв (зависимость источника не подключена)';
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
      views.push(fieldView(ctx, f, shown, isConflict));
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

  // Связи между изменениями: на какие записи списка ссылается версия источника.
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

/** Что даст слияние: список изменений источника относительно вашего мода. Ничего не меняет. */
export function planMerge(ctx: ModContext, source: MergeSource, ledger: MergeLedger, options: MergePlanOptions = {}): MergePlan {
  return compute(ctx, source, ledger.state(ctx, source.name), options).plan;
}

// ---------------------------------------------------------------- выбор

/** Запись и все, на кого она (через версию источника) ссылается среди изменений: целый диалог с репликами. */
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
 * «Исправить ссылки»: к принятым добавить новые записи, на которые есть ссылки из принятых
 * (и дальше по цепочке новых). Возвращает добавленные id.
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

// ---------------------------------------------------------------- применение

export interface MergeSelection {
  /** Принятые записи (id). Остальные — «игнор». */
  accept: readonly string[];
  /** Выбор по полям конфликтов: `sid → ключ поля → source | mine`. */
  resolutions?: Readonly<Record<string, Readonly<Record<string, MergeChoice>>>>;
  /** Как решать конфликты без выбора (по умолчанию `mine`: ваши данные не теряются). */
  conflicts?: MergeChoice;
  /** Вместе с каждой принятой записью принять все, на кого она ссылается. */
  recursive?: boolean;
  /** Принять и новые записи, на которые есть принятые ссылки. */
  fixReferences?: boolean;
  /** Пользователь просил слить и данные уровня (слияние их не умеет, см. `MERGE_LEVEL_DATA_NOTE`). */
  levelData?: boolean;
}

export interface MergeSkip {
  sid: string;
  reason: string;
}

export interface MergeResult {
  /** Правка в истории (undefined — менять оказалось нечего). */
  changesetId: number | undefined;
  label: string;
  accepted: string[];
  created: number;
  changed: number;
  deleted: number;
  /** Поля конфликтов, взятые из источника / оставленные вашими. */
  tookSource: number;
  keptMine: number;
  /** Принятые целиком ради «исправить ссылки» или рекурсивного выбора. */
  addedByClosure: string[];
  skipped: MergeSkip[];
  /** Ссылки принятых записей на записи, которых нет нигде. */
  dangling: string[];
  notes: string[];
}

/** Вернуть полю значение «как у вас» (`before` изменения). */
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

/** Заголовок шага истории: разбирается `step-title.ts`. */
export function mergeLabel(sourceName: string, count: number): string {
  return `слияние: ${sourceName} (${count} записей)`;
}

/**
 * Применить выбранные изменения одной правкой. Список пересчитывается по текущему состоянию мода,
 * поэтому результат всегда соответствует тому, что видно сейчас. Принятое запоминается в `ledger`
 * вместе с правкой (отмена правки отменяет и «слито»).
 */
export function applyMerge(ctx: ModContext, source: MergeSource, ledger: MergeLedger, selection: MergeSelection, options: MergePlanOptions = {}): MergeResult {
  const { plan, internals } = compute(ctx, source, ledger.state(ctx, source.name), options);
  const bySid = new Map(plan.changes.map((c) => [c.sid, c]));
  const skipped: MergeSkip[] = [];
  const notes: string[] = [];
  let accept: string[] = [];
  for (const sid of selection.accept) {
    if (!bySid.has(sid)) skipped.push({ sid, reason: 'нет в списке изменений (уже слита, совпадает с вашей или отклонена)' });
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
      skipped.push({ sid, reason: 'отклонена — сначала верните её в список' });
      return false;
    }
    if (c.blocked) {
      skipped.push({ sid, reason: c.blocked });
      return false;
    }
    return true;
  });
  const ordered = plan.changes.filter((c) => ok.includes(c.sid));
  if (selection.levelData) notes.push(MERGE_LEVEL_DATA_NOTE);
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
  // Ссылки принятых записей на то, чего в моде нет (ни среди принятых, ни среди своих).
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

/** Отклонить записи: больше не показываются при слиянии этого мода (кнопка «Показать пропущенные» вернёт их). */
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

/** Вернуть отклонённые записи в список. */
export function unrejectMerge(ledger: MergeLedger, source: MergeSource | string, sids: readonly string[]): void {
  ledger.unreject(typeof source === 'string' ? source : source.name, sids);
}

// ---------------------------------------------------------------- отчёт

const KIND_MARK: Record<MergeKind, string> = { new: '+', changed: '~', deleted: '−' };

/** Список изменений текстом (CLI, MCP): одна строка на запись, под ней поля. */
export function formatMergePlan(plan: MergePlan, limit = Infinity): string[] {
  const c = plan.counts;
  const lines = [
    `слияние «${plan.source}»: новых ${c.new}, изменённых ${c.changed}, удалённых ${c.deleted}, конфликтов ${c.conflicts}` +
      (c.rejected ? `, отклонённых (скрыто) ${c.rejected}` : '') +
      (c.alreadyMerged ? `, уже слито ${c.alreadyMerged}` : '') +
      (c.identical ? `, совпадает ${c.identical}` : '') +
      (c.blocked ? `, нельзя принять ${c.blocked}` : ''),
  ];
  for (const w of plan.warnings) lines.push(`! ${w}`);
  let shown = 0;
  for (const ch of plan.changes) {
    if (shown >= limit) {
      lines.push(`… ещё ${plan.changes.length - shown}`);
      break;
    }
    shown++;
    const flags = [ch.conflict ? `КОНФЛИКТ (${ch.conflict})` : '', ch.rejected ? 'отклонена' : '', ch.blocked ? `нельзя: ${ch.blocked}` : ''].filter((x) => x !== '');
    lines.push(`${KIND_MARK[ch.kind]} ${ch.typeName} ${ch.sid} «${ch.name}»${ch.localizedName ? ` (${ch.localizedName})` : ''}${flags.length ? `  [${flags.join('; ')}]` : ''}`);
    for (const f of ch.fields) lines.push(`    ${f.conflict ? '! ' : ''}${f.text}${f.conflict ? '   (у вас иначе: источник → ' + (f.after ?? 'нет') + ')' : ''}`);
  }
  if (plan.levelData) lines.push(`данные уровня: ${plan.levelData.files.length} файлов в ${plan.levelData.dir} — ${MERGE_LEVEL_DATA_NOTE}`);
  return lines;
}

/** Итог применения текстом. */
export function formatMergeResult(r: MergeResult): string[] {
  const lines = [
    r.accepted.length === 0
      ? 'ничего не принято'
      : `слито ${r.accepted.length}: новых ${r.created}, изменённых ${r.changed}, удалённых ${r.deleted}` +
        (r.tookSource + r.keptMine > 0 ? `; конфликты: из источника ${r.tookSource}, оставлено ваших ${r.keptMine}` : ''),
  ];
  if (r.addedByClosure.length) lines.push(`по ссылкам добавлено записей: ${r.addedByClosure.length}`);
  for (const s of r.skipped) lines.push(`пропущено ${s.sid}: ${s.reason}`);
  if (r.dangling.length) lines.push(`! ссылки на записи, которых нет: ${r.dangling.slice(0, 10).join(', ')}${r.dangling.length > 10 ? '…' : ''} (слейте и их или исправьте ссылки)`);
  lines.push(...r.notes);
  return lines;
}

// ---------------------------------------------------------------- выбор для CLI / MCP

export interface MergeFilter {
  /** Конкретные id записей. */
  ids?: readonly string[];
  /** Типы: имя (`WEAPON`) или номер. */
  types?: readonly string[];
  /** Вид изменения. */
  kinds?: readonly MergeKind[];
  /** Все записи списка (конфликты решаются отдельно: по умолчанию остаются ваши значения). */
  all?: boolean;
}

/** Какие записи списка выбраны фильтром (по id / типу / виду / «все»). Пустой фильтр — ничего. */
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
