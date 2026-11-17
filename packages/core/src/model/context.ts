/**
 * Mod editing context: lower layers (vanilla in order, then dependencies) and the mod being
 * edited itself. Gives the resulting value of each record, its status (as in FCS), the reference
 * index and edit commands with undo/redo. The mod stores only changes relative to the lower
 * layers; only those are written on save.
 *
 * Mod changes are immutable record snapshots: a command does not edit the mod record in place but
 * computes a new one. So undo is simply returning the previous snapshot, and "record changed
 * since the last save" means "the snapshot is not the same object that was saved".
 */
import { decodeText, encodeText } from '../text.ts';
import { UiTextError } from '../ui-text.ts';
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import { joinModList, splitModList } from '../format/helpers.ts';
import { emptyRecord, FileType, type DataFile, type GameRecord, type Instance, type ModHeader, type Reference } from '../format/types.ts';
import { indexPoByRecord, type PoFile, type RecordTranslation } from '../locale/po.ts';
import type { GameSchema } from '../schema/game-schema.ts';
import {
  applyLayer,
  cloneRecord,
  diffRecord,
  isRemovalMarker,
  isRemovedRef,
  recordsEqual,
  removalMarker,
  scalarMap,
  type ScalarDict,
  type ScalarValueMap,
} from './record-ops.ts';

/** Data layer: file and its name (`gamedata.base`, `rebirth.mod`, ...). */
export interface Layer {
  name: string;
  file: DataFile;
}

/**
 * Record status from the point of view of the edited mod:
 * - `base`: a lower-layer record the mod does not touch;
 * - `new`: the record is created by the mod;
 * - `changed`: the mod changes a lower-layer record;
 * - `deleted`: the mod deletes a lower-layer record.
 */
export type RecordStatus = 'base' | 'new' | 'changed' | 'deleted';

export interface RecordOrigin {
  status: RecordStatus;
  /** Layer where the record first appeared (the mod name for new ones). */
  origin: string;
  /** All layers that set this record, in order (the mod can be last). */
  layers: string[];
  /** The record is deleted in lower layers (and possibly re-created by the mod). */
  deletedBelow?: string;
}

/** Mod header info in text form. */
export interface ModInfo {
  /** Mod file name (`My mod.mod`): string ids of new records are built from it. */
  fileName: string;
  /** File format: 16 or 17. */
  fileType: number;
  version: number;
  author: string;
  description: string;
  dependencies: string[];
  references: string[];
  /** Last issued numeric id: a new record gets `lastId + 1`. */
  lastId: number;
}

export interface ReferenceEntry {
  /** The record that holds the reference. */
  source: string;
  /** Reference category or `instance:<key>` for a placed object. */
  category: string;
  target: string;
  ref?: Reference;
  instance?: Instance;
}

interface Slot {
  delta: GameRecord;
  index: number;
}

export type ChangeOp =
  | { kind: 'record'; stringId: string; before?: Slot; after?: Slot }
  | { kind: 'info'; before: ModInfo; after: ModInfo };

export interface Changeset {
  id: number;
  label: string;
  ops: ChangeOp[];
}

export interface ModContextOptions {
  /** Lower layers in load order. */
  layers: readonly Layer[];
  /** The edited mod: the read file, or undefined for a new mod. */
  mod?: DataFile;
  /** Mod file name (`My mod.mod`). */
  modName: string;
  schema?: GameSchema;
  /** `gamedata.po` of the data language: translated record names (shown and searched). */
  po?: PoFile;
  /** Locale code of `po` (`de_DE`), if known. */
  dataLocale?: string;
}

export interface ChangeEvent {
  stringIds: string[];
  info: boolean;
}

/** Edit command error (unknown record, id already taken, etc.). */
export class EditError extends UiTextError {
  override name = 'EditError';
}

const CHANGED_V16 = 0x80000001;
const NEW_V16 = 0x80000002;

function infoFromFile(file: DataFile | undefined, fileName: string): ModInfo {
  const h = file?.header;
  return {
    fileName,
    fileType: file?.fileType ?? FileType.Mod,
    version: h?.version ?? 1,
    author: h ? decodeText(h.author) : '',
    description: h ? decodeText(h.description) : '',
    dependencies: h ? splitModList(h.dependencies) : [],
    references: h ? splitModList(h.references) : [],
    lastId: file?.lastId ?? 0,
  };
}

function sameInfo(a: ModInfo, b: ModInfo): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Text → bytes; if the text has not changed, the original bytes (and encoding) stay. */
function keepBytes(text: string, original: Uint8Array | undefined): Uint8Array {
  return original && decodeText(original) === text ? original : encodeText(text);
}

export class ModContext {
  readonly layers: readonly Layer[];
  readonly schema: GameSchema | undefined;
  private translations: Map<string, RecordTranslation>;
  /** Locale of the loaded translation (`ru_RU`); undefined — names only in the original. */
  dataLocale: string | undefined;

  /** sid → lower-layer records (layer number, record) in order. */
  private readonly lowerEntries = new Map<string, { layer: number; rec: GameRecord }[]>();
  private readonly lowerCache = new Map<string, GameRecord | null>();
  private readonly resolvedCache = new Map<string, GameRecord | null>();

  private readonly deltas = new Map<string, GameRecord>();
  private order: string[] = [];
  /** Mod records as they are in the file (read or saved). */
  private originals = new Map<string, GameRecord>();
  private originalFile: DataFile | undefined;
  private originalInfo: ModInfo;
  private modInfo: ModInfo;

  private readonly undoStack: Changeset[] = [];
  private readonly redoStack: Changeset[] = [];
  private open: Changeset | undefined;
  private depth = 0;
  private nextChangesetId = 1;

  private backIndex: Map<string, Set<string>> | undefined;
  private readonly listeners = new Set<(e: ChangeEvent) => void>();

  constructor(options: ModContextOptions) {
    this.layers = options.layers;
    this.schema = options.schema;
    this.translations = options.po ? indexPoByRecord(options.po) : new Map<string, RecordTranslation>();
    this.dataLocale = options.po ? options.dataLocale : undefined;
    for (const [i, layer] of options.layers.entries()) {
      for (const rec of layer.file.records) {
        let list = this.lowerEntries.get(rec.stringId);
        if (!list) {
          list = [];
          this.lowerEntries.set(rec.stringId, list);
        }
        list.push({ layer: i, rec });
      }
    }
    this.originalFile = options.mod;
    for (const rec of options.mod?.records ?? []) {
      if (this.deltas.has(rec.stringId)) throw new EditError({ en: `The mod has two records with id ${rec.stringId}`, ru: `В моде две записи с id ${rec.stringId}`, zh: `Mod 中有两条 ID 为 ${rec.stringId} 的记录` });
      this.deltas.set(rec.stringId, rec);
      this.originals.set(rec.stringId, rec);
      this.order.push(rec.stringId);
    }
    this.originalInfo = infoFromFile(options.mod, options.modName);
    this.modInfo = { ...this.originalInfo, dependencies: [...this.originalInfo.dependencies], references: [...this.originalInfo.references] };
  }

  // ---------------------------------------------------------------- reading

  get modName(): string {
    return this.modInfo.fileName;
  }

  get info(): Readonly<ModInfo> {
    return this.modInfo;
  }

  /** Record in the lower layers (result of overlaying); undefined if absent or deleted. */
  lower(stringId: string): GameRecord | undefined {
    let rec = this.lowerCache.get(stringId);
    if (rec === undefined) {
      let acc: GameRecord | undefined;
      for (const { rec: layer } of this.lowerEntries.get(stringId) ?? []) acc = applyLayer(acc, layer);
      rec = acc ?? null;
      this.lowerCache.set(stringId, rec);
    }
    return rec ?? undefined;
  }

  /** Resulting record including the mod; undefined if absent or deleted. The returned record must not be modified. */
  get(stringId: string): GameRecord | undefined {
    let rec = this.resolvedCache.get(stringId);
    if (rec === undefined) {
      const lower = this.lower(stringId);
      const delta = this.deltas.get(stringId);
      rec = (delta ? applyLayer(lower, delta) : lower) ?? null;
      this.resolvedCache.set(stringId, rec);
    }
    return rec ?? undefined;
  }

  /**
   * Record type and name without assembling the whole record, for indexes of tens of thousands of rows. The same
   * record as `get ?? lower ?? delta`: the resulting one; for one deleted by the mod, the lower layers'; otherwise
   * the mod record. For lower layers the type and name are taken from the last layer (this is how
   * `applyLayer` overlays them); a deletion marker last means there is no record.
   */
  headline(stringId: string): Pick<GameRecord, 'type' | 'name'> | undefined {
    if (!this.deltas.has(stringId)) {
      const last = this.lowerEntries.get(stringId)?.at(-1)?.rec;
      return last && !isRemovalMarker(last) ? last : undefined;
    }
    return this.get(stringId) ?? this.lower(stringId) ?? this.deltas.get(stringId);
  }

  has(stringId: string): boolean {
    return this.get(stringId) !== undefined;
  }

  /** Mod record (changes) as it will be written to the file. */
  delta(stringId: string): GameRecord | undefined {
    return this.deltas.get(stringId);
  }

  /** Mod records in file order. */
  modRecords(): GameRecord[] {
    return this.order.map((s) => this.deltas.get(s)!);
  }

  status(stringId: string): RecordStatus | undefined {
    const delta = this.deltas.get(stringId);
    const lower = this.lower(stringId);
    if (!delta) return lower ? 'base' : undefined;
    if (!lower) return isRemovalMarker(delta) ? undefined : 'new';
    return isRemovalMarker(delta) ? 'deleted' : 'changed';
  }

  origin(stringId: string): RecordOrigin | undefined {
    const status = this.status(stringId);
    if (!status) return undefined;
    const entries = this.lowerEntries.get(stringId) ?? [];
    const layers = entries.map((e) => this.layers[e.layer]!.name);
    if (this.deltas.has(stringId)) layers.push(this.modName);
    const out: RecordOrigin = { status, origin: layers[0] ?? this.modName, layers };
    let acc: GameRecord | undefined;
    for (const e of entries) {
      const next = applyLayer(acc, e.rec);
      if (acc && !next) out.deletedBelow = this.layers[e.layer]!.name;
      acc = next;
    }
    return out;
  }

  /** All string ids (including deleted ones) in order of first appearance across layers. */
  *allStringIds(): Generator<string> {
    yield* this.lowerEntries.keys();
    for (const s of this.order) if (!this.lowerEntries.has(s)) yield s;
  }

  /** All existing resulting records. */
  *records(): Generator<GameRecord> {
    for (const s of this.allStringIds()) {
      const r = this.get(s);
      if (r) yield r;
    }
  }

  /** Record name (as text); undefined for a missing one. */
  name(stringId: string): string | undefined {
    const r = this.get(stringId) ?? this.lower(stringId);
    return r ? decodeText(r.name) : undefined;
  }

  /** Name of the record in the data language (from its `gamedata.po`); undefined — no translation. */
  localizedName(stringId: string): string | undefined {
    const e = this.translations.get(stringId)?.name;
    const s = e?.msgstr[0];
    return s === undefined || s === '' ? undefined : s;
  }

  /**
   * Switch the data language: `po` of another locale, or none. Does not touch records and does
   * not notify subscribers (names are not record data); callers refresh their own views.
   */
  setTranslations(po: PoFile | undefined, dataLocale?: string): void {
    this.translations = po ? indexPoByRecord(po) : new Map<string, RecordTranslation>();
    this.dataLocale = po ? dataLocale : undefined;
  }

  /** Does the mod have unsaved changes. */
  get dirty(): boolean {
    if (!sameInfo(this.modInfo, this.originalInfo)) return true;
    if (this.order.length !== this.originals.size) return true;
    return this.order.some((s) => this.deltas.get(s) !== this.originals.get(s));
  }

  isDirty(stringId: string): boolean {
    return this.deltas.get(stringId) !== this.originals.get(stringId);
  }

  // ---------------------------------------------------------------- references

  /** References from the record (resulting), including placed objects. */
  referencesFrom(stringId: string): ReferenceEntry[] {
    const rec = this.get(stringId);
    if (!rec) return [];
    const out: ReferenceEntry[] = [];
    for (const [category, list] of rec.refs) for (const ref of list) out.push({ source: stringId, category, target: ref.target, ref });
    for (const [key, instance] of rec.instances) out.push({ source: stringId, category: `instance:${key}`, target: instance.target, instance });
    return out;
  }

  /** Back references: which records reference `stringId`. The index is built on the first call. */
  referencesTo(stringId: string): ReferenceEntry[] {
    const sources = this.index().get(stringId);
    if (!sources) return [];
    const out: ReferenceEntry[] = [];
    for (const s of sources) for (const e of this.referencesFrom(s)) if (e.target === stringId) out.push(e);
    return out;
  }

  private index(): Map<string, Set<string>> {
    if (!this.backIndex) {
      this.backIndex = new Map();
      for (const s of this.allStringIds()) this.indexAdd(s, this.get(s));
    }
    return this.backIndex;
  }

  private indexAdd(source: string, rec: GameRecord | undefined): void {
    if (!rec || !this.backIndex) return;
    for (const t of recordTargets(rec)) {
      let set = this.backIndex.get(t);
      if (!set) {
        set = new Set();
        this.backIndex.set(t, set);
      }
      set.add(source);
    }
  }

  private indexRemove(source: string, rec: GameRecord | undefined): void {
    if (!rec || !this.backIndex) return;
    for (const t of recordTargets(rec)) this.backIndex.get(t)?.delete(source);
  }

  // ---------------------------------------------------------------- history

  /**
   * Run several commands as one edit (one undo). If `fn` throws,
   * all its changes are rolled back. Nested transactions become part of the outer one.
   */
  transaction<T>(label: string, fn: () => T): T {
    if (this.depth === 0) this.open = { id: this.nextChangesetId++, label, ops: [] };
    this.depth++;
    let ok = false;
    try {
      const result = fn();
      ok = true;
      return result;
    } finally {
      this.depth--;
      if (this.depth === 0) {
        const cs = this.open!;
        this.open = undefined;
        if (!ok) {
          this.revertOps(cs.ops);
          // A rolled-back edit never reached the history: its number is free again.
          if (this.nextChangesetId === cs.id + 1) this.nextChangesetId = cs.id;
        } else if (cs.ops.length > 0) {
          this.undoStack.push(cs);
          this.redoStack.length = 0;
        }
      }
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Undo the last edit; returns it or undefined. */
  undo(): Changeset | undefined {
    if (this.depth > 0) throw new EditError({ en: 'Cannot undo inside a transaction', ru: 'Нельзя отменять внутри транзакции', zh: '不能在事务内撤销' });
    const cs = this.undoStack.pop();
    if (!cs) return undefined;
    this.revertOps(cs.ops);
    this.redoStack.push(cs);
    return cs;
  }

  redo(): Changeset | undefined {
    if (this.depth > 0) throw new EditError({ en: 'Cannot redo inside a transaction', ru: 'Нельзя повторять внутри транзакции', zh: '不能在事务内重做' });
    const cs = this.redoStack.pop();
    if (!cs) return undefined;
    const changed: string[] = [];
    let info = false;
    for (const op of cs.ops) {
      if (op.kind === 'record') {
        this.applySlot(op.stringId, op.after);
        changed.push(op.stringId);
      } else {
        this.modInfo = op.after;
        info = true;
      }
    }
    this.undoStack.push(cs);
    this.emit({ stringIds: changed, info });
    return cs;
  }

  /**
   * Undo edits up to and including `id` (the "back arrow" menu, the "History" panel). If there is no such
   * active edit: EditError, nothing changes. Returns the undone ones (newest first).
   */
  undoTo(id: number): Changeset[] {
    if (this.depth > 0) throw new EditError({ en: 'Cannot undo inside a transaction', ru: 'Нельзя отменять внутри транзакции', zh: '不能在事务内撤销' });
    if (!this.undoStack.some((c) => c.id === id)) throw new EditError({ en: `Edit ${id} is not among the applied edits`, ru: `Правки ${id} нет среди действующих`, zh: `编辑 ${id} 不在已生效的编辑中` });
    const out: Changeset[] = [];
    for (;;) {
      const cs = this.undo()!;
      out.push(cs);
      if (cs.id === id) return out;
    }
  }

  /** Redo undone edits up to and including `id`. Returns the redone ones in order. */
  redoTo(id: number): Changeset[] {
    if (this.depth > 0) throw new EditError({ en: 'Cannot redo inside a transaction', ru: 'Нельзя повторять внутри транзакции', zh: '不能在事务内重做' });
    if (!this.redoStack.some((c) => c.id === id)) throw new EditError({ en: `Edit ${id} is not among the undone edits`, ru: `Правки ${id} нет среди отменённых`, zh: `编辑 ${id} 不在已撤销的编辑中` });
    const out: Changeset[] = [];
    for (;;) {
      const cs = this.redo()!;
      out.push(cs);
      if (cs.id === id) return out;
    }
  }

  /**
   * Go to the state right after edit `id` (undone or active); `0` goes to the state
   * before all history edits. Returns how many edits were undone and redone.
   */
  goToStep(id: number): { undone: number; redone: number } {
    if (id === 0) {
      const first = this.undoStack[0];
      return { undone: first ? this.undoTo(first.id).length : 0, redone: 0 };
    }
    const i = this.undoStack.findIndex((c) => c.id === id);
    if (i >= 0) {
      const next = this.undoStack[i + 1];
      return { undone: next ? this.undoTo(next.id).length : 0, redone: 0 };
    }
    return { undone: 0, redone: this.redoTo(id).length };
  }

  /** Edit from the undo history by id (only those currently active). */
  findChangeset(id: number): Changeset | undefined {
    return this.undoStack.find((c) => c.id === id);
  }

  /**
   * Roll back one edit from the history without touching later ones: with a new edit ("rollback: …")
   * that can be undone too. If the affected records (or the header) were changed later:
   * EditError, nothing changes. An edit already undone via undo has nothing to roll back.
   */
  rollbackChangeset(id: number): Changeset {
    if (this.depth > 0) throw new EditError({ en: 'Cannot roll back inside a transaction', ru: 'Нельзя откатывать внутри транзакции', zh: '不能在事务内回滚' });
    const cs = this.findChangeset(id);
    if (!cs) throw new EditError(this.redoStack.some((c) => c.id === id) ? { en: `Edit ${id} is already undone`, ru: `Правка ${id} уже отменена`, zh: `编辑 ${id} 已被撤销` } : { en: `Edit ${id} is not in the history`, ru: `Правки ${id} нет в истории`, zh: `历史中没有编辑 ${id}` });
    // State after the edit: the last operation for each record.
    const last = new Map<string, Slot | undefined>();
    let info: ModInfo | undefined;
    for (const op of cs.ops) {
      if (op.kind === 'record') last.set(op.stringId, op.after);
      else info = op.after;
    }
    const later = [...last].filter(([sid, after]) => this.deltas.get(sid) !== after?.delta).map(([sid]) => sid);
    if (info !== undefined && this.modInfo !== info) later.push('заголовок мода');
    if (later.length > 0) throw new EditError({ en: `Cannot roll back “${cs.label}”: changed later: ${later.join(', ')}`, ru: `Нельзя откатить «${cs.label}»: позже изменены ${later.join(', ')}`, zh: `无法回滚 “${cs.label}”：之后又修改了 ${later.join('、')}` });
    const next = this.nextChangesetId;
    this.transaction(`откат: ${cs.label}`, () => {
      for (const op of [...cs.ops].reverse()) {
        if (op.kind === 'record') this.setDelta(op.stringId, op.before?.delta, op.before?.index);
        else this.setInfo(op.before);
      }
    });
    const done = this.undoStack.at(-1);
    if (done?.id !== next) throw new EditError({ en: `Rolling back “${cs.label}” changed nothing`, ru: `Откат «${cs.label}» ничего не изменил`, zh: `回滚 “${cs.label}” 没有改变任何内容` });
    return done;
  }

  /** Edits that can be undone (the last one at the end), and ones that can be redone. */
  history(): { undo: readonly Changeset[]; redo: readonly Changeset[] } {
    return { undo: [...this.undoStack], redo: [...this.redoStack].reverse() };
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private revertOps(ops: readonly ChangeOp[]): void {
    const changed: string[] = [];
    let info = false;
    for (const op of [...ops].reverse()) {
      if (op.kind === 'record') {
        this.applySlot(op.stringId, op.before);
        changed.push(op.stringId);
      } else {
        this.modInfo = op.before;
        info = true;
      }
    }
    this.emit({ stringIds: changed, info });
  }

  private applySlot(stringId: string, slot: Slot | undefined): void {
    const old = this.backIndex ? this.get(stringId) : undefined;
    const at = this.order.indexOf(stringId);
    if (at >= 0) this.order.splice(at, 1);
    if (slot) {
      this.deltas.set(stringId, slot.delta);
      this.order.splice(Math.min(slot.index, this.order.length), 0, stringId);
    } else this.deltas.delete(stringId);
    this.resolvedCache.delete(stringId);
    if (this.backIndex) {
      this.indexRemove(stringId, old);
      this.indexAdd(stringId, this.get(stringId));
    }
  }

  /** Write a new snapshot of a mod record (undefined removes the record from the mod) and add it to the history. */
  private setDelta(stringId: string, delta: GameRecord | undefined, index?: number): void {
    const prev = this.deltas.get(stringId);
    if (prev === delta) return;
    const at = this.order.indexOf(stringId);
    const before = prev ? { delta: prev, index: at } : undefined;
    const after = delta ? { delta, index: index ?? (at >= 0 ? at : this.order.length) } : undefined;
    this.record({ kind: 'record', stringId, before, after }, () => {
      this.applySlot(stringId, after);
    });
    this.emit({ stringIds: [stringId], info: false });
  }

  private setInfo(next: ModInfo): void {
    const before = this.modInfo;
    if (sameInfo(before, next)) return;
    this.record({ kind: 'info', before, after: next }, () => {
      this.modInfo = next;
    });
    this.emit({ stringIds: [], info: true });
  }

  private record(op: ChangeOp, apply: () => void): void {
    if (this.depth === 0) {
      this.transaction(op.kind === 'record' ? `правка ${op.stringId}` : 'заголовок мода', () => {
        this.record(op, apply);
      });
      return;
    }
    apply();
    this.open!.ops.push(op);
  }

  // ---------------------------------------------------------------- commands

  private require(stringId: string): GameRecord {
    const rec = this.get(stringId);
    if (!rec) throw new EditError({ en: `No record ${stringId}`, ru: `Записи ${stringId} нет`, zh: `没有记录 ${stringId}` });
    return rec;
  }

  /** String id for a new record: `<lastId+1>-<mod name>`; lastId is incremented. */
  allocateStringId(): string {
    let id = this.modInfo.lastId;
    let sid: string;
    do {
      id++;
      sid = `${id}-${this.modName}`;
    } while (this.lowerEntries.has(sid) || this.deltas.has(sid));
    this.setInfo({ ...this.modInfo, lastId: id });
    return sid;
  }

  private checkFree(stringId: string): void {
    if (this.has(stringId) || this.deltas.has(stringId)) throw new EditError({ en: `Record ${stringId} already exists`, ru: `Запись ${stringId} уже есть`, zh: `记录 ${stringId} 已存在` });
  }

  /** Set the resulting value of a record: the difference with the lower layers goes into the mod. */
  private putResolved(stringId: string, desired: GameRecord): void {
    const lower = this.lower(stringId);
    const prev = this.deltas.get(stringId);
    const prevChange = prev && !isRemovalMarker(prev) ? prev : undefined;
    let delta: GameRecord | undefined;
    if (lower) delta = diffRecord(lower, desired, prevChange);
    else {
      delta = cloneRecord(desired);
      for (const [cat, list] of delta.refs) delta.refs.set(cat, list.filter((r) => !isRemovedRef(r)));
    }
    if (delta) {
      delta.stringId = stringId;
      if (prev) {
        delta.lead = prev.lead;
        delta.id = prev.id;
        delta.changeFlags = prev.changeFlags;
        if (isRemovalMarker(prev)) delta.changeFlags = 0;
        if (recordsEqual(delta, prev)) delta = prev;
      }
    }
    this.setDelta(stringId, delta);
  }

  /**
   * Change a record arbitrarily: `mutate` gets a copy of the resulting record. The difference with
   * the lower layers goes into the mod. The other commands are built on this one.
   */
  editRecord(stringId: string, mutate: (draft: GameRecord) => void, label = `правка ${stringId}`): void {
    const draft = cloneRecord(this.require(stringId));
    mutate(draft);
    if (draft.stringId !== stringId) throw new EditError({ en: 'The string id is changed with changeStringIds', ru: 'Строковый id меняется командой changeStringIds', zh: '字符串 ID 需用 changeStringIds 修改' });
    this.transaction(label, () => {
      this.putResolved(stringId, draft);
    });
  }

  /**
   * Set the whole resulting value of a record (mod merging): the difference with the lower
   * layers goes into the mod. The record may not exist; then it is created. Service fields (`lead`, `id`, flags)
   * are taken from the previous mod record, and for a new one they are zeroed: saving will set them.
   */
  putRecord(stringId: string, desired: GameRecord, label = `правка ${stringId}`): void {
    const draft = cloneRecord(desired);
    draft.stringId = stringId;
    if (!this.deltas.has(stringId)) {
      draft.lead = 0;
      draft.id = 0;
      draft.changeFlags = 0;
    }
    this.transaction(label, () => {
      this.putResolved(stringId, draft);
    });
  }

  /** Create a record. Without `stringId` the id is issued automatically. Returns the id. */
  createRecord(type: number, name: string, options: { stringId?: string } = {}): string {
    return this.transaction(`создать «${name}»`, () => {
      const sid = options.stringId ?? this.allocateStringId();
      this.checkFree(sid);
      this.putResolved(sid, emptyRecord(type, sid, encodeText(name)));
      return sid;
    });
  }

  /** Copy of a record (all resulting fields and references) under a new id. */
  duplicateRecord(stringId: string, options: { stringId?: string; name?: string } = {}): string {
    const src = this.require(stringId);
    return this.transaction(`копия ${stringId}`, () => {
      const sid = options.stringId ?? this.allocateStringId();
      this.checkFree(sid);
      const copy = cloneRecord(src);
      copy.stringId = sid;
      if (options.name !== undefined) copy.name = encodeText(options.name);
      this.putResolved(sid, copy);
      return sid;
    });
  }

  /**
   * Delete a record. A new mod record is simply removed; a lower-layer record is marked
   * deleted. `removeReferences`: also remove references to it from other records.
   */
  deleteRecord(stringId: string, options: { removeReferences?: boolean } = {}): void {
    this.require(stringId);
    this.transaction(`удалить ${stringId}`, () => {
      if (options.removeReferences) {
        for (const source of new Set(this.referencesTo(stringId).map((e) => e.source))) {
          if (source === stringId) continue;
          this.editRecord(source, (d) => {
            for (const [cat, list] of d.refs) d.refs.set(cat, list.filter((r) => r.target !== stringId));
          });
        }
      }
      const lower = this.lower(stringId);
      const prev = this.deltas.get(stringId);
      if (!lower) this.setDelta(stringId, undefined);
      else {
        const marker = removalMarker(lower);
        if (prev) {
          marker.lead = prev.lead;
          marker.id = prev.id;
          if (isRemovalMarker(prev)) marker.changeFlags = prev.changeFlags;
        }
        this.setDelta(stringId, prev && isRemovalMarker(prev) ? prev : marker);
      }
    });
  }

  /** Remove all changes of a record from the mod (for a new record, delete it). */
  revertRecord(stringId: string): void {
    this.setDelta(stringId, undefined);
  }

  /** Restore a lower-layer record deleted by the mod. */
  restoreRecord(stringId: string): void {
    const prev = this.deltas.get(stringId);
    if (prev && isRemovalMarker(prev)) this.setDelta(stringId, undefined);
  }

  /** Delete several records as one edit (one undo); already deleted ones are skipped. Returns how many were deleted. */
  deleteRecords(stringIds: Iterable<string>, options: { removeReferences?: boolean } = {}): number {
    const ids = [...new Set(stringIds)].filter((sid) => this.status(sid) !== 'deleted');
    for (const sid of ids) this.require(sid);
    if (ids.length === 0) return 0;
    this.transaction(`удалить записи: ${ids.length}`, () => {
      for (const sid of ids) this.deleteRecord(sid, options);
    });
    return ids.length;
  }

  /** Copies of several records as one edit (one undo); deleted ones are skipped. Returns the new ids in order. */
  duplicateRecords(stringIds: Iterable<string>): string[] {
    const ids = [...new Set(stringIds)].filter((sid) => this.status(sid) !== 'deleted');
    for (const sid of ids) this.require(sid);
    if (ids.length === 0) return [];
    return this.transaction(`копии записей: ${ids.length}`, () => ids.map((sid) => this.duplicateRecord(sid)));
  }

  /** Restore several records deleted by the mod as one edit. Returns how many were restored. */
  restoreRecords(stringIds: Iterable<string>): number {
    const ids = [...new Set(stringIds)].filter((sid) => this.status(sid) === 'deleted');
    if (ids.length === 0) return 0;
    this.transaction(`восстановить записи: ${ids.length}`, () => {
      for (const sid of ids) this.restoreRecord(sid);
    });
    return ids.length;
  }

  /** Remove all mod changes of several changed records as one edit. Returns how many were reverted. */
  revertRecords(stringIds: Iterable<string>): number {
    const ids = [...new Set(stringIds)].filter((sid) => this.status(sid) === 'changed');
    if (ids.length === 0) return 0;
    this.transaction(`откатить записи: ${ids.length}`, () => {
      for (const sid of ids) this.revertRecord(sid);
    });
    return ids.length;
  }

  renameRecord(stringId: string, name: string): void {
    this.editRecord(stringId, (d) => {
      d.name = encodeText(name);
    }, `имя ${stringId}`);
  }

  setField<D extends ScalarDict>(stringId: string, dict: D, key: string, value: ScalarValueMap[D]): void {
    this.editRecord(stringId, (d) => {
      scalarMap(d, dict).set(key, value);
    }, `${stringId}: ${key}`);
  }

  /** Return a field to its lower-layer value (for a new record, remove the field). */
  resetField(stringId: string, dict: ScalarDict, key: string): void {
    const lower = this.lower(stringId);
    this.editRecord(stringId, (d) => {
      const lo = lower ? scalarMap(lower, dict).get(key) : undefined;
      if (lo === undefined) scalarMap(d, dict).delete(key);
      else scalarMap(d, dict).set(key, lo);
    }, `${stringId}: сброс ${key}`);
  }

  /** Replace the references of a category entirely. */
  setReferences(stringId: string, category: string, refs: readonly Reference[]): void {
    this.editRecord(stringId, (d) => {
      d.refs.set(category, refs.map((r) => ({ ...r })));
    }, `${stringId}: ${category}`);
  }

  /** Add a reference (or change the values of an existing reference to the same target). */
  addReference(stringId: string, category: string, target: string, values: readonly number[] = this.refDefaults(stringId, category)): void {
    this.editRecord(stringId, (d) => {
      const list = d.refs.get(category) ?? [];
      const ref = { target, v0: values[0] ?? 0, v1: values[1] ?? 0, v2: values[2] ?? 0 };
      const i = list.findIndex((r) => r.target === target);
      if (i >= 0) list[i] = ref;
      else list.push(ref);
      d.refs.set(category, list);
    }, `${stringId}: + ${category} → ${target}`);
  }

  removeReference(stringId: string, category: string, target: string): void {
    this.editRecord(stringId, (d) => {
      const list = d.refs.get(category);
      if (list) d.refs.set(category, list.filter((r) => r.target !== target));
    }, `${stringId}: − ${category} → ${target}`);
  }

  /** Return a reference category to its lower-layer list (for a new record, or one the lower layers lack, drop it). */
  resetReferences(stringId: string, category: string): void {
    const lower = this.lower(stringId)?.refs.get(category);
    this.editRecord(stringId, (d) => {
      if (lower === undefined) d.refs.delete(category);
      else d.refs.set(category, lower.filter((r) => !isRemovedRef(r)).map((r) => ({ ...r })));
    }, `${stringId}: сброс ${category}`);
  }

  clearReferences(stringId: string, category: string): void {
    this.setReferences(stringId, category, []);
  }

  setInstance(stringId: string, key: string, instance: Instance): void {
    this.editRecord(stringId, (d) => {
      d.instances.set(key, instance);
    }, `${stringId}: объект ${key}`);
  }

  /** Remove a placed object (only one added by the mod: lower layers have no deletion marker). */
  removeInstance(stringId: string, key: string): void {
    this.editRecord(stringId, (d) => {
      d.instances.delete(key);
    }, `${stringId}: − объект ${key}`);
  }

  /**
   * Name of a record type: a built-in one, or one added by a schema extension of this context.
   * A number nobody declared is shown as `TYPE_<number>`.
   */
  typeName(type: number): string {
    return itemTypeName(type, this.schema?.itemTypes);
  }

  /** Number of a record type by name (built-in or from a schema extension); undefined if unknown. */
  typeId(name: string): number | undefined {
    return itemTypeId(name, this.schema?.itemTypes);
  }

  /** Default values of a new reference from the schema (or 0, 0, 0). */
  refDefaults(stringId: string, category: string): number[] {
    const rec = this.get(stringId);
    const type = rec && this.schema?.types.get(this.typeName(rec.type));
    const def = type?.fields.get(category);
    return def?.refDefaults ?? [0, 0, 0];
  }

  /**
   * Rename string ids of new mod records (simultaneously: they can be swapped).
   * References in all mod records are rewritten. Record positions in the file are preserved.
   */
  changeStringIds(mapping: ReadonlyMap<string, string>): void {
    for (const [from, to] of mapping) {
      if (this.status(from) !== 'new') throw new EditError({ en: `Only new records of the mod can change their id: ${from}`, ru: `Менять id можно только у новых записей мода: ${from}`, zh: `只有 Mod 的新记录可以修改 ID：${from}` });
      if (from !== to && (this.lowerEntries.has(to) || (this.deltas.has(to) && !mapping.has(to)))) {
        throw new EditError({ en: `Id ${to} is already taken`, ru: `Id ${to} уже занят`, zh: `ID ${to} 已被占用` });
      }
    }
    const targets = new Set(mapping.values());
    if (targets.size !== mapping.size) throw new EditError({ en: 'Two ids are renamed to the same one', ru: 'Два id переименовываются в один', zh: '两个 ID 被重命名为同一个' });
    const remap = (s: string): string => mapping.get(s) ?? s;
    this.transaction('смена id', () => {
      const moved = [...mapping.keys()]
        .map((from) => ({ from, index: this.order.indexOf(from) }))
        .sort((a, b) => b.index - a.index);
      const updated = new Map<string, GameRecord>();
      for (const sid of this.order) {
        const delta = this.deltas.get(sid)!;
        const next = remapRecord(delta, remap);
        if (next !== delta || mapping.has(sid)) updated.set(sid, next);
      }
      for (const { from } of moved) this.setDelta(from, undefined);
      for (const [sid, rec] of updated) if (!mapping.has(sid)) this.setDelta(sid, rec);
      for (const { from, index } of [...moved].reverse()) {
        const rec = updated.get(from)!;
        this.setDelta(rec.stringId, rec, index);
      }
    });
  }

  /** Change the mod header info. */
  setModInfo(patch: Partial<Omit<ModInfo, 'fileName'>>): void {
    this.transaction('заголовок мода', () => {
      this.setInfo({ ...this.modInfo, ...patch });
    });
  }

  // ---------------------------------------------------------------- saving

  /**
   * Assemble the mod file: only mod records (changes). Records and the header untouched since the last save
   * are written as they were (byte for byte). Changed ones get their flags recomputed:
   * format 16: 0x80000002 new / 0x80000001 changed (the previous change status is preserved);
   * format 17: save number in the high bits and 0/1/3 in the low bits.
   */
  buildModFile(): DataFile {
    return this.build().file;
  }

  /** Assemble the file and consider it saved: `dirty` = false afterwards, undo still works. */
  markSaved(): DataFile {
    const { file, dirtyRecords } = this.build();
    for (const [sid, flags] of dirtyRecords) {
      const delta = this.deltas.get(sid)!;
      delta.changeFlags = flags.changeFlags;
      delta.lead = flags.lead;
    }
    this.originals = new Map(this.order.map((s) => [s, this.deltas.get(s)!]));
    this.originalFile = file;
    this.originalInfo = this.modInfo;
    return file;
  }

  private build(): { file: DataFile; dirtyRecords: Map<string, { changeFlags: number; lead: number }> } {
    const info = this.modInfo;
    const v17 = info.fileType === FileType.MergeMod;
    const anyDirty = this.dirty;
    const orig = this.originalFile;
    const sameType = orig?.fileType === info.fileType;
    const oldMerge = sameType ? orig.header?.merge : undefined;
    const saveCount = (oldMerge?.saveCount ?? 0) + (anyDirty || !sameType ? 1 : 0);
    const dirtyRecords = new Map<string, { changeFlags: number; lead: number }>();
    const records = this.order.map((sid) => {
      const delta = this.deltas.get(sid)!;
      if (sameType && delta === this.originals.get(sid)) return delta;
      const flags = { changeFlags: this.flagsFor(sid, delta, v17, saveCount), lead: v17 ? (delta.lead === 0 ? 1 : delta.lead) : 0 };
      dirtyRecords.set(sid, flags);
      return { ...delta, ...flags };
    });
    const oh = sameType ? orig.header : undefined;
    let header: ModHeader;
    if (oh && !anyDirty) header = oh;
    else {
      const depsText = info.dependencies.join(',');
      const refsText = info.references.join(',');
      header = {
        version: info.version,
        author: keepBytes(info.author, oh?.author),
        description: keepBytes(info.description, oh?.description),
        dependencies: oh && decodeText(oh.dependencies) === depsText ? oh.dependencies : joinModList(info.dependencies),
        references: oh && decodeText(oh.references) === refsText ? oh.references : joinModList(info.references),
      };
      if (v17) {
        header.merge = oldMerge
          ? { ...oldMerge, saveCount }
          : { saveCount, lastMerge: 0, mergeEntries: [], deleteRequests: [] };
        if (oh?.extra) header.extra = oh.extra;
      }
    }
    const file: DataFile = {
      fileType: info.fileType,
      header,
      lastId: info.lastId,
      records,
      tail: sameType ? orig.tail : new Uint8Array(),
    };
    if (sameType && orig.latin1Ids) file.latin1Ids = orig.latin1Ids;
    return { file, dirtyRecords };
  }

  private flagsFor(sid: string, delta: GameRecord, v17: boolean, saveCount: number): number {
    const lower = this.lower(sid);
    const prev = this.originals.get(sid);
    const prevV17 = this.originalFile?.fileType === FileType.MergeMod;
    const prevSt = prev ? (prevV17 ? prev.changeFlags & 15 : prev.changeFlags & 0x7fffffff) : undefined;
    let st: 'new' | 'changed' | 'renamed';
    if (!lower) st = 'new';
    else if (prevSt === 3 && !isRemovalMarker(delta) && prev && !isRemovalMarker(prev)) st = 'renamed';
    else st = 'changed';
    if (v17) return ((saveCount << 4) | (st === 'new' ? 0 : st === 'changed' ? 1 : 3)) >>> 0;
    return st === 'new' ? NEW_V16 : st === 'changed' ? CHANGED_V16 : 0x80000003;
  }
}

/** Targets of the record's references and objects. */
function recordTargets(rec: GameRecord): Set<string> {
  const out = new Set<string>();
  for (const list of rec.refs.values()) for (const r of list) out.add(r.target);
  for (const i of rec.instances.values()) out.add(i.target);
  return out;
}

/** Copy of the record with rewritten ids (its own and reference targets); the same record if nothing to change. */
function remapRecord(rec: GameRecord, remap: (s: string) => string): GameRecord {
  let touched = remap(rec.stringId) !== rec.stringId;
  for (const list of rec.refs.values()) if (list.some((r) => remap(r.target) !== r.target)) touched = true;
  for (const i of rec.instances.values()) if (remap(i.target) !== i.target) touched = true;
  if (!touched) return rec;
  const out = cloneRecord(rec);
  out.stringId = remap(rec.stringId);
  for (const list of out.refs.values()) for (const r of list) r.target = remap(r.target);
  for (const i of out.instances.values()) i.target = remap(i.target);
  return out;
}

