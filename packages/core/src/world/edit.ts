/**
 * World edits in a mod: move, rotate, new and removed instances in level files
 * (`zone.X.Y.zone`, `leveldata.level`, `interiors.level`).
 *
 * A mod level file (type 15, no header) is a diff on top of the lower layers: only changed or new
 * records. How it works in game files and Workshop mods:
 *  - the owner record (`0-buildinglist`, type INSTANCE_COLLECTION, name "0", no fields) carries only
 *    changed / new instances, change flags 0;
 *  - an instance is overwritten whole (target, position, quaternion, states);
 *  - to remove an instance — an instance with the same key and an empty target, position 0, rotation (1, 0, 0, 0);
 *  - mods put building states (GAMESTATE_BUILDING) as full copies (3191 of 3191);
 *  - the key of a new instance is `<n>-<mod name>-INGAME`, n — the file's `lastId` + 1.
 *
 * Untouched mod records are written as the same bytes: `writeDataFile` is lossless (162/162 level
 * files of Workshop mods), and records the edit did not touch stay the same objects.
 * The module has no disk access.
 */
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import { emptyRecord, FileType, type DataFile, type GameRecord, type Instance, type Vec3, type Vec4 } from '../format/types.ts';
import { applyLayer, cloneRecord, instanceEqual, recordsEqual } from '../model/record-ops.ts';
import { decodeText, encodeText } from '../text.ts';
import { zoneOfPoint } from './terrain.ts';
import { zoneOfPath, type WorldFile } from './world.ts';
import { UiTextError } from '../ui-text.ts';

/** A "removal" instance: this is how a lower layer loses an object. */
export function removedInstance(): Instance {
  return { target: '', position: [0, 0, 0], rotation: [1, 0, 0, 0], states: [] };
}

export interface WorldStep {
  label: string;
  changes: WorldRecordChange[];
}

interface WorldRecordChange {
  path: string;
  sid: string;
  /** The mod record before the step (undefined — it did not exist). */
  before: GameRecord | undefined;
  after: GameRecord | undefined;
  lastIdBefore: number;
  lastIdAfter: number;
}

interface ModLevelFile {
  path: string;
  /** The mod's original file (undefined — no file yet). */
  original: DataFile | undefined;
  /** Mod records in file order; new ones at the end. */
  records: Map<string, GameRecord>;
  lastId: number;
}

export interface MoveOptions {
  /** New world height of the building (`world Y pos` of its state), if the instance has a state. */
  worldY?: number;
}

export interface PlaceOptions {
  /** Key of the new instance (default `<lastId+1>-<mod>-INGAME`). */
  key?: string;
  /** Owner record type, if it does not exist yet (default INSTANCE_COLLECTION). */
  holderType?: string;
  /**
   * State records of a new instance (furniture, item points in interiors). `newId` gives
   * a free id `<n>-<mod>-INGAME` and advances `lastId`; record string ids are written into the
   * instance states in order.
   */
  states?: (key: string, newId: () => string) => GameRecord[];
}

/** Level files read only on request (`addFiles`): interiors. */
export const LAZY_LEVEL_FILES: readonly string[] = ['interiors.level'];

function isLazy(path: string): boolean {
  return LAZY_LEVEL_FILES.includes(path.toLowerCase());
}

/** What changed: level-file records (instance owners and states). */
export interface WorldChange {
  path: string;
  sid: string;
}

type Listener = (changed: readonly WorldChange[]) => void;

const SCALARS = ['bools', 'floats', 'ints', 'vec3s', 'vec4s', 'strings', 'files'] as const;

/**
 * An object of a zone file must lie in that zone: all objects in game files do, and the game loads
 * objects together with the zone. To move one to another zone — remove it and place it again.
 */
export function checkZone(path: string, position: Vec3): void {
  const zone = zoneOfPath(path);
  if (!zone) return;
  const z = zoneOfPoint(position[0], position[2]);
  if (z.x !== zone.x || z.y !== zone.y)
    throw new UiTextError({ en: `Point ${Math.round(position[0])} ${Math.round(position[2])} is in zone ${z.x}.${z.y}, but the object is from zone ${zone.x}.${zone.y}. To move it to another zone, remove it and place it again`, ru: `Точка ${Math.round(position[0])} ${Math.round(position[2])} — в зоне ${z.x}.${z.y}, а объект из зоны ${zone.x}.${zone.y}. Перенести в другую зону: удалить и поставить заново`, zh: `点 ${Math.round(position[0])} ${Math.round(position[2])} 位于区域 ${z.x}.${z.y}，而对象属于区域 ${zone.x}.${zone.y}。要移到其他区域，请删除后重新放置` });
}

/** Mod `My Mod.mod` → `My Mod`. */
export function modBaseName(layer: string): string {
  return layer.replace(/\.(mod|base)$/i, '');
}

export class WorldEdits {
  readonly modLayer: string;
  readonly modBase: string;
  /** Path (lowercase) → lower-layer files in order. */
  private readonly lowerFiles = new Map<string, WorldFile[]>();
  private readonly lowerCache = new Map<string, Map<string, GameRecord>>();
  private readonly mod = new Map<string, ModLevelFile>();
  private readonly undoStack: WorldStep[] = [];
  private readonly redoStack: WorldStep[] = [];
  private pending: WorldStep | undefined;
  /** Undo stack length at save time (-1 — the saved state can no longer be reached). */
  private savedAt = 0;
  private readonly listeners = new Set<Listener>();
  /** Paths changed since the last save (even if the edit was undone). */
  private readonly touched = new Set<string>();
  /** Lazy files not read yet: they cannot be edited (the mod would wipe its own file). */
  private readonly unread = new Set<string>(LAZY_LEVEL_FILES);

  constructor(files: readonly WorldFile[], modLayer: string) {
    this.modLayer = modLayer;
    this.modBase = modBaseName(modLayer);
    this.add(files);
  }

  /**
   * Finish reading lazy files (`interiors.level` of vanilla, dependencies and the mod). `paths` — which
   * files are now fully read, even if no layer has them.
   */
  addFiles(files: readonly WorldFile[], paths: readonly string[] = LAZY_LEVEL_FILES): void {
    for (const p of [...paths, ...files.map((f) => f.path)]) if (!this.unread.has(p.toLowerCase())) throw new UiTextError({ en: `File ${p} is already read`, ru: `Файл ${p} уже прочитан`, zh: `文件 ${p} 已读取` });
    this.add(files);
    for (const p of paths) this.unread.delete(p.toLowerCase());
  }

  /** The file is read (not lazy, or already finished reading). */
  isLoaded(path: string): boolean {
    return !this.unread.has(path.toLowerCase());
  }

  private add(files: readonly WorldFile[]): void {
    for (const wf of files) {
      const k = wf.path.toLowerCase();
      this.unread.delete(k);
      this.lowerCache.delete(k);
      if (wf.layer === this.modLayer) {
        const records = new Map<string, GameRecord>();
        for (const r of wf.file.records) records.set(r.stringId, r);
        this.mod.set(k, { path: wf.path, original: wf.file, records, lastId: wf.file.lastId });
      } else {
        const list = this.lowerFiles.get(k);
        if (list) list.push(wf);
        else this.lowerFiles.set(k, [wf]);
      }
    }
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(changes: readonly WorldRecordChange[] = []): void {
    const seen = new Set<string>();
    const out: WorldChange[] = [];
    for (const c of changes) {
      const k = `${c.path.toLowerCase()}|${c.sid}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ path: c.path, sid: c.sid });
    }
    for (const fn of this.listeners) fn(out);
  }

  /** Merged lower-layer records of the file (without the mod). */
  private lower(path: string): Map<string, GameRecord> {
    const k = path.toLowerCase();
    let out = this.lowerCache.get(k);
    if (out) return out;
    out = new Map();
    for (const wf of this.lowerFiles.get(k) ?? [])
      for (const rec of wf.file.records) {
        const next = applyLayer(out.get(rec.stringId), rec);
        if (next) out.set(rec.stringId, next);
        else out.delete(rec.stringId);
      }
    this.lowerCache.set(k, out);
    return out;
  }

  private modFile(path: string): ModLevelFile {
    const k = path.toLowerCase();
    if (this.unread.has(k)) throw new UiTextError({ en: `${path} is not read yet: call addFiles first`, ru: `${path} ещё не прочитан: сначала addFiles`, zh: `${path} 尚未读取：请先调用 addFiles` });
    let f = this.mod.get(k);
    if (!f) {
      const lowerPath = this.lowerFiles.get(k)?.[0]?.path ?? path;
      f = { path: lowerPath, original: undefined, records: new Map(), lastId: 0 };
      this.mod.set(k, f);
    }
    return f;
  }

  /** Record with the mod's edits. */
  record(path: string, sid: string): GameRecord | undefined {
    const lo = this.lower(path).get(sid);
    const m = this.mod.get(path.toLowerCase())?.records.get(sid);
    return m ? applyLayer(lo, m) : lo;
  }

  /** Instance with the mod's edits (undefined — absent or removed). */
  instance(path: string, holder: string, key: string): Instance | undefined {
    const lo = this.lower(path).get(holder)?.instances.get(key);
    const m = this.mod.get(path.toLowerCase())?.records.get(holder)?.instances.get(key);
    const v = m ?? lo;
    return v && v.target !== '' ? v : undefined;
  }

  /** Instance owner records of the file (with the mod's edits): `0-buildinglist` etc. */
  holders(path: string, type = 'INSTANCE_COLLECTION'): string[] {
    const ids = new Set<string>();
    for (const [sid, r] of this.lower(path)) if (itemTypeName(r.type) === type) ids.add(sid);
    for (const [sid, r] of this.mod.get(path.toLowerCase())?.records ?? []) if (itemTypeName(r.type) === type) ids.add(sid);
    return [...ids];
  }

  /** Write a change of a mod record (part of a step). */
  private change(path: string, sid: string, edit: (rec: GameRecord) => void, create: () => GameRecord): void {
    const f = this.modFile(path);
    const before = f.records.get(sid);
    const after = before ? cloneRecord(before) : create();
    const lastIdBefore = f.lastId;
    edit(after);
    this.commit({ path: f.path, sid, before, after, lastIdBefore, lastIdAfter: f.lastId });
  }

  private commit(c: WorldRecordChange): void {
    this.apply(c, 'after');
    this.touched.add(c.path.toLowerCase());
    if (this.pending) {
      this.pending.changes.push(c);
      return;
    }
    this.pushStep({ label: '', changes: [c] });
  }

  private pushStep(step: WorldStep): void {
    if (step.changes.length === 0) return;
    if (this.savedAt > this.undoStack.length) this.savedAt = -1;
    this.undoStack.push(step);
    this.redoStack.length = 0;
    this.emit(step.changes);
  }

  private apply(c: WorldRecordChange, side: 'before' | 'after'): void {
    const f = this.modFile(c.path);
    const rec = c[side];
    if (rec) f.records.set(c.sid, rec);
    else f.records.delete(c.sid);
    f.lastId = side === 'after' ? c.lastIdAfter : c.lastIdBefore;
  }

  /** Several edits as one undo step. */
  transaction<T>(label: string, fn: () => T): T {
    if (this.pending) {
      return fn();
    }
    const step: WorldStep = { label, changes: [] };
    this.pending = step;
    try {
      const out = fn();
      this.pending = undefined;
      this.pushStep(step);
      return out;
    } catch (e) {
      this.pending = undefined;
      for (const c of [...step.changes].reverse()) this.apply(c, 'before');
      throw e;
    }
  }

  private holderRecord(path: string, holder: string, type: string): () => GameRecord {
    return () => {
      const lo = this.lower(path).get(holder);
      // Mods write interior layouts with their fields (`associated building`, `is exterior`).
      if (lo && isLazy(path)) {
        const c = cloneRecord(lo);
        c.instances.clear();
        return c;
      }
      return emptyRecord(lo?.type ?? itemTypeId(type) ?? 0, holder, lo?.name ?? encodeText(holder.replace(/-.*$/, '')));
    };
  }

  private setInstance(path: string, holder: string, key: string, inst: Instance): void {
    const lo = this.lower(path).get(holder)?.instances.get(key);
    this.change(
      path,
      holder,
      (rec) => {
        // Matches the lower layers — the mod edit is no longer needed.
        if (lo && instanceEqual(lo, inst)) rec.instances.delete(key);
        else rec.instances.set(key, inst);
      },
      this.holderRecord(path, holder, 'INSTANCE_COLLECTION'),
    );
    this.dropEmpty(path, holder);
  }

  /** Remove a mod record if it has no edits left and was not in the original file. */
  private dropEmpty(path: string, sid: string): void {
    const f = this.modFile(path);
    const rec = f.records.get(sid);
    if (!rec || f.original?.records.some((r) => r.stringId === sid)) return;
    const lo = this.lower(path).get(sid);
    const empty = rec.instances.size === 0 && rec.refs.size === 0 && SCALARS.every((d) => rec[d].size === 0);
    // A full copy that matches the lower layers (building state put back) is not needed either.
    const same = lo !== undefined && recordsEqual(applyLayer(lo, rec) ?? lo, lo) && rec.instances.size === 0;
    if (!empty && !same) return;
    const before = rec;
    this.commit({ path: f.path, sid, before, after: undefined, lastIdBefore: f.lastId, lastIdAfter: f.lastId });
  }

  /**
   * Move / rotate an instance. Position as in the file (for buildings y is height above ground),
   * `worldY` — world height for the building state.
   */
  move(path: string, holder: string, key: string, position: Vec3, rotation: Vec4, options: MoveOptions = {}, label = 'Move object'): void {
    const cur = this.instance(path, holder, key);
    if (!cur) throw new UiTextError({ en: `No object ${key} in ${holder} (${path})`, ru: `Нет объекта ${key} в ${holder} (${path})`, zh: `${holder}（${path}）中没有对象 ${key}` });
    checkZone(path, position);
    this.transaction(label, () => {
      this.setInstance(path, holder, key, { target: cur.target, position: [...position], rotation: [...rotation], states: cur.states.map((s) => s.slice()) });
      if (options.worldY !== undefined) {
        for (const s of cur.states) {
          const sid = decodeText(s);
          const st = this.record(path, sid);
          if (!st || itemTypeName(st.type) !== 'GAMESTATE_BUILDING' || !st.floats.has('world Y pos')) continue;
          const wy = options.worldY;
          // Mods put the state as a full copy — so do we.
          this.change(path, sid, (rec) => rec.floats.set('world Y pos', wy), () => cloneRecord(st));
          this.dropEmpty(path, sid);
        }
      }
    });
  }

  /** Place a new instance of record `target`. Returns the key. */
  place(path: string, holder: string, target: string, position: Vec3, rotation: Vec4, options: PlaceOptions = {}, label = 'New object'): string {
    const f = this.modFile(path);
    const taken = (k: string): boolean => this.lower(path).get(holder)?.instances.has(k) === true || f.records.get(holder)?.instances.has(k) === true;
    let key = options.key;
    let n = f.lastId;
    if (key === undefined) {
      do key = `${++n}-${this.modBase}-INGAME`;
      while (taken(key));
    } else if (taken(key)) throw new UiTextError({ en: `Key ${key} is already taken`, ru: `Ключ ${key} уже занят`, zh: `键 ${key} 已被占用` });
    checkZone(path, position);
    const k = key;
    const newId = (): string => {
      let id: string;
      do id = `${++n}-${this.modBase}-INGAME`;
      while (this.record(path, id) !== undefined || taken(id));
      return id;
    };
    const states = options.states?.(k, newId) ?? [];
    this.transaction(label, () => {
      this.change(
        path,
        holder,
        (rec) => {
          rec.instances.set(k, { target, position: [...position], rotation: [...rotation], states: states.map((s) => encodeText(s.stringId)) });
          // `lastId` grows together with the key and state ids; undo restores it too.
          f.lastId = Math.max(f.lastId, n);
        },
        this.holderRecord(path, holder, options.holderType ?? 'INSTANCE_COLLECTION'),
      );
      for (const st of states) {
        if (this.record(path, st.stringId)) throw new UiTextError({ en: `Record ${st.stringId} already exists in ${path}`, ru: `Запись ${st.stringId} уже есть в ${path}`, zh: `${path} 中已有记录 ${st.stringId}` });
        this.change(path, st.stringId, () => undefined, () => st);
      }
    });
    return k;
  }

  /** Remove an instance: our own new one is erased, one from lower layers gets a "removal" written. */
  remove(path: string, holder: string, key: string, label = 'Remove object'): void {
    if (!this.instance(path, holder, key)) throw new UiTextError({ en: `No object ${key} in ${holder} (${path})`, ru: `Нет объекта ${key} в ${holder} (${path})`, zh: `${holder}（${path}）中没有对象 ${key}` });
    const lo = this.lower(path).get(holder)?.instances.get(key);
    const cur = this.instance(path, holder, key)!;
    this.transaction(label, () => {
      if (lo) this.setInstance(path, holder, key, removedInstance());
      else {
        this.change(path, holder, (rec) => rec.instances.delete(key), this.holderRecord(path, holder, 'INSTANCE_COLLECTION'));
        this.dropEmpty(path, holder);
        // Nobody needs the states of our own new object any more.
        for (const s of cur.states) this.erase(path, decodeText(s));
      }
    });
  }

  /** Erase a record that exists only in the mod. */
  private erase(path: string, sid: string): void {
    const f = this.modFile(path);
    const before = f.records.get(sid);
    if (!before || this.lower(path).has(sid)) return;
    this.commit({ path: f.path, sid, before, after: undefined, lastIdBefore: f.lastId, lastIdAfter: f.lastId });
  }

  /**
   * Edit a level-file record (an object state). The mod puts a lower-layer record as a full
   * copy, like Workshop mods; if it returns to the original, the edit goes away.
   */
  editState(path: string, sid: string, edit: (rec: GameRecord) => void, label = `Edit ${sid}`): void {
    const cur = this.record(path, sid);
    if (!cur) throw new UiTextError({ en: `No record ${sid} in ${path}`, ru: `Нет записи ${sid} в ${path}`, zh: `${path} 中没有记录 ${sid}` });
    this.transaction(label, () => {
      this.change(path, sid, edit, () => cloneRecord(cur));
      this.dropEmpty(path, sid);
    });
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Step titles: what Ctrl+Z will undo and what Ctrl+Y will redo. */
  undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  history(): { undo: string[]; redo: string[] } {
    return { undo: this.undoStack.map((s) => s.label), redo: this.redoStack.map((s) => s.label).reverse() };
  }

  undo(): WorldStep | undefined {
    const step = this.undoStack.pop();
    if (!step) return undefined;
    for (const c of [...step.changes].reverse()) {
      this.apply(c, 'before');
      this.touched.add(c.path.toLowerCase());
    }
    this.redoStack.push(step);
    this.emit(step.changes);
    return step;
  }

  redo(): WorldStep | undefined {
    const step = this.redoStack.pop();
    if (!step) return undefined;
    for (const c of step.changes) {
      this.apply(c, 'after');
      this.touched.add(c.path.toLowerCase());
    }
    this.undoStack.push(step);
    this.emit(step.changes);
    return step;
  }

  /** There are unsaved edits. */
  isDirty(): boolean {
    return this.savedAt !== this.undoStack.length;
  }

  /** Files that need writing (changed since the last save). */
  dirtyFiles(): string[] {
    return [...this.touched].map((k) => this.mod.get(k)?.path ?? k).filter((p) => this.differsFromOriginal(p));
  }

  private differsFromOriginal(path: string): boolean {
    const f = this.mod.get(path.toLowerCase());
    if (!f) return false;
    const orig = f.original;
    if (!orig) return f.records.size > 0;
    if (orig.records.length !== f.records.size || orig.lastId !== f.lastId) return true;
    return orig.records.some((r) => f.records.get(r.stringId) !== r);
  }

  /**
   * Mod level file for writing: type 15, no header, records in original order (new ones at the end),
   * the tail of the original file (empty for a new one). undefined — no records left in the file and
   * there was no original file.
   */
  buildFile(path: string): DataFile | undefined {
    const f = this.mod.get(path.toLowerCase());
    if (!f) return undefined;
    if (!f.original && f.records.size === 0) return undefined;
    const records: GameRecord[] = [];
    const seen = new Set<string>();
    for (const r of f.original?.records ?? []) {
      const cur = f.records.get(r.stringId);
      if (cur) records.push(cur);
      seen.add(r.stringId);
    }
    for (const [sid, r] of f.records) if (!seen.has(sid)) records.push(r);
    const out: DataFile = { fileType: f.original?.fileType ?? FileType.Data, lastId: f.lastId, records, tail: f.original?.tail ?? new Uint8Array(0) };
    if (f.original?.latin1Ids) out.latin1Ids = f.original.latin1Ids;
    return out;
  }

  /** After the files are written to disk: the mod's current files become the originals. */
  markSaved(): void {
    for (const k of this.touched) {
      const f = this.mod.get(k);
      if (!f) continue;
      const built = this.buildFile(f.path);
      f.original = built;
      f.records = new Map((built?.records ?? []).map((r) => [r.stringId, r]));
    }
    this.touched.clear();
    this.savedAt = this.undoStack.length;
    this.emit();
  }

  /**
   * World files with the mod's current edits — for a new `WorldIndex`. Interiors (`interiors.level`)
   * — only with `interiors: true`.
   */
  files(options: { interiors?: boolean } = {}): WorldFile[] {
    const keep = (path: string): boolean => options.interiors === true || !isLazy(path);
    const out: WorldFile[] = [];
    for (const list of this.lowerFiles.values()) out.push(...list.filter((wf) => keep(wf.path)));
    for (const f of this.mod.values()) {
      if (!keep(f.path)) continue;
      const file = this.buildFile(f.path);
      if (file) out.push({ layer: this.modLayer, path: f.path, file });
    }
    return out;
  }

  /** All mod level files (original and created by edits). */
  modFiles(): string[] {
    return [...this.mod.values()].map((f) => f.path);
  }

  /** Records of a mod level file (original and edits). */
  modRecords(path: string): readonly GameRecord[] {
    return [...(this.mod.get(path.toLowerCase())?.records.values() ?? [])];
  }
}
