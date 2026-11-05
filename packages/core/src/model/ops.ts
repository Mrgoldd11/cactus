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
import { fieldEnum, parseEnumValue } from './enums.ts';
import { SCALAR_DICTS, scalarMap, type ScalarDict, type ScalarValueMap } from './record-ops.ts';

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
  | ({ op: 'info' } & Partial<Omit<ModInfo, 'fileName'>>);

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
  const ts = rec && ctx.schema?.types.get(itemTypeName(rec.type));
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
  const def = rec && fieldEnum(ctx.schema, itemTypeName(rec.type), key, rec);
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

/** Выполнить операции одной транзакцией. При ошибке ничего не меняется. */
export function applyOps(ctx: ModContext, ops: readonly EditOp[], label = `${ops.length} правок`): ApplyOpsResult {
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
        const sid = ctx.createRecord(resolveTypeFilter(op.type), op.name, op.id !== undefined ? { stringId: op.id } : {});
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
    }
    touched.add(id(op.id));
  }
}
