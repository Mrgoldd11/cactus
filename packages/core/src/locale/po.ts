/**
 * Парсер gettext PO (`locale/<язык>/gamedata.po`).
 *
 * В переводах Kenshi у записи бывают комментарии:
 * ```
 * #. Type: BUILDING                 — тип игровой записи
 * #. Name: Ancient Citadel          — её имя
 * #: 5316-TwoStorey.mod:0           — строковый id записи; `:N` — номер строкового поля,
 *                                     без номера — имя записи. Ссылок может быть несколько.
 * #, fuzzy
 * #~ msgid "..."                    — устаревшая запись
 * ```
 */

export interface PoReference {
  /** Строковый id записи (`5316-TwoStorey.mod`). */
  stringId: string;
  /** Номер строкового поля; undefined — имя записи. */
  field?: number;
}

export interface PoEntry {
  /** `# …` — комментарии переводчика. */
  comments: string[];
  /** `#. …` — комментарии из исходников. */
  extracted: string[];
  /** `#: …` как в файле, по одному элементу на ссылку. */
  references: string[];
  /** `#, …` */
  flags: string[];
  /** `#| …` — предыдущий msgid. */
  previous: string[];
  msgctxt?: string;
  msgid: string;
  msgidPlural?: string;
  /** msgstr или msgstr[0..n]. */
  msgstr: string[];
  obsolete: boolean;
  /** Номер строки, где начинается запись (с 1). */
  line: number;
}

export interface PoWarning {
  line: number;
  message: string;
  text: string;
}

export interface PoFile {
  /** Разобранная запись с пустым msgid (заголовок), если есть. */
  header?: PoEntry;
  /** Заголовок как пары «ключ: значение». */
  headers: Map<string, string>;
  entries: PoEntry[];
  warnings: PoWarning[];
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };

export function unescapePoString(s: string): string {
  return s.replace(/\\(.)/g, (m, c: string) => ESCAPES[c] ?? m);
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function newEntry(line: number): PoEntry {
  return { comments: [], extracted: [], references: [], flags: [], previous: [], msgid: '', msgstr: [], obsolete: false, line };
}

export function parsePo(text: string): PoFile {
  const entries: PoEntry[] = [];
  const warnings: PoWarning[] = [];
  let entry = newEntry(1);
  let hasKeyword = false;
  /** Куда дописывать строки-продолжения `"..."`. */
  let target: { set: (s: string) => void } | undefined;

  let empty = true;
  const flush = (): void => {
    if (hasKeyword) entries.push(entry);
    entry = newEntry(0);
    empty = true;
    hasKeyword = false;
    target = undefined;
  };
  const touch = (lineNo: number): void => {
    if (empty) entry.line = lineNo;
    empty = false;
  };

  stripBom(text)
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const lineNo = index + 1;
      let line = raw.trim();
      const warn = (message: string): void => {
        warnings.push({ line: lineNo, message, text: raw });
      };
      if (line === '') {
        flush();
        return;
      }
      let obsolete = false;
      if (line.startsWith('#~')) {
        obsolete = true;
        line = line.slice(2).trim();
        if (line === '') return;
        // `#~| msgid "..."` — предыдущий msgid устаревшей записи.
        if (line.startsWith('|')) {
          obsolete = false;
          line = '#' + line;
        }
      }

      if (!obsolete && line.startsWith('#')) {
        // Комментарий после ключевых слов начинает новую запись.
        if (hasKeyword) flush();
        touch(lineNo);
        const kind = line[1];
        const body = line.slice(2).trim();
        if (kind === '.') entry.extracted.push(body);
        else if (kind === ':') entry.references.push(...body.split(/\s+/).filter((s) => s.length > 0));
        else if (kind === ',') entry.flags.push(...body.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
        else if (kind === '|') entry.previous.push(body);
        else entry.comments.push(line.slice(1).trim());
        return;
      }

      if (line.startsWith('"')) {
        const m = /^"(.*)"$/.exec(line);
        if (!m || !target) {
          warn('строка-продолжение не к месту');
          return;
        }
        target.set(unescapePoString(m[1]!));
        return;
      }

      const m = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+"(.*)"$/.exec(line);
      if (!m) {
        warn('строка не разобрана');
        return;
      }
      const keyword = m[1]!;
      const value = unescapePoString(m[3]!);
      // msgctxt или msgid после msgstr — новая запись без пустой строки между ними.
      if ((keyword === 'msgctxt' || keyword === 'msgid') && entry.msgstr.length > 0) flush();
      touch(lineNo);
      hasKeyword = true;
      if (obsolete) entry.obsolete = true;
      const e = entry;
      if (keyword === 'msgctxt') {
        e.msgctxt = value;
        target = { set: (s) => (e.msgctxt = (e.msgctxt ?? '') + s) };
      } else if (keyword === 'msgid') {
        e.msgid = value;
        target = { set: (s) => (e.msgid += s) };
      } else if (keyword === 'msgid_plural') {
        e.msgidPlural = value;
        target = { set: (s) => (e.msgidPlural = (e.msgidPlural ?? '') + s) };
      } else {
        const n = m[2] !== undefined ? Number(m[2]) : 0;
        e.msgstr[n] = value;
        target = { set: (s) => (e.msgstr[n] = (e.msgstr[n] ?? '') + s) };
      }
    });
  flush();

  const result: PoFile = { headers: new Map(), entries: [], warnings };
  for (const e of entries) {
    if (e.msgid === '' && e.msgctxt === undefined && !e.obsolete && result.header === undefined) {
      result.header = e;
      for (const h of (e.msgstr[0] ?? '').split('\n')) {
        const colon = h.indexOf(':');
        if (colon > 0) result.headers.set(h.slice(0, colon).trim(), h.slice(colon + 1).trim());
      }
    } else {
      result.entries.push(e);
    }
  }
  return result;
}

export function parsePoReference(ref: string): PoReference {
  const m = /^(.*):(\d+)$/.exec(ref);
  return m ? { stringId: m[1]!, field: Number(m[2]) } : { stringId: ref };
}

/** Значение комментария `#. Ключ: значение`. */
export function poExtracted(entry: PoEntry, key: string): string | undefined {
  const prefix = `${key}:`;
  const line = entry.extracted.find((x) => x.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

export interface RecordTranslation {
  stringId: string;
  /** Из `#. Type:`. Комментарии Type/Name относятся к первой ссылке записи PO, поэтому тип берётся только оттуда. */
  type?: string;
  /** Перевод имени записи. */
  name?: PoEntry;
  /** Номер строкового поля → перевод. */
  fields: Map<number, PoEntry>;
}

/**
 * Индекс переводов по строковым id записей. Устаревшие (`#~`) записи пропускаются.
 * Если на одно поле ссылаются несколько записей PO, остаётся первая.
 */
export function indexPoByRecord(po: PoFile): Map<string, RecordTranslation> {
  const index = new Map<string, RecordTranslation>();
  for (const e of po.entries) {
    if (e.obsolete) continue;
    const type = poExtracted(e, 'Type');
    for (const [i, raw] of e.references.entries()) {
      const ref = parsePoReference(raw);
      let rec = index.get(ref.stringId);
      if (!rec) {
        rec = { stringId: ref.stringId, fields: new Map() };
        index.set(ref.stringId, rec);
      }
      if (type !== undefined && i === 0) rec.type ??= type;
      if (ref.field === undefined) rec.name ??= e;
      else if (!rec.fields.has(ref.field)) rec.fields.set(ref.field, e);
    }
  }
  return index;
}

/** Перевод msgid → msgstr (первая неустаревшая запись с непустым переводом). */
export function poTranslationMap(po: PoFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of po.entries) {
    const s = e.msgstr[0];
    if (e.obsolete || s === undefined || s === '' || map.has(e.msgid)) continue;
    map.set(e.msgid, s);
  }
  return map;
}
