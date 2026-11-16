import { describe, expect, it } from 'vitest';
import { bytesEqual, decodeIdentifier, decodeText, detectEncoding, encodeText, firstDifference, isAscii, isValidUtf8 } from '../src/index.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('encodings', () => {
  it('detects ASCII and UTF-8', () => {
    expect(isAscii(utf8('Hello'))).toBe(true);
    expect(isAscii(utf8('Привет'))).toBe(false);
    expect(isValidUtf8(utf8('Привет, мир — 日本'))).toBe(true);
    expect(isValidUtf8(new Uint8Array([0xcf, 0xf0, 0xe8]))).toBe(false); // "При" in cp1251
    expect(isValidUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toBe(false); // surrogate
    expect(isValidUtf8(new Uint8Array([0xc0, 0x80]))).toBe(false); // overlong encoding
  });

  it('auto: UTF-8, and if not UTF-8 — cp1251', () => {
    expect(decodeText(utf8('Скверное место'))).toBe('Скверное место');
    const cp = encodeText('Скверное место', 'cp1251');
    expect(cp.length).toBe('Скверное место'.length);
    expect(detectEncoding(cp)).toBe('cp1251');
    expect(decodeText(cp)).toBe('Скверное место');
    expect(decodeText(cp, 'cp1251')).toBe('Скверное место');
  });

  it('cp1251 there and back, error on a character outside the encoding', () => {
    const text = 'Ёжик №5 «кавычки» — тире';
    expect(decodeText(encodeText(text, 'cp1251'), 'cp1251')).toBe(text);
    expect(() => encodeText('日本', 'cp1251')).toThrow(RangeError);
  });

  it('non-UTF-8 identifiers are read as latin1', () => {
    expect(decodeIdentifier(utf8('123-mod.mod'))).toEqual({ text: '123-mod.mod', latin1: false });
    const raw = new Uint8Array([0x31, 0x2d, 0xe9]);
    const id = decodeIdentifier(raw);
    expect(id.latin1).toBe(true);
    expect(bytesEqual(encodeText(id.text, 'latin1'), raw)).toBe(true);
  });

  it('firstDifference', () => {
    expect(firstDifference(utf8('abc'), utf8('abc'))).toBe(-1);
    expect(firstDifference(utf8('abc'), utf8('abd'))).toBe(2);
    expect(firstDifference(utf8('ab'), utf8('abc'))).toBe(2);
  });
});
