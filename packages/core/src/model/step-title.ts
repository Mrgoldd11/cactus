/**
 * Понятные названия шагов истории (кружочки ↶ ↷, панель «История»): «Изменён текст реплики
 * „Бип победил…“», «Добавлен ответ игрока», «Удалена связь». Название строится по метке
 * транзакции и по тому, что правка на самом деле поменяла (разница записей до и после), сразу
 * на двух языках. Метки остаются прежними строками — API ядра не меняется.
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import { translatedText, type TranslationIndex } from '../locale/translation.ts';
import type { Changeset, ModContext } from './context.ts';
import type { RecordDiff } from './diff.ts';
import { changesetDiff, formatScalar } from './present.ts';

export interface StepTitle {
  ru: string;
  en: string;
  /** Правка пришла от ИИ (живая связь MCP). */
  ai: boolean;
  /** Откат другой правки. */
  rollback: boolean;
}

export interface StepTitleOptions {
  /** Перевод реплик игры: русское название шага цитирует русский текст реплики. */
  translation?: TranslationIndex;
}

const AI_PREFIX = 'ИИ: ';
const ROLLBACK_PREFIX = 'откат: ';
const LINE = 'DIALOGUE_LINE';
const QUOTE_MAX = 32;

interface Pair {
  ru: string;
  en: string;
}

function short(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > QUOTE_MAX ? `${one.slice(0, QUOTE_MAX - 1).trimEnd()}…` : one;
}

function quote(s: string): string {
  return s === '' ? '' : ` „${short(s)}“`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

class Describer {
  private readonly ctx: ModContext;
  private readonly diffs: RecordDiff[];
  private readonly options: StepTitleOptions;

  constructor(ctx: ModContext, diffs: RecordDiff[], options: StepTitleOptions) {
    this.ctx = ctx;
    this.diffs = diffs;
    this.options = options;
  }

  private rec(d: RecordDiff): GameRecord {
    return (d.after ?? d.before)!;
  }

  isLine(d: RecordDiff): boolean {
    return itemTypeName(this.rec(d).type) === LINE;
  }

  /** Первый непустой текст реплики: русский (если есть перевод) и как в данных. */
  lineText(rec: GameRecord | undefined): Pair {
    if (!rec) return { ru: '', en: '' };
    for (let i = 0; rec.strings.has(`text${i}`); i++) {
      const en = decodeText(rec.strings.get(`text${i}`)!);
      if (en.trim() === '') continue;
      return { ru: translatedText(this.options.translation, rec.stringId, `text${i}`, en) ?? en, en };
    }
    return { ru: '', en: '' };
  }

  /** Имя записи для названия: у реплики — её текст. */
  recordName(rec: GameRecord): Pair {
    if (itemTypeName(rec.type) === LINE) {
      const t = this.lineText(rec);
      return { ru: quote(t.ru), en: quote(t.en) };
    }
    const en = decodeText(rec.name) || rec.stringId;
    const ru = this.ctx.localizedName(rec.stringId) ?? en;
    return { ru: ` «${short(ru)}»`, en: ` «${short(en)}»` };
  }

  added(): RecordDiff[] {
    return this.diffs.filter((d) => d.change === 'added');
  }

  removed(): RecordDiff[] {
    return this.diffs.filter((d) => d.change === 'removed');
  }

  /** Связи `lines`, добавленные (+1) или убранные (−1) у записей, которые остались. */
  links(sign: 1 | -1): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    for (const d of this.diffs) {
      if (d.change !== 'changed') continue;
      for (const f of d.fields) {
        if (f.kind !== 'ref' || f.category !== 'lines') continue;
        if (sign === 1 ? !f.before && f.after : f.before && !f.after) out.push({ from: d.stringId, to: f.target });
      }
    }
    return out;
  }

  /** Новая реплика: ответ игрока или реплика NPC. */
  newLine(d: RecordDiff | undefined, verb: 'add' | 'insert' | 'copy' | 'paste'): Pair {
    const rec = d?.after;
    const t = this.lineText(rec);
    const player = (rec?.ints.get('speaker') ?? 0) !== 0;
    const what: Pair = player ? { ru: 'ответ игрока', en: 'player answer' } : { ru: 'реплика NPC', en: 'NPC line' };
    const ru = {
      add: player ? 'Добавлен' : 'Добавлена',
      insert: player ? 'Вставлен' : 'Вставлена',
      copy: player ? 'Скопирован' : 'Скопирована',
      paste: player ? 'Вставлен' : 'Вставлена',
    }[verb];
    const en = { add: 'Added', insert: 'Inserted', copy: 'Copied', paste: 'Pasted' }[verb];
    const tail: Pair = verb === 'insert' ? { ru: ' между репликами', en: ' between lines' } : { ru: '', en: '' };
    return { ru: `${ru} ${what.ru}${quote(t.ru)}${tail.ru}`, en: `${en} ${what.en}${quote(t.en)}${tail.en}` };
  }

  lineTextChanged(d: RecordDiff): Pair {
    const t = this.lineText(d.after);
    return { ru: `Изменён текст реплики${quote(t.ru)}`, en: `Changed line text${quote(t.en)}` };
  }

  linkTitle(added: boolean, n: number): Pair {
    if (n === 1) return added ? { ru: 'Добавлена связь', en: 'Added link' } : { ru: 'Удалена связь', en: 'Removed link' };
    return added
      ? { ru: `Добавлено ${n} ${plural(n, 'связь', 'связи', 'связей')}`, en: `Added ${n} links` }
      : { ru: `Удалено ${n} ${plural(n, 'связь', 'связи', 'связей')}`, en: `Removed ${n} links` };
  }

  /** По одной лишь разнице, когда метка ничего не говорит. */
  generic(): Pair | undefined {
    const added = this.added();
    const removed = this.removed();
    const changed = this.diffs.filter((d) => d.change === 'changed');
    if (this.diffs.length === 0) return undefined;
    if (this.diffs.length === 1) {
      const d = this.diffs[0]!;
      const name = this.recordName(this.rec(d));
      if (d.change === 'added') return this.isLine(d) ? this.newLine(d, 'add') : { ru: `Создана запись${name.ru}`, en: `Created record${name.en}` };
      if (d.change === 'removed') return this.isLine(d) ? { ru: `Удалена реплика${name.ru}`, en: `Deleted line${name.en}` } : { ru: `Удалена запись${name.ru}`, en: `Deleted record${name.en}` };
      const fields = d.fields;
      const linkFields = fields.filter((f) => f.kind === 'ref' && f.category === 'lines');
      if (linkFields.length === fields.length) {
        const plus = this.links(1).length;
        const minus = this.links(-1).length;
        if (plus > 0 && minus === 0) return this.linkTitle(true, plus);
        if (minus > 0 && plus === 0) return this.linkTitle(false, minus);
        return { ru: 'Изменены связи реплики', en: 'Changed line links' };
      }
      if (this.isLine(d) && fields.every((f) => f.kind === 'field' && f.dict === 'strings' && /^text\d+$/.test(f.key))) return this.lineTextChanged(d);
      if (fields.length === 1 && fields[0]!.kind === 'name') {
        const after = decodeText(d.after!.name);
        return { ru: `Переименовано в «${short(after)}»`, en: `Renamed to «${short(after)}»` };
      }
      if (fields.length === 1) {
        const f = fields[0]!;
        const key = f.kind === 'field' || f.kind === 'instance' ? f.key : f.kind === 'ref' || f.kind === 'refOrder' ? f.category : f.kind;
        const value = f.kind === 'field' && f.after !== undefined ? ` → ${short(formatScalar(f.dict, f.after))}` : '';
        return { ru: `Изменено «${key}» у${name.ru}${value}`, en: `Changed «${key}» on${name.en}${value}` };
      }
      return {
        ru: `Изменено ${fields.length} ${plural(fields.length, 'поле', 'поля', 'полей')} у${name.ru}`,
        en: `Changed ${fields.length} fields on${name.en}`,
      };
    }
    const parts: Pair[] = [];
    if (added.length) parts.push({ ru: `создано ${added.length}`, en: `${added.length} created` });
    if (changed.length) parts.push({ ru: `изменено ${changed.length}`, en: `${changed.length} changed` });
    if (removed.length) parts.push({ ru: `удалено ${removed.length}`, en: `${removed.length} deleted` });
    return { ru: `Записи: ${parts.map((p) => p.ru).join(', ')}`, en: `Records: ${parts.map((p) => p.en).join(', ')}` };
  }

  /** Название по метке транзакции; undefined — метка не из команд ядра. */
  byLabel(label: string): Pair | undefined {
    const lineAdded = this.added().find((d) => this.isLine(d));
    switch (label) {
      case 'новая реплика':
        return this.newLine(lineAdded, 'add');
      case 'вставить реплику':
        return this.newLine(lineAdded, 'insert');
      case 'копия реплики':
        return this.newLine(lineAdded, 'copy');
      case 'копии реплик': {
        const n = this.added().filter((d) => this.isLine(d)).length;
        return { ru: `Скопировано ${n} ${plural(n, 'реплика', 'реплики', 'реплик')}`, en: `Copied ${n} lines` };
      }
      case 'удалить реплику': {
        const gone = this.removed().find((d) => this.isLine(d));
        const t = this.lineText(gone?.before);
        return { ru: `Удалена реплика${quote(t.ru)}`, en: `Deleted line${quote(t.en)}` };
      }
      case 'удалить выделенное': {
        const lines = this.removed().filter((d) => this.isLine(d)).length;
        const links = this.links(-1).length;
        const ru: string[] = [];
        const en: string[] = [];
        if (lines) {
          ru.push(`${lines} ${plural(lines, 'реплика', 'реплики', 'реплик')}`);
          en.push(`${lines} ${lines === 1 ? 'line' : 'lines'}`);
        }
        if (links && !lines) {
          ru.push(`${links} ${plural(links, 'связь', 'связи', 'связей')}`);
          en.push(`${links} ${links === 1 ? 'link' : 'links'}`);
        }
        return { ru: `Удалено: ${ru.join(', ') || 'выделенное'}`, en: `Deleted: ${en.join(', ') || 'selection'}` };
      }
      case 'порядок реплик':
        return { ru: 'Изменён порядок реплик', en: 'Changed line order' };
      case 'как в игре':
        return { ru: 'Возвращено как в игре', en: 'Reverted to game version' };
      case 'новое условие':
        return { ru: 'Добавлено условие', en: 'Added condition' };
      case 'новое действие':
        return { ru: 'Добавлено действие', en: 'Added action' };
      case 'условие':
        return { ru: 'Изменено условие', en: 'Changed condition' };
      case 'действие':
        return { ru: 'Изменено действие', en: 'Changed action' };
      case 'убрать условие':
        return { ru: 'Убрано условие', en: 'Removed condition' };
      case 'убрать действие':
        return { ru: 'Убрано действие', en: 'Removed action' };
      case 'смена id':
        return { ru: 'Сменены id записей', en: 'Changed record ids' };
      case 'заголовок мода':
        return { ru: 'Изменён заголовок мода', en: 'Changed mod header' };
    }
    if (/: текст$/.test(label)) {
      const d = this.diffs.find((x) => this.isLine(x));
      return d ? this.lineTextChanged(d) : { ru: 'Изменён текст реплики', en: 'Changed line text' };
    }
    const relation = /^отношение («.*») (→|⇄) («.*»): (сброс|-?\d+)$/s.exec(label);
    if (relation) {
      const [, a, arrow, b, v] = relation;
      const reset = v === 'сброс';
      return {
        ru: `Отношение ${a} ${arrow} ${b}: ${reset ? 'по умолчанию' : v}`,
        en: `Relation ${a} ${arrow} ${b}: ${reset ? 'default' : v}`,
      };
    }
    const bulk = /^массово: (\S+) (.*) \((\d+) записей\)$/s.exec(label);
    if (bulk) {
      const [, field, what, n] = bulk;
      const en = what!.replace(/^замена /, 'replace ').replace(/^\+ ссылка /, 'add reference ').replace(/^− ссылка /, 'remove reference ');
      return { ru: `Массовая правка ${field}: ${what} (записей: ${n})`, en: `Bulk edit ${field}: ${en} (records: ${n})` };
    }
    const merge = /^слияние: (.*) \((\d+) записей\)$/s.exec(label);
    if (merge) return { ru: `Слияние с «${merge[1]!}»: записей ${merge[2]!}`, en: `Merge from «${merge[1]!}»: ${merge[2]!} records` };
    const created = /^создать «(.*)»$/s.exec(label);
    if (created) {
      const d = this.added()[0];
      const name = d ? this.recordName(d.after!) : { ru: ` «${created[1]!}»`, en: ` «${created[1]!}»` };
      return { ru: `Создана запись${name.ru}`, en: `Created record${name.en}` };
    }
    if (/^копия /.test(label)) {
      const d = this.added()[0];
      const name = d ? this.recordName(d.after!) : { ru: '', en: '' };
      return { ru: `Создана копия${name.ru}`, en: `Created copy${name.en}` };
    }
    if (/^удалить /.test(label)) {
      const d = this.removed()[0];
      if (d && this.isLine(d)) return this.byLabel('удалить реплику');
      const name = d ? this.recordName(d.before!) : { ru: '', en: '' };
      return { ru: `Удалена запись${name.ru}`, en: `Deleted record${name.en}` };
    }
    return undefined;
  }
}

/**
 * Метка без смысла для человека (`правка 12-Мой.mod`, `имя …`, `12-Мой.mod: damage`, `3 правок`):
 * её заменяет описание по разнице.
 */
function technical(label: string, cs: Changeset): boolean {
  if (/^(правка|имя) /.test(label) || /^\d+ правок$/.test(label)) return true;
  return cs.ops.some((op) => op.kind === 'record' && label.startsWith(`${op.stringId}: `));
}

const NO_TRANSLATION = {};
const caches = new WeakMap<object, WeakMap<Changeset, StepTitle>>();

/**
 * Понятное название шага истории на двух языках. Правка не меняется после записи в историю,
 * поэтому название считается один раз (кэш по самой правке и переводу).
 */
export function describeChangeset(ctx: ModContext, cs: Changeset, options: StepTitleOptions = {}): StepTitle {
  const key = options.translation ?? NO_TRANSLATION;
  let cache = caches.get(key);
  if (!cache) caches.set(key, (cache = new WeakMap()));
  const hit = cache.get(cs);
  if (hit) return hit;
  const out = describeLabel(ctx, cs, cs.label, options);
  cache.set(cs, out);
  return out;
}

function describeLabel(ctx: ModContext, cs: Changeset, label: string, options: StepTitleOptions): StepTitle {
  if (label.startsWith(AI_PREFIX)) {
    const title = label.slice(AI_PREFIX.length);
    return { ru: `ИИ: ${title}`, en: `AI: ${title}`, ai: true, rollback: false };
  }
  if (label.startsWith(ROLLBACK_PREFIX)) {
    // Разница отката обратна исходной правке, поэтому название — по метке исходной.
    const inner = describeLabel(ctx, { ...cs, ops: [] }, label.slice(ROLLBACK_PREFIX.length), options);
    return { ru: `Откат: ${inner.ru}`, en: `Rollback: ${inner.en}`, ai: inner.ai, rollback: true };
  }
  const d = new Describer(ctx, changesetDiff(ctx, cs), options);
  const info = cs.ops.some((op) => op.kind === 'info');
  const pair = d.byLabel(label) ?? (technical(label, cs) || label === '' ? d.generic() : undefined);
  if (pair) return { ...pair, ai: false, rollback: false };
  if (info && cs.ops.every((op) => op.kind === 'info')) return { ru: 'Изменён заголовок мода', en: 'Changed mod header', ai: false, rollback: false };
  // Своя метка (скрипт сборки, команда CLI) — показать как есть.
  return { ru: label, en: label, ai: false, rollback: false };
}
