/**
 * Простой zip-архив (deflate) без внешних пакетов. Имена — UTF-8 с флагом 0x800, чтобы
 * проводник Windows и 7-Zip показывали русские имена правильно. ZIP64 не нужен: файлы и
 * архив меньше 4 ГБ (иначе — ошибка).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const UTF8 = 0x0800;

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Упаковать папку `dir` в `zipPath`; внутри архива всё лежит в папке `rootName`. */
export function zipDir(dir: string, zipPath: string, rootName: string): { files: number; bytes: number } {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const files = listFiles(dir);
  for (const file of files) {
    const name = Buffer.from(`${rootName}/${relative(dir, file).split(sep).join('/')}`, 'utf8');
    const data = readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const crc = crc32(data);
    const { time, date } = dosTime(statSync(file).mtime);
    if (offset + body.length > 0xffffffff) throw new Error('Архив больше 4 ГБ: нужен ZIP64');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // нужна версия 2.0
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); // создано: MS-DOS, версия 2.0
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(UTF8, 8);
    c.writeUInt16LE(stored ? 0 : 8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30); // extra
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk
    c.writeUInt16LE(0, 36); // internal attrs
    c.writeUInt32LE(0x20, 38); // external attrs: FILE_ATTRIBUTE_ARCHIVE
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  if (files.length > 0xffff) throw new Error('Слишком много файлов: нужен ZIP64');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...chunks, cd, end]);
  writeFileSync(zipPath, all);
  return { files: files.length, bytes: all.length };
}
