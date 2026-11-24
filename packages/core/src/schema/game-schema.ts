/**
 * Game schema: record types and their fields (fcs.def), enums (fcs_enums.def) and the category
 * tree (fcs_layout.def), put together and cross-checked.
 */
import { ITEM_TYPE_NAMES, isItemTypeName, itemTypeId, VANILLA_ITEM_TYPES, type ItemTypes } from '../format/item-types.ts';
import type { UiText } from '../ui-text.ts';
import { parseFcsDef, warnText, type FcsDef, type FieldCondition, type FieldDef, type FieldKind, type TranslateRule } from './fcs-def.ts';
import { parseFcsEnums, type EnumDef, type EnumValue, type FcsEnums } from './fcs-enums.ts';
import { parseFcsLayout, walkLayout, type FcsLayout, type LayoutNode } from './fcs-layout.ts';
import { BUILTIN_ENUM_LABELS, BUILTIN_ENUMS, BUILTIN_FIELD_ENUMS } from './builtin-enums.ts';

export interface TypeSchema {
  name: string;
  /** Fields by name, in order of first appearance in fcs.def. */
  fields: Map<string, FieldDef>;
  conditions: FieldCondition[];
  /** Reference categories whose entries are owned by this record (`OWNED:`). */
  owned: string[];
  translate: TranslateRule[];
  /** Lines of the fcs.def sections the type is built from. */
  sectionLines: number[];
  /** The type is not in fcs.def; it is inferred from data. */
  inferred?: boolean;
  /** The type is not in fcs.def, but its fields are known from FCS (`builtin-enums.ts`). */
  builtin?: boolean;
  /** Schema extension (mod folder name) that introduced the type; absent for the game's own types. */
  extension?: string;
}

/**
 * Where a warning comes from: `fcs.def`, `fcs_enums.def` or `fcs_layout.def` for the game's own
 * files, the full path of the file for a schema extension (FCS Extended).
 */
export type SchemaSource = string;

export interface SchemaWarning {
  source: SchemaSource;
  /** Schema extension (mod folder name) the file belongs to; absent for the game's own files. */
  extension?: string;
  line: number;
  /** English text (MCP, logs). */
  message: string;
  /** The text in every interface language (the Mod info window). */
  texts: UiText;
  text: string;
}

export interface GameSchema {
  types: Map<string, TypeSchema>;
  enums: Map<string, EnumDef>;
  layout: LayoutNode[];
  /**
   * Enums referenced by fcs.def but absent from fcs_enums.def: they are
   * built into FCS/the game. Name → the `TYPE.field` fields that use it.
   */
  externalEnums: Map<string, string[]>;
  warnings: SchemaWarning[];
  /** Record types added by schema extensions on top of the built-in table (`format/item-types.ts`). */
  itemTypes: ItemTypes;
  /** Names of the schema extensions applied to this schema, in load order; absent when there are none. */
  extensions?: readonly string[];
}

export interface SchemaSources {
  fcsDef: string;
  fcsEnums?: string;
  fcsLayout?: string;
}

/** A record type number declared by a schema extension. */
export interface ItemTypeDecl {
  name: string;
  value: number;
  line: number;
}

/**
 * One parsed file of the schema. The game's own files are three parts (`fcs.def`,
 * `fcs_enums.def`, `fcs_layout.def`); a schema extension file is one part that may carry all
 * three kinds of content at once (`schema/extensions.ts` splits it).
 */
export interface SchemaPart {
  source: SchemaSource;
  /** Schema extension (mod folder name) the file belongs to; absent for the game's own files. */
  extension?: string;
  def?: FcsDef;
  enums?: FcsEnums;
  layout?: FcsLayout;
  /** Record type numbers from `// enum itemType { NAME=N }` comment lines (see `resolveItemTypes`). */
  itemTypeHints?: ItemTypeDecl[];
}

/** Build the schema from already parsed files. */
export function buildGameSchema(def: FcsDef, enums?: FcsEnums, layout?: FcsLayout): GameSchema {
  const parts: SchemaPart[] = [{ source: 'fcs.def', def }];
  if (enums) parts.push({ source: 'fcs_enums.def', enums });
  if (layout) parts.push({ source: 'fcs_layout.def', layout });
  return buildGameSchemaFromParts(parts);
}

/** The enum FCS Extended uses to register new record types; it never becomes a schema enum. */
export const ITEM_TYPE_ENUM = 'itemType';

/**
 * Record types declared by schema extensions.
 *
 * FCS Extended has no dedicated syntax for this. A new type gets its number in one of two ways:
 * 1. A real `enum itemType { NAME=N }` block in the extension's def file (FCS Extended looks
 *    type names up in its def-file enums before the enum built into FCS).
 * 2. A .NET plugin (DLL) that hooks the parser of FCS. Cactus never runs DLLs, so the number is
 *    then unknown, unless the def file repeats it in a comment: `// enum itemType { NAME=N }`.
 *    The author of FCS Extended writes this comment in his own examples (WorldStates). A comment
 *    is used only for names that no real block declares.
 * A type that gets no number from either source is reported where a section uses it.
 */
function resolveItemTypes(parts: readonly SchemaPart[], warn: (part: SchemaPart, line: number, texts: UiText) => void): ItemTypes {
  const extra = new Map<number, string>();
  const extraByName = new Map<string, number>();
  const declare = (part: SchemaPart, d: ItemTypeDecl): void => {
    const where = `${ITEM_TYPE_ENUM} ${d.name}=${String(d.value)}`;
    if (!Number.isInteger(d.value) || d.value < 0) {
      warn(part, d.line, warnText(
        `${where}: a record type number must be a non-negative integer; ignored`,
        `${where}: номер типа записи должен быть неотрицательным целым; пропущено`,
        `${where}：记录类型编号必须是非负整数；已忽略`,
      ));
      return;
    }
    if (isItemTypeName(d.name)) {
      if (itemTypeId(d.name) !== d.value) {
        const id = String(itemTypeId(d.name));
        warn(part, d.line, warnText(
          `${where}: ${d.name} is a built-in record type with number ${id}; ignored`,
          `${where}: ${d.name} — встроенный тип записи с номером ${id}; пропущено`,
          `${where}：${d.name} 是内置记录类型，编号为 ${id}；已忽略`,
        ));
      }
      return;
    }
    const builtin = ITEM_TYPE_NAMES[d.value];
    if (builtin !== undefined) {
      warn(part, d.line, warnText(
        `${where}: number ${String(d.value)} is the built-in record type ${builtin}; ignored`,
        `${where}: номер ${String(d.value)} занят встроенным типом записи ${builtin}; пропущено`,
        `${where}：编号 ${String(d.value)} 属于内置记录类型 ${builtin}；已忽略`,
      ));
      return;
    }
    const oldValue = extraByName.get(d.name);
    if (oldValue !== undefined && oldValue !== d.value) {
      warn(part, d.line, warnText(
        `${where}: ${d.name} was already declared with number ${String(oldValue)}; the last declaration wins`,
        `${where}: ${d.name} уже объявлен с номером ${String(oldValue)}; действует последнее объявление`,
        `${where}：${d.name} 已声明为编号 ${String(oldValue)}；以最后一次声明为准`,
      ));
      if (extra.get(oldValue) === d.name) extra.delete(oldValue);
    }
    const oldName = extra.get(d.value);
    if (oldName !== undefined && oldName !== d.name) {
      warn(part, d.line, warnText(
        `${where}: number ${String(d.value)} is also used by ${oldName}; records with this number are shown as ${d.name}`,
        `${where}: номер ${String(d.value)} уже есть у ${oldName}; записи с этим номером показаны как ${d.name}`,
        `${where}：编号 ${String(d.value)} 也被 ${oldName} 使用；该编号的记录显示为 ${d.name}`,
      ));
    }
    extra.set(d.value, d.name);
    extraByName.set(d.name, d.value);
  };
  for (const part of parts) {
    if (part.extension === undefined) continue;
    for (const block of part.enums?.blocks ?? []) {
      if (block.name !== ITEM_TYPE_ENUM) continue;
      for (const v of block.values) declare(part, { name: v.name, value: v.value, line: block.line });
    }
  }
  const declared = new Set(extraByName.keys());
  for (const part of parts) {
    if (part.extension === undefined) continue;
    for (const hint of part.itemTypeHints ?? []) if (!declared.has(hint.name)) declare(part, hint);
  }
  return extra.size === 0 ? VANILLA_ITEM_TYPES : { extra, extraByName };
}

/**
 * Build the schema from parsed files in load order. FCS Extended loads `fcs_preload.def` of
 * every extension, then the game's files, then `fcs.def` of every extension; the caller passes
 * the parts in that order.
 *
 * - Types and fields: sections add up; the first definition of a field wins.
 * - Enums: the game's files define them; a block from an extension is appended to the enum of
 *   the same name (FCS Extended does the same), or creates a new enum. Appending happens after
 *   the built-in enums are merged in, so `enum DialogConditionEnum { }` followed by a block with
 *   new values extends the enum built into FCS.
 * - Layout: the trees are concatenated.
 *
 * `preWarnings` go first in the warning list (patch problems found before parsing).
 */
export function buildGameSchemaFromParts(parts: readonly SchemaPart[], preWarnings: readonly SchemaWarning[] = []): GameSchema {
  const warnings: SchemaWarning[] = [...preWarnings];
  const warn = (part: SchemaPart, line: number, texts: UiText, text = ''): void => {
    warnings.push({ source: part.source, ...(part.extension !== undefined ? { extension: part.extension } : {}), line, message: texts.en, texts, text });
  };
  for (const part of parts) {
    for (const w of part.def?.warnings ?? []) warn(part, w.line, w.texts, w.text);
    for (const w of part.enums?.warnings ?? []) warn(part, w.line, w.texts, w.text);
    for (const w of part.layout?.warnings ?? []) warn(part, w.line, w.texts, w.text);
  }

  const itemTypes = resolveItemTypes(parts, warn);
  const knownType = (name: string): boolean => isItemTypeName(name, itemTypes);
  const unknownTypeHelp = (name: string): UiText => {
    const line = `"enum ${ITEM_TYPE_ENUM} { ${name}=<number> }"`;
    return warnText(
      `record type ${name} has no number: add ${line} to this file (as a "//" comment if a DLL plugin registers the type in FCS Extended)`,
      `у типа записи ${name} нет номера: добавьте в этот файл ${line} (комментарием "//", если тип регистрирует DLL-плагин FCS Extended)`,
      `记录类型 ${name} 没有编号：请在此文件中添加 ${line}（如果该类型由 FCS Extended 的 DLL 插件注册，则写成 "//" 注释）`,
    );
  };

  // The file an extension's field or condition came from; the game's own are not stored.
  const origin = new WeakMap<object, SchemaPart>();
  const fallbackDef: SchemaPart = parts.find((p) => p.def !== undefined && p.extension === undefined) ?? { source: 'fcs.def' };
  const partOf = (o: object): SchemaPart => origin.get(o) ?? fallbackDef;
  const ownedFrom = new Map<string, { part: SchemaPart; line: number }>();

  const types = new Map<string, TypeSchema>();
  for (const part of parts) {
    const ext = part.extension;
    for (const section of part.def?.sections ?? []) {
      for (const typeName of section.types) {
        if (!knownType(typeName)) warn(part, section.line, ext === undefined ? warnText(`unknown record type ${typeName}`, `неизвестный тип записи ${typeName}`, `未知记录类型 ${typeName}`) : unknownTypeHelp(typeName));
        let t = types.get(typeName);
        if (!t) {
          t = { name: typeName, fields: new Map(), conditions: [], owned: [], translate: [], sectionLines: [] };
          // A type of the game stays the game's even when a preload file names it first.
          if (ext !== undefined && !isItemTypeName(typeName)) t.extension = ext;
          types.set(typeName, t);
        }
        if (ext === undefined) t.sectionLines.push(section.line);
        for (const f of section.fields) {
          const prev = t.fields.get(f.name);
          if (!prev) {
            const field = ext === undefined ? f : { ...f, extension: ext };
            if (ext !== undefined) origin.set(field, part);
            t.fields.set(f.name, field);
          } else if (prev.kind !== f.kind || prev.targetType !== f.targetType || prev.enumName !== f.enumName) {
            if (ext === undefined) {
              const at = `${typeName}.${f.name}`;
              warn(part, f.line, warnText(
                `${at}: duplicate field of another kind (was ${prev.kind} on line ${prev.line})`,
                `${at}: повтор поля с другим видом (было ${prev.kind} в строке ${prev.line})`,
                `${at}：重复的字段类型不同（第 ${prev.line} 行为 ${prev.kind}）`,
              ));
            } else {
              const file = partOf(prev).source;
              const at = `${typeName}.${f.name}`;
              warn(part, f.line, warnText(
                `${at}: the field is already defined as ${prev.kind} (${file}, line ${String(prev.line)}); this definition is ignored`,
                `${at}: поле уже задано как ${prev.kind} (${file}, строка ${String(prev.line)}); это определение пропущено`,
                `${at}：该字段已定义为 ${prev.kind}（${file}，第 ${String(prev.line)} 行）；此定义已忽略`,
              ));
            }
          }
        }
        for (const c of section.conditions) {
          if (ext !== undefined) origin.set(c, part);
          t.conditions.push(c);
        }
        for (const o of section.owned) {
          if (t.owned.includes(o.category)) continue;
          t.owned.push(o.category);
          if (ext !== undefined) ownedFrom.set(`${typeName}\n${o.category}`, { part, line: o.line });
        }
        t.translate.push(...section.translate);
      }
    }
  }

  // Enums: the game's files as a map, then the built-in ones, then blocks from extensions.
  const parsedEnums = new Map<string, EnumDef>();
  let gameEnums: SchemaPart | undefined;
  for (const part of parts) {
    if (!part.enums || part.extension !== undefined) continue;
    gameEnums ??= part;
    for (const [name, e] of part.enums.enums) parsedEnums.set(name, e);
  }
  const enumMap = mergeBuiltinEnums(parsedEnums, (line, texts) => {
    warn(gameEnums ?? { source: 'fcs_enums.def' }, line, texts);
  });
  const emptyBlocks = new Map<string, { part: SchemaPart; line: number }>();
  for (const part of parts) {
    const ext = part.extension;
    if (!part.enums || ext === undefined) continue;
    for (const block of part.enums.blocks) {
      if (block.name === ITEM_TYPE_ENUM) continue;
      // `mergeBuiltinEnums` returns fresh objects, so appending here does not touch parsed files.
      let e = enumMap.get(block.name);
      if (!e) {
        e = { name: block.name, shared: block.shared, values: [], line: block.line, extension: ext };
        enumMap.set(block.name, e);
        emptyBlocks.set(block.name, { part, line: block.line });
      }
      for (const v of block.values) {
        const i = e.values.findIndex((x) => x.name === v.name);
        if (i >= 0) {
          const old = e.values[i]!;
          if (old.value === v.value) continue;
          const at = `${block.name}.${v.name}`;
          warn(part, block.line, warnText(
            `${at}: already defined with number ${String(old.value)}; the number ${String(v.value)} from this file replaces it`,
            `${at}: уже задано с номером ${String(old.value)}; номер ${String(v.value)} из этого файла его заменяет`,
            `${at}：已定义为编号 ${String(old.value)}；此文件中的编号 ${String(v.value)} 将替换它`,
          ));
          e.values[i] = { ...v, extension: ext };
          continue;
        }
        const clash = e.values.find((x) => x.value === v.value && x.extension !== ext);
        if (clash) {
          const at = `${block.name}.${v.name}=${String(v.value)}`;
          warn(part, block.line, warnText(`${at}: the number is already used by ${clash.name}`, `${at}: этот номер уже занят ${clash.name}`, `${at}：该编号已被 ${clash.name} 使用`));
        }
        e.values.push({ ...v, extension: ext });
      }
    }
  }
  for (const [name, at] of emptyBlocks) {
    if (enumMap.get(name)!.values.length > 0) continue;
    warn(at.part, at.line, warnText(
      `enum ${name} has no values: FCS Extended fills an empty block from an enum built into FCS, which Cactus does not know`,
      `в enum ${name} нет значений: FCS Extended заполняет пустой блок из встроенного в FCS enum, которого Cactus не знает`,
      `enum ${name} 没有值：FCS Extended 会用 FCS 内置的 enum 填充空块，而 Cactus 不知道该 enum`,
    ));
  }
  addBuiltinFields(types, enumMap);

  // Cross-checks.
  const haveEnums = parts.some((p) => p.enums !== undefined);
  const externalEnums = new Map<string, string[]>();
  for (const t of types.values()) {
    for (const f of t.fields.values()) {
      if (f.kind === 'enum' && haveEnums) {
        const e = enumMap.get(f.enumName!);
        if (!e) {
          const users = externalEnums.get(f.enumName!) ?? [];
          users.push(`${t.name}.${f.name}`);
          externalEnums.set(f.enumName!, users);
        } else if (!e.values.some((v) => v.name === f.default)) {
          const at = `${t.name}.${f.name}`;
          warn(partOf(f), f.line, warnText(`${at}: ${f.enumName} has no value ${String(f.default)}`, `${at}: в ${f.enumName} нет значения ${String(f.default)}`, `${at}：${f.enumName} 中没有值 ${String(f.default)}`));
        }
      }
      if (f.targetType !== undefined && !knownType(f.targetType)) {
        const at = `${t.name}.${f.name}`;
        warn(partOf(f), f.line, warnText(`${at}: unknown reference type ${f.targetType}`, `${at}: неизвестный тип ссылки ${f.targetType}`, `${at}：未知引用类型 ${f.targetType}`));
      }
    }
    for (const c of t.conditions) {
      if (!findField(t, c.field)) warn(partOf(c), c.line, warnText(`${t.name}: condition for the unknown field “${c.field}”`, `${t.name}: условие для неизвестного поля «${c.field}»`, `${t.name}：条件针对未知字段“${c.field}”`));
      if (!findField(t, c.dependsOn)) warn(partOf(c), c.line, warnText(`${t.name}: condition depends on the unknown field “${c.dependsOn}”`, `${t.name}: условие зависит от неизвестного поля «${c.dependsOn}»`, `${t.name}：条件依赖未知字段“${c.dependsOn}”`));
    }
    for (const o of t.owned) {
      const f = t.fields.get(o);
      if (f?.kind === 'reference') continue;
      const from = ownedFrom.get(`${t.name}\n${o}`);
      warn(from?.part ?? fallbackDef, from?.line ?? t.sectionLines[0] ?? 0, warnText(`${t.name}: OWNED ${o} is not a reference field`, `${t.name}: OWNED ${o} — не поле-ссылка`, `${t.name}：OWNED ${o} 不是引用字段`));
    }
  }

  const layoutParts = parts.filter((p) => p.layout !== undefined);
  for (const part of layoutParts) {
    for (const node of walkLayout(part.layout!.roots)) {
      if (!knownType(node.type)) warn(part, node.line, warnText(`unknown type ${node.type}`, `неизвестный тип ${node.type}`, `未知类型 ${node.type}`));
      const t = types.get(node.type);
      for (const flt of node.filters) {
        if (t && !findField(t, flt.field)) warn(part, node.line, warnText(`${node.type}: filter by the unknown field “${flt.field}”`, `${node.type}: фильтр по неизвестному полю «${flt.field}»`, `${node.type}：按未知字段“${flt.field}”筛选`));
      }
    }
  }
  // The game's own tree is passed through as is; trees of extensions are tagged copies.
  const tagged = (node: LayoutNode, extension: string): LayoutNode => ({ ...node, extension, children: node.children.map((c) => tagged(c, extension)) });
  const layout: LayoutNode[] =
    layoutParts.length === 1 && layoutParts[0]!.extension === undefined
      ? layoutParts[0]!.layout!.roots
      : layoutParts.flatMap((p) => (p.extension === undefined ? p.layout!.roots : p.layout!.roots.map((n) => tagged(n, p.extension!))));

  const extensions = [...new Set(parts.flatMap((p) => (p.extension !== undefined ? [p.extension] : [])))];
  return { types, enums: enumMap, layout, externalEnums, warnings, itemTypes, ...(extensions.length > 0 ? { extensions } : {}) };
}

function labelled(enumName: string, v: EnumValue): EnumValue {
  const label = BUILTIN_ENUM_LABELS[enumName]?.[v.name];
  return label !== undefined ? { ...v, label } : v;
}

/** Enums from `builtin-enums.ts` on top of fcs_enums.def; the parsed data is not changed. */
function mergeBuiltinEnums(parsed: ReadonlyMap<string, EnumDef>, warn: (line: number, texts: UiText) => void): Map<string, EnumDef> {
  const out = new Map<string, EnumDef>();
  for (const [name, e] of parsed) out.set(name, { ...e, values: e.values.map((v) => labelled(name, v)) });
  for (const [name, names] of Object.entries(BUILTIN_ENUMS)) {
    const e = out.get(name);
    if (!e) {
      out.set(name, { name, shared: false, line: 0, builtin: true, values: names.map((n, value) => labelled(name, { name: n, value })) });
      continue;
    }
    if (!e.shared) continue;
    // `enum shared`: numbers by name from C#, order and descriptions from the file.
    const seen = new Set<string>();
    const values: EnumValue[] = [];
    for (const v of e.values) {
      const value = names.indexOf(v.name);
      if (value < 0) {
        warn(e.line, warnText(
          `${name}: value ${v.name} is not in the FCS enum, numbered by its order in the file`,
          `${name}: значения ${v.name} нет в enum'е FCS — номер по порядку в файле`,
          `${name}：值 ${v.name} 不在 FCS 的 enum 中，按文件中的顺序编号`,
        ));
        values.push(v);
      } else values.push({ ...v, value });
      seen.add(v.name);
    }
    for (const [value, n] of names.entries()) if (!seen.has(n)) values.push(labelled(name, { name: n, value }));
    out.set(name, { ...e, values });
  }
  return out;
}

/** Fields from `BUILTIN_FIELD_ENUMS` for types absent from fcs.def (DIALOG_ACTION). */
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

/** Parse file texts and build the schema. */
export function parseGameSchema(sources: SchemaSources): GameSchema {
  return buildGameSchema(
    parseFcsDef(sources.fcsDef),
    sources.fcsEnums !== undefined ? parseFcsEnums(sources.fcsEnums) : undefined,
    sources.fcsLayout !== undefined ? parseFcsLayout(sources.fcsLayout) : undefined,
  );
}

/**
 * Field by a key from the data. Handles repeating fields (`looped`): the key `text3`
 * finds the description of `text0`.
 */
export function findField(type: TypeSchema, key: string): FieldDef | undefined {
  const exact = type.fields.get(key);
  if (exact) return exact;
  const m = /^(.*?)(\d+)$/.exec(key);
  if (!m) return undefined;
  const base = type.fields.get(`${m[1]!}0`);
  return base?.looped ? base : undefined;
}

/** The record dictionary that stores a value of this field kind. */
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
