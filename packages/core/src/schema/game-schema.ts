/**
 * Схема игры: типы записей и их поля (fcs.def), перечисления (fcs_enums.def) и дерево
 * категорий (fcs_layout.def), собранные вместе и проверенные друг по другу.
 */
import { isItemTypeName } from '../format/item-types.ts';
import { parseFcsDef, type FcsDef, type FieldCondition, type FieldDef, type FieldKind, type TranslateRule } from './fcs-def.ts';
import { parseFcsEnums, type EnumDef, type FcsEnums } from './fcs-enums.ts';
import { parseFcsLayout, walkLayout, type FcsLayout, type LayoutNode } from './fcs-layout.ts';

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

  // Перекрёстные проверки.
  const enumMap = enums?.enums ?? new Map<string, EnumDef>();
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
