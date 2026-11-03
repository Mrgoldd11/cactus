/**
 * Схема игры текстом — для CLI (`kedit schema`) и ресурсов MCP: список типов, поля типа
 * с видом, значением по умолчанию и описанием из fcs.def, значения перечислений.
 */
import type { FieldDef } from '../schema/fcs-def.ts';
import type { GameSchema, TypeSchema } from '../schema/game-schema.ts';

export interface TypeSummary {
  name: string;
  fields: number;
  references: number;
  inferred: boolean;
}

/** Типы записей по алфавиту. */
export function listTypes(schema: GameSchema): TypeSummary[] {
  return [...schema.types.values()]
    .map((t) => ({
      name: t.name,
      fields: t.fields.size,
      references: [...t.fields.values()].filter((f) => f.kind === 'reference').length,
      inferred: t.inferred === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatDefault(f: FieldDef): string {
  if (f.default === undefined) return '';
  if (f.kind === 'color' && typeof f.default === 'number') return ` = #${(f.default >>> 0).toString(16).padStart(6, '0')}`;
  return ` = ${typeof f.default === 'string' && f.kind !== 'enum' ? JSON.stringify(f.default) : String(f.default)}`;
}

/** Поле одной строкой: `name: kind [детали] = default — описание`. */
export function formatFieldDef(f: FieldDef): string {
  let kind: string = f.kind;
  if (f.kind === 'enum' && f.enumName) kind = `enum ${f.enumName}`;
  else if (f.kind === 'reference') kind = `ref → ${f.targetType ?? '?'}${f.refDefaults ? ` (${f.refDefaults.join(', ')})` : ''}`;
  else if (f.kind === 'instance') kind = `instance → ${f.targetType ?? '?'}`;
  else if (f.kind === 'file' && f.fileFilter) kind = `file ${f.fileFilter}`;
  const flags = [f.looped && 'looped', f.multiline && 'multiline', f.bitset && 'bitset', f.inferred && 'из данных'].filter(Boolean);
  const desc = f.description ? ` — ${f.description.replace(/\s*\n\s*/g, ' ')}` : '';
  return `${f.name}: ${kind}${formatDefault(f)}${flags.length ? ` [${flags.join(', ')}]` : ''}${desc}`;
}

/** Описание типа: поля по группам (категориям fcs.def), затем условия видимости. */
export function formatTypeSchema(type: TypeSchema): string[] {
  const out = [`[${type.name}]${type.inferred ? ' (выведен из данных)' : ''} — полей ${type.fields.size}`];
  const groups = new Map<string, FieldDef[]>();
  for (const f of type.fields.values()) {
    const g = f.category ?? '';
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    list.push(f);
  }
  for (const [g, list] of groups) {
    if (g) out.push(`${g}:`);
    for (const f of list) out.push(`  ${formatFieldDef(f)}`);
  }
  if (type.owned.length) out.push(`принадлежат записи: ${type.owned.join(', ')}`);
  for (const c of type.conditions) out.push(`условие: ${c.field} видно, если ${c.dependsOn} ${c.negate ? '≠' : '='} ${c.values.join(' | ')}`);
  return out;
}

/** Значения перечисления: `NAME = value — описание`. */
export function formatEnum(schema: GameSchema, name: string): string[] | undefined {
  const e = schema.enums.get(name);
  if (!e) {
    const users = schema.externalEnums.get(name);
    return users ? [`${name}: встроено в игру, значений в fcs_enums.def нет; используют ${users.join(', ')}`] : undefined;
  }
  const out = [`${e.name}${e.shared ? ' (общий)' : ''} — значений ${e.values.length}`];
  let group: string | undefined;
  for (const v of e.values) {
    if (v.group !== undefined && v.group !== group) {
      group = v.group;
      out.push(`${group}:`);
    }
    out.push(`  ${v.name} = ${v.value}${v.description ? ` — ${v.description}` : ''}`);
  }
  return out;
}

/** Поиск типа без учёта регистра. */
export function findTypeSchema(schema: GameSchema, name: string): TypeSchema | undefined {
  return schema.types.get(name) ?? [...schema.types.values()].find((t) => t.name.toLowerCase() === name.toLowerCase());
}
