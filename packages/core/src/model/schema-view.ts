/**
 * Схема игры текстом — для CLI (`kedit schema`) и ресурсов MCP: список типов, поля типа
 * с видом, значением по умолчанию и описанием из fcs.def, значения перечислений.
 */
import type { FieldDef } from '../schema/fcs-def.ts';
import { itemTypeId } from '../format/item-types.ts';
import type { GameSchema, SchemaWarning, TypeSchema } from '../schema/game-schema.ts';

export interface TypeSummary {
  name: string;
  fields: number;
  references: number;
  inferred: boolean;
  /** Schema extension that introduced the type; absent for the game's own types. */
  extension?: string;
  /** Fields that schema extensions added to a type they did not introduce. */
  extensionFields: number;
}

/** Типы записей по алфавиту. */
export function listTypes(schema: GameSchema): TypeSummary[] {
  return [...schema.types.values()]
    .map((t) => ({
      name: t.name,
      fields: t.fields.size,
      references: [...t.fields.values()].filter((f) => f.kind === 'reference').length,
      inferred: t.inferred === true,
      ...(t.extension !== undefined ? { extension: t.extension } : {}),
      extensionFields: [...t.fields.values()].filter((f) => f.extension !== undefined && f.extension !== t.extension).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The mark of a schema extension in schema listings: ` [extension NAME]`. */
function extensionMark(name: string): string {
  return ` [extension ${name}]`;
}

/** Where a type of the type list comes from; empty for a type the extensions did not touch. */
export function typeOriginNote(t: TypeSummary): string {
  if (t.extension !== undefined) return extensionMark(t.extension);
  return t.extensionFields > 0 ? ` [${String(t.extensionFields)} from extensions]` : '';
}

function formatDefault(f: FieldDef): string {
  if (f.default === undefined) return '';
  if (f.kind === 'color' && typeof f.default === 'number') return ` = #${(f.default >>> 0).toString(16).padStart(6, '0')}`;
  return ` = ${typeof f.default === 'string' && f.kind !== 'enum' ? JSON.stringify(f.default) : String(f.default)}`;
}

/**
 * Поле одной строкой: `name: kind [детали] = default — описание`.
 * A field added by a schema extension is flagged `extension NAME`, unless that extension is
 * `typeExtension`, the one that introduced the whole type.
 */
export function formatFieldDef(f: FieldDef, typeExtension?: string): string {
  let kind: string = f.kind;
  if (f.kind === 'enum' && f.enumName) kind = `enum ${f.enumName}`;
  else if (f.kind === 'reference') kind = `ref → ${f.targetType ?? '?'}${f.refDefaults ? ` (${f.refDefaults.join(', ')})` : ''}`;
  else if (f.kind === 'instance') kind = `instance → ${f.targetType ?? '?'}`;
  else if (f.kind === 'file' && f.fileFilter) kind = `file ${f.fileFilter}`;
  const flags = [
    f.looped && 'looped',
    f.multiline && 'multiline',
    f.bitset && 'bitset',
    f.inferred && 'из данных',
    f.extension !== undefined && f.extension !== typeExtension && `extension ${f.extension}`,
  ].filter(Boolean);
  const desc = f.description ? ` — ${f.description.replace(/\s*\n\s*/g, ' ')}` : '';
  return `${f.name}: ${kind}${formatDefault(f)}${flags.length ? ` [${flags.join(', ')}]` : ''}${desc}`;
}

/** Описание типа: поля по группам (категориям fcs.def), затем условия видимости. */
export function formatTypeSchema(type: TypeSchema): string[] {
  const origin = type.extension !== undefined ? extensionMark(type.extension) : '';
  const out = [`[${type.name}]${type.inferred ? ' (выведен из данных)' : ''} — полей ${type.fields.size}${origin}`];
  const groups = new Map<string, FieldDef[]>();
  for (const f of type.fields.values()) {
    const g = f.category ?? '';
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    list.push(f);
  }
  for (const [g, list] of groups) {
    if (g) out.push(`${g}:`);
    for (const f of list) out.push(`  ${formatFieldDef(f, type.extension)}`);
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
  const out = [`${e.name}${e.shared ? ' (общий)' : ''} — значений ${e.values.length}${e.extension !== undefined ? extensionMark(e.extension) : ''}`];
  let group: string | undefined;
  for (const v of e.values) {
    if (v.group !== undefined && v.group !== group) {
      group = v.group;
      out.push(`${group}:`);
    }
    const origin = v.extension !== undefined && v.extension !== e.extension ? extensionMark(v.extension) : '';
    out.push(`  ${v.name} = ${v.value}${origin}${v.description ? ` — ${v.description}` : ''}`);
  }
  return out;
}

/** Поиск типа без учёта регистра. */
export function findTypeSchema(schema: GameSchema, name: string): TypeSchema | undefined {
  return schema.types.get(name) ?? [...schema.types.values()].find((t) => t.name.toLowerCase() === name.toLowerCase());
}

/** What one schema extension (FCS Extended files of a mod) adds to the schema. */
export interface ExtensionSummary {
  name: string;
  /** Record types the extension introduced; `id` is absent when the type got no number. */
  types: { name: string; id?: number }[];
  /** Fields added to types the extension did not introduce, as `TYPE.field`. */
  fields: string[];
  /** Enums the extension created. */
  enums: string[];
  /** Values appended to enums the extension did not create, as `Enum.VALUE`. */
  enumValues: string[];
  /** Warnings about the files of the extension. */
  warnings: SchemaWarning[];
}

/** The schema extensions applied to the schema, in load order, with what each one adds. */
export function summarizeExtensions(schema: GameSchema): ExtensionSummary[] {
  const byName = new Map<string, ExtensionSummary>();
  const of = (name: string): ExtensionSummary => {
    let s = byName.get(name);
    if (!s) byName.set(name, (s = { name, types: [], fields: [], enums: [], enumValues: [], warnings: [] }));
    return s;
  };
  for (const name of schema.extensions ?? []) of(name);
  for (const t of schema.types.values()) {
    if (t.extension !== undefined) {
      const id = itemTypeId(t.name, schema.itemTypes);
      of(t.extension).types.push({ name: t.name, ...(id !== undefined ? { id } : {}) });
    }
    for (const f of t.fields.values()) {
      if (f.extension !== undefined && f.extension !== t.extension) of(f.extension).fields.push(`${t.name}.${f.name}`);
    }
  }
  for (const e of schema.enums.values()) {
    if (e.extension !== undefined) of(e.extension).enums.push(e.name);
    for (const v of e.values) {
      if (v.extension !== undefined && v.extension !== e.extension) of(v.extension).enumValues.push(`${e.name}.${v.name}`);
    }
  }
  for (const w of schema.warnings) if (w.extension !== undefined) of(w.extension).warnings.push(w);
  return [...byName.values()];
}

/** Names of a list, cut after `max` with the number of the rest. */
function shortList(items: readonly string[], max: number): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')}, +${String(items.length - max)} more`;
}

/** One line about a schema extension: `schema extension NAME: types …; fields …; warnings N`. */
export function formatExtensionSummary(s: ExtensionSummary, max = 6): string {
  const parts: string[] = [];
  if (s.types.length) parts.push(`types ${shortList(s.types.map((t) => (t.id !== undefined ? `${t.name}=${String(t.id)}` : `${t.name} (no number)`)), max)}`);
  if (s.fields.length) parts.push(`fields ${shortList(s.fields, max)}`);
  if (s.enums.length) parts.push(`enums ${shortList(s.enums, max)}`);
  if (s.enumValues.length) parts.push(`enum values ${shortList(s.enumValues, max)}`);
  if (parts.length === 0) parts.push('adds nothing');
  if (s.warnings.length) parts.push(`warnings ${String(s.warnings.length)}`);
  return `schema extension ${s.name}: ${parts.join('; ')}`;
}

/** Everything a schema extension adds, in full, then its warnings with file and line. */
export function formatExtensionDetail(s: ExtensionSummary): string[] {
  const out = [formatExtensionSummary(s, Infinity)];
  for (const w of s.warnings) out.push(`warning: ${w.source}:${String(w.line)}: ${w.message}`);
  return out;
}
