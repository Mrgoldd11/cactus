/**
 * gettext PO parser (`locale/<language>/gamedata.po`).
 *
 * In Kenshi translations an entry may have comments:
 * ```
 * #. Type: BUILDING                 — type of the game record
 * #. Name: Ancient Citadel          — its name
 * #: 5316-TwoStorey.mod:0           — string id of the record; `:N` is the string field number,
 *                                     no number means the record name. There may be several references.
 * #, fuzzy
 * #~ msgid "..."                    — obsolete entry
 * ```
 */

export interface PoReference {
  /** String id of the record (`5316-TwoStorey.mod`). */
  stringId: string;
  /** String field number; undefined means the record name. */
  field?: number;
}

export interface PoEntry {
  /** `# …`: translator comments. */
  comments: string[];
  /** `#. …`: comments from the sources. */
  extracted: string[];
  /** `#: …` as in the file, one element per reference. */
  references: string[];
  /** `#, …` */
  flags: string[];
  /** `#| …`: previous msgid. */
  previous: string[];
  msgctxt?: string;
  msgid: string;
  msgidPlural?: string;
  /** msgstr or msgstr[0..n]. */
  msgstr: string[];
  obsolete: boolean;
  /** Line number where the entry starts (1-based). */
  line: number;
}

export interface PoWarning {
  line: number;
  message: string;
  text: string;
}

export interface PoFile {
  /** The parsed entry with an empty msgid (the header), if any. */
  header?: PoEntry;
  /** Header as "key: value" pairs. */
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
  /** Where to append continuation strings `"..."`. */
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
        // `#~| msgid "..."`: previous msgid of an obsolete entry.
        if (line.startsWith('|')) {
          obsolete = false;
          line = '#' + line;
        }
      }

      if (!obsolete && line.startsWith('#')) {
        // A comment after keywords starts a new entry.
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
          warn('continuation line out of place');
          return;
        }
        target.set(unescapePoString(m[1]!));
        return;
      }

      const m = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+"(.*)"$/.exec(line);
      if (!m) {
        warn('line not parsed');
        return;
      }
      const keyword = m[1]!;
      const value = unescapePoString(m[3]!);
      // msgctxt or msgid after msgstr: a new entry without an empty line between them.
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

/** Value of a `#. Key: value` comment. */
export function poExtracted(entry: PoEntry, key: string): string | undefined {
  const prefix = `${key}:`;
  const line = entry.extracted.find((x) => x.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

export interface RecordTranslation {
  stringId: string;
  /** From `#. Type:`. Type/Name comments refer to the first reference of the PO entry, so the type is taken only from there. */
  type?: string;
  /** Translation of the record name. */
  name?: PoEntry;
  /** String field number → translation. */
  fields: Map<number, PoEntry>;
}

/**
 * Translation index by record string ids. Obsolete (`#~`) entries are skipped.
 * If several PO entries refer to one field, the first one stays.
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

/** Translate msgid → msgstr (the first non-obsolete entry with a non-empty translation). */
export function poTranslationMap(po: PoFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of po.entries) {
    const s = e.msgstr[0];
    if (e.obsolete || s === undefined || s === '' || map.has(e.msgid)) continue;
    map.set(e.msgid, s);
  }
  return map;
}
