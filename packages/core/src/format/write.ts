import { UiTextError } from '../ui-text.ts';
import { encodeText } from '../text.ts';
import { ByteWriter } from './binary.ts';
import { FileType, type DataFile, type GameRecord, type ModHeader } from './types.ts';

export interface WriteOptions {
  /**
   * Format 17: what to write into the first number of a record (`lead`).
   * - `auto` (default): recompute the length if `lead` is not 0. FCS writes either the length or 0
   *   (all records in Dialogue.mod have 0), so 0 is left as is.
   * - `always`: always recompute the length; `preserve`: write `lead` as is.
   */
  recordLengths?: 'auto' | 'always' | 'preserve';
}

class DataFileWriter {
  private readonly w = new ByteWriter(1 << 20);
  private readonly file: DataFile;
  private readonly options: WriteOptions;

  constructor(file: DataFile, options: WriteOptions) {
    this.file = file;
    this.options = options;
  }

  private id(text: string): void {
    const latin1 = this.file.latin1Ids?.has(text) ?? false;
    this.w.str(encodeText(text, latin1 ? 'latin1' : 'utf-8'));
  }

  write(): Uint8Array {
    const { file, w } = this;
    w.i32(file.fileType);
    if (file.fileType === FileType.Mod || file.fileType === FileType.MergeMod) {
      if (!file.header) throw new UiTextError({ en: `A file of type ${file.fileType} needs a header`, ru: `Для файла типа ${file.fileType} нужен заголовок`, zh: `类型 ${file.fileType} 的文件需要文件头` });
      this.header(file.header, file.fileType);
    }
    w.i32(file.lastId);
    w.i32(file.records.length);
    const mode = file.fileType === FileType.MergeMod ? (this.options.recordLengths ?? 'auto') : 'preserve';
    for (const rec of file.records) this.record(rec, mode === 'always' || (mode === 'auto' && rec.lead !== 0));
    w.bytes(file.tail);
    return w.finish();
  }

  private header(h: ModHeader, fileType: number): void {
    const w = this.w;
    let lengthAt = -1;
    if (fileType === FileType.MergeMod) {
      lengthAt = w.pos;
      w.i32(0);
    }
    w.i32(h.version);
    w.str(h.author);
    w.str(h.description);
    w.str(h.dependencies);
    w.str(h.references);
    if (lengthAt < 0) return;
    if (h.merge) {
      const m = h.merge;
      w.u32(m.saveCount);
      w.u32(m.lastMerge);
      if (m.mergeEntries.length > 255) throw new UiTextError({ en: 'The format cannot hold more than 255 merge entries', ru: 'Больше 255 записей слияния не помещается в формат', zh: '该格式最多只能容纳 255 条合并记录' });
      w.u8(m.mergeEntries.length);
      for (const e of m.mergeEntries) {
        this.id(e.key);
        w.u32(e.a);
        w.u32(e.b);
      }
      if (m.deleteRequests) {
        if (m.deleteRequests.length > 255) throw new UiTextError({ en: 'The format cannot hold more than 255 delete requests', ru: 'Больше 255 запросов удаления не помещается в формат', zh: '该格式最多只能容纳 255 条删除请求' });
        w.u8(m.deleteRequests.length);
        for (const d of m.deleteRequests) {
          this.id(d.key);
          w.u32(d.a);
          w.str(d.value);
        }
      }
    }
    if (h.extra) w.bytes(h.extra);
    w.patchI32(lengthAt, w.pos - lengthAt - 4);
  }

  private record(rec: GameRecord, recomputeLength: boolean): void {
    const w = this.w;
    const nan = rec.quirks?.nanBits;
    const boolBytes = rec.quirks?.boolBytes;
    const f = (v: number, path: string): void => {
      w.f32(v, Number.isNaN(v) ? nan?.get(path) : undefined);
    };

    const start = w.pos;
    w.i32(rec.lead);
    w.i32(rec.type);
    w.i32(rec.id);
    w.str(rec.name);
    this.id(rec.stringId);
    w.u32(rec.changeFlags);

    w.i32(rec.bools.size);
    for (const [k, v] of rec.bools) {
      this.id(k);
      w.u8(v ? (boolBytes?.get(k) ?? 1) : 0);
    }
    w.i32(rec.floats.size);
    for (const [k, v] of rec.floats) {
      this.id(k);
      f(v, `float:${k}`);
    }
    w.i32(rec.ints.size);
    for (const [k, v] of rec.ints) {
      this.id(k);
      w.i32(v);
    }
    w.i32(rec.vec3s.size);
    for (const [k, v] of rec.vec3s) {
      this.id(k);
      for (let i = 0; i < 3; i++) f(v[i]!, `vec3:${k}:${i}`);
    }
    w.i32(rec.vec4s.size);
    for (const [k, v] of rec.vec4s) {
      this.id(k);
      for (let i = 0; i < 4; i++) f(v[i]!, `vec4:${k}:${i}`);
    }
    w.i32(rec.strings.size);
    for (const [k, v] of rec.strings) {
      this.id(k);
      w.str(v);
    }
    w.i32(rec.files.size);
    for (const [k, v] of rec.files) {
      this.id(k);
      w.str(v);
    }
    w.i32(rec.refs.size);
    for (const [cat, list] of rec.refs) {
      this.id(cat);
      w.i32(list.length);
      for (const ref of list) {
        this.id(ref.target);
        w.i32(ref.v0);
        w.i32(ref.v1);
        w.i32(ref.v2);
      }
    }
    w.i32(rec.instances.size);
    for (const [k, inst] of rec.instances) {
      this.id(k);
      this.id(inst.target);
      for (let i = 0; i < 3; i++) f(inst.position[i]!, `inst:${k}:${i}`);
      for (let i = 0; i < 4; i++) f(inst.rotation[i]!, `inst:${k}:${i + 3}`);
      w.i32(inst.states.length);
      for (const s of inst.states) w.str(s);
    }
    if (recomputeLength) w.patchI32(start, w.pos - start);
  }
}

/** Assemble a data file back into bytes. */
export function writeDataFile(file: DataFile, options: WriteOptions = {}): Uint8Array {
  return new DataFileWriter(file, options).write();
}
