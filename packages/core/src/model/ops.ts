/**
 * Правки в виде данных (JSON): список операций, которые выполняются одной транзакцией —
 * одна отмена на весь список. Так правят мод CLI (`build` с JSON-планом) и MCP.
 *
 * Новые записи можно называть псевдонимом (`as: "$guard"`) и ссылаться на них дальше
 * по тексту (`id: "$guard"`, `target: "$guard"`).
 */
import { encodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import { DICT_FOR_KIND, findField } from '../schema/game-schema.ts';
import type { ModContext, ModInfo } from './context.ts';
import { EditError } from './context.ts';
import { resolveTypeFilter } from './search.ts';
import { fieldEnum, getEnum, parseEnumValue } from './enums.ts';
import { SCALAR_DICTS, scalarMap, type ScalarDict, type ScalarValueMap } from './record-ops.ts';
import { CHOICE_SPEAKERS } from './dialogue-graph.ts';
import {
  addCondition,
  addEffect,
  addLine,
  deleteGraphItems,
  duplicateLine,
  insertLineBetween,
  linkLine,
  removeAction,
  revertLine,
  setLineTexts,
  unlinkLine,
} from '../dialog/edit.ts';

export type JsonScalar = boolean | number | string | number[];

export type EditOp =
  | { op: 'create'; type: string | number; name: string; id?: string; as?: string }
  | { op: 'duplicate'; from: string; name?: string; id?: string; as?: string }
  | { op: 'delete'; id: string; removeReferences?: boolean }
  | { op: 'restore'; id: string }
  | { op: 'revert'; id: string }
  | { op: 'rename'; id: string; name: string }
  | { op: 'set'; id: string; field: string; value: JsonScalar; dict?: string }
  | { op: 'reset'; id: string; field: string; dict?: string }
  | { op: 'addRef'; id: string; category: string; target: string; values?: number[] }
  | { op: 'removeRef'; id: string; category: string; target: string }
  | { op: 'setRefs'; id: string; category: string; refs: { target: string; values?: number[] }[] }
  | ({ op: 'info' } & Partial<Omit<ModInfo, 'fileName'>>)
  // ── граф диалога (те же команды ядра, что у редактора) ──
  | { op: 'addLine'; parent: string; speaker?: EnumInput; text?: string; texts?: string[]; as?: string }
  | { op: 'insertLine'; parent: string; child: string; speaker?: EnumInput; text?: string; texts?: string[]; as?: string }
  | { op: 'link'; parent: string; child: string }
  | { op: 'unlink'; parent: string; child: string }
  | { op: 'setText'; id: string; text?: string; texts?: string[] }
  | { op: 'duplicateLine'; id: string; parent?: string; as?: string }
  | { op: 'deleteLines'; lines?: string[]; links?: { parent: string; child: string }[] }
  | { op: 'revertLine'; id: string }
  | { op: 'addCondition'; id: string; cond: EnumInput; value: number; who?: EnumInput; cmp?: EnumInput; tag?: number; as?: string }
  | { op: 'addEffect'; id: string; action: EnumInput; values?: number[]; as?: string }
  | { op: 'removeAction'; id: string; category: 'conditions' | 'effects'; action: string };

/** Значение перечисления: число или имя (`T_TARGET`, `DC_HAS_TAG`, «равно»). */
export type EnumInput = number | string;

export interface ApplyOpsResult {
  /** Псевдоним → строковый id созданной записи. */
  aliases: Record<string, string>;
  /** Id созданных записей по порядку. */
  created: string[];
  /** Id всех затронутых записей. */
  touched: string[];
}

const DICT_ALIASES: Record<string, ScalarDict> = {
  bool: 'bools',
  bools: 'bools',
  int: 'ints',
  ints: 'ints',
  float: 'floats',
  floats: 'floats',
  str: 'strings',
  string: 'strings',
  strings: 'strings',
  file: 'files',
  files: 'files',
  vec3: 'vec3s',
  vec3s: 'vec3s',
  vec4: 'vec4s',
  vec4s: 'vec4s',
};

export function parseDictName(name: string): ScalarDict {
  const d = DICT_ALIASES[name.toLowerCase()];
  if (!d) throw new EditError(`Неизвестный вид поля «${name}»: bool, int, float, str, file, vec3, vec4`);
  return d;
}

/**
 * В каком словаре лежит поле: явно заданный вид → где поле уже есть в записи → схема
 * (fcs.def) → по значению (true/false — bool, целое — int, дробное — float, строка — str).
 */
export function fieldDict(ctx: ModContext, stringId: string, key: string, value?: JsonScalar, explicit?: string): ScalarDict {
  if (explicit) return parseDictName(explicit);
  const rec = ctx.get(stringId) ?? ctx.lower(stringId);
  if (rec) for (const d of SCALAR_DICTS) if (scalarMap(rec, d).has(key)) return d;
  const ts = rec && ctx.schema?.types.get(ctx.typeName(rec.type));
  const f = ts ? findField(ts, key) : undefined;
  const fromSchema = f ? DICT_FOR_KIND[f.kind] : undefined;
  if (fromSchema && fromSchema !== 'refs' && fromSchema !== 'instances') return fromSchema;
  if (typeof value === 'boolean') return 'bools';
  if (typeof value === 'number') return Number.isInteger(value) ? 'ints' : 'floats';
  if (Array.isArray(value)) return value.length === 4 ? 'vec4s' : 'vec3s';
  if (value !== undefined) return 'strings';
  throw new EditError(`Не знаю вид поля ${key} у ${stringId}: укажите dict`);
}

/** Имя значения enum-поля (`DR_ONCE_ONLY`, `ONCE_ONLY`, «один раз») → число; прочее как есть. */
function enumInput(ctx: ModContext, stringId: string, key: string, value: JsonScalar): JsonScalar {
  if (typeof value !== 'string' || /^-?\d+$/.test(value.trim())) return value;
  const rec = ctx.get(stringId) ?? ctx.lower(stringId);
  const def = rec && fieldEnum(ctx.schema, ctx.typeName(rec.type), key, rec);
  if (!def) return value;
  const n = parseEnumValue(def, value);
  if (n === undefined) throw new EditError(`В ${def.name} нет значения «${value}»`);
  return n;
}

/** Значение из JSON в значение словаря. */
export function coerceValue<D extends ScalarDict>(dict: D, value: JsonScalar, key = ''): ScalarValueMap[D] {
  const bad = (): never => {
    throw new EditError(`Значение ${JSON.stringify(value)} не подходит для ${dict}${key ? ` (${key})` : ''}`);
  };
  const num = (): number => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    return Number.isNaN(n) && value !== 'NaN' ? bad() : n;
  };
  switch (dict) {
    case 'bools':
      if (typeof value === 'boolean') return value as ScalarValueMap[D];
      if (value === 1 || value === 'true' || value === '1') return true as ScalarValueMap[D];
      if (value === 0 || value === 'false' || value === '0') return false as ScalarValueMap[D];
      return bad();
    case 'ints': {
      const n = num();
      if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) return bad();
      return n as ScalarValueMap[D];
    }
    case 'floats':
      return Math.fround(num()) as ScalarValueMap[D];
    case 'strings':
    case 'files':
      if (typeof value !== 'string') return bad();
      return encodeText(value) as ScalarValueMap[D];
    case 'vec3s':
    case 'vec4s': {
      const n = dict === 'vec3s' ? 3 : 4;
      if (!Array.isArray(value) || value.length !== n || value.some((x) => typeof x !== 'number')) return bad();
      return value.map((x) => Math.fround(x)) as ScalarValueMap[D];
    }
  }
}

/**
 * Метка по умолчанию. Одна операция графа диалога получает ту же метку, что и правка в окне
 * редактора, — тогда история называет шаг понятно («Добавлен ответ игрока „…“»).
 */
function defaultLabel(ops: readonly EditOp[]): string {
  const op = ops.length === 1 ? ops[0] : undefined;
  switch (op?.op) {
    case 'addLine':
      return 'новая реплика';
    case 'insertLine':
      return 'вставить реплику';
    case 'duplicateLine':
      return 'копия реплики';
    case 'deleteLines':
      return (op.lines?.length ?? 0) === 1 && !op.links?.length ? 'удалить реплику' : 'удалить выделенное';
    case 'revertLine':
      return 'как в игре';
    case 'addCondition':
      return 'новое условие';
    case 'addEffect':
      return 'новое действие';
    case 'removeAction':
      return op.category === 'conditions' ? 'убрать условие' : 'убрать действие';
    case 'setText':
      return `${op.id}: текст`;
    default:
      return `${ops.length} правок`;
  }
}

/** Выполнить операции одной транзакцией. При ошибке ничего не меняется. */
export function applyOps(ctx: ModContext, ops: readonly EditOp[], label = defaultLabel(ops)): ApplyOpsResult {
  const aliases: Record<string, string> = {};
  const created: string[] = [];
  const touched = new Set<string>();
  const id = (s: string): string => {
    if (!s.startsWith('$')) return s;
    const v = aliases[s];
    if (v === undefined) throw new EditError(`Псевдоним ${s} не определён выше`);
    return v;
  };
  const alias = (name: string | undefined, sid: string): void => {
    if (name === undefined) return;
    if (!name.startsWith('$')) throw new EditError(`Псевдоним должен начинаться с $: ${name}`);
    aliases[name] = sid;
  };
  ctx.transaction(label, () => {
    for (const [i, op] of ops.entries()) {
      try {
        applyOne(op);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new EditError(`Операция ${i + 1} (${op.op}): ${msg}`);
      }
    }
  });
  return { aliases, created, touched: [...touched] };

  function applyOne(op: EditOp): void {
    switch (op.op) {
      case 'create': {
        const sid = ctx.createRecord(resolveTypeFilter(op.type, ctx.schema?.itemTypes), op.name, op.id !== undefined ? { stringId: op.id } : {});
        alias(op.as, sid);
        created.push(sid);
        touched.add(sid);
        return;
      }
      case 'duplicate': {
        const sid = ctx.duplicateRecord(id(op.from), {
          ...(op.id !== undefined ? { stringId: op.id } : {}),
          ...(op.name !== undefined ? { name: op.name } : {}),
        });
        alias(op.as, sid);
        created.push(sid);
        touched.add(sid);
        return;
      }
      case 'delete':
        ctx.deleteRecord(id(op.id), { removeReferences: op.removeReferences ?? false });
        break;
      case 'restore':
        ctx.restoreRecord(id(op.id));
        break;
      case 'revert':
        ctx.revertRecord(id(op.id));
        break;
      case 'rename':
        ctx.renameRecord(id(op.id), op.name);
        break;
      case 'set': {
        const sid = id(op.id);
        const value = enumInput(ctx, sid, op.field, op.value);
        const dict = fieldDict(ctx, sid, op.field, value, op.dict);
        ctx.setField(sid, dict, op.field, coerceValue(dict, value, op.field));
        break;
      }
      case 'reset': {
        const sid = id(op.id);
        ctx.resetField(sid, fieldDict(ctx, sid, op.field, undefined, op.dict), op.field);
        break;
      }
      case 'addRef':
        if (op.values) ctx.addReference(id(op.id), op.category, id(op.target), op.values);
        else ctx.addReference(id(op.id), op.category, id(op.target));
        break;
      case 'removeRef':
        ctx.removeReference(id(op.id), op.category, id(op.target));
        break;
      case 'setRefs': {
        const sid = id(op.id);
        const defaults = ctx.refDefaults(sid, op.category);
        ctx.setReferences(
          sid,
          op.category,
          op.refs.map((r) => {
            const v = r.values ?? defaults;
            return { target: id(r.target), v0: v[0] ?? 0, v1: v[1] ?? 0, v2: v[2] ?? 0 };
          }),
        );
        break;
      }
      case 'info': {
        const patch: Partial<Omit<ModInfo, 'fileName'>> & { op?: string } = { ...op };
        delete patch.op;
        ctx.setModInfo(patch);
        return;
      }
      case 'addLine':
      case 'insertLine': {
        const parent = id(op.parent);
        const speaker = op.speaker !== undefined ? speakerOf(op.speaker) : nextSpeaker(parent);
        const sid =
          op.op === 'addLine'
            ? addLine(ctx, parent, { speaker })
            : insertLineBetween(ctx, parent, id(op.child), { speaker });
        const texts = op.texts ?? (op.text !== undefined ? [op.text] : undefined);
        if (texts) setLineTexts(ctx, sid, texts);
        alias(op.as, sid);
        created.push(sid);
        touched.add(sid).add(parent);
        if (op.op === 'insertLine') touched.add(id(op.child));
        return;
      }
      case 'link':
      case 'unlink': {
        const parent = id(op.parent);
        if (op.op === 'link') linkLine(ctx, parent, id(op.child));
        else unlinkLine(ctx, parent, id(op.child));
        touched.add(parent);
        return;
      }
      case 'setText': {
        const texts = op.texts ?? (op.text !== undefined ? [op.text] : undefined);
        if (!texts) throw new EditError('нужен text или texts');
        setLineTexts(ctx, id(op.id), texts);
        break;
      }
      case 'duplicateLine': {
        const sid = duplicateLine(ctx, id(op.id), op.parent !== undefined ? id(op.parent) : undefined);
        alias(op.as, sid);
        created.push(sid);
        touched.add(sid);
        if (op.parent !== undefined) touched.add(id(op.parent));
        return;
      }
      case 'deleteLines': {
        const lines = (op.lines ?? []).map(id);
        const links = (op.links ?? []).map((l) => ({ parent: id(l.parent), child: id(l.child) }));
        if (!lines.length && !links.length) throw new EditError('нужны lines или links');
        deleteGraphItems(ctx, { lines, links });
        for (const s of [...lines, ...links.map((l) => l.parent)]) touched.add(s);
        return;
      }
      case 'revertLine':
        revertLine(ctx, id(op.id));
        break;
      case 'addCondition': {
        const a = addCondition(ctx, id(op.id), {
          cond: enumArg('DialogConditionEnum', op.cond),
          who: op.who !== undefined ? enumArg('TalkerEnum', op.who) : 0,
          cmp: op.cmp !== undefined ? enumArg('ComparisonEnum', op.cmp) : 0,
          value: op.value,
          ...(op.tag !== undefined ? { tag: op.tag } : {}),
        });
        alias(op.as, a);
        created.push(a);
        touched.add(a);
        break;
      }
      case 'addEffect': {
        const a = addEffect(ctx, id(op.id), { action: enumArg('DialogActionEnum', op.action), ...(op.values ? { values: op.values } : {}) });
        alias(op.as, a);
        created.push(a);
        touched.add(a);
        break;
      }
      case 'removeAction':
        removeAction(ctx, id(op.id), op.category, id(op.action));
        break;
    }
    touched.add(id(op.id));
  }

  /** Значение перечисления по имени или числу (имена — из fcs_enums.def). */
  function enumArg(name: string, v: EnumInput): number {
    if (typeof v === 'number') return v;
    if (/^-?\d+$/.test(v.trim())) return Number(v);
    const def = getEnum(ctx.schema, name);
    const n = def && parseEnumValue(def, v);
    if (n === undefined) throw new EditError(`В ${name} нет значения «${v}»`);
    return n;
  }

  /** Кто говорит: npc / player или TalkerEnum (T_ME, T_TARGET, …). */
  function speakerOf(v: EnumInput): number {
    if (v === 'npc') return 0;
    if (v === 'player') return 1;
    return enumArg('TalkerEnum', v);
  }

  /** Как в графе редактора: после реплики NPC — ответ игрока, иначе — реплика NPC. */
  function nextSpeaker(parent: string): number {
    const rec = ctx.get(parent) ?? ctx.lower(parent);
    return rec && itemTypeName(rec.type) === 'DIALOGUE_LINE' && !CHOICE_SPEAKERS.has(rec.ints.get('speaker') ?? 0) ? 1 : 0;
  }
}
