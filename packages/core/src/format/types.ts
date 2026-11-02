/**
 * Модель файла данных Kenshi (.base, .mod; тот же формат записей в .save/.level/.zone).
 *
 * Принцип: прочитать и записать = те же байты. Поэтому строковые значения — исходные
 * байты (`Uint8Array`), порядок всех словарей сохраняется (Map хранит порядок вставки),
 * а редкие «нестандартные» значения (NaN с особыми битами, булевы не 0/1, идентификаторы
 * не в UTF-8) запоминаются в `RecordQuirks`/`DataFile.latin1Ids`.
 */

/** Тип файла — первое int32. */
export const FileType = {
  /** Сейвы, .platoon, .zone и т. п.: без заголовка мода. */
  Data: 15,
  /** .mod/.base старого формата. */
  Mod: 16,
  /** .mod с длиной заголовка и данными слияния (FCS после 1.0.x). */
  MergeMod: 17,
} as const;

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export interface MergeEntry {
  key: string;
  a: number;
  b: number;
}

export interface DeleteRequest {
  key: string;
  a: number;
  value: Uint8Array;
}

/** Данные, которые FCS пишет в заголовок формата 17 после списка ссылок. */
export interface MergeData {
  saveCount: number;
  lastMerge: number;
  mergeEntries: MergeEntry[];
  /** undefined — блока удалений в файле не было (это не то же самое, что пустой список). */
  deleteRequests?: DeleteRequest[];
}

export interface ModHeader {
  version: number;
  author: Uint8Array;
  description: Uint8Array;
  /** Зависимости через запятую, как в файле. См. `splitModList`. */
  dependencies: Uint8Array;
  /** Ссылки (references) через запятую. */
  references: Uint8Array;
  /** Только формат 17. */
  merge?: MergeData;
  /** Только формат 17: байты заголовка, которые идут после разобранных полей (обычно пусто). */
  extra?: Uint8Array;
}

export interface Reference {
  /** Строковый id записи, на которую ссылаемся. */
  target: string;
  v0: number;
  v1: number;
  v2: number;
}

export interface Instance {
  /** Строковый id размещаемой записи. */
  target: string;
  position: Vec3;
  /** Кватернион в порядке файла (w, x, y, z). */
  rotation: Vec4;
  states: Uint8Array[];
}

/** Отклонения от «канонической» записи значений, нужные только для записи байт в байт. */
export interface RecordQuirks {
  /** Путь значения → исходные биты NaN. Путь: `float:<ключ>`, `vec3:<ключ>:<i>`, `inst:<ключ>:<i>`. */
  nanBits?: Map<string, number>;
  /** Ключ булева поля → исходный байт, если он не 0 и не 1. */
  boolBytes?: Map<string, number>;
}

export interface GameRecord {
  /**
   * Первое int32 записи. В формате 17 — длина записи в байтах (включая само число) или 0;
   * ненулевая длина при записи пересчитывается. В остальных форматах — как в файле (обычно 0).
   */
  lead: number;
  /** Тип записи, номер (см. `itemTypeName`). */
  type: number;
  id: number;
  name: Uint8Array;
  /** Строковый id, например `2604-gamedata.base`. */
  stringId: string;
  /** Флаги изменения как в файле (uint32): новая/изменённая/переименованная и счётчик сохранений. */
  changeFlags: number;
  bools: Map<string, boolean>;
  floats: Map<string, number>;
  ints: Map<string, number>;
  vec3s: Map<string, Vec3>;
  vec4s: Map<string, Vec4>;
  strings: Map<string, Uint8Array>;
  files: Map<string, Uint8Array>;
  /** Категория → ссылки. Внутри категории порядок и повторы сохраняются. */
  refs: Map<string, Reference[]>;
  instances: Map<string, Instance>;
  quirks?: RecordQuirks;
}

export interface DataFile {
  fileType: number;
  /** Есть у форматов 16 и 17. */
  header?: ModHeader;
  /** Последний выданный числовой id (FCS берёт следующий для новых записей). */
  lastId: number;
  records: GameRecord[];
  /** Байты после последней записи (у .zone там список id; у .mod обычно пусто). */
  tail: Uint8Array;
  /** Идентификаторы, которые в файле записаны не в UTF-8 (прочитаны как latin1). */
  latin1Ids?: Set<string>;
}

export function emptyRecord(type: number, stringId: string, name: Uint8Array = new Uint8Array()): GameRecord {
  return {
    lead: 0,
    type,
    id: 0,
    name,
    stringId,
    changeFlags: 0,
    bools: new Map(),
    floats: new Map(),
    ints: new Map(),
    vec3s: new Map(),
    vec4s: new Map(),
    strings: new Map(),
    files: new Map(),
    refs: new Map(),
    instances: new Map(),
  };
}
