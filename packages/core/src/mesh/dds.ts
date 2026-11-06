/**
 * Текстуры DDS игры в RGBA. В Kenshi почти все текстуры сжаты DXT1 / DXT3 / DXT5 (BC1–BC3);
 * несжатые 32-битные тоже читаем. Распаковка на процессоре: так картинка одинаково выходит
 * и в окне (WebGL без расширений сжатия), и в тестах, и при рендере иконок.
 *
 * Можно взять уменьшенный уровень (mip), если он есть: `maxSize` — наибольшая сторона.
 */

export interface DdsImage {
  width: number;
  height: number;
  /** r, g, b, a по 8 бит, строки сверху вниз. */
  rgba: Uint8Array;
  /** Формат в файле: `DXT1`, `DXT5`, `RGBA32`… */
  format: string;
  /** Номер взятого уровня mip (0 — полный размер). */
  level: number;
}

export class DdsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DdsFormatError';
  }
}

const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;

interface Header {
  width: number;
  height: number;
  mipCount: number;
  format: string;
  /** Байт на блок 4×4 (сжатые) или на пиксель (несжатые). */
  blockBytes: number;
  compressed: boolean;
  masks?: { r: number; g: number; b: number; a: number; bits: number };
  dataStart: number;
}

function readHeader(bytes: Uint8Array): Header {
  if (bytes.length < 128) throw new DdsFormatError('файл короче заголовка DDS');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 0x20534444) throw new DdsFormatError('это не DDS');
  const height = v.getUint32(12, true);
  const width = v.getUint32(16, true);
  const mipCount = Math.max(1, v.getUint32(28, true));
  const pfFlags = v.getUint32(80, true);
  let dataStart = 128;
  if (pfFlags & DDPF_FOURCC) {
    const four = String.fromCharCode(bytes[84]!, bytes[85]!, bytes[86]!, bytes[87]!);
    if (four === 'DX10') {
      const dxgi = v.getUint32(128, true);
      dataStart = 148;
      // 71 BC1, 74 BC2, 77 BC3 (UNORM; +1 — SRGB)
      const map: Record<number, string> = { 71: 'DXT1', 72: 'DXT1', 74: 'DXT3', 75: 'DXT3', 77: 'DXT5', 78: 'DXT5' };
      const f = map[dxgi];
      if (!f) throw new DdsFormatError(`формат DXGI ${dxgi} не поддерживается`);
      return { width, height, mipCount, format: f, blockBytes: f === 'DXT1' ? 8 : 16, compressed: true, dataStart };
    }
    if (four === 'DXT1') return { width, height, mipCount, format: four, blockBytes: 8, compressed: true, dataStart };
    if (four === 'DXT3' || four === 'DXT5') return { width, height, mipCount, format: four, blockBytes: 16, compressed: true, dataStart };
    throw new DdsFormatError(`сжатие ${four} не поддерживается`);
  }
  if (pfFlags & DDPF_RGB) {
    const bits = v.getUint32(88, true);
    if (bits !== 32 && bits !== 24) throw new DdsFormatError(`несжатый DDS ${bits} бит не поддерживается`);
    const masks = {
      r: v.getUint32(92, true),
      g: v.getUint32(96, true),
      b: v.getUint32(100, true),
      a: pfFlags & DDPF_ALPHAPIXELS ? v.getUint32(104, true) : 0,
      bits,
    };
    return { width, height, mipCount, format: bits === 32 ? 'RGBA32' : 'RGB24', blockBytes: bits / 8, compressed: false, masks, dataStart };
  }
  throw new DdsFormatError('неизвестный формат пикселей DDS');
}

function levelSize(h: Header, w: number, hh: number): number {
  return h.compressed ? Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(hh / 4)) * h.blockBytes : w * hh * h.blockBytes;
}

/** Размеры и формат без распаковки. */
export function ddsInfo(bytes: Uint8Array): { width: number; height: number; format: string; mipCount: number } {
  const h = readHeader(bytes);
  return { width: h.width, height: h.height, format: h.format, mipCount: h.mipCount };
}

/** Распаковать DDS в RGBA. `maxSize` — взять первый уровень mip, у которого обе стороны ≤ него. */
export function decodeDds(bytes: Uint8Array, options: { maxSize?: number } = {}): DdsImage {
  const h = readHeader(bytes);
  let w = h.width;
  let hh = h.height;
  let off = h.dataStart;
  let level = 0;
  const max = options.maxSize ?? Infinity;
  while (level + 1 < h.mipCount && (w > max || hh > max)) {
    off += levelSize(h, w, hh);
    w = Math.max(1, w >> 1);
    hh = Math.max(1, hh >> 1);
    level++;
  }
  const size = levelSize(h, w, hh);
  if (off + size > bytes.length) throw new DdsFormatError('файл DDS обрывается');
  const data = bytes.subarray(off, off + size);
  const rgba = h.compressed ? decodeBlocks(data, w, hh, h.format) : decodeRaw(data, w, hh, h);
  return { width: w, height: hh, rgba, format: h.format, level };
}

function decodeRaw(data: Uint8Array, w: number, hh: number, h: Header): Uint8Array {
  const out = new Uint8Array(w * hh * 4);
  const m = h.masks!;
  const step = m.bits / 8;
  const chan = (px: number, mask: number): number => {
    if (mask === 0) return 255;
    const shift = 31 - Math.clz32(mask & -mask); // номер младшего бита маски
    const width = 32 - Math.clz32(mask >>> shift);
    const val = (px & mask) >>> shift;
    return width >= 8 ? val >>> (width - 8) : Math.round((val * 255) / ((1 << width) - 1));
  };
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < w * hh; i++) {
    const px = step === 4 ? v.getUint32(i * 4, true) : data[i * 3]! | (data[i * 3 + 1]! << 8) | (data[i * 3 + 2]! << 16);
    out[i * 4] = chan(px, m.r);
    out[i * 4 + 1] = chan(px, m.g);
    out[i * 4 + 2] = chan(px, m.b);
    out[i * 4 + 3] = chan(px, m.a);
  }
  return out;
}

function decodeBlocks(data: Uint8Array, w: number, hh: number, format: string): Uint8Array {
  const out = new Uint8Array(w * hh * 4);
  const bw = Math.max(1, Math.ceil(w / 4));
  const bh = Math.max(1, Math.ceil(hh / 4));
  const blockBytes = format === 'DXT1' ? 8 : 16;
  const colors = new Uint8Array(16);
  const alpha = new Uint8Array(16);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const b = (by * bw + bx) * blockBytes;
      let colorAt = b;
      if (format === 'DXT3') {
        for (let i = 0; i < 16; i++) {
          const nib = (data[b + (i >> 1)]! >> ((i & 1) * 4)) & 0xf;
          alpha[i] = nib * 17;
        }
        colorAt = b + 8;
      } else if (format === 'DXT5') {
        const a0 = data[b]!, a1 = data[b + 1]!;
        const pal = [a0, a1, 0, 0, 0, 0, 0, 0];
        if (a0 > a1) for (let i = 1; i < 7; i++) pal[i + 1] = Math.round(((7 - i) * a0 + i * a1) / 7);
        else {
          for (let i = 1; i < 5; i++) pal[i + 1] = Math.round(((5 - i) * a0 + i * a1) / 5);
          pal[6] = 0;
          pal[7] = 255;
        }
        // 48 бит индексов, по 3 на пиксель
        let bits = 0;
        let have = 0;
        let p = b + 2;
        for (let i = 0; i < 16; i++) {
          while (have < 3) {
            bits |= data[p++]! << have;
            have += 8;
          }
          alpha[i] = pal[bits & 7]!;
          bits >>>= 3;
          have -= 3;
        }
        colorAt = b + 8;
      }
      const c0 = data[colorAt]! | (data[colorAt + 1]! << 8);
      const c1 = data[colorAt + 2]! | (data[colorAt + 3]! << 8);
      const r0 = ((c0 >> 11) & 31) * 255 / 31, g0 = ((c0 >> 5) & 63) * 255 / 63, b0 = (c0 & 31) * 255 / 31;
      const r1 = ((c1 >> 11) & 31) * 255 / 31, g1 = ((c1 >> 5) & 63) * 255 / 63, b1 = (c1 & 31) * 255 / 31;
      const four = format !== 'DXT1' || c0 > c1;
      const pal = [
        r0, g0, b0, 255,
        r1, g1, b1, 255,
        four ? (2 * r0 + r1) / 3 : (r0 + r1) / 2, four ? (2 * g0 + g1) / 3 : (g0 + g1) / 2, four ? (2 * b0 + b1) / 3 : (b0 + b1) / 2, 255,
        four ? (r0 + 2 * r1) / 3 : 0, four ? (g0 + 2 * g1) / 3 : 0, four ? (b0 + 2 * b1) / 3 : 0, four ? 255 : 0,
      ];
      const idx = data[colorAt + 4]! | (data[colorAt + 5]! << 8) | (data[colorAt + 6]! << 16) | (data[colorAt + 7]! << 24);
      for (let i = 0; i < 16; i++) colors[i] = (idx >>> (i * 2)) & 3;
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= hh) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= w) continue;
          const i = py * 4 + px;
          const c = colors[i]! * 4;
          const o = (y * w + x) * 4;
          out[o] = Math.round(pal[c]!);
          out[o + 1] = Math.round(pal[c + 1]!);
          out[o + 2] = Math.round(pal[c + 2]!);
          out[o + 3] = format === 'DXT1' ? pal[c + 3]! : alpha[i]!;
        }
      }
    }
  return out;
}
