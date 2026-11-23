/** Low-level little-endian reading/writing. */

import { mapUi, type UiText, UiTextError } from '../ui-text.ts';

const OFFSET: UiText = { en: 'offset', ru: 'смещение', zh: '偏移' };

/** What is being read: a technical name (`int`, `vec3`) is the same in every language. */
export type ReadWhat = string | UiText;

function what(w: ReadWhat): UiText {
  return typeof w === 'string' ? { en: w } : w;
}

/** Corrupt or unexpected file; the text ends with the byte offset in every language. */
export class FormatError extends UiTextError {
  readonly offset: number;

  constructor(message: string | UiText, offset: number) {
    super(mapUi([what(message), OFFSET], ([m, o]) => `${m} (${o} ${offset})`));
    this.name = 'FormatError';
    this.offset = offset;
  }
}

const STRING: UiText = { en: 'a string', ru: 'строки', zh: '字符串' };
const BLOCK: UiText = { en: 'a block', ru: 'блока', zh: '数据块' };

export class ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos = 0;
  /** Original bits of the last read float, if it was NaN. */
  lastNaNBits: number | undefined;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  private need(n: number, w: ReadWhat): void {
    if (this.pos + n > this.bytes.length) {
      const left = this.remaining;
      const t = what(w);
      throw new FormatError(
        {
          en: `File ends early: ${n} bytes needed for ${t.en}, ${left} left`,
          ru: `Файл обрывается: нужно ${n} байт для ${t.ru ?? t.en}, осталось ${left}`,
          zh: `文件提前结束：读取${t.zh ?? t.en}需要 ${n} 字节，只剩 ${left}`,
        },
        this.pos,
      );
    }
  }

  i32(): number {
    this.need(4, 'int');
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u32(): number {
    this.need(4, 'uint');
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** float32; for NaN it also returns the original bits via `lastNaNBits`. */
  f32(): number {
    this.need(4, 'float');
    const v = this.view.getFloat32(this.pos, true);
    this.lastNaNBits = Number.isNaN(v) ? this.view.getUint32(this.pos, true) : undefined;
    this.pos += 4;
    return v;
  }

  u8(): number {
    this.need(1, 'byte');
    return this.bytes[this.pos++]!;
  }

  /** String: int32 length + bytes. A copy of the bytes is returned. */
  str(): Uint8Array {
    const start = this.pos;
    const n = this.i32();
    if (n < 0) throw new FormatError({ en: `Negative string length ${n}`, ru: `Отрицательная длина строки ${n}`, zh: `字符串长度为负：${n}` }, start);
    this.need(n, STRING);
    const v = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** Element count: int32 >= 0 and no more than could fit into the rest of the file. */
  count(minItemSize: number, w: ReadWhat): number {
    const start = this.pos;
    const n = this.i32();
    if (n < 0 || n * minItemSize > this.remaining) {
      const t = what(w);
      throw new FormatError(
        {
          en: `Implausible element count (${t.en}): ${n}`,
          ru: `Неправдоподобное число элементов (${t.ru ?? t.en}): ${n}`,
          zh: `元素数量不合理（${t.zh ?? t.en}）：${n}`,
        },
        start,
      );
    }
    return n;
  }

  take(n: number): Uint8Array {
    this.need(n, BLOCK);
    const v = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
}

const CANONICAL_NAN = 0x7fc00000;

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(initialSize = 1 << 16) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  /** float32; NaN is written with the saved bits, if known. */
  f32(v: number, nanBits?: number): void {
    this.ensure(4);
    if (Number.isNaN(v)) this.view.setUint32(this.pos, nanBits ?? CANONICAL_NAN, true);
    else this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v;
  }

  bytes(v: Uint8Array): void {
    this.ensure(v.length);
    this.buf.set(v, this.pos);
    this.pos += v.length;
  }

  str(v: Uint8Array): void {
    this.i32(v.length);
    this.bytes(v);
  }

  /** Overwrite an int32 at an already written offset (for length fields). */
  patchI32(offset: number, v: number): void {
    this.view.setInt32(offset, v, true);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}
