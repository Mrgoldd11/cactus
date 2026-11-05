import { decodeIdentifier } from '../text.ts';
import { ByteReader, FormatError } from './binary.ts';
import {
  FileType,
  type DataFile,
  type DeleteRequest,
  type GameRecord,
  type Instance,
  type MergeData,
  type MergeEntry,
  type ModHeader,
  type RecordQuirks,
  type Reference,
  type Vec3,
  type Vec4,
} from './types.ts';

export interface ReadOptions {
  /**
   * Файлы без типа в начале (сейвы старого вида): тип 15 предполагается, если первое
   * число не 15/16/17. По умолчанию неизвестный тип — ошибка.
   */
  allowUnknownFileType?: boolean;
}

class DataFileReader {
  private readonly r: ByteReader;
  private latin1Ids: Set<string> | undefined;

  constructor(bytes: Uint8Array) {
    this.r = new ByteReader(bytes);
  }

  private id(): string {
    const { text, latin1 } = decodeIdentifier(this.r.str());
    if (latin1) (this.latin1Ids ??= new Set()).add(text);
    return text;
  }

  /** Только тип файла и заголовок мода (без записей). */
  readHeader(): { fileType: number; header?: ModHeader; recordCount?: number } {
    const fileType = this.r.i32();
    if (fileType !== FileType.Mod && fileType !== FileType.MergeMod) return { fileType };
    const header = this.header(fileType);
    this.r.i32();
    return { fileType, header, recordCount: this.r.i32() };
  }

  read(options: ReadOptions): DataFile {
    const r = this.r;
    const fileType = r.i32();
    if (fileType !== FileType.Data && fileType !== FileType.Mod && fileType !== FileType.MergeMod) {
      if (!options.allowUnknownFileType) throw new FormatError(`Неизвестный тип файла ${fileType}`, 0);
    }
    const header = fileType === FileType.Mod || fileType === FileType.MergeMod ? this.header(fileType) : undefined;
    const lastId = r.i32();
    const count = r.count(60, 'записи');
    const records: GameRecord[] = new Array<GameRecord>(count);
    for (let i = 0; i < count; i++) records[i] = this.record();
    const tail = r.take(r.remaining);
    const file: DataFile = { fileType, lastId, records, tail };
    if (header) file.header = header;
    if (this.latin1Ids) file.latin1Ids = this.latin1Ids;
    return file;
  }

  private header(fileType: number): ModHeader {
    const r = this.r;
    let end = -1;
    if (fileType === FileType.MergeMod) {
      const start = r.pos;
      const len = r.i32();
      end = r.pos + len;
      if (len < 0 || end > r.length) throw new FormatError(`Неверная длина заголовка ${len}`, start);
    }
    const header: ModHeader = {
      version: r.i32(),
      author: r.str(),
      description: r.str(),
      dependencies: r.str(),
      references: r.str(),
    };
    if (end < 0) return header;
    if (r.pos > end) throw new FormatError('Поля заголовка выходят за его длину', r.pos);

    const afterRefs = r.pos;
    if (r.pos < end) {
      try {
        header.merge = this.mergeData(end);
      } catch (e) {
        if (!(e instanceof FormatError)) throw e;
        // Незнакомое содержимое — сохраняем как есть.
        r.pos = afterRefs;
      }
    }
    if (r.pos < end) header.extra = r.take(end - r.pos);
    return header;
  }

  private mergeData(end: number): MergeData {
    const r = this.r;
    const guard = (): void => {
      if (r.pos > end) throw new FormatError('Данные слияния выходят за заголовок', r.pos);
    };
    const saveCount = r.u32();
    const lastMerge = r.u32();
    const mergeEntries: MergeEntry[] = [];
    const n = r.u8();
    for (let i = 0; i < n; i++) {
      mergeEntries.push({ key: this.id(), a: r.u32(), b: r.u32() });
      guard();
    }
    guard();
    const merge: MergeData = { saveCount, lastMerge, mergeEntries };
    if (r.pos < end) {
      const deleteRequests: DeleteRequest[] = [];
      const d = r.u8();
      for (let i = 0; i < d; i++) {
        deleteRequests.push({ key: this.id(), a: r.u32(), value: r.str() });
        guard();
      }
      guard();
      merge.deleteRequests = deleteRequests;
    }
    return merge;
  }

  private dict<T>(what: string, minSize: number, read: (key: string) => T): Map<string, T> {
    const r = this.r;
    const n = r.count(4 + minSize, what);
    const map = new Map<string, T>();
    for (let i = 0; i < n; i++) {
      const at = r.pos;
      const key = this.id();
      if (map.has(key)) throw new FormatError(`Повтор ключа «${key}» (${what})`, at);
      map.set(key, read(key));
    }
    return map;
  }

  private record(): GameRecord {
    const r = this.r;
    let quirks: RecordQuirks | undefined;
    const float = (path: string): number => {
      const v = r.f32();
      if (r.lastNaNBits !== undefined) ((quirks ??= {}).nanBits ??= new Map()).set(path, r.lastNaNBits);
      return v;
    };

    const lead = r.i32();
    const type = r.i32();
    const id = r.i32();
    const name = r.str();
    const stringId = this.id();
    const changeFlags = r.u32();

    const bools = this.dict('bool', 1, (key) => {
      const b = r.u8();
      if (b > 1) ((quirks ??= {}).boolBytes ??= new Map()).set(key, b);
      return b !== 0;
    });
    const floats = this.dict('float', 4, (key) => float(`float:${key}`));
    const ints = this.dict('int', 4, () => r.i32());
    const vec3s = this.dict('vec3', 12, (key): Vec3 => [float(`vec3:${key}:0`), float(`vec3:${key}:1`), float(`vec3:${key}:2`)]);
    const vec4s = this.dict('vec4', 16, (key): Vec4 => [
      float(`vec4:${key}:0`),
      float(`vec4:${key}:1`),
      float(`vec4:${key}:2`),
      float(`vec4:${key}:3`),
    ]);
    const strings = this.dict('string', 4, () => r.str());
    const files = this.dict('filename', 4, () => r.str());
    const refs = this.dict('ref category', 4, (): Reference[] => {
      const n = r.count(16, 'ссылки');
      const list: Reference[] = new Array<Reference>(n);
      for (let i = 0; i < n; i++) list[i] = { target: this.id(), v0: r.i32(), v1: r.i32(), v2: r.i32() };
      return list;
    });
    const instances = this.dict('instance', 36, (key): Instance => {
      const target = this.id();
      const position: Vec3 = [float(`inst:${key}:0`), float(`inst:${key}:1`), float(`inst:${key}:2`)];
      const rotation: Vec4 = [float(`inst:${key}:3`), float(`inst:${key}:4`), float(`inst:${key}:5`), float(`inst:${key}:6`)];
      const n = r.count(4, 'состояния экземпляра');
      const states: Uint8Array[] = new Array<Uint8Array>(n);
      for (let i = 0; i < n; i++) states[i] = r.str();
      return { target, position, rotation, states };
    });

    const rec: GameRecord = {
      lead,
      type,
      id,
      name,
      stringId,
      changeFlags,
      bools,
      floats,
      ints,
      vec3s,
      vec4s,
      strings,
      files,
      refs,
      instances,
    };
    if (quirks) rec.quirks = quirks;
    return rec;
  }
}

/** Разобрать файл данных (.base/.mod/.save…) из байтов. */
export function readDataFile(bytes: Uint8Array, options: ReadOptions = {}): DataFile {
  return new DataFileReader(bytes).read(options);
}

/** Тип файла, заголовок мода и число записей — без чтения записей (для списка модов). */
export function readModHeader(bytes: Uint8Array): { fileType: number; header?: ModHeader; recordCount?: number } {
  return new DataFileReader(bytes).readHeader();
}
