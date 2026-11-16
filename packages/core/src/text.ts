/**
 * Strings in Kenshi files are bytes with no stated encoding. Game data is UTF-8;
 * saves and some old mods contain cp1251. The core stores string values
 * as the original bytes, and these functions convert them to text and back.
 */

export type TextEncoding = 'utf-8' | 'cp1251' | 'latin1';

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Loose = new TextDecoder('utf-8', { ignoreBOM: true });
const cp1251Decoder = new TextDecoder('windows-1251');
const utf8Encoder = new TextEncoder();

/** Reverse cp1251 table: character → byte (built from the decoder, so no hand-kept table). */
let cp1251Table: Map<number, number> | undefined;
function cp1251Reverse(): Map<number, number> {
  if (cp1251Table) return cp1251Table;
  const table = new Map<number, number>();
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  const chars = cp1251Decoder.decode(bytes);
  for (let i = 0; i < 256; i++) {
    const code = chars.charCodeAt(i);
    if (code !== 0xfffd && !table.has(code)) table.set(code, i);
  }
  cp1251Table = table;
  return table;
}

export function isAscii(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b >= 0x80) return false;
  return true;
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  if (isAscii(bytes)) return true;
  try {
    utf8Strict.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function asciiToString(bytes: Uint8Array): string {
  // Short strings (field keys, ids) in one call: `apply` with a typed array
  // skips the iterator, unlike `...` (that was half of the file-parse time).
  if (bytes.length <= 8192) return String.fromCharCode.apply(null, bytes as unknown as number[]);
  let out = '';
  // In chunks, to stay under the argument limit on long strings.
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

/**
 * Bytes → text. `auto`: UTF-8 if the bytes are valid UTF-8, otherwise cp1251.
 * For `utf-8`, invalid sequences are replaced with U+FFFD.
 */
export function decodeText(bytes: Uint8Array, encoding: TextEncoding | 'auto' = 'auto'): string {
  if (isAscii(bytes)) return asciiToString(bytes);
  switch (encoding) {
    case 'utf-8':
      return utf8Loose.decode(bytes);
    case 'cp1251':
      return cp1251Decoder.decode(bytes);
    case 'latin1':
      return asciiToString(bytes);
    case 'auto':
      return isValidUtf8(bytes) ? utf8Strict.decode(bytes) : cp1251Decoder.decode(bytes);
  }
}

/** Which encoding the bytes were most likely written in. ASCII counts as UTF-8. */
export function detectEncoding(bytes: Uint8Array): 'utf-8' | 'cp1251' {
  return isValidUtf8(bytes) ? 'utf-8' : 'cp1251';
}

/** Text → bytes. For cp1251 and latin1 an unmappable character is an error (no silent data loss). */
export function encodeText(text: string, encoding: TextEncoding = 'utf-8'): Uint8Array {
  if (encoding === 'utf-8') return utf8Encoder.encode(text);
  const out = new Uint8Array(text.length);
  const table = encoding === 'cp1251' ? cp1251Reverse() : undefined;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const byte = code < 0x80 ? code : table ? table.get(code) : code <= 0xff ? code : undefined;
    if (byte === undefined) {
      throw new RangeError(`Символ U+${code.toString(16).toUpperCase().padStart(4, '0')} нельзя записать в ${encoding}`);
    }
    out[i] = byte;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** First difference of two buffers, or -1. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * Identifiers (field keys, record string ids, reference categories) are needed as JS strings.
 * They are almost always ASCII/UTF-8; if the bytes are not UTF-8, the string is decoded as latin1
 * (byte = character), and the caller remembers this to write it back as the same bytes.
 */
export function decodeIdentifier(bytes: Uint8Array): { text: string; latin1: boolean } {
  if (isAscii(bytes)) return { text: asciiToString(bytes), latin1: false };
  try {
    return { text: utf8Strict.decode(bytes), latin1: false };
  } catch {
    return { text: asciiToString(bytes), latin1: true };
  }
}
