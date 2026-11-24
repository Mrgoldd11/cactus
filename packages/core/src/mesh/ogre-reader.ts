/**
 * Little-endian reader shared by the Ogre `.mesh` and `.skeleton` parsers. Both formats are nested
 * chunks "id (uint16) + length (uint32) + data" with `\n`-terminated strings.
 */

import type { Vec3 } from '../format/types.ts';
import { type UiText, UiTextError } from '../ui-text.ts';

/** Corrupt or unsupported `.mesh` / `.skeleton` file. */
export class MeshFormatError extends UiTextError {
  constructor(message: string | UiText) {
    super(message);
    this.name = 'MeshFormatError';
  }
}

/** Chunk header size (id + length). */
export const CHUNK_OVERHEAD = 6;

export class OgreReader {
  private readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get left(): number {
    return this.bytes.length - this.pos;
  }

  need(n: number): void {
    if (n > this.left) throw new MeshFormatError({ en: `file ends early (${n} bytes needed at ${this.pos}, ${this.left} left)`, ru: `файл обрывается (нужно ${n} байт на ${this.pos}, осталось ${this.left})`, zh: `文件提前结束（在 ${this.pos} 处需要 ${n} 字节，只剩 ${this.left}）` });
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Read `n` floats into `out` starting at index `at`. */
  floats(out: Float32Array | number[], at: number, n: number): void {
    this.need(n * 4);
    for (let i = 0; i < n; i++) out[at + i] = this.view.getFloat32(this.pos + i * 4, true);
    this.pos += n * 4;
  }

  vec3(): Vec3 {
    return [this.f32(), this.f32(), this.f32()];
  }

  /** Quaternion in file order: x, y, z, w. */
  quat(): [number, number, number, number] {
    return [this.f32(), this.f32(), this.f32(), this.f32()];
  }

  /** String up to `\n` (this is how Ogre writes strings). */
  line(): string {
    const end = this.bytes.indexOf(10, this.pos);
    if (end < 0) throw new MeshFormatError({ en: `unterminated string at ${this.pos}`, ru: `строка без конца на ${this.pos}`, zh: `${this.pos} 处的字符串没有结尾` });
    let s = '';
    for (let i = this.pos; i < end; i++) s += String.fromCharCode(this.bytes[i]!);
    this.pos = end + 1;
    return s;
  }

  /** The next `n` bytes as a view (no copy). */
  slice(n: number): Uint8Array {
    this.need(n);
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  /** id of the next chunk without moving the position; undefined at end of file. */
  peekChunk(): number | undefined {
    return this.left >= CHUNK_OVERHEAD ? this.view.getUint16(this.pos, true) : undefined;
  }

  /** Chunk header: id and length (the length of old versions cannot be trusted). */
  chunk(): { id: number; length: number } {
    const id = this.u16();
    const length = this.u32();
    return { id, length };
  }
}
