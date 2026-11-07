/**
 * Помощник перевода модов. Мод-перевод — отдельный мод, который зависит от оригинала, грузится
 * после него и задаёт поверх только тексты: имена записей и текстовые строковые поля. Так
 * устроены «RUS»-патчи мастерской (например, «Expanded Vanilla Armor RUS»).
 *
 * Что считается текстом:
 * - имя записи — у типов, чьи имена переводит игра (`TRANSLATE: ALL | NAME` в `fcs.def`);
 * - строковые поля — те ключи, что переводит официальный перевод игры (`ru_RU.translation`):
 *   `description`, `textN` (реплики) и т. д. Пустые строки и строки без букв (`/INSULT/!`)
 *   переводить нечего.
 *
 * Тексты оригинала берутся из его собственных записей: новые записи — все тексты, изменённые
 * записи ванили — только тексты, которые мод меняет (остальное переводит перевод игры).
 *
 * Перевод можно выгрузить в CSV, JSON или gettext PO (для Poedit, как у FCS; с оригиналом) и загрузить обратно. При загрузке
 * строка, чей оригинал с тех пор изменился (автор обновил мод), не применяется — она в отчёте.
 */
import { decodeText, encodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import { EditError, type ModContext } from './context.ts';
import { applyLayer, isRemovalMarker, SCALAR_DICTS, scalarMap } from './record-ops.ts';
import type { ConflictLayer } from './conflicts.ts';
import { parsePo } from '../locale/po.ts';

/** Типы, у которых игра переводит имя записи (`fcs.def`, `TRANSLATE: ALL` или `NAME`). */
export const NAME_TRANSLATED_TYPES: ReadonlySet<string> = new Set([
  'ANIMAL_CHARACTER', 'BIOME_GROUP', 'CHARACTER', 'BUILDING',
  'ARMOUR', 'ARTIFACTS', 'CHARACTER_PHYSICS_ATTACHMENT', 'CONTAINER', 'CROSSBOW', 'FACTION', 'ITEM', 'NEST_ITEM',
  'ITEMS_CULTURE', 'LIMB_REPLACEMENT', 'LOCATIONAL_DAMAGE', 'MAP_ITEM', 'MATERIAL_SPECS_WEAPON',
  'NEW_GAME_STARTOFF', 'RACE', 'RACE_GROUP', 'RESEARCH', 'TOWN', 'WEAPON', 'WEAPON_MANUFACTURER',
]);

/** Строковые поля, которые переводит официальный перевод игры (`ru_RU.translation`). */
const TEXT_KEYS: ReadonlySet<string> = new Set([
  'description', 'Description', 'category', 'building category', 'building group', 'building name', 'string',
  'unexplored name', 'display name', 'company description', 'inventory content name', 'stringvar', 'difficulty', 'style',
]);
const TEXT_KEY_PATTERNS = [/^text\d+$/, /^rank\d+$/, /^negative rank\d+$/];

/** Поле `field` у текста: `name` — имя записи, иначе ключ строкового поля. */
export const NAME_FIELD = 'name';

export function isTextKey(key: string): boolean {
  return TEXT_KEYS.has(key) || TEXT_KEY_PATTERNS.some((p) => p.test(key));
}

/** Есть ли что переводить: буквы вне тегов вида `/INSULT/`. */
export function hasTranslatableText(text: string): boolean {
  return /\p{L}/u.test(text.replace(/\/[A-Z_0-9]+\//g, ''));
}

/** Текст оригинала, который нужно перевести. */
export interface TextEntry {
  /** Строковый id записи. */
  id: string;
  /** Тип записи (`ARMOUR`). */
  type: string;
  /** Имя записи в оригинале — подпись для людей. */
  record: string;
  /** `name` или ключ строкового поля. */
  field: string;
  original: string;
}

/** Нижние записи (итог слоёв ниже `index`) для набора id. */
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

/** Тексты записи `rec` слоя поверх `lower` (undefined — запись новая). */
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
 * Тексты слоя `source` (мода-оригинала) по порядку его записей. `layers` — слои по порядку
 * загрузки, `source` среди них (имя без учёта регистра).
 */
export function layerTexts(layers: readonly ConflictLayer[], source: string): TextEntry[] {
  const index = layers.findIndex((l) => l.name.toLowerCase() === source.toLowerCase());
  if (index < 0) throw new EditError(`Мода ${source} нет среди слоёв`);
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

/** Состояние перевода текста: нет перевода / как в оригинале / переведено. */
export type TranslationStatus = 'todo' | 'same' | 'done';

export interface TranslationRow extends TextEntry {
  /** Текст в моде-переводе; undefined — мод-перевод поле не задаёт. */
  translation?: string;
  status: TranslationStatus;
}

/** Что мод контекста (перевод) задаёт для поля записи; undefined — не задаёт. */
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
 * Строки перевода: тексты оригинала `source` (слой контекста) и что задаёт для них
 * редактируемый мод (мод-перевод).
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

/** Лишнее в моде-переводе: тексты не из оригиналов и изменения, которые не тексты. */
export interface TranslationExtras {
  /** Тексты для записей или полей, которых в оригиналах нет (устарели или опечатка в id). */
  orphans: { id: string; field: string; text: string }[];
  /** Записи, в которых мод-перевод меняет не только тексты (числа, ссылки, удаление). */
  nonText: { id: string; what: string }[];
}

/** Проверка мода-перевода: всё ли, что он задаёт, — тексты оригиналов `sources`. */
export function translationExtras(ctx: ModContext, sources: readonly string[]): TranslationExtras {
  const known = new Set<string>();
  for (const s of sources) for (const e of layerTexts(ctx.layers, s)) known.add(`${e.id}\n${e.field}`);
  const out: TranslationExtras = { orphans: [], nonText: [] };
  for (const delta of ctx.modRecords()) {
    const id = delta.stringId;
    if (isRemovalMarker(delta)) {
      out.nonText.push({ id, what: 'удаляет запись' });
      continue;
    }
    const lower = ctx.lower(id);
    if (!lower) {
      out.nonText.push({ id, what: 'новая запись' });
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
    for (const k of delta.instances.keys()) other.push(`объект ${k}`);
    if (other.length > 0) out.nonText.push({ id, what: other.join(', ') });
  }
  return out;
}

/**
 * Поставить перевод поля в редактируемый мод. Пустой текст или текст как в оригинале (нижних
 * слоях) — убрать перевод: мод перестаёт задавать поле.
 */
export function setTranslation(ctx: ModContext, id: string, field: string, text: string): void {
  const lower = ctx.lower(id);
  if (!ctx.get(id)) throw new EditError(`Записи ${id} нет`);
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

// ---------------------------------------------------------------- файлы CSV и JSON

/** Строка файла перевода. `original` — текст, с которого переводили (для проверки при загрузке). */
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

/** CSV (UTF-8 с BOM — чтобы Excel показал кириллицу; разделитель — запятая; концы строк CRLF). */
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
 * gettext PO для Poedit — как файлы перевода FCS (`locale/Kenshi_translations.txt`). Строка —
 * запись: `msgctxt` = «id|поле» (по нему загрузка находит текст), `msgid` — оригинал,
 * `msgstr` — перевод (пусто — не переведено). Оригинал мода — в заголовке `X-Kedit-Source`.
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
  if (rows.length === 0 && po.entries.length > 0) throw new EditError('Файл перевода: в PO нет строк с msgctxt «id|поле» — это не выгрузка редактора');
  const source = po.headers.get('X-Kedit-Source');
  return { ...(source ? { source } : {}), rows };
}

/** Разбор CSV: кавычки по RFC 4180, разделитель — из строки заголовка (`,` `;` или табуляция). */
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
  /** Оригинал из JSON (в CSV не пишется). */
  source?: string;
  rows: TranslationFileRow[];
}

/** Файл перевода: JSON (`kedit-translation`), PO (выгрузка редактора) или CSV с колонками `id`, `field`, `translation` (и `original`). */
export function parseTranslationFile(text: string): ParsedTranslationFile {
  const t = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (t.trimStart().startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch (e) {
      throw new EditError(`Файл перевода: неверный JSON (${(e as Error).message})`, { cause: e });
    }
    const d = data as { format?: unknown; source?: unknown; rows?: unknown };
    if (d.format !== TRANSLATION_JSON_FORMAT || !Array.isArray(d.rows)) throw new EditError(`Файл перевода: ожидался JSON с format "${TRANSLATION_JSON_FORMAT}" и rows`);
    const rows: TranslationFileRow[] = [];
    for (const [n, x] of (d.rows as unknown[]).entries()) {
      const r = x as Record<string, unknown>;
      if (typeof r['id'] !== 'string' || typeof r['field'] !== 'string' || typeof r['translation'] !== 'string') {
        throw new EditError(`Файл перевода: строка ${n + 1} без id, field или translation`);
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
  if (ci < 0 || cf < 0 || ct < 0) throw new EditError('Файл перевода: в CSV нужны колонки id, field и translation');
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
  /** Поставлено новых или изменённых переводов. */
  applied: number;
  /** Перевод уже такой же. */
  unchanged: number;
  /** Пустой перевод — пропущено. */
  empty: number;
  /** Оригинал изменился с тех пор, как переводили: не применено (с `applyStale` — применено). */
  stale: { id: string; field: string; was: string; now: string }[];
  /** Таких записи или поля в оригинале нет. */
  unknown: { id: string; field: string }[];
}

/**
 * Загрузить перевод из файла в редактируемый мод (одна правка — одна отмена). Строки сверяются
 * с текстами оригинала `source`: чужие id и поля пропускаются, строки с изменившимся оригиналом
 * не применяются без `applyStale`.
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
 * Мод-перевод зависит от оригинала (в заголовке): лаунчер требует оригинал и ставит перевод
 * после него, иначе перевод перекроется оригиналом. Возвращает true, если зависимость добавлена.
 */
export function ensureTranslationDependency(ctx: ModContext, source: string): boolean {
  const deps = ctx.info.dependencies;
  if (deps.some((d) => d.toLowerCase() === source.toLowerCase())) return false;
  ctx.setModInfo({ dependencies: [...deps, source] });
  return true;
}

/** Отчёт загрузки текстом. */
export function formatApplyReport(r: ApplyTranslationReport): string[] {
  const lines = [`применено ${r.applied}, без изменений ${r.unchanged}, пустых ${r.empty}, оригинал изменился ${r.stale.length}, нет в оригинале ${r.unknown.length}`];
  for (const s of r.stale.slice(0, 20)) lines.push(`  изменился оригинал ${s.id} ${s.field}: было ${JSON.stringify(s.was)} → стало ${JSON.stringify(s.now)}`);
  for (const u of r.unknown.slice(0, 20)) lines.push(`  нет в оригинале: ${u.id} ${u.field}`);
  return lines;
}
