/**
 * Правки мира в моде: сдвиг, поворот, новые и удалённые экземпляры в файлах уровня
 * (`zone.X.Y.zone`, `leveldata.level`, `interiors.level`).
 *
 * Файл уровня мода (тип 15, без шапки) — разница поверх нижних слоёв: только изменённые или новые
 * записи. Как это устроено в файлах игры и модов мастерской:
 *  - запись-владелец (`0-buildinglist`, тип INSTANCE_COLLECTION, имя «0», без полей) несёт только
 *    изменённые / новые экземпляры, флаги изменений 0;
 *  - экземпляр перезаписывается целиком (цель, позиция, кватернион, состояния);
 *  - убрать экземпляр — экземпляр с тем же ключом и пустой целью, позиция 0, поворот (1, 0, 0, 0);
 *  - состояния зданий (GAMESTATE_BUILDING) моды кладут полными копиями (3191 из 3191);
 *  - ключ нового экземпляра — `<n>-<имя мода>-INGAME`, n — `lastId` файла + 1.
 *
 * Не тронутые записи мода пишутся теми же байтами: `writeDataFile` без потерь (162/162 файла
 * уровней модов мастерской), а записи, которых правка не касалась, остаются теми же объектами.
 * Модуль без доступа к диску.
 */
import { itemTypeId, itemTypeName } from '../format/item-types.ts';
import { emptyRecord, FileType, type DataFile, type GameRecord, type Instance, type Vec3, type Vec4 } from '../format/types.ts';
import { applyLayer, cloneRecord, instanceEqual, recordsEqual } from '../model/record-ops.ts';
import { decodeText, encodeText } from '../text.ts';
import { zoneOfPoint } from './terrain.ts';
import { zoneOfPath, type WorldFile } from './world.ts';

/** Экземпляр-«удаление»: так нижний слой теряет объект. */
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
  /** Запись мода до шага (undefined — её не было). */
  before: GameRecord | undefined;
  after: GameRecord | undefined;
  lastIdBefore: number;
  lastIdAfter: number;
}

interface ModLevelFile {
  path: string;
  /** Исходный файл мода (undefined — файла ещё нет). */
  original: DataFile | undefined;
  /** Записи мода в порядке файла; новые — в конце. */
  records: Map<string, GameRecord>;
  lastId: number;
}

export interface MoveOptions {
  /** Новая высота здания в мире (`world Y pos` его состояния), если у экземпляра есть состояние. */
  worldY?: number;
}

export interface PlaceOptions {
  /** Ключ нового экземпляра (по умолчанию `<lastId+1>-<мод>-INGAME`). */
  key?: string;
  /** Тип записи-владельца, если её ещё нет (по умолчанию INSTANCE_COLLECTION). */
  holderType?: string;
  /**
   * Записи состояний нового экземпляра (мебель, точки предметов в интерьерах). `newId` даёт
   * свободный id `<n>-<мод>-INGAME` и двигает `lastId`; строковые id записей пишутся в
   * состояния экземпляра по порядку.
   */
  states?: (key: string, newId: () => string) => GameRecord[];
}

/** Файлы уровня, которые читаются только по запросу (`addFiles`): интерьеры. */
export const LAZY_LEVEL_FILES: readonly string[] = ['interiors.level'];

function isLazy(path: string): boolean {
  return LAZY_LEVEL_FILES.includes(path.toLowerCase());
}

/** Что поменялось: записи файлов уровня (владельцы экземпляров и состояния). */
export interface WorldChange {
  path: string;
  sid: string;
}

type Listener = (changed: readonly WorldChange[]) => void;

const SCALARS = ['bools', 'floats', 'ints', 'vec3s', 'vec4s', 'strings', 'files'] as const;

/**
 * Объект файла зоны должен лежать в этой зоне: в файлах игры так у всех объектов, и игра грузит
 * объекты вместе с зоной. Перенести в другую зону — удалить и поставить заново.
 */
export function checkZone(path: string, position: Vec3): void {
  const zone = zoneOfPath(path);
  if (!zone) return;
  const z = zoneOfPoint(position[0], position[2]);
  if (z.x !== zone.x || z.y !== zone.y)
    throw new Error(`Точка ${Math.round(position[0])} ${Math.round(position[2])} — в зоне ${z.x}.${z.y}, а объект из зоны ${zone.x}.${zone.y}. Перенести в другую зону: удалить и поставить заново`);
}

/** Мод `My Mod.mod` → `My Mod`. */
export function modBaseName(layer: string): string {
  return layer.replace(/\.(mod|base)$/i, '');
}

export class WorldEdits {
  readonly modLayer: string;
  readonly modBase: string;
  /** Путь (нижний регистр) → файлы нижних слоёв по порядку. */
  private readonly lowerFiles = new Map<string, WorldFile[]>();
  private readonly lowerCache = new Map<string, Map<string, GameRecord>>();
  private readonly mod = new Map<string, ModLevelFile>();
  private readonly undoStack: WorldStep[] = [];
  private readonly redoStack: WorldStep[] = [];
  private pending: WorldStep | undefined;
  /** Длина стека отмены на момент сохранения (-1 — сохранённое состояние уже не достичь). */
  private savedAt = 0;
  private readonly listeners = new Set<Listener>();
  /** Пути, которые менялись с последнего сохранения (даже если правку отменили). */
  private readonly touched = new Set<string>();
  /** Ленивые файлы, которые ещё не прочитаны: править их нельзя (мод затёр бы свой файл). */
  private readonly unread = new Set<string>(LAZY_LEVEL_FILES);

  constructor(files: readonly WorldFile[], modLayer: string) {
    this.modLayer = modLayer;
    this.modBase = modBaseName(modLayer);
    this.add(files);
  }

  /**
   * Дочитать ленивые файлы (`interiors.level` ванили, зависимостей и мода). `paths` — какие
   * файлы теперь прочитаны полностью, даже если ни в одном слое их нет.
   */
  addFiles(files: readonly WorldFile[], paths: readonly string[] = LAZY_LEVEL_FILES): void {
    for (const p of [...paths, ...files.map((f) => f.path)]) if (!this.unread.has(p.toLowerCase())) throw new Error(`Файл ${p} уже прочитан`);
    this.add(files);
    for (const p of paths) this.unread.delete(p.toLowerCase());
  }

  /** Файл прочитан (не ленивый или уже дочитан). */
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

  /** Слитые записи нижних слоёв файла (без мода). */
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
    if (this.unread.has(k)) throw new Error(`${path} ещё не прочитан: сначала addFiles`);
    let f = this.mod.get(k);
    if (!f) {
      const lowerPath = this.lowerFiles.get(k)?.[0]?.path ?? path;
      f = { path: lowerPath, original: undefined, records: new Map(), lastId: 0 };
      this.mod.set(k, f);
    }
    return f;
  }

  /** Запись с правками мода. */
  record(path: string, sid: string): GameRecord | undefined {
    const lo = this.lower(path).get(sid);
    const m = this.mod.get(path.toLowerCase())?.records.get(sid);
    return m ? applyLayer(lo, m) : lo;
  }

  /** Экземпляр с правками мода (undefined — нет или удалён). */
  instance(path: string, holder: string, key: string): Instance | undefined {
    const lo = this.lower(path).get(holder)?.instances.get(key);
    const m = this.mod.get(path.toLowerCase())?.records.get(holder)?.instances.get(key);
    const v = m ?? lo;
    return v && v.target !== '' ? v : undefined;
  }

  /** Записи-владельцы экземпляров файла (с правками мода): `0-buildinglist` и т. п. */
  holders(path: string, type = 'INSTANCE_COLLECTION'): string[] {
    const ids = new Set<string>();
    for (const [sid, r] of this.lower(path)) if (itemTypeName(r.type) === type) ids.add(sid);
    for (const [sid, r] of this.mod.get(path.toLowerCase())?.records ?? []) if (itemTypeName(r.type) === type) ids.add(sid);
    return [...ids];
  }

  /** Записать изменение записи мода (часть шага). */
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

  /** Несколько правок одним шагом отмены. */
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
      // Раскладки интерьеров моды пишут с полями (`associated building`, `is exterior`).
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
        // Совпало с нижними слоями — правка мода больше не нужна.
        if (lo && instanceEqual(lo, inst)) rec.instances.delete(key);
        else rec.instances.set(key, inst);
      },
      this.holderRecord(path, holder, 'INSTANCE_COLLECTION'),
    );
    this.dropEmpty(path, holder);
  }

  /** Убрать запись мода, если в ней не осталось правок и её не было в исходном файле. */
  private dropEmpty(path: string, sid: string): void {
    const f = this.modFile(path);
    const rec = f.records.get(sid);
    if (!rec || f.original?.records.some((r) => r.stringId === sid)) return;
    const lo = this.lower(path).get(sid);
    const empty = rec.instances.size === 0 && rec.refs.size === 0 && SCALARS.every((d) => rec[d].size === 0);
    // Полная копия, совпавшая с нижними слоями (состояние здания вернули на место), тоже не нужна.
    const same = lo !== undefined && recordsEqual(applyLayer(lo, rec) ?? lo, lo) && rec.instances.size === 0;
    if (!empty && !same) return;
    const before = rec;
    this.commit({ path: f.path, sid, before, after: undefined, lastIdBefore: f.lastId, lastIdAfter: f.lastId });
  }

  /**
   * Сдвинуть / повернуть экземпляр. Позиция — как в файле (у зданий y — высота над землёй),
   * `worldY` — высота в мире для состояния здания.
   */
  move(path: string, holder: string, key: string, position: Vec3, rotation: Vec4, options: MoveOptions = {}, label = 'Сдвиг объекта'): void {
    const cur = this.instance(path, holder, key);
    if (!cur) throw new Error(`Нет объекта ${key} в ${holder} (${path})`);
    checkZone(path, position);
    this.transaction(label, () => {
      this.setInstance(path, holder, key, { target: cur.target, position: [...position], rotation: [...rotation], states: cur.states.map((s) => s.slice()) });
      if (options.worldY !== undefined) {
        for (const s of cur.states) {
          const sid = decodeText(s);
          const st = this.record(path, sid);
          if (!st || itemTypeName(st.type) !== 'GAMESTATE_BUILDING' || !st.floats.has('world Y pos')) continue;
          const wy = options.worldY;
          // Моды кладут состояние полной копией — так и делаем.
          this.change(path, sid, (rec) => rec.floats.set('world Y pos', wy), () => cloneRecord(st));
          this.dropEmpty(path, sid);
        }
      }
    });
  }

  /** Поставить новый экземпляр записи `target`. Возвращает ключ. */
  place(path: string, holder: string, target: string, position: Vec3, rotation: Vec4, options: PlaceOptions = {}, label = 'Новый объект'): string {
    const f = this.modFile(path);
    const taken = (k: string): boolean => this.lower(path).get(holder)?.instances.has(k) === true || f.records.get(holder)?.instances.has(k) === true;
    let key = options.key;
    let n = f.lastId;
    if (key === undefined) {
      do key = `${++n}-${this.modBase}-INGAME`;
      while (taken(key));
    } else if (taken(key)) throw new Error(`Ключ ${key} уже занят`);
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
          // `lastId` растёт вместе с ключом и id состояний; отмена вернёт и его.
          f.lastId = Math.max(f.lastId, n);
        },
        this.holderRecord(path, holder, options.holderType ?? 'INSTANCE_COLLECTION'),
      );
      for (const st of states) {
        if (this.record(path, st.stringId)) throw new Error(`Запись ${st.stringId} уже есть в ${path}`);
        this.change(path, st.stringId, () => undefined, () => st);
      }
    });
    return k;
  }

  /** Убрать экземпляр: свой новый — стираем, из нижних слоёв — пишем «удаление». */
  remove(path: string, holder: string, key: string, label = 'Удаление объекта'): void {
    if (!this.instance(path, holder, key)) throw new Error(`Нет объекта ${key} в ${holder} (${path})`);
    const lo = this.lower(path).get(holder)?.instances.get(key);
    const cur = this.instance(path, holder, key)!;
    this.transaction(label, () => {
      if (lo) this.setInstance(path, holder, key, removedInstance());
      else {
        this.change(path, holder, (rec) => rec.instances.delete(key), this.holderRecord(path, holder, 'INSTANCE_COLLECTION'));
        this.dropEmpty(path, holder);
        // Состояния своего нового объекта больше никому не нужны.
        for (const s of cur.states) this.erase(path, decodeText(s));
      }
    });
  }

  /** Стереть запись, которая есть только в моде. */
  private erase(path: string, sid: string): void {
    const f = this.modFile(path);
    const before = f.records.get(sid);
    if (!before || this.lower(path).has(sid)) return;
    this.commit({ path: f.path, sid, before, after: undefined, lastIdBefore: f.lastId, lastIdAfter: f.lastId });
  }

  /**
   * Поправить запись файла уровня (состояние объекта). Запись нижних слоёв мод кладёт полной
   * копией, как моды мастерской; вернулась к исходной — правка уходит.
   */
  editState(path: string, sid: string, edit: (rec: GameRecord) => void, label = `Правка ${sid}`): void {
    const cur = this.record(path, sid);
    if (!cur) throw new Error(`Нет записи ${sid} в ${path}`);
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

  /** Названия шагов: что отменит Ctrl+Z и что вернёт Ctrl+Y. */
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

  /** Есть несохранённые правки. */
  isDirty(): boolean {
    return this.savedAt !== this.undoStack.length;
  }

  /** Файлы, которые надо записать (менялись с последнего сохранения). */
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
   * Файл уровня мода для записи: тип 15, без шапки, записи в исходном порядке (новые — в конце),
   * хвост исходного файла (у нового — пустой). undefined — в файле не осталось записей и
   * исходного файла не было.
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

  /** После записи файлов на диск: текущие файлы мода становятся исходными. */
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
   * Файлы мира с текущими правками мода — для нового `WorldIndex`. Интерьеры (`interiors.level`)
   * — только с `interiors: true`.
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

  /** Все файлы уровня мода (исходные и созданные правками). */
  modFiles(): string[] {
    return [...this.mod.values()].map((f) => f.path);
  }

  /** Записи файла уровня мода (исходные и правки). */
  modRecords(path: string): readonly GameRecord[] {
    return [...(this.mod.get(path.toLowerCase())?.records.values() ?? [])];
  }
}
