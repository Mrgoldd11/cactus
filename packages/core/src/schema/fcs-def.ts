/**
 * Parser of `fcs.def` — the record field descriptions FCS uses.
 *
 * File structure:
 * ```
 * [TYPE]  or  [TYPE1,TYPE2, TYPE3]       — section for one or several record types
 * category:                               — field group header (no value)
 * field name:  <value> [modifiers] "description"
 * condition "field" if "other" is Enum.A or Enum.B   — when to show the field
 * OWNED: lines                            — reference category whose entries are "owned" by this record
 * TRANSLATE: ALL | NAME | FIELDS [if ...] — what in the record is translated
 * // comment
 * ```
 * Values: `True`/`False`, integer, fractional (`1.0`), `"string"`, `"Ogre mesh|*.mesh"` (file
 * with a filter), `TEXTURE_DDS`/`TEXTURE_ANY` (texture file), `#RRGGBB` (color), `Enum.VALUE`,
 * `TYPE` or `TYPE (v0, v1, v2)` (reference with default values), `TYPE (x,y,z) (w,x,y,z)`
 * (instances), `null`. Modifiers: `looped` (the field repeats: text0, text1, …),
 * `multiline`, `bitset`, `SINGLE` (a reference list of at most one entry), `REQUIRED`.
 */

import type { UiText } from '../ui-text.ts';

export type FieldKind =
  | 'bool'
  | 'int'
  | 'float'
  | 'string'
  | 'file'
  | 'color'
  | 'enum'
  | 'reference'
  | 'instance'
  | 'null'
  // fcs.def has no vectors; these kinds appear only on fields inferred from data.
  | 'vec3'
  | 'vec4';

export interface FieldDef {
  name: string;
  kind: FieldKind;
  /** Default value: bool/int/float/string/color (as a number), enum — the value name. */
  default?: boolean | number | string;
  /** Description with `\n` expanded. */
  description?: string;
  /** Group (the `category:` header above the field). */
  category?: string;
  /** For enum: the enum name from `fcs_enums.def`. */
  enumName?: string;
  /** For reference/instance: the record type the field references. */
  targetType?: string;
  /** For reference: default v0..v2 values; length = how many values are used. */
  refDefaults?: number[];
  /** For instance: default position and rotation. */
  instanceDefaults?: { position: number[]; rotation: number[] };
  /** For file: the file-picker filter (`Ogre mesh|*.mesh`) or `TEXTURE_DDS`/`TEXTURE_ANY`. */
  fileFilter?: string;
  looped?: boolean;
  multiline?: boolean;
  bitset?: boolean;
  /**
   * Reference list limit (`SINGLE` modifier = 1). FCS reports a list with more entries as an error;
   * the vanilla fcs.def uses none, FCS Extended files may.
   */
  limit?: number;
  /** `REQUIRED` modifier: FCS treats the reference as mandatory. Kept for display only. */
  required?: boolean;
  /** The field is not described in fcs.def but inferred from data (`withInferredFields`). */
  inferred?: boolean;
  /** The field is not described in fcs.def but known from FCS (`builtin-enums.ts`). */
  builtin?: boolean;
  /** Schema extension (mod folder name) that added the field; absent for the game's own fields. */
  extension?: string;
  /** Line number in fcs.def (1-based); 0 for inferred fields. */
  line: number;
}

export interface FieldCondition {
  /** A field whose visibility depends on a condition. */
  field: string;
  /** The field whose value it depends on. */
  dependsOn: string;
  negate: boolean;
  /** Allowed values (joined by `or`), as in the file: `MapFeatureMode.FOLIAGE`, `False`. */
  values: string[];
  line: number;
}

export interface TranslateRule {
  /** ALL — name and string fields, NAME — name only, FIELDS — fields only. */
  mode: string;
  /** Condition as in the file (`named is false`), if any. */
  condition?: string;
  line: number;
}

export interface FcsSection {
  types: string[];
  line: number;
  fields: FieldDef[];
  conditions: FieldCondition[];
  owned: { category: string; line: number }[];
  translate: TranslateRule[];
  /** Group headers in order of appearance. */
  categories: string[];
}

export interface ParseWarning {
  line: number;
  /** English text (MCP, logs). */
  message: string;
  /** The text in every interface language (the window). */
  texts: UiText;
  text: string;
}

/** Warning text in every interface language; `message` of the warning is its English one. */
export function warnText(en: string, ru: string, zh: string): UiText {
  return { en, ru, zh };
}

/** `message` and `texts` of a warning at once. */
export function warnTexts(en: string, ru: string, zh: string): { message: string; texts: UiText } {
  return { message: en, texts: warnText(en, ru, zh) };
}

export interface FcsDef {
  sections: FcsSection[];
  warnings: ParseWarning[];
}

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/;
const ENUM_RE = /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/;
const TYPE_RE = /^[A-Z][A-Z0-9_]*$/;
const TEXTURE_KINDS = new Set(['TEXTURE_DDS', 'TEXTURE_ANY']);
const MODIFIERS = new Set(['looped', 'multiline', 'bitset', 'single', 'required']);

export function unescapeDescription(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function parseNumberList(s: string): number[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map(Number);
}

/** Parse a field value (everything after the colon). Returns undefined if the value is not recognized. */
function parseFieldValue(raw: string, name: string, line: number): FieldDef | UiText {
  let rest = raw.trim();
  const def: FieldDef = { name, kind: 'null', line };

  // 1. Main value.
  let token: string;
  let quoted: string | undefined;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end < 0) return warnText('unclosed quote in the value', 'незакрытая кавычка в значении', '值中的引号未闭合');
    quoted = rest.slice(1, end);
    token = '';
    rest = rest.slice(end + 1);
  } else {
    const m = /^[^\s("]+/.exec(rest);
    token = m ? m[0] : '';
    rest = rest.slice(token.length);
  }

  // 2. Parenthesized groups: (0, 24,0) and (1,0,0,0).
  const groups: number[][] = [];
  for (;;) {
    const m = /^\s*\(([^)]*)\)/.exec(rest);
    if (!m) break;
    groups.push(parseNumberList(m[1]!));
    rest = rest.slice(m[0].length);
  }

  // 3. Modifiers before the description.
  for (;;) {
    // FCS compares modifiers case-insensitively (`SINGLE`, `REQUIRED` are written in capitals).
    const m = /^\s*([A-Za-z]+)\b/.exec(rest);
    const mod = m?.[1]?.toLowerCase();
    if (!m || mod === undefined || !MODIFIERS.has(mod)) break;
    if (mod === 'single') def.limit = 1;
    else def[mod as 'looped' | 'multiline' | 'bitset' | 'required'] = true;
    rest = rest.slice(m[0].length);
  }

  // 4. Description: from the first to the last quote (unescaped quotes occur inside).
  rest = rest.trim();
  if (rest.length > 0) {
    const first = rest.indexOf('"');
    const last = rest.lastIndexOf('"');
    if (first !== 0 || last <= first) return warnText(`could not parse the end of the value: ${rest}`, `не разобран хвост значения: ${rest}`, `无法解析值的结尾：${rest}`);
    def.description = unescapeDescription(rest.slice(first + 1, last));
  }

  // 5. Field kind.
  if (quoted !== undefined) {
    if (quoted.includes('|') && quoted.includes('*')) {
      def.kind = 'file';
      def.fileFilter = quoted;
    } else {
      def.kind = 'string';
      def.default = quoted;
    }
  } else if (token === 'True' || token === 'False') {
    def.kind = 'bool';
    def.default = token === 'True';
  } else if (INT_RE.test(token)) {
    def.kind = 'int';
    def.default = Number(token);
  } else if (FLOAT_RE.test(token)) {
    def.kind = 'float';
    def.default = Number(token);
  } else if (/^#[0-9A-Fa-f]{6}$/.test(token)) {
    def.kind = 'color';
    def.default = parseInt(token.slice(1), 16);
  } else if (TEXTURE_KINDS.has(token)) {
    def.kind = 'file';
    def.fileFilter = token;
  } else if (ENUM_RE.test(token)) {
    def.kind = 'enum';
    const dot = token.indexOf('.');
    def.enumName = token.slice(0, dot);
    def.default = token.slice(dot + 1);
  } else if (token === 'null') {
    def.kind = 'null';
  } else if (TYPE_RE.test(token)) {
    def.targetType = token;
    if (groups.length >= 2) {
      def.kind = 'instance';
      def.instanceDefaults = { position: groups[0]!, rotation: groups[1]! };
    } else {
      def.kind = 'reference';
      if (groups.length === 1) def.refDefaults = groups[0]!;
    }
  } else {
    return warnText(`unknown value “${token}”`, `неизвестное значение «${token}»`, `未知的值“${token}”`);
  }
  if (def.kind !== 'reference' && def.kind !== 'instance' && groups.length > 0) {
    return warnText('brackets on a field that is not a reference', 'скобки у поля, которое не является ссылкой', '非引用字段带有括号');
  }
  return def;
}

const CONDITION_RE = /^condition\s+"([^"]*)"\s+if\s+"([^"]*)"\s+(is|not)\s+(.+)$/;

export function parseFcsDef(text: string): FcsDef {
  const sections: FcsSection[] = [];
  const warnings: ParseWarning[] = [];
  let current: FcsSection | undefined;
  let category: string | undefined;

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    const warn = (texts: UiText): void => {
      warnings.push({ line: lineNo, message: texts.en, texts, text: line });
    };
    if (trimmed === '' || trimmed.startsWith('//')) return;

    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      const types = sectionMatch[1]!
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      current = { types, line: lineNo, fields: [], conditions: [], owned: [], translate: [], categories: [] };
      sections.push(current);
      category = undefined;
      return;
    }
    if (!current) {
      warn(warnText('line before the first section', 'строка до первой секции', '第一个分节之前的行'));
      return;
    }

    const cond = CONDITION_RE.exec(trimmed);
    if (cond) {
      current.conditions.push({
        field: cond[1]!,
        dependsOn: cond[2]!,
        negate: cond[3] === 'not',
        values: cond[4]!
          .split(/\s+or\s+/)
          .map((v) => v.trim().replace(/^"(.*)"$/, '$1')),
        line: lineNo,
      });
      return;
    }

    const colon = line.indexOf(':');
    if (colon < 0) {
      warn(warnText('line without a colon', 'строка без двоеточия', '没有冒号的行'));
      return;
    }
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (value === '') {
      category = name;
      current.categories.push(name);
      return;
    }
    if (name === 'OWNED') {
      current.owned.push({ category: value, line: lineNo });
      return;
    }
    if (name === 'TRANSLATE') {
      const m = /^(\w+)(?:\s+if\s+(.+))?$/.exec(value);
      if (!m) {
        warn(warnText('could not parse the TRANSLATE rule', 'не разобрано правило TRANSLATE', '无法解析 TRANSLATE 规则'));
        return;
      }
      const rule: TranslateRule = { mode: m[1]!, line: lineNo };
      if (m[2]) rule.condition = m[2];
      current.translate.push(rule);
      return;
    }

    const parsed = parseFieldValue(value, name, lineNo);
    if ('en' in parsed) {
      warn(parsed);
      return;
    }
    if (category !== undefined) parsed.category = category;
    current.fields.push(parsed);
  });

  return { sections, warnings };
}
