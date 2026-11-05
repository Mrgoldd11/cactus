/**
 * Строки в файлах Kenshi — это байты без указания кодировки. В данных игры это UTF-8,
 * в сейвах и части старых модов встречается cp1251. Ядро хранит строковые значения
 * как исходные байты, а эти функции переводят их в текст и обратно.
 */

export type TextEncoding = 'utf-8' | 'cp1251' | 'latin1';

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Loose = new TextDecoder('utf-8', { ignoreBOM: true });
const cp1251Decoder = new TextDecoder('windows-1251');
const utf8Encoder = new TextEncoder();

/** Обратная таблица cp1251: символ → байт (строится из декодера, чтобы не держать таблицу руками). */
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
  // Короткие строки (ключи полей, id) — одним вызовом: `apply` с типизированным массивом
  // не проходит через итератор, в отличие от `...` (это была половина времени разбора файла).
  if (bytes.length <= 8192) return String.fromCharCode.apply(null, bytes as unknown as number[]);
  let out = '';
  // Кусками, чтобы не упереться в лимит аргументов на длинных строках.
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

/**
 * Байты → текст. `auto`: UTF-8, если байты — корректный UTF-8, иначе cp1251.
 * Для `utf-8` некорректные последовательности заменяются на U+FFFD.
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

/** Какой кодировкой скорее всего записаны байты. ASCII считается UTF-8. */
export function detectEncoding(bytes: Uint8Array): 'utf-8' | 'cp1251' {
  return isValidUtf8(bytes) ? 'utf-8' : 'cp1251';
}

/** Текст → байты. Для cp1251 и latin1 символ без соответствия — ошибка (не теряем данные молча). */
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

/** Первое различие двух буферов или -1. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * Идентификаторы (ключи полей, строковые id записей, категории ссылок) нужны как JS-строки.
 * Почти всегда это ASCII/UTF-8; если байты не UTF-8, строка декодируется как latin1
 * (байт = символ), а вызывающий запоминает это, чтобы записать её обратно теми же байтами.
 */
export function decodeIdentifier(bytes: Uint8Array): { text: string; latin1: boolean } {
  if (isAscii(bytes)) return { text: asciiToString(bytes), latin1: false };
  try {
    return { text: utf8Strict.decode(bytes), latin1: false };
  } catch {
    return { text: asciiToString(bytes), latin1: true };
  }
}
