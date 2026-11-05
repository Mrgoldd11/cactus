/**
 * Схема игры: типы записей и их поля (fcs.def), перечисления (fcs_enums.def) и дерево
 * категорий (fcs_layout.def), собранные вместе и проверенные друг по другу.
 */
import { isItemTypeName } from '../format/item-types.ts';
import { parseFcsDef, type FcsDef, type FieldCondition, type FieldDef, type FieldKind, type TranslateRule } from './fcs-def.ts';
import { parseFcsEnums, type EnumDef, type EnumValue, type FcsEnums } from './fcs-enums.ts';
import { parseFcsLayout, walkLayout, type FcsLayout, type LayoutNode } from './fcs-layout.ts';
import { BUILTIN_ENUM_LABELS, BUILTIN_ENUMS, BUILTIN_FIELD_ENUMS } from './builtin-enums.ts';

export interface TypeSchema {
  name: string;
  /** Поля по имени, в порядке первого появления в fcs.def. */
  fields: Map<string, FieldDef>;
  conditions: FieldCondition[];
  /** Категории ссылок, записи в которых принадлежат этой записи (`OWNED:`). */
  owned: string[];
  translate: TranslateRule[];
  /** Строки секций fcs.def, из которых собран тип. */
  sectionLines: number[];
  /** Типа нет в fcs.def, он выведен из данных. */
  inferred?: boolean;
  /** Типа нет в fcs.def, но его поля известны из FCS (`builtin-enums.ts`). */
  builtin?: boolean;
}

export type SchemaSource = 'fcs.def' | 'fcs_enums.def' | 'fcs_layout.def';

export interface SchemaWarning {
  source: SchemaSource;
  line: number;
  message: string;
  text: string;
}

export interface GameSchema {
  types: Map<string, TypeSchema>;
  enums: Map<string, EnumDef>;
  layout: LayoutNode[];
  /**
   * Перечисления, на которые ссылается fcs.def, но которых нет в fcs_enums.def: они
   * встроены в FCS/игру. Имя → поля `ТИП.поле`, которые его используют.
   */
  externalEnums: Map<string, string[]>;
  warnings: SchemaWarning[];
}

export interface SchemaSources {
  fcsDef: string;
  fcsEnums?: string;
  fcsLayout?: string;
}

/** Собрать схему из уже разобранных файлов. */
export function buildGameSchema(def: FcsDef, enums?: FcsEnums, layout?: FcsLayout): GameSchema {
  const warnings: SchemaWarning[] = [];
  for (const w of def.warnings) warnings.push({ source: 'fcs.def', ...w });
  for (const w of enums?.warnings ?? []) warnings.push({ source: 'fcs_enums.def', ...w });
  for (const w of layout?.warnings ?? []) warnings.push({ source: 'fcs_layout.def', ...w });
  const warn = (source: SchemaSource, line: number, message: string, text = ''): void => {
    warnings.push({ source, line, message, text });
  };

  const types = new Map<string, TypeSchema>();
  for (const section of def.sections) {
    for (const typeName of section.types) {
      if (!isItemTypeName(typeName)) warn('fcs.def', section.line, `неизвестный тип записи ${typeName}`);
      let t = types.get(typeName);
      if (!t) {
        t = { name: typeName, fields: new Map(), conditions: [], owned: [], translate: [], sectionLines: [] };
        types.set(typeName, t);
      }
      t.sectionLines.push(section.line);
      for (const f of section.fields) {
        const prev = t.fields.get(f.name);
        if (!prev) t.fields.set(f.name, f);
        else if (prev.kind !== f.kind || prev.targetType !== f.targetType || prev.enumName !== f.enumName) {
          warn('fcs.def', f.line, `${typeName}.${f.name}: повтор поля с другим видом (было ${prev.kind} в строке ${prev.line})`);
        }
      }
      t.conditions.push(...section.conditions);
      for (const o of section.owned) if (!t.owned.includes(o.category)) t.owned.push(o.category);
      t.translate.push(...section.translate);
    }
  }

  const enumMap = mergeBuiltinEnums(enums?.enums ?? new Map<string, EnumDef>(), (line, message) => {
    warn('fcs_enums.def', line, message);
  });
  addBuiltinFields(types, enumMap);

  // Перекрёстные проверки.
  const externalEnums = new Map<string, string[]>();
  for (const t of types.values()) {
    for (const f of t.fields.values()) {
      if (f.kind === 'enum' && enums) {
        const e = enumMap.get(f.enumName!);
        if (!e) {
          const users = externalEnums.get(f.enumName!) ?? [];
          users.push(`${t.name}.${f.name}`);
          externalEnums.set(f.enumName!, users);
        } else if (!e.values.some((v) => v.name === f.default)) {
          warn('fcs.def', f.line, `${t.name}.${f.name}: в ${f.enumName} нет значения ${String(f.default)}`);
        }
      }
      if (f.targetType !== undefined && !isItemTypeName(f.targetType)) {
        warn('fcs.def', f.line, `${t.name}.${f.name}: неизвестный тип ссылки ${f.targetType}`);
      }
    }
    for (const c of t.conditions) {
      if (!findField(t, c.field)) warn('fcs.def', c.line, `${t.name}: условие для неизвестного поля «${c.field}»`);
      if (!findField(t, c.dependsOn)) warn('fcs.def', c.line, `${t.name}: условие зависит от неизвестного поля «${c.dependsOn}»`);
    }
    for (const o of t.owned) {
      const f = t.fields.get(o);
      if (f?.kind !== 'reference') warn('fcs.def', t.sectionLines[0] ?? 0, `${t.name}: OWNED ${o} — не поле-ссылка`);
    }
  }
  for (const node of walkLayout(layout?.roots ?? [])) {
    if (!isItemTypeName(node.type)) warn('fcs_layout.def', node.line, `неизвестный тип ${node.type}`);
    const t = types.get(node.type);
    for (const flt of node.filters) {
      if (t && !findField(t, flt.field)) warn('fcs_layout.def', node.line, `${node.type}: фильтр по неизвестному полю «${flt.field}»`);
    }
  }

  return { types, enums: enumMap, layout: layout?.roots ?? [], externalEnums, warnings };
}

function labelled(enumName: string, v: EnumValue): EnumValue {
  const label = BUILTIN_ENUM_LABELS[enumName]?.[v.name];
  return label !== undefined ? { ...v, label } : v;
}

/** Перечисления из `builtin-enums.ts` поверх fcs_enums.def; разобранные данные не меняются. */
function mergeBuiltinEnums(parsed: ReadonlyMap<string, EnumDef>, warn: (line: number, message: string) => void): Map<string, EnumDef> {
  const out = new Map<string, EnumDef>();
  for (const [name, e] of parsed) out.set(name, { ...e, values: e.values.map((v) => labelled(name, v)) });
  for (const [name, names] of Object.entries(BUILTIN_ENUMS)) {
    const e = out.get(name);
    if (!e) {
      out.set(name, { name, shared: false, line: 0, builtin: true, values: names.map((n, value) => labelled(name, { name: n, value })) });
      continue;
    }
    if (!e.shared) continue;
    // `enum shared`: номера по имени из C#, порядок и описания — из файла.
    const seen = new Set<string>();
    const values: EnumValue[] = [];
    for (const v of e.values) {
      const value = names.indexOf(v.name);
      if (value < 0) {
        warn(e.line, `${name}: значения ${v.name} нет в enum'е FCS — номер по порядку в файле`);
        values.push(v);
      } else values.push({ ...v, value });
      seen.add(v.name);
    }
    for (const [value, n] of names.entries()) if (!seen.has(n)) values.push(labelled(name, { name: n, value }));
    out.set(name, { ...e, values });
  }
  return out;
}

/** Поля из `BUILTIN_FIELD_ENUMS` для типов, которых нет в fcs.def (DIALOG_ACTION). */
function addBuiltinFields(types: Map<string, TypeSchema>, enums: ReadonlyMap<string, EnumDef>): void {
  for (const [typeName, fields] of Object.entries(BUILTIN_FIELD_ENUMS)) {
    let t = types.get(typeName);
    if (!t) {
      t = { name: typeName, fields: new Map(), conditions: [], owned: [], translate: [], sectionLines: [], builtin: true };
      types.set(typeName, t);
    }
    for (const [key, enumName] of Object.entries(fields)) {
      if (t.fields.has(key)) continue;
      const def: FieldDef = { name: key, kind: 'enum', enumName, line: 0, builtin: true };
      const first = enums.get(enumName)?.values[0];
      if (first) def.default = first.name;
      t.fields.set(key, def);
    }
  }
}

/** Разобрать тексты файлов и собрать схему. */
export function parseGameSchema(sources: SchemaSources): GameSchema {
  return buildGameSchema(
    parseFcsDef(sources.fcsDef),
    sources.fcsEnums !== undefined ? parseFcsEnums(sources.fcsEnums) : undefined,
    sources.fcsLayout !== undefined ? parseFcsLayout(sources.fcsLayout) : undefined,
  );
}

/**
 * Поле по ключу из данных. Учитывает повторяющиеся поля (`looped`): ключ `text3`
 * находит описание `text0`.
 */
export function findField(type: TypeSchema, key: string): FieldDef | undefined {
  const exact = type.fields.get(key);
  if (exact) return exact;
  const m = /^(.*?)(\d+)$/.exec(key);
  if (!m) return undefined;
  const base = type.fields.get(`${m[1]!}0`);
  return base?.looped ? base : undefined;
}

/** Словарь записи, в котором хранится значение поля этого вида. */
export type RecordDict = 'bools' | 'floats' | 'ints' | 'vec3s' | 'vec4s' | 'strings' | 'files' | 'refs' | 'instances';

export const DICT_FOR_KIND: Record<FieldKind, RecordDict | undefined> = {
  bool: 'bools',
  int: 'ints',
  enum: 'ints',
  color: 'ints',
  float: 'floats',
  string: 'strings',
  file: 'files',
  reference: 'refs',
  instance: 'instances',
  null: undefined,
  vec3: 'vec3s',
  vec4: 'vec4s',
};
