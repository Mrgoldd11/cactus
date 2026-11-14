/**
 * Контекст редактирования мода: нижние слои (ваниль по порядку, затем зависимости) и сам
 * редактируемый мод. Даёт итоговое значение каждой записи, её статус (как в FCS), индекс
 * ссылок и команды правки с отменой/повтором. Мод хранит только изменения относительно нижних
 * слоёв; при сохранении пишутся только они.
 *
 * Изменения мода — неизменяемые снимки записей: команда не правит запись мода на месте, а
 * вычисляет новую. Поэтому отмена — это просто возврат прежнего снимка, а «запись изменена
 * с последнего сохранения» — это «снимок не тот же объект, что был сохранён».
 */
import { decodeText, encodeText } from '../text.ts';
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

/** Слой данных: файл и его имя (`gamedata.base`, `rebirth.mod`, ...). */
export interface Layer {
  name: string;
  file: DataFile;
}

/**
 * Статус записи с точки зрения редактируемого мода:
 * - `base` — запись нижних слоёв, мод её не трогает;
 * - `new` — запись создана модом;
 * - `changed` — мод меняет запись нижних слоёв;
 * - `deleted` — мод удаляет запись нижних слоёв.
 */
export type RecordStatus = 'base' | 'new' | 'changed' | 'deleted';

export interface RecordOrigin {
  status: RecordStatus;
  /** Слой, где запись появилась впервые (имя мода для новых). */
  origin: string;
  /** Все слои, которые задают эту запись, по порядку (последним может быть мод). */
  layers: string[];
  /** Запись удалена в нижних слоях (и, возможно, создана заново модом). */
  deletedBelow?: string;
}

/** Сведения из заголовка мода в текстовом виде. */
export interface ModInfo {
  /** Имя файла мода (`Мой мод.mod`): из него строятся строковые id новых записей. */
  fileName: string;
  /** Формат файла: 16 или 17. */
  fileType: number;
  version: number;
  author: string;
  description: string;
  dependencies: string[];
  references: string[];
  /** Последний выданный числовой id: новая запись получит `lastId + 1`. */
  lastId: number;
}

export interface ReferenceEntry {
  /** Запись, в которой ссылка. */
  source: string;
  /** Категория ссылки или `instance:<ключ>` для размещённого объекта. */
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
  /** Нижние слои по порядку загрузки. */
  layers: readonly Layer[];
  /** Редактируемый мод: прочитанный файл или undefined для нового мода. */
  mod?: DataFile;
  /** Имя файла мода (`Мой мод.mod`). */
  modName: string;
  schema?: GameSchema;
  /** gamedata.po — для поиска по русским названиям. */
  po?: PoFile;
}

export interface ChangeEvent {
  stringIds: string[];
  info: boolean;
}

/** Ошибка команды правки (неизвестная запись, занятый id и т. п.). */
export class EditError extends Error {
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

/** Текст → байты; если текст не изменился, остаются исходные байты (и кодировка). */
function keepBytes(text: string, original: Uint8Array | undefined): Uint8Array {
  return original && decodeText(original) === text ? original : encodeText(text);
}

export class ModContext {
  readonly layers: readonly Layer[];
  readonly schema: GameSchema | undefined;
  readonly translations: Map<string, RecordTranslation>;

  /** sid → записи нижних слоёв (номер слоя, запись) по порядку. */
  private readonly lowerEntries = new Map<string, { layer: number; rec: GameRecord }[]>();
  private readonly lowerCache = new Map<string, GameRecord | null>();
  private readonly resolvedCache = new Map<string, GameRecord | null>();

  private readonly deltas = new Map<string, GameRecord>();
  private order: string[] = [];
  /** Записи мода в том виде, в каком они в файле (прочитаны или сохранены). */
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
      if (this.deltas.has(rec.stringId)) throw new EditError(`В моде две записи с id ${rec.stringId}`);
      this.deltas.set(rec.stringId, rec);
      this.originals.set(rec.stringId, rec);
      this.order.push(rec.stringId);
    }
    this.originalInfo = infoFromFile(options.mod, options.modName);
    this.modInfo = { ...this.originalInfo, dependencies: [...this.originalInfo.dependencies], references: [...this.originalInfo.references] };
  }

  // ---------------------------------------------------------------- чтение

  get modName(): string {
    return this.modInfo.fileName;
  }

  get info(): Readonly<ModInfo> {
    return this.modInfo;
  }

  /** Запись в нижних слоях (итог наложения), undefined — нет или удалена. */
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

  /** Итоговая запись с учётом мода, undefined — нет или удалена. Возвращённую запись нельзя изменять. */
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
   * Тип и имя записи без сборки всей записи — для индексов на десятки тысяч строк. Та же
   * запись, что `get ?? lower ?? delta`: итоговая, для удалённой модом — нижних слоёв, иначе
   * запись мода. У нижних слоёв тип и имя берутся из последнего слоя (так их накладывает
   * `applyLayer`); маркер удаления последним — записи нет.
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

  /** Запись мода (изменения) как она будет записана в файл. */
  delta(stringId: string): GameRecord | undefined {
    return this.deltas.get(stringId);
  }

  /** Записи мода в порядке файла. */
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

  /** Все строковые id (в том числе удалённые) в порядке первого появления по слоям. */
  *allStringIds(): Generator<string> {
    yield* this.lowerEntries.keys();
    for (const s of this.order) if (!this.lowerEntries.has(s)) yield s;
  }

  /** Все существующие итоговые записи. */
  *records(): Generator<GameRecord> {
    for (const s of this.allStringIds()) {
      const r = this.get(s);
      if (r) yield r;
    }
  }

  /** Имя записи (текстом); для отсутствующей — undefined. */
  name(stringId: string): string | undefined {
    const r = this.get(stringId) ?? this.lower(stringId);
    return r ? decodeText(r.name) : undefined;
  }

  /** Русское имя записи из gamedata.po. */
  localizedName(stringId: string): string | undefined {
    const e = this.translations.get(stringId)?.name;
    const s = e?.msgstr[0];
    return s === undefined || s === '' ? undefined : s;
  }

  /** Есть ли у мода несохранённые изменения. */
  get dirty(): boolean {
    if (!sameInfo(this.modInfo, this.originalInfo)) return true;
    if (this.order.length !== this.originals.size) return true;
    return this.order.some((s) => this.deltas.get(s) !== this.originals.get(s));
  }

  isDirty(stringId: string): boolean {
    return this.deltas.get(stringId) !== this.originals.get(stringId);
  }

  // ---------------------------------------------------------------- ссылки

  /** Ссылки из записи (итоговые), включая размещённые объекты. */
  referencesFrom(stringId: string): ReferenceEntry[] {
    const rec = this.get(stringId);
    if (!rec) return [];
    const out: ReferenceEntry[] = [];
    for (const [category, list] of rec.refs) for (const ref of list) out.push({ source: stringId, category, target: ref.target, ref });
    for (const [key, instance] of rec.instances) out.push({ source: stringId, category: `instance:${key}`, target: instance.target, instance });
    return out;
  }

  /** Обратные ссылки: какие записи ссылаются на `stringId`. Индекс строится при первом вызове. */
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

  // ---------------------------------------------------------------- история

  /**
   * Выполнить несколько команд как одну правку (одна отмена). Если `fn` бросает исключение,
   * все её изменения откатываются. Вложенные транзакции входят во внешнюю.
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
        if (!ok) this.revertOps(cs.ops);
        else if (cs.ops.length > 0) {
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

  /** Отменить последнюю правку; возвращает её или undefined. */
  undo(): Changeset | undefined {
    if (this.depth > 0) throw new EditError('Нельзя отменять внутри транзакции');
    const cs = this.undoStack.pop();
    if (!cs) return undefined;
    this.revertOps(cs.ops);
    this.redoStack.push(cs);
    return cs;
  }

  redo(): Changeset | undefined {
    if (this.depth > 0) throw new EditError('Нельзя повторять внутри транзакции');
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
   * Отменить правки до `id` включительно (меню «кружочка назад», панель «История»). Если такой
   * действующей правки нет — EditError, ничего не меняется. Возвращает отменённые (новые первыми).
   */
  undoTo(id: number): Changeset[] {
    if (this.depth > 0) throw new EditError('Нельзя отменять внутри транзакции');
    if (!this.undoStack.some((c) => c.id === id)) throw new EditError(`Правки ${id} нет среди действующих`);
    const out: Changeset[] = [];
    for (;;) {
      const cs = this.undo()!;
      out.push(cs);
      if (cs.id === id) return out;
    }
  }

  /** Повторить отменённые правки до `id` включительно. Возвращает повторённые по порядку. */
  redoTo(id: number): Changeset[] {
    if (this.depth > 0) throw new EditError('Нельзя повторять внутри транзакции');
    if (!this.redoStack.some((c) => c.id === id)) throw new EditError(`Правки ${id} нет среди отменённых`);
    const out: Changeset[] = [];
    for (;;) {
      const cs = this.redo()!;
      out.push(cs);
      if (cs.id === id) return out;
    }
  }

  /**
   * Перейти к состоянию сразу после правки `id` (отменённой или действующей); `0` — к состоянию
   * до всех правок истории. Возвращает, сколько правок отменено и повторено.
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

  /** Правка из истории отмены по id (только те, что сейчас действуют). */
  findChangeset(id: number): Changeset | undefined {
    return this.undoStack.find((c) => c.id === id);
  }

  /**
   * Откатить одну правку из истории, не трогая более поздние: новой правкой («откат: …»),
   * которую тоже можно отменить. Если затронутые записи (или заголовок) меняли позже —
   * EditError, ничего не меняется. Правку, уже отменённую через undo, откатывать нечего.
   */
  rollbackChangeset(id: number): Changeset {
    if (this.depth > 0) throw new EditError('Нельзя откатывать внутри транзакции');
    const cs = this.findChangeset(id);
    if (!cs) throw new EditError(this.redoStack.some((c) => c.id === id) ? `Правка ${id} уже отменена` : `Правки ${id} нет в истории`);
    // Состояние после правки: последняя операция по каждой записи.
    const last = new Map<string, Slot | undefined>();
    let info: ModInfo | undefined;
    for (const op of cs.ops) {
      if (op.kind === 'record') last.set(op.stringId, op.after);
      else info = op.after;
    }
    const later = [...last].filter(([sid, after]) => this.deltas.get(sid) !== after?.delta).map(([sid]) => sid);
    if (info !== undefined && this.modInfo !== info) later.push('заголовок мода');
    if (later.length > 0) throw new EditError(`Нельзя откатить «${cs.label}»: позже изменены ${later.join(', ')}`);
    const next = this.nextChangesetId;
    this.transaction(`откат: ${cs.label}`, () => {
      for (const op of [...cs.ops].reverse()) {
        if (op.kind === 'record') this.setDelta(op.stringId, op.before?.delta, op.before?.index);
        else this.setInfo(op.before);
      }
    });
    const done = this.undoStack.at(-1);
    if (done?.id !== next) throw new EditError(`Откат «${cs.label}» ничего не изменил`);
    return done;
  }

  /** Правки, которые можно отменить (последняя — в конце), и которые можно повторить. */
  history(): { undo: readonly Changeset[]; redo: readonly Changeset[] } {
    return { undo: [...this.undoStack], redo: [...this.redoStack].reverse() };
  }

  /** Подписка на изменения; возвращает функцию отписки. */
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

  /** Записать новый снимок записи мода (undefined — убрать запись из мода) и занести в историю. */
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

  // ---------------------------------------------------------------- команды

  private require(stringId: string): GameRecord {
    const rec = this.get(stringId);
    if (!rec) throw new EditError(`Записи ${stringId} нет`);
    return rec;
  }

  /** Строковый id для новой записи: `<lastId+1>-<имя мода>`; lastId увеличивается. */
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
    if (this.has(stringId) || this.deltas.has(stringId)) throw new EditError(`Запись ${stringId} уже есть`);
  }

  /** Поставить итоговое значение записи: в мод попадёт разница с нижними слоями. */
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
   * Изменить запись произвольно: `mutate` получает копию итоговой записи. В мод попадёт
   * разница с нижними слоями. Остальные команды построены на этой.
   */
  editRecord(stringId: string, mutate: (draft: GameRecord) => void, label = `правка ${stringId}`): void {
    const draft = cloneRecord(this.require(stringId));
    mutate(draft);
    if (draft.stringId !== stringId) throw new EditError('Строковый id меняется командой changeStringIds');
    this.transaction(label, () => {
      this.putResolved(stringId, draft);
    });
  }

  /**
   * Поставить итоговое значение записи целиком (слияние модов): в мод попадёт разница с нижними
   * слоями. Записи может не быть — тогда она создаётся. Служебные поля (`lead`, `id`, флаги)
   * берутся от прежней записи мода, а у новой — обнуляются: их выставит сохранение.
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

  /** Создать запись. Без `stringId` id выдаётся автоматически. Возвращает id. */
  createRecord(type: number, name: string, options: { stringId?: string } = {}): string {
    return this.transaction(`создать «${name}»`, () => {
      const sid = options.stringId ?? this.allocateStringId();
      this.checkFree(sid);
      this.putResolved(sid, emptyRecord(type, sid, encodeText(name)));
      return sid;
    });
  }

  /** Копия записи (все итоговые поля и ссылки) под новым id. */
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
   * Удалить запись. Новая запись мода просто убирается, запись нижних слоёв помечается
   * удалённой. `removeReferences` — заодно убрать ссылки на неё из других записей.
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

  /** Убрать из мода все изменения записи (для новой записи — удалить её). */
  revertRecord(stringId: string): void {
    this.setDelta(stringId, undefined);
  }

  /** Вернуть удалённую модом запись нижних слоёв. */
  restoreRecord(stringId: string): void {
    const prev = this.deltas.get(stringId);
    if (prev && isRemovalMarker(prev)) this.setDelta(stringId, undefined);
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

  /** Вернуть полю значение нижних слоёв (у новой записи — убрать поле). */
  resetField(stringId: string, dict: ScalarDict, key: string): void {
    const lower = this.lower(stringId);
    this.editRecord(stringId, (d) => {
      const lo = lower ? scalarMap(lower, dict).get(key) : undefined;
      if (lo === undefined) scalarMap(d, dict).delete(key);
      else scalarMap(d, dict).set(key, lo);
    }, `${stringId}: сброс ${key}`);
  }

  /** Заменить ссылки категории целиком. */
  setReferences(stringId: string, category: string, refs: readonly Reference[]): void {
    this.editRecord(stringId, (d) => {
      d.refs.set(category, refs.map((r) => ({ ...r })));
    }, `${stringId}: ${category}`);
  }

  /** Добавить ссылку (или поменять значения существующей ссылки на ту же цель). */
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

  clearReferences(stringId: string, category: string): void {
    this.setReferences(stringId, category, []);
  }

  setInstance(stringId: string, key: string, instance: Instance): void {
    this.editRecord(stringId, (d) => {
      d.instances.set(key, instance);
    }, `${stringId}: объект ${key}`);
  }

  /** Убрать размещённый объект (только добавленный модом: у нижних слоёв нет маркера удаления). */
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

  /** Значения новой ссылки по умолчанию из схемы (или 0, 0, 0). */
  refDefaults(stringId: string, category: string): number[] {
    const rec = this.get(stringId);
    const type = rec && this.schema?.types.get(this.typeName(rec.type));
    const def = type?.fields.get(category);
    return def?.refDefaults ?? [0, 0, 0];
  }

  /**
   * Переименовать строковые id новых записей мода (одновременно: можно менять местами).
   * Ссылки во всех записях мода переписываются. Позиции записей в файле сохраняются.
   */
  changeStringIds(mapping: ReadonlyMap<string, string>): void {
    for (const [from, to] of mapping) {
      if (this.status(from) !== 'new') throw new EditError(`Менять id можно только у новых записей мода: ${from}`);
      if (from !== to && (this.lowerEntries.has(to) || (this.deltas.has(to) && !mapping.has(to)))) {
        throw new EditError(`Id ${to} уже занят`);
      }
    }
    const targets = new Set(mapping.values());
    if (targets.size !== mapping.size) throw new EditError('Два id переименовываются в один');
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

  /** Изменить сведения заголовка мода. */
  setModInfo(patch: Partial<Omit<ModInfo, 'fileName'>>): void {
    this.transaction('заголовок мода', () => {
      this.setInfo({ ...this.modInfo, ...patch });
    });
  }

  // ---------------------------------------------------------------- сохранение

  /**
   * Собрать файл мода: только записи мода (изменения). Нетронутые с последнего сохранения
   * записи и заголовок пишутся как были (байт в байт). У изменённых флаги пересчитываются:
   * формат 16 — 0x80000002 новая / 0x80000001 изменена (прежний статус изменения сохраняется);
   * формат 17 — номер сохранения в старших битах и 0/1/3 в младших.
   */
  buildModFile(): DataFile {
    return this.build().file;
  }

  /** Собрать файл и считать его сохранённым: дальше `dirty` = false, отмена по-прежнему работает. */
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

/** Цели ссылок и объектов записи. */
function recordTargets(rec: GameRecord): Set<string> {
  const out = new Set<string>();
  for (const list of rec.refs.values()) for (const r of list) out.add(r.target);
  for (const i of rec.instances.values()) out.add(i.target);
  return out;
}

/** Копия записи с переписанными id (своим и целями ссылок); та же запись, если менять нечего. */
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

