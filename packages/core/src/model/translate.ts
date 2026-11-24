/**
 * Mod translation helper. A translation mod is a separate mod that depends on the original, loads
 * after it and overrides only texts: record names and text string fields. This is how the
 * Workshop "RUS" patches work (e.g. "Expanded Vanilla Armor RUS").
 *
 * What counts as text:
 * - the record name — for types whose names the game translates (`TRANSLATE: ALL | NAME` in `fcs.def`);
 * - string fields — the keys the game's official translation translates (`ru_RU.translation`):
 *   `description`, `textN` (lines) etc. Empty strings and strings without letters (`/INSULT/!`)
 *   have nothing to translate.
 *
 * The original's texts come from its own records: new records — all texts, changed
 * vanilla records — only the texts the mod changes (the rest is covered by the game's translation).
 *
 * A translation can be exported to CSV, JSON or gettext PO (for Poedit, like FCS; with the original) and loaded back. On load
 * a line whose original has changed since (the author updated the mod) is not applied — it goes into the report.
 */
import { decodeText, encodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import { EditError, type ModContext } from './context.ts';
import { applyLayer, isRemovalMarker, SCALAR_DICTS, scalarMap } from './record-ops.ts';
import type { ConflictLayer } from './conflicts.ts';
import { parsePo } from '../locale/po.ts';

/** Types whose record name the game translates (`fcs.def`, `TRANSLATE: ALL` or `NAME`). */
export const NAME_TRANSLATED_TYPES: ReadonlySet<string> = new Set([
  'ANIMAL_CHARACTER', 'BIOME_GROUP', 'CHARACTER', 'BUILDING',
  'ARMOUR', 'ARTIFACTS', 'CHARACTER_PHYSICS_ATTACHMENT', 'CONTAINER', 'CROSSBOW', 'FACTION', 'ITEM', 'NEST_ITEM',
  'ITEMS_CULTURE', 'LIMB_REPLACEMENT', 'LOCATIONAL_DAMAGE', 'MAP_ITEM', 'MATERIAL_SPECS_WEAPON',
  'NEW_GAME_STARTOFF', 'RACE', 'RACE_GROUP', 'RESEARCH', 'TOWN', 'WEAPON', 'WEAPON_MANUFACTURER',
]);

/** String fields translated by the game's official translation (`ru_RU.translation`). */
const TEXT_KEYS: ReadonlySet<string> = new Set([
  'description', 'Description', 'category', 'building category', 'building group', 'building name', 'string',
  'unexplored name', 'display name', 'company description', 'inventory content name', 'stringvar', 'difficulty', 'style',
]);
const TEXT_KEY_PATTERNS = [/^text\d+$/, /^rank\d+$/, /^negative rank\d+$/];

/** `field` of a text: `name` — the record name, otherwise the string field key. */
export const NAME_FIELD = 'name';

export function isTextKey(key: string): boolean {
  return TEXT_KEYS.has(key) || TEXT_KEY_PATTERNS.some((p) => p.test(key));
}

/** Whether there is anything to translate: letters outside tags like `/INSULT/`. */
export function hasTranslatableText(text: string): boolean {
  return /\p{L}/u.test(text.replace(/\/[A-Z_0-9]+\//g, ''));
}

/** Original text that needs translating. */
export interface TextEntry {
  /** String id of the record. */
  id: string;
  /** Record type (`ARMOUR`). */
  type: string;
  /** Record name in the original — a label for humans. */
  record: string;
  /** `name` or a string field key. */
  field: string;
  original: string;
}

/** Lower records (result of the layers below `index`) for a set of ids. */
function lowerRecords(layers: readonly ConflictLayer[], index: number, ids: ReadonlySet<string>): Map<string, GameRecord> {
  const out = new Map<string, GameRecord>();
  const dead = new Set<string>();
  for (let i = 0; i < index; i++) {
    for (const r of layers[i]!.file.records) {
      if (!ids.has(r.stringId)) continue;
      const next = applyLayer(dead.has(r.stringId) ? undefined : out.get(r.stringId), r);
      if (next) {
        out.set(r.stringId, next);
        dead.delete(r.stringId);
      } else {
        out.delete(r.stringId);
        dead.add(r.stringId);
      }
    }
  }
  return out;
}

/** Texts of layer record `rec` on top of `lower` (undefined — the record is new). */
function recordTexts(rec: GameRecord, lower: GameRecord | undefined): TextEntry[] {
  const type = itemTypeName(rec.type);
  const record = decodeText(rec.name);
  const out: TextEntry[] = [];
  if (NAME_TRANSLATED_TYPES.has(type) && hasTranslatableText(record) && (!lower || decodeText(lower.name) !== record)) {
    out.push({ id: rec.stringId, type, record, field: NAME_FIELD, original: record });
  }
  for (const [key, bytes] of rec.strings) {
    if (!isTextKey(key)) continue;
    const text = decodeText(bytes);
    if (!hasTranslatableText(text)) continue;
    const lo = lower?.strings.get(key);
    if (lo !== undefined && decodeText(lo) === text) continue;
    out.push({ id: rec.stringId, type, record, field: key, original: text });
  }
  return out;
}

/**
 * Texts of layer `source` (the original mod) in its record order. `layers` — layers in load
 * order, `source` among them (name compared case-insensitively).
 */
export function layerTexts(layers: readonly ConflictLayer[], source: string): TextEntry[] {
  const index = layers.findIndex((l) => l.name.toLowerCase() === source.toLowerCase());
  if (index < 0) throw new EditError({ en: `Mod ${source} is not among the layers`, ru: `Мода ${source} нет среди слоёв`, zh: `Mod ${source} 不在图层中` });
  const own = new Map<string, GameRecord>();
  for (const r of layers[index]!.file.records) own.set(r.stringId, r);
  const lower = lowerRecords(layers, index, new Set(own.keys()));
  const out: TextEntry[] = [];
  for (const rec of own.values()) {
    if (isRemovalMarker(rec)) continue;
    out.push(...recordTexts(rec, lower.get(rec.stringId)));
  }
  return out;
}

/** Translation state of a text: no translation / same as original / translated. */
export type TranslationStatus = 'todo' | 'same' | 'done';

export interface TranslationRow extends TextEntry {
  /** Text in the translation mod; undefined — the translation mod does not set the field. */
  translation?: string;
  status: TranslationStatus;
}

/** What the context mod (translation) sets for a record field; undefined — it does not set it. */
function modText(ctx: ModContext, id: string, field: string): string | undefined {
  const delta = ctx.delta(id);
  if (!delta || isRemovalMarker(delta)) return undefined;
  if (field === NAME_FIELD) {
    const name = decodeText(delta.name);
    const lower = ctx.lower(id);
    return lower && decodeText(lower.name) === name ? undefined : name;
  }
  const v = delta.strings.get(field);
  return v === undefined ? undefined : decodeText(v);
}

/**
 * Translation rows: texts of the original `source` (a context layer) and what the
 * edited mod (the translation mod) sets for them.
 */
export function translationRows(ctx: ModContext, source: string): TranslationRow[] {
  return layerTexts(ctx.layers, source).map((e) => {
    const translation = modText(ctx, e.id, e.field);
    const status: TranslationStatus = translation === undefined ? 'todo' : translation === e.original ? 'same' : 'done';
    return { ...e, ...(translation !== undefined ? { translation } : {}), status };
  });
}

export interface TranslationSummary {
  total: number;
  done: number;
  same: number;
  todo: number;
}

export function summarizeTranslation(rows: readonly TranslationRow[]): TranslationSummary {
  const s: TranslationSummary = { total: rows.length, done: 0, same: 0, todo: 0 };
  for (const r of rows) s[r.status]++;
  return s;
}

/** Extras in the translation mod: texts not from the originals and changes that are not texts. */
export interface TranslationExtras {
  /** Texts for records or fields absent from the originals (stale, or an id typo). */
  orphans: { id: string; field: string; text: string }[];
  /** Records where the translation mod changes more than texts (numbers, references, deletion). */
  nonText: { id: string; what: string }[];
}

/** Words of the translation check per interface language. */
const EXTRAS_WORDS: Record<string, { deletes: string; created: string; object: (key: string) => string }> = {
  en: { deletes: 'deletes the record', created: 'new record', object: (k) => `object ${k}` },
  ru: { deletes: 'удаляет запись', created: 'новая запись', object: (k) => `объект ${k}` },
  zh: { deletes: '删除该记录', created: '新记录', object: (k) => `对象 ${k}` },
};

/** Check a translation mod: is everything it sets a text of the originals `sources`. */
export function translationExtras(ctx: ModContext, sources: readonly string[], lang = 'en'): TranslationExtras {
  const w = EXTRAS_WORDS[lang] ?? EXTRAS_WORDS.en!;
  const known = new Set<string>();
  for (const s of sources) for (const e of layerTexts(ctx.layers, s)) known.add(`${e.id}\n${e.field}`);
  const out: TranslationExtras = { orphans: [], nonText: [] };
  for (const delta of ctx.modRecords()) {
    const id = delta.stringId;
    if (isRemovalMarker(delta)) {
      out.nonText.push({ id, what: w.deletes });
      continue;
    }
    const lower = ctx.lower(id);
    if (!lower) {
      out.nonText.push({ id, what: w.created });
      continue;
    }
    const name = modText(ctx, id, NAME_FIELD);
    if (name !== undefined && !known.has(`${id}\n${NAME_FIELD}`)) out.orphans.push({ id, field: NAME_FIELD, text: name });
    for (const [key, v] of delta.strings) {
      if (!known.has(`${id}\n${key}`)) {
        if (isTextKey(key)) out.orphans.push({ id, field: key, text: decodeText(v) });
        else out.nonText.push({ id, what: key });
      }
    }
    const other: string[] = [];
    for (const dict of SCALAR_DICTS) if (dict !== 'strings' && scalarMap(delta, dict).size > 0) other.push(...scalarMap(delta, dict).keys());
    for (const [cat, list] of delta.refs) if (list.length > 0) other.push(cat);
    for (const k of delta.instances.keys()) other.push(w.object(k));
    if (other.length > 0) out.nonText.push({ id, what: other.join(', ') });
  }
  return out;
}

/**
 * Set a field translation in the edited mod. Empty text or text equal to the original (lower
 * layers) removes the translation: the mod stops setting the field.
 */
export function setTranslation(ctx: ModContext, id: string, field: string, text: string): void {
  const lower = ctx.lower(id);
  if (!ctx.get(id)) throw new EditError({ en: `No record ${id}`, ru: `Записи ${id} нет`, zh: `没有记录 ${id}` });
  ctx.editRecord(id, (d) => {
    if (field === NAME_FIELD) {
      d.name = text === '' && lower ? lower.name : keep(text, lower?.name);
      return;
    }
    const lo = lower?.strings.get(field);
    if (text === '' || (lo !== undefined && decodeText(lo) === text)) {
      if (lo !== undefined) d.strings.set(field, lo);
      else if (text === '') d.strings.delete(field);
      else d.strings.set(field, encodeText(text));
    } else d.strings.set(field, encodeText(text));
  }, `перевод ${id}: ${field}`);
}

function keep(text: string, original: Uint8Array | undefined): Uint8Array {
  return original && decodeText(original) === text ? original : encodeText(text);
}

// ---------------------------------------------------------------- CSV and JSON files

/** Translation file row. `original` is the text that was translated (checked on load). */
export interface TranslationFileRow {
  id: string;
  field: string;
  type?: string;
  record?: string;
  original?: string;
  translation: string;
}

const CSV_COLUMNS = ['id', 'field', 'type', 'record', 'original', 'translation'] as const;

function csvCell(s: string): string {
  return /[",;\r\n\t]/.test(s) || s.trim() !== s ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV (UTF-8 with BOM so Excel shows Cyrillic; comma separator; CRLF line ends). */
export function formatTranslationCsv(rows: readonly TranslationRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push([r.id, r.field, r.type, r.record, r.original, r.translation ?? ''].map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export const TRANSLATION_JSON_FORMAT = 'kedit-translation';

export function formatTranslationJson(source: string, rows: readonly TranslationRow[]): string {
  const out = {
    format: TRANSLATION_JSON_FORMAT,
    version: 1,
    source,
    rows: rows.map((r) => ({ id: r.id, field: r.field, type: r.type, record: r.record, original: r.original, translation: r.translation ?? '' })),
  };
  return `${JSON.stringify(out, null, 1)}\n`;
}

function poString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/**
 * gettext PO for Poedit — like FCS translation files (`locale/Kenshi_translations.txt`). One entry
 * per row: `msgctxt` = "id|field" (load finds the text by it), `msgid` — the original,
 * `msgstr` — the translation (empty — not translated). The mod's original is in the `X-Kedit-Source` header.
 */
export function formatTranslationPo(source: string, rows: readonly TranslationRow[]): string {
  const out = [
    'msgid ""',
    'msgstr ""',
    poString('MIME-Version: 1.0\n'),
    poString('Content-Type: text/plain; charset=UTF-8\n'),
    poString('Content-Transfer-Encoding: 8bit\n'),
    poString('X-Generator: Cactus\n'),
    poString(`X-Kedit-Source: ${source}\n`),
    '',
  ];
  for (const r of rows) {
    out.push(`#. Type: ${r.type}`, `#. Name: ${r.record.replace(/\r?\n/g, ' ')}`, `#. Field: ${r.field}`, `#: ${r.id}`);
    out.push(`msgctxt ${poString(`${r.id}|${r.field}`)}`, `msgid ${poString(r.original)}`, `msgstr ${poString(r.translation ?? '')}`, '');
  }
  return out.join('\n');
}

function parseTranslationPo(text: string): ParsedTranslationFile {
  const po = parsePo(text);
  const rows: TranslationFileRow[] = [];
  for (const e of po.entries) {
    if (e.obsolete || e.msgctxt === undefined) continue;
    const bar = e.msgctxt.lastIndexOf('|');
    if (bar <= 0) continue;
    rows.push({ id: e.msgctxt.slice(0, bar), field: e.msgctxt.slice(bar + 1), original: e.msgid, translation: e.msgstr[0] ?? '' });
  }
  if (rows.length === 0 && po.entries.length > 0) throw new EditError({ en: 'Translation file: the PO has no entries with msgctxt “id|field” — it is not an editor export', ru: 'Файл перевода: в PO нет строк с msgctxt «id|поле» — это не выгрузка редактора', zh: '翻译文件：PO 中没有 msgctxt 为 “id|字段” 的条目——这不是编辑器导出的文件' });
  const source = po.headers.get('X-Kedit-Source');
  return { ...(source ? { source } : {}), rows };
}

/** CSV parsing: quotes per RFC 4180, separator taken from the header row (`,` `;` or tab). */
export function parseCsv(text: string): string[][] {
  const s = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const firstLine = s.slice(0, s.search(/\r?\n|$/));
  const sep = [',', ';', '\t'].map((c) => ({ c, n: firstLine.split(c).length })).sort((a, b) => b.n - a.n)[0]!.c;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (ch === '\r' && s[i + 1] === '\n') i++;
    } else cell += ch;
    i++;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface ParsedTranslationFile {
  /** Original from JSON (not written to CSV). */
  source?: string;
  rows: TranslationFileRow[];
}

/** Translation file: JSON (`kedit-translation`), PO (editor export) or CSV with columns `id`, `field`, `translation` (and `original`). */
export function parseTranslationFile(text: string): ParsedTranslationFile {
  const t = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (t.trimStart().startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch (e) {
      throw new EditError({ en: `Translation file: invalid JSON (${(e as Error).message})`, ru: `Файл перевода: неверный JSON (${(e as Error).message})`, zh: `翻译文件：无效的 JSON（${(e as Error).message}）` }, { cause: e });
    }
    const d = data as { format?: unknown; source?: unknown; rows?: unknown };
    if (d.format !== TRANSLATION_JSON_FORMAT || !Array.isArray(d.rows)) throw new EditError({ en: `Translation file: expected JSON with format "${TRANSLATION_JSON_FORMAT}" and rows`, ru: `Файл перевода: ожидался JSON с format "${TRANSLATION_JSON_FORMAT}" и rows`, zh: `翻译文件：应为含 format "${TRANSLATION_JSON_FORMAT}" 和 rows 的 JSON` });
    const rows: TranslationFileRow[] = [];
    for (const [n, x] of (d.rows as unknown[]).entries()) {
      const r = x as Record<string, unknown>;
      if (typeof r['id'] !== 'string' || typeof r['field'] !== 'string' || typeof r['translation'] !== 'string') {
        throw new EditError({ en: `Translation file: row ${n + 1} has no id, field or translation`, ru: `Файл перевода: строка ${n + 1} без id, field или translation`, zh: `翻译文件：第 ${n + 1} 行缺少 id、field 或 translation` });
      }
      const row: TranslationFileRow = { id: r['id'], field: r['field'], translation: r['translation'] };
      if (typeof r['original'] === 'string') row.original = r['original'];
      if (typeof r['type'] === 'string') row.type = r['type'];
      if (typeof r['record'] === 'string') row.record = r['record'];
      rows.push(row);
    }
    return { ...(typeof d.source === 'string' ? { source: d.source } : {}), rows };
  }
  if (/^msgid\s/m.test(t)) return parseTranslationPo(t);
  const table = parseCsv(t);
  const head = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string): number => head.indexOf(name);
  const [ci, cf, ct] = [col('id'), col('field'), col('translation')];
  if (ci < 0 || cf < 0 || ct < 0) throw new EditError({ en: 'Translation file: the CSV needs columns id, field and translation', ru: 'Файл перевода: в CSV нужны колонки id, field и translation', zh: '翻译文件：CSV 需要 id、field 和 translation 列' });
  const co = col('original');
  const cty = col('type');
  const cr = col('record');
  return {
    rows: table.slice(1).map((r) => {
      const row: TranslationFileRow = { id: r[ci] ?? '', field: r[cf] ?? '', translation: r[ct] ?? '' };
      if (co >= 0 && r[co] !== undefined) row.original = r[co];
      if (cty >= 0 && r[cty] !== undefined) row.type = r[cty];
      if (cr >= 0 && r[cr] !== undefined) row.record = r[cr];
      return row;
    }),
  };
}

export interface ApplyTranslationReport {
  /** New or changed translations set. */
  applied: number;
  /** Translation already the same. */
  unchanged: number;
  /** Empty translation — skipped. */
  empty: number;
  /** The original changed since translation: not applied (with `applyStale` — applied). */
  stale: { id: string; field: string; was: string; now: string }[];
  /** No such record or field in the original. */
  unknown: { id: string; field: string }[];
}

/**
 * Load a translation from a file into the edited mod (one edit — one undo). Rows are checked
 * against the texts of the original `source`: foreign ids and fields are skipped, rows whose original
 * changed are not applied without `applyStale`.
 */
export function applyTranslationRows(ctx: ModContext, source: string, rows: readonly TranslationFileRow[], options: { applyStale?: boolean } = {}): ApplyTranslationReport {
  const texts = new Map(translationRows(ctx, source).map((r) => [`${r.id}\n${r.field}`, r]));
  const report: ApplyTranslationReport = { applied: 0, unchanged: 0, empty: 0, stale: [], unknown: [] };
  ctx.transaction(`перевод из файла (${rows.length})`, () => {
    for (const r of rows) {
      const cur = texts.get(`${r.id}\n${r.field}`);
      if (!cur) {
        report.unknown.push({ id: r.id, field: r.field });
        continue;
      }
      if (r.translation === '') {
        report.empty++;
        continue;
      }
      if (r.original !== undefined && r.original !== cur.original) {
        report.stale.push({ id: r.id, field: r.field, was: r.original, now: cur.original });
        if (!options.applyStale) continue;
      }
      if (cur.translation === r.translation) {
        report.unchanged++;
        continue;
      }
      setTranslation(ctx, r.id, r.field, r.translation);
      report.applied++;
    }
    if (report.applied > 0) ensureTranslationDependency(ctx, source);
  });
  return report;
}

/**
 * A translation mod depends on the original (in the header): the launcher requires the original and puts
 * the translation after it, otherwise the original would override the translation. Returns true if the dependency was added.
 */
export function ensureTranslationDependency(ctx: ModContext, source: string): boolean {
  const deps = ctx.info.dependencies;
  if (deps.some((d) => d.toLowerCase() === source.toLowerCase())) return false;
  ctx.setModInfo({ dependencies: [...deps, source] });
  return true;
}

/** Words of the translation import report per interface language. */
const REPORT_WORDS: Record<string, { head: (applied: number, same: number, empty: number, stale: number, unknown: number) => string; stale: (what: string, was: string, now: string) => string; unknown: string }> = {
  en: {
    head: (a, s, e, st, u) => `applied ${a}, unchanged ${s}, empty ${e}, original changed ${st}, not in the original ${u}`,
    stale: (x, a, b) => `original changed ${x}: was ${a} → now ${b}`,
    unknown: 'not in the original:',
  },
  ru: {
    head: (a, s, e, st, u) => `применено ${a}, без изменений ${s}, пустых ${e}, оригинал изменился ${st}, нет в оригинале ${u}`,
    stale: (x, a, b) => `изменился оригинал ${x}: было ${a} → стало ${b}`,
    unknown: 'нет в оригинале:',
  },
  zh: {
    head: (a, s, e, st, u) => `已应用 ${a}，未更改 ${s}，空 ${e}，原文已更改 ${st}，原文中不存在 ${u}`,
    stale: (x, a, b) => `原文已更改 ${x}：原为 ${a} → 现为 ${b}`,
    unknown: '原文中不存在：',
  },
};

/** Load report as text. */
export function formatApplyReport(r: ApplyTranslationReport, lang = 'en'): string[] {
  const w = REPORT_WORDS[lang] ?? REPORT_WORDS.en!;
  const lines = [w.head(r.applied, r.unchanged, r.empty, r.stale.length, r.unknown.length)];
  for (const s of r.stale.slice(0, 20)) lines.push(`  ${w.stale(`${s.id} ${s.field}`, JSON.stringify(s.was), JSON.stringify(s.now))}`);
  for (const u of r.unknown.slice(0, 20)) lines.push(`  ${w.unknown} ${u.id} ${u.field}`);
  return lines;
}
