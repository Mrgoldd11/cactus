/**
 * Clear names of history steps (the ↶ ↷ circles, the History panel): "Changed line text
 * 'Beep won…'", "Added player reply", "Removed link". The name is built from the transaction
 * label and from what the edit actually changed (record diff before and after), in both
 * languages at once. Labels stay the same strings — the core API does not change.
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import { translatedText, type TranslationIndex } from '../locale/translation.ts';
import type { Changeset, ModContext } from './context.ts';
import type { RecordDiff } from './diff.ts';
import { changesetDiff, formatScalar } from './present.ts';
import { mapUi, uiText, type UiText } from '../ui-text.ts';
import { formatEnumValue, refValueEnum } from './enums.ts';

export interface StepTitle {
  /** The title in the interface languages; non-English titles quote line texts in the data language. */
  text: UiText;
  /** The edit came from AI (live MCP link). */
  ai: boolean;
  /** Revert of another edit. */
  rollback: boolean;
}

export interface StepTitleOptions {
  /** Translation of the game texts: non-English titles quote the line text in that language. */
  translation?: TranslationIndex;
}

const ROLLBACK: UiText = { en: 'Rollback: ', ru: 'Откат: ', zh: '回滚：' };
const AI_PREFIX = 'ИИ: ';
const ROLLBACK_PREFIX = 'откат: ';
const LINE = 'DIALOGUE_LINE';
const QUOTE_MAX = 32;

/** A title in every language the core has texts for. */
type Pair = { en: string; ru: string; zh: string };

const EMPTY: Pair = { en: '', ru: '', zh: '' };

/** Same text in every language (names, ids, labels shown as they are). */
function same(s: string): Pair {
  return { en: s, ru: s, zh: s };
}

/** Text quoted from the data: `en` is the text as in the data, `tr` its translation. */
interface Quoted {
  en: string;
  tr: string;
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

  /** First non-empty line text: as in the data and in the translation (if there is one). */
  lineText(rec: GameRecord | undefined): Quoted {
    if (!rec) return { en: '', tr: '' };
    for (let i = 0; rec.strings.has(`text${i}`); i++) {
      const en = decodeText(rec.strings.get(`text${i}`)!);
      if (en.trim() === '') continue;
      return { tr: translatedText(this.options.translation, rec.stringId, `text${i}`, en) ?? en, en };
    }
    return { en: '', tr: '' };
  }

  /** Quoted line text for every language. */
  quoted(t: Quoted): Pair {
    return { en: quote(t.en), ru: quote(t.tr), zh: quote(t.tr) };
  }

  /** Record name for the title: for a line, its text. */
  recordName(rec: GameRecord): Pair {
    if (itemTypeName(rec.type) === LINE) return this.quoted(this.lineText(rec));
    const en = decodeText(rec.name) || rec.stringId;
    const tr = this.ctx.localizedName(rec.stringId) ?? en;
    return { en: ` “${short(en)}”`, ru: ` «${short(tr)}»`, zh: ` “${short(tr)}”` };
  }

  /** Data-language name of a live record of `typeName` named `name` in the data; undefined — none or no translation. */
  translatedByName(typeName: string, name: string): string | undefined {
    for (const sid of this.ctx.allStringIds()) {
      const h = this.ctx.headline(sid);
      if (!h || itemTypeName(h.type) !== typeName || decodeText(h.name) !== name) continue;
      const tr = this.ctx.localizedName(sid);
      if (tr !== undefined) return tr;
    }
    return undefined;
  }

  added(): RecordDiff[] {
    return this.diffs.filter((d) => d.change === 'added');
  }

  removed(): RecordDiff[] {
    return this.diffs.filter((d) => d.change === 'removed');
  }

  /** `lines` links added (+1) or removed (−1) on records that remain. */
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

  /** New line: player reply or NPC line. */
  newLine(d: RecordDiff | undefined, verb: 'add' | 'insert' | 'copy' | 'paste'): Pair {
    const rec = d?.after;
    const t = this.lineText(rec);
    const player = (rec?.ints.get('speaker') ?? 0) !== 0;
    const what: Pair = player ? { ru: 'ответ игрока', en: 'player answer', zh: '玩家回答' } : { ru: 'реплика NPC', en: 'NPC line', zh: 'NPC 台词' };
    const ru = {
      add: player ? 'Добавлен' : 'Добавлена',
      insert: player ? 'Вставлен' : 'Вставлена',
      copy: player ? 'Скопирован' : 'Скопирована',
      paste: player ? 'Вставлен' : 'Вставлена',
    }[verb];
    const en = { add: 'Added', insert: 'Inserted', copy: 'Copied', paste: 'Pasted' }[verb];
    const zh = { add: '添加了', insert: '插入了', copy: '复制了', paste: '粘贴了' }[verb];
    const tail: Pair = verb === 'insert' ? { ru: ' между репликами', en: ' between lines', zh: '（在台词之间）' } : EMPTY;
    const q = this.quoted(t);
    return { ru: `${ru} ${what.ru}${q.ru}${tail.ru}`, en: `${en} ${what.en}${q.en}${tail.en}`, zh: `${zh}${what.zh}${q.zh}${tail.zh}` };
  }

  lineTextChanged(d: RecordDiff): Pair {
    const q = this.quoted(this.lineText(d.after));
    return { ru: `Изменён текст реплики${q.ru}`, en: `Changed line text${q.en}`, zh: `修改了台词文本${q.zh}` };
  }

  linkTitle(added: boolean, n: number): Pair {
    if (n === 1) return added ? { ru: 'Добавлена связь', en: 'Added link', zh: '添加了连接' } : { ru: 'Удалена связь', en: 'Removed link', zh: '删除了连接' };
    return added
      ? { ru: `Добавлено ${n} ${plural(n, 'связь', 'связи', 'связей')}`, en: `Added ${n} links`, zh: `添加了 ${n} 个连接` }
      : { ru: `Удалено ${n} ${plural(n, 'связь', 'связи', 'связей')}`, en: `Removed ${n} links`, zh: `删除了 ${n} 个连接` };
  }

  /** From the diff alone, when the label says nothing. */
  generic(): Pair | undefined {
    const added = this.added();
    const removed = this.removed();
    const changed = this.diffs.filter((d) => d.change === 'changed');
    if (this.diffs.length === 0) return undefined;
    if (this.diffs.length === 1) {
      const d = this.diffs[0]!;
      const name = this.recordName(this.rec(d));
      if (d.change === 'added') return this.isLine(d) ? this.newLine(d, 'add') : { ru: `Создана запись${name.ru}`, en: `Created record${name.en}`, zh: `创建了记录${name.zh}` };
      if (d.change === 'removed')
        return this.isLine(d)
          ? { ru: `Удалена реплика${name.ru}`, en: `Deleted line${name.en}`, zh: `删除了台词${name.zh}` }
          : { ru: `Удалена запись${name.ru}`, en: `Deleted record${name.en}`, zh: `删除了记录${name.zh}` };
      const fields = d.fields;
      const linkFields = fields.filter((f) => f.kind === 'ref' && f.category === 'lines');
      if (linkFields.length === fields.length) {
        const plus = this.links(1).length;
        const minus = this.links(-1).length;
        if (plus > 0 && minus === 0) return this.linkTitle(true, plus);
        if (minus > 0 && plus === 0) return this.linkTitle(false, minus);
        return { ru: 'Изменены связи реплики', en: 'Changed line links', zh: '修改了台词的连接' };
      }
      if (this.isLine(d) && fields.every((f) => f.kind === 'field' && f.dict === 'strings' && /^text\d+$/.test(f.key))) return this.lineTextChanged(d);
      if (fields.length === 1 && fields[0]!.kind === 'name') {
        const after = decodeText(d.after!.name);
        return { ru: `Переименовано в «${short(after)}»`, en: `Renamed to “${short(after)}”`, zh: `重命名为 “${short(after)}”` };
      }
      if (fields.length === 1) {
        const f = fields[0]!;
        const key = f.kind === 'field' || f.kind === 'instance' ? f.key : f.kind === 'ref' || f.kind === 'refOrder' ? f.category : f.kind;
        const value = f.kind === 'field' && f.after !== undefined ? ` → ${short(formatScalar(f.dict, f.after))}` : '';
        return { ru: `Изменено «${key}» у${name.ru}${value}`, en: `Changed “${key}” on${name.en}${value}`, zh: `修改了${name.zh} 的 “${key}”${value}` };
      }
      return {
        ru: `Изменено ${fields.length} ${plural(fields.length, 'поле', 'поля', 'полей')} у${name.ru}`,
        en: `Changed ${fields.length} fields on${name.en}`,
        zh: `修改了${name.zh} 的 ${fields.length} 个字段`,
      };
    }
    const parts: Pair[] = [];
    if (added.length) parts.push({ ru: `создано ${added.length}`, en: `${added.length} created`, zh: `创建 ${added.length}` });
    if (changed.length) parts.push({ ru: `изменено ${changed.length}`, en: `${changed.length} changed`, zh: `修改 ${changed.length}` });
    if (removed.length) parts.push({ ru: `удалено ${removed.length}`, en: `${removed.length} deleted`, zh: `删除 ${removed.length}` });
    return {
      ru: `Записи: ${parts.map((p) => p.ru).join(', ')}`,
      en: `Records: ${parts.map((p) => p.en).join(', ')}`,
      zh: `记录：${parts.map((p) => p.zh).join('，')}`,
    };
  }

  /** Title from the transaction label; undefined — the label is not from core commands. */
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
        return { ru: `Скопировано ${n} ${plural(n, 'реплика', 'реплики', 'реплик')}`, en: `Copied ${n} lines`, zh: `复制了 ${n} 条台词` };
      }
      case 'удалить реплику': {
        const gone = this.removed().find((d) => this.isLine(d));
        const q = this.quoted(this.lineText(gone?.before));
        return { ru: `Удалена реплика${q.ru}`, en: `Deleted line${q.en}`, zh: `删除了台词${q.zh}` };
      }
      case 'удалить выделенное': {
        const lines = this.removed().filter((d) => this.isLine(d)).length;
        const links = this.links(-1).length;
        const ru: string[] = [];
        const en: string[] = [];
        const zh: string[] = [];
        if (lines) {
          ru.push(`${lines} ${plural(lines, 'реплика', 'реплики', 'реплик')}`);
          en.push(`${lines} ${lines === 1 ? 'line' : 'lines'}`);
          zh.push(`${lines} 条台词`);
        }
        if (links && !lines) {
          ru.push(`${links} ${plural(links, 'связь', 'связи', 'связей')}`);
          en.push(`${links} ${links === 1 ? 'link' : 'links'}`);
          zh.push(`${links} 个连接`);
        }
        return { ru: `Удалено: ${ru.join(', ') || 'выделенное'}`, en: `Deleted: ${en.join(', ') || 'selection'}`, zh: `已删除：${zh.join('，') || '所选内容'}` };
      }
      case 'порядок реплик':
        return { ru: 'Изменён порядок реплик', en: 'Changed line order', zh: '修改了台词顺序' };
      case 'как в игре':
        return { ru: 'Возвращено как в игре', en: 'Reverted to game version', zh: '恢复为游戏原样' };
      case 'новое условие':
        return { ru: 'Добавлено условие', en: 'Added condition', zh: '添加了条件' };
      case 'новое действие':
        return { ru: 'Добавлено действие', en: 'Added action', zh: '添加了动作' };
      case 'условие':
        return { ru: 'Изменено условие', en: 'Changed condition', zh: '修改了条件' };
      case 'действие':
        return { ru: 'Изменено действие', en: 'Changed action', zh: '修改了动作' };
      case 'убрать условие':
        return { ru: 'Убрано условие', en: 'Removed condition', zh: '移除了条件' };
      case 'убрать действие':
        return { ru: 'Убрано действие', en: 'Removed action', zh: '移除了动作' };
      case 'смена id':
        return { ru: 'Сменены id записей', en: 'Changed record ids', zh: '修改了记录 ID' };
      case 'заголовок мода':
        return { ru: 'Изменён заголовок мода', en: 'Changed mod header', zh: '修改了 Mod 头信息' };
    }
    if (/: текст$/.test(label)) {
      const d = this.diffs.find((x) => this.isLine(x));
      return d ? this.lineTextChanged(d) : { ru: 'Изменён текст реплики', en: 'Changed line text', zh: '修改了台词文本' };
    }
    const relation = /^отношение («.*») (→|⇄) («.*»): (сброс|-?\d+)$/s.exec(label);
    if (relation) {
      const [, a, arrow, b, v] = relation;
      const reset = v === 'сброс';
      return {
        ru: `Отношение ${a} ${arrow} ${b}: ${reset ? 'по умолчанию' : v}`,
        en: `Relation ${a} ${arrow} ${b}: ${reset ? 'default' : v}`,
        zh: `关系 ${a} ${arrow} ${b}：${reset ? '默认' : v}`,
      };
    }
    const fix = /^исправление: (\d+)$/.exec(label);
    if (fix) return { ru: `Исправлены ошибки проверки: ${fix[1]!}`, en: `Fixed validation problems: ${fix[1]!}`, zh: `修复了检查问题：${fix[1]!}` };
    const clean = /^очистка: (\d+)$/.exec(label);
    if (clean) return { ru: `Очистка мода: убрано пунктов ${clean[1]!}`, en: `Mod cleanup: removed ${clean[1]!} items`, zh: `Mod 清理：移除了 ${clean[1]!} 项` };
    const bulk = /^массово: (\S+) (.*) \((\d+) записей\)$/s.exec(label);
    if (bulk) {
      const [, field, what, n] = bulk;
      const en = what!.replace(/^замена /, 'replace ').replace(/^\+ ссылка /, 'add reference ').replace(/^− ссылка /, 'remove reference ');
      const zh = what!.replace(/^замена /, '替换 ').replace(/^\+ ссылка /, '添加引用 ').replace(/^− ссылка /, '移除引用 ');
      return { ru: `Массовая правка ${field}: ${what} (записей: ${n})`, en: `Bulk edit ${field}: ${en} (records: ${n})`, zh: `批量编辑 ${field}：${zh}（记录：${n}）` };
    }
    const race = /^раса: («.*») как («.*») \((\d+) правок\)$/s.exec(label);
    if (race) {
      const [, a, b, n] = race;
      return { ru: `Совместимость расы ${a!} как ${b!} (правок: ${n!})`, en: `Race compatibility ${a!} like ${b!} (changes: ${n!})`, zh: `种族兼容 ${a!} 如同 ${b!}（更改：${n!}）` };
    }
    const newRace = /^новая раса («.*») на основе («.*?»)(?: \+ совместимость \((\d+) правок\))?$/s.exec(label);
    if (newRace) {
      const [, a, b, n] = newRace;
      // The label keeps the sample's name as in the data; show it in the data language like other names.
      const tr = this.translatedByName('RACE', b!.slice(1, -1));
      const bt = tr !== undefined ? `«${tr}»` : b!;
      if (n === undefined) return { ru: `Новая раса ${a!} на основе ${bt}`, en: `New race ${a!} based on ${b!}`, zh: `基于 ${bt} 的新种族 ${a!}` };
      return {
        ru: `Новая раса ${a!} на основе ${bt} + совместимость (правок: ${n})`,
        en: `New race ${a!} based on ${b!} + compatibility (changes: ${n})`,
        zh: `基于 ${bt} 的新种族 ${a!} + 兼容（更改：${n}）`,
      };
    }
    const creature = /^новое существо («.*») на основе («.*?»)$/s.exec(label);
    if (creature) {
      const [, a, b] = creature;
      const tr = this.translatedByName('ANIMAL_CHARACTER', b!.slice(1, -1));
      const bt = tr !== undefined ? `«${tr}»` : b!;
      return { ru: `Новое существо ${a!} на основе ${bt}`, en: `New creature ${a!} based on ${b!}`, zh: `基于 ${bt} 的新生物 ${a!}` };
    }
    const newRec = /^новая запись «(.*)» по образцу (.+)$/s.exec(label);
    if (newRec) {
      const [, a, from] = newRec;
      const d = this.added()[0];
      const name = d ? this.recordName(d.after!) : same(` «${a!}»`);
      const src = this.ctx.get(from!) ?? this.ctx.lower(from!);
      const sample = src ? this.recordName(src) : same(` ${from!}`);
      return { ru: `Новая запись${name.ru} по образцу${sample.ru}`, en: `New record${name.en} based on${sample.en}`, zh: `基于${sample.zh} 的新记录${name.zh}` };
    }
    // event-dialogue.ts eventDialogueLabel: «диалог на событие: «NAME» → PKG (событие N)» / «в пакет: …»
    const onEvent = /^(диалог на событие|в пакет): «(.*)» → (.+) \(событие (\d+)\)$/s.exec(label);
    if (onEvent) {
      const [, kind, a, pkgSid, n] = onEvent;
      // A package made by the same step is labelled by its holder: take the added package then.
      const named = this.ctx.get(pkgSid!);
      const made = this.added().find((d) => d.after !== undefined && itemTypeName(d.after.type) === 'DIALOGUE_PACKAGE')?.after;
      const pkgRec = named && itemTypeName(named.type) === 'DIALOGUE_PACKAGE' ? named : (made ?? named);
      const pkg = pkgRec ? this.recordName(pkgRec) : same(` ${pkgSid!}`);
      const def = refValueEnum(this.ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
      const ev = (lang: string): string => (def ? formatEnumValue(def, Number(n), lang) : n!);
      if (kind === 'в пакет')
        return { ru: `Диалог «${a!}» в пакет${pkg.ru}: ${ev('ru')}`, en: `Dialogue “${a!}” into package${pkg.en}: ${ev('en')}`, zh: `对话“${a!}”加入对话包${pkg.zh}：${ev('zh')}` };
      return { ru: `Диалог на событие «${a!}» → пакет${pkg.ru}: ${ev('ru')}`, en: `Dialogue on event “${a!}” → package${pkg.en}: ${ev('en')}`, zh: `事件对话“${a!}” → 对话包${pkg.zh}：${ev('zh')}` };
    }
    // ways.ts addToListsLabel: «в игру: SID → LIST (field)» / «в игру: SID → мест N как у SAMPLE»
    // Ids may have spaces («12-My Mod.mod»); field names have no brackets.
    const intoMany = /^в игру: (.+?) → мест (\d+)(?: как у (.+))?$/s.exec(label);
    const intoOne = intoMany ? null : /^в игру: (.+?) → (.+) \(([^()]+)\)$/s.exec(label);
    if (intoOne || intoMany) {
      const nameOf = (sid: string): Pair => {
        const r = this.ctx.get(sid) ?? this.ctx.lower(sid);
        return r ? this.recordName(r) : same(` ${sid}`);
      };
      const rec = nameOf((intoOne ?? intoMany)![1]!);
      if (intoOne) {
        const list = nameOf(intoOne[2]!);
        const f = intoOne[3]!;
        return { ru: `В игру:${rec.ru} → в${list.ru} (${f})`, en: `Into the game:${rec.en} → to${list.en} (${f})`, zh: `进入游戏：${rec.zh} → ${list.zh}（${f}）` };
      }
      const n = intoMany![2]!;
      const from = intoMany![3];
      if (from === undefined) return { ru: `В игру:${rec.ru} → мест: ${n}`, en: `Into the game:${rec.en} → places: ${n}`, zh: `进入游戏：${rec.zh} → 位置：${n}` };
      const s = nameOf(from);
      return {
        ru: `В игру:${rec.ru} → туда же, где${s.ru} (мест: ${n})`,
        en: `Into the game:${rec.en} → same places as${s.en} (places: ${n})`,
        zh: `进入游戏：${rec.zh} → 与${s.zh} 相同的位置（${n}）`,
      };
    }
    const anims = /^анимации («.*»): клипов (\d+), рас (\d+)$/s.exec(label);
    if (anims) {
      const [, f, c, r] = anims;
      return { ru: `Анимации ${f!}: клипов ${c!}, рас ${r!}`, en: `Animations ${f!}: clips ${c!}, races ${r!}`, zh: `动画 ${f!}：片段 ${c!}，种族 ${r!}` };
    }
    const merge = /^слияние: (.*) \((\d+) записей\)$/s.exec(label);
    if (merge)
      return { ru: `Слияние с «${merge[1]!}»: записей ${merge[2]!}`, en: `Merge from “${merge[1]!}”: ${merge[2]!} records`, zh: `从 “${merge[1]!}” 合并：${merge[2]!} 条记录` };
    const pkg = /^Пакет диалогов («.*») → (?:(«.*»)|(\d+) персонажам)$/s.exec(label);
    if (pkg) {
      const [, p, one, n] = pkg;
      return {
        ru: label,
        en: `Dialogue package ${p!} → ${one ?? `${n!} characters`}`,
        zh: `对话包 ${p!} → ${one ?? `${n!} 个角色`}`,
      };
    }
    const tr = /^перевод (\S+): (.*)$/s.exec(label);
    if (tr) return { ru: label, en: `Translation ${tr[1]!}: ${tr[2]!}`, zh: `翻译 ${tr[1]!}：${tr[2]!}` };
    const trFile = /^перевод из файла \((\d+)\)$/.exec(label);
    if (trFile) return { ru: label, en: `Translation from file (${trFile[1]!})`, zh: `从文件导入翻译（${trFile[1]!}）` };
    const created = /^создать «(.*)»$/s.exec(label);
    if (created) {
      const d = this.added()[0];
      const name = d ? this.recordName(d.after!) : same(` «${created[1]!}»`);
      return { ru: `Создана запись${name.ru}`, en: `Created record${name.en}`, zh: `创建了记录${name.zh}` };
    }
    const many = /^(удалить|копии|восстановить|откатить) запис(?:и|ей): (\d+)$/.exec(label);
    if (many) {
      const n = Number(many[2]!);
      const word = plural(n, 'запись', 'записи', 'записей');
      const en = `${n} ${n === 1 ? 'record' : 'records'}`;
      switch (many[1]) {
        case 'удалить':
          return { ru: `Удалено: ${n} ${word}`, en: `Deleted ${en}`, zh: `删除了 ${n} 条记录` };
        case 'копии':
          return { ru: `Скопировано: ${n} ${word}`, en: `Copied ${en}`, zh: `复制了 ${n} 条记录` };
        case 'восстановить':
          return { ru: `Восстановлено: ${n} ${word}`, en: `Restored ${en}`, zh: `恢复了 ${n} 条记录` };
        default:
          return { ru: `Отменены правки: ${n} ${word}`, en: `Reverted ${en}`, zh: `撤销了 ${n} 条记录的修改` };
      }
    }
    if (/^копия /.test(label)) {
      const d = this.added()[0];
      const name = d ? this.recordName(d.after!) : EMPTY;
      return { ru: `Создана копия${name.ru}`, en: `Created copy${name.en}`, zh: `创建了副本${name.zh}` };
    }
    if (/^удалить /.test(label)) {
      const d = this.removed()[0];
      if (d && this.isLine(d)) return this.byLabel('удалить реплику');
      const name = d ? this.recordName(d.before!) : EMPTY;
      return { ru: `Удалена запись${name.ru}`, en: `Deleted record${name.en}`, zh: `删除了记录${name.zh}` };
    }
    return undefined;
  }
}

/**
 * A label meaningless to a human (`правка 12-Мой.mod`, `имя …`, `12-Мой.mod: damage`, `3 правок`):
 * it is replaced by a description from the diff.
 */
function technical(label: string, cs: Changeset): boolean {
  if (/^(правка|имя) /.test(label) || /^\d+ правок$/.test(label)) return true;
  return cs.ops.some((op) => op.kind === 'record' && label.startsWith(`${op.stringId}: `));
}

const NO_TRANSLATION = {};
const caches = new WeakMap<object, WeakMap<Changeset, StepTitle>>();

/**
 * Clear history-step title in both languages. An edit does not change after it enters the history,
 * so the title is computed once (cached by the edit itself and the translation).
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
    return { text: { ru: `ИИ: ${title}`, en: `AI: ${title}`, zh: `AI：${title}` }, ai: true, rollback: false };
  }
  if (label.startsWith(ROLLBACK_PREFIX)) {
    // A revert's diff is the inverse of the original edit, so the title comes from the original's label.
    const inner = describeLabel(ctx, { ...cs, ops: [] }, label.slice(ROLLBACK_PREFIX.length), options);
    return { text: mapUi([inner.text], ([t], lang) => `${uiText(ROLLBACK, lang)}${t!}`), ai: inner.ai, rollback: true };
  }
  const d = new Describer(ctx, changesetDiff(ctx, cs), options);
  const info = cs.ops.some((op) => op.kind === 'info');
  const pair = d.byLabel(label) ?? (technical(label, cs) || label === '' ? d.generic() : undefined);
  if (pair) return { text: pair, ai: false, rollback: false };
  if (info && cs.ops.every((op) => op.kind === 'info')) return { text: { ru: 'Изменён заголовок мода', en: 'Changed mod header', zh: '修改了 Mod 头信息' }, ai: false, rollback: false };
  // A custom label (build script, CLI command) — show as is.
  return { text: same(label), ai: false, rollback: false };
}
