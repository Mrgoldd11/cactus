/**
 * Конфликты модов: какие слои (моды) меняют одну и ту же запись и одно и то же поле
 * разными значениями. Побеждает поздний слой (ниже в `mods.cfg`), как в игре.
 *
 * «Поле» здесь — то, что накладывается по ключу (см. `record-ops.ts`):
 * - `record` — удаление записи (булево `REMOVED`);
 * - `name` — имя записи (берётся из последнего слоя);
 * - `scalar` — скалярное поле `dict:key`;
 * - `ref` — ссылка на цель в категории (значения или «удалить»);
 * - `instance` — размещённый объект по ключу.
 *
 * Два мода, добавляющие разные ссылки в одну категорию, не конфликтуют: обе ссылки
 * останутся. Конфликт — когда два слоя задают одно поле по-разному, и победит только один.
 * Если один мод удаляет запись, а другой её меняет, — конфликт уровня записи.
 */
import { decodeText } from '../text.ts';
import type { GameRecord, Instance } from '../format/types.ts';
import { isVanillaLayer } from '../vanilla.ts';
import { applyLayer, isRemovalMarker, isRemovedRef, SCALAR_DICTS, scalarMap, type ScalarDict } from './record-ops.ts';
import { formatFloat, formatRefValues, formatScalar } from './present.ts';
import type { ModContext } from './context.ts';

/** Слой для поиска конфликтов: имя и записи (подходит `Layer`). */
export interface ConflictLayer {
  name: string;
  file: { records: readonly GameRecord[] };
}

export type ConflictFieldKind = 'record' | 'name' | 'scalar' | 'ref' | 'instance';

/** Какое поле: ключ `id` уникален в пределах записи. */
export interface FieldRef {
  /** `record`, `name`, `floats:cut damage multiplier`, `ref:<категория>:<цель>`, `inst:<ключ>`. */
  id: string;
  kind: ConflictFieldKind;
  dict?: ScalarDict;
  key?: string;
  category?: string;
  target?: string;
}

/** Поле, которое задаёт слой, и его значение текстом. */
export interface FieldTouch extends FieldRef {
  value: string;
}

/** Что делает с записью один слой. */
export interface LayerTouch {
  layer: string;
  /** Слой удаляет запись. */
  removes: boolean;
  /** Записи до этого слоя не было (слой её создаёт). */
  creates: boolean;
  fields: FieldTouch[];
}

export interface FieldConflict extends FieldRef {
  /** Значение в базовых слоях (ванили); нет — поля в ванили нет. */
  base?: string;
  /** Значения слоёв, которые задают поле, по порядку загрузки. */
  values: { layer: string; value: string }[];
  /** Слой, чьё значение будет в игре (последний). */
  winner: string;
}

export interface RecordConflict {
  sid: string;
  type: number;
  name: string;
  /** Небазовые слои, которые трогают запись, по порядку загрузки. */
  layers: string[];
  fields: FieldConflict[];
}

export interface ConflictOptions {
  /** Базовый слой (ваниль): его значения не считаются «изменением». По умолчанию — `isVanillaLayer`. */
  isBase?: (name: string) => boolean;
  /** Только конфликты, в которых участвует этот слой (имя без учёта регистра). */
  only?: string;
}

// Value keys of conflicts stay Russian (the window maps them per language; see conflictValue).
const REMOVE_TEXT = 'удалить';
const CHANGE_TEXT = 'изменить';

function formatInstance(i: Instance): string {
  return `${i.target} (${i.position.map(formatFloat).join(', ')}) rot (${i.rotation.map(formatFloat).join(', ')})${i.states.length ? ` states ${i.states.length}` : ''}`;
}

/**
 * Поля, которые слой `rec` задаёт поверх записи `below` (undefined — записи ниже нет).
 * Маркеры удаления ссылок для несуществующей записи ничего не значат и не считаются.
 */
export function layerFields(rec: GameRecord, below: GameRecord | undefined): FieldTouch[] {
  if (isRemovalMarker(rec)) return [{ id: 'record', kind: 'record', value: REMOVE_TEXT }];
  const out: FieldTouch[] = [];
  const name = decodeText(rec.name);
  if (!below || decodeText(below.name) !== name) out.push({ id: 'name', kind: 'name', value: JSON.stringify(name) });
  for (const dict of SCALAR_DICTS) {
    for (const [key, v] of scalarMap(rec, dict)) out.push({ id: `${dict}:${key}`, kind: 'scalar', dict, key, value: formatScalar(dict, v) });
  }
  for (const [category, list] of rec.refs) {
    for (const r of list) {
      if (isRemovedRef(r) && !below) continue;
      out.push({ id: `ref:${category}:${r.target}`, kind: 'ref', category, target: r.target, value: formatRefValues(r, 'ru') });
    }
  }
  for (const [key, inst] of rec.instances) out.push({ id: `inst:${key}`, kind: 'instance', key, value: formatInstance(inst) });
  return out;
}

/** Значение поля в записи текстом; undefined — поля нет. */
export function fieldValue(rec: GameRecord | undefined, f: FieldRef): string | undefined {
  if (!rec) return f.kind === 'record' ? 'нет записи' : undefined;
  switch (f.kind) {
    case 'record':
      return 'есть';
    case 'name':
      return JSON.stringify(decodeText(rec.name));
    case 'scalar': {
      const v = scalarMap(rec, f.dict!).get(f.key!);
      return v === undefined ? undefined : formatScalar(f.dict!, v);
    }
    case 'ref': {
      const r = rec.refs.get(f.category!)?.find((x) => x.target === f.target);
      return r ? formatRefValues(r, 'ru') : undefined;
    }
    case 'instance': {
      const i = rec.instances.get(f.key!);
      return i ? formatInstance(i) : undefined;
    }
  }
}

function strip(f: FieldTouch): FieldRef {
  const ref: FieldRef = { id: f.id, kind: f.kind };
  if (f.dict !== undefined) ref.dict = f.dict;
  if (f.key !== undefined) ref.key = f.key;
  if (f.category !== undefined) ref.category = f.category;
  if (f.target !== undefined) ref.target = f.target;
  return ref;
}

interface Entry {
  layer: string;
  rec: GameRecord;
}

/** Поиск по нескольким записям: индекс небазовых и базовых записей по sid. */
function indexLayers(layers: readonly ConflictLayer[], isBase: (name: string) => boolean, want?: ReadonlySet<string>): { base: Map<string, Entry[]>; mods: Map<string, Entry[]> } {
  const base = new Map<string, Entry[]>();
  const mods = new Map<string, Entry[]>();
  for (const layer of layers) {
    const into = isBase(layer.name) ? base : mods;
    for (const rec of layer.file.records) {
      if (want && !want.has(rec.stringId)) continue;
      let list = into.get(rec.stringId);
      if (!list) into.set(rec.stringId, (list = []));
      list.push({ layer: layer.name, rec });
    }
  }
  return { base, mods };
}

function fold(entries: readonly Entry[] | undefined): GameRecord | undefined {
  let acc: GameRecord | undefined;
  for (const e of entries ?? []) acc = applyLayer(acc, e.rec);
  return acc;
}

/** Что каждый небазовый слой делает с записью. `below` у каждого слоя — итог всех слоёв ниже. */
function touchesOf(baseRec: GameRecord | undefined, mods: readonly Entry[]): LayerTouch[] {
  let acc = baseRec;
  return mods.map((e) => {
    const fields = layerFields(e.rec, acc);
    const t: LayerTouch = { layer: e.layer, removes: isRemovalMarker(e.rec), creates: acc === undefined && !isRemovalMarker(e.rec), fields };
    acc = applyLayer(acc, e.rec);
    return t;
  });
}

export interface TouchReport {
  sid: string;
  /** Запись в базовых слоях (ванили); нет — запись создают моды. */
  base?: GameRecord;
  /** Небазовые слои, которые задают запись, по порядку загрузки. */
  touches: LayerTouch[];
}

/** Кто (какие небазовые слои) трогает запись и что именно задаёт. */
export function touchedBy(layers: readonly ConflictLayer[], sid: string, options: Pick<ConflictOptions, 'isBase'> = {}): TouchReport {
  const isBase = options.isBase ?? isVanillaLayer;
  const { base, mods } = indexLayers(layers, isBase, new Set([sid]));
  const baseRec = fold(base.get(sid));
  return { sid, ...(baseRec ? { base: baseRec } : {}), touches: touchesOf(baseRec, mods.get(sid) ?? []) };
}

/** Конфликты одной записи по отчёту `touchedBy`; пусто — конфликтов нет. */
export function recordConflicts(report: TouchReport): FieldConflict[] {
  const { touches, base } = report;
  if (touches.length < 2) return [];
  const out: FieldConflict[] = [];
  // Удаление против изменения.
  if (touches.some((t) => t.removes) && touches.some((t) => !t.removes)) {
    const values = touches.map((t) => ({ layer: t.layer, value: t.removes ? REMOVE_TEXT : CHANGE_TEXT }));
    out.push({ id: 'record', kind: 'record', base: fieldValue(base, { id: 'record', kind: 'record' })!, values, winner: values.at(-1)!.layer });
  }
  const byField = new Map<string, { ref: FieldRef; values: { layer: string; value: string }[] }>();
  for (const t of touches) {
    for (const f of t.fields) {
      if (f.kind === 'record') continue;
      let g = byField.get(f.id);
      if (!g) byField.set(f.id, (g = { ref: strip(f), values: [] }));
      g.values.push({ layer: t.layer, value: f.value });
    }
  }
  for (const { ref, values } of byField.values()) {
    if (values.length < 2 || new Set(values.map((v) => v.value)).size < 2) continue;
    const b = fieldValue(base, ref);
    out.push({ ...ref, ...(b !== undefined ? { base: b } : {}), values, winner: values.at(-1)!.layer });
  }
  return out;
}

function headline(entries: readonly Entry[]): { type: number; name: string } {
  const live = [...entries].reverse().find((e) => !isRemovalMarker(e.rec)) ?? entries.at(-1)!;
  return { type: live.rec.type, name: decodeText(live.rec.name) };
}

/**
 * Все конфликты между небазовыми слоями. Порядок — по первому появлению записи в модах.
 * С `only` — только записи, которые трогает этот слой, и только поля, которые он задаёт.
 */
export function findConflicts(layers: readonly ConflictLayer[], options: ConflictOptions = {}): RecordConflict[] {
  const isBase = options.isBase ?? isVanillaLayer;
  const only = options.only?.toLowerCase();
  const { mods } = indexLayers(layers.filter((l) => !isBase(l.name)), () => false);
  const candidates = new Set<string>();
  for (const [sid, list] of mods) {
    if (list.length < 2) continue;
    if (only !== undefined && !list.some((e) => e.layer.toLowerCase() === only)) continue;
    candidates.add(sid);
  }
  if (candidates.size === 0) return [];
  const { base } = indexLayers(
    layers.filter((l) => isBase(l.name)),
    () => true,
    candidates,
  );
  const out: RecordConflict[] = [];
  for (const sid of candidates) {
    const entries = mods.get(sid)!;
    const baseRec = fold(base.get(sid));
    let fields = recordConflicts({ sid, ...(baseRec ? { base: baseRec } : {}), touches: touchesOf(baseRec, entries) });
    if (only !== undefined) fields = fields.filter((f) => f.values.some((v) => v.layer.toLowerCase() === only));
    if (fields.length === 0) continue;
    out.push({ sid, ...headline(entries), layers: entries.map((e) => e.layer), fields });
  }
  return out;
}

/** Слои контекста для поиска конфликтов: нижние слои и сам мод (его записи как есть сейчас). */
export function contextLayers(ctx: ModContext): ConflictLayer[] {
  const records = ctx.modRecords();
  return records.length > 0 ? [...ctx.layers, { name: ctx.modName, file: { records } }] : [...ctx.layers];
}

/** Words of the conflict texts in one interface language. */
interface ConflictWords {
  wholeRecord: string;
  name: string;
  object: (key: string) => string;
  mods: (n: number, list: string) => string;
  vanilla: (v: string) => string;
  wins: (layer: string) => string;
  removes: string;
  creates: string;
}

const CONFLICT_WORDS: Record<string, ConflictWords> = {
  en: { wholeRecord: 'whole record', name: 'name', object: (k) => `object ${k}`, mods: (n, l) => `mods: ${n} (${l})`, vanilla: (v) => ` (vanilla ${v})`, wins: (l) => `wins ${l}`, removes: ' — DELETES the record', creates: ' — creates the record' },
  ru: { wholeRecord: 'запись целиком', name: 'имя', object: (k) => `объект ${k}`, mods: (n, l) => `модов: ${n} (${l})`, vanilla: (v) => ` (ваниль ${v})`, wins: (l) => `победит ${l}`, removes: ' — УДАЛЯЕТ запись', creates: ' — создаёт запись' },
  zh: { wholeRecord: '整条记录', name: '名称', object: (k) => `对象 ${k}`, mods: (n, l) => `Mod：${n}（${l}）`, vanilla: (v) => `（原版 ${v}）`, wins: (l) => `生效：${l}`, removes: ' — 删除该记录', creates: ' — 创建该记录' },
};
const conflictWords = (lang: string): ConflictWords => CONFLICT_WORDS[lang] ?? CONFLICT_WORDS.en!;

/** Подпись поля для людей: `cut damage multiplier`, `<категория> → <цель>`, `объект <ключ>`. */
export function fieldLabel(f: FieldRef, nameOf: (sid: string) => string = (s) => s, lang = 'en'): string {
  const w = conflictWords(lang);
  switch (f.kind) {
    case 'record':
      return w.wholeRecord;
    case 'name':
      return w.name;
    case 'scalar':
      return f.key!;
    case 'ref':
      return `${f.category} → ${nameOf(f.target!)}`;
    case 'instance':
      return w.object(f.key!);
  }
}

/** Конфликт записи текстом для CLI/MCP. */
export function formatConflict(c: RecordConflict, nameOf?: (sid: string) => string, lang = 'en'): string[] {
  const w = conflictWords(lang);
  const lines = [`${c.sid} «${c.name}» — ${w.mods(c.layers.length, c.layers.join(', '))}`];
  for (const f of c.fields) {
    lines.push(`  ${fieldLabel(f, nameOf, lang)}${f.base !== undefined ? w.vanilla(f.base) : ''}: ${w.wins(f.winner)}`);
    for (const v of f.values) lines.push(`    ${v.layer === f.winner ? '→' : ' '} ${v.layer}: ${v.value}`);
  }
  return lines;
}

/** Отчёт `touchedBy` текстом для CLI/MCP. */
export function formatTouches(r: TouchReport, nameOf?: (sid: string) => string, lang = 'en'): string[] {
  const w = conflictWords(lang);
  const lines: string[] = [];
  for (const t of r.touches) {
    lines.push(`  ${t.layer}${t.removes ? w.removes : t.creates ? w.creates : ''}`);
    if (t.removes) continue;
    for (const f of t.fields) lines.push(`    ${fieldLabel(f, nameOf, lang)} = ${f.value}`);
  }
  return lines;
}
