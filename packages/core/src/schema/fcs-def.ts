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
 * `multiline`, `bitset`.
 */

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
  message: string;
  text: string;
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
const MODIFIERS = new Set(['looped', 'multiline', 'bitset']);

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
function parseFieldValue(raw: string, name: string, line: number): FieldDef | string {
  let rest = raw.trim();
  const def: FieldDef = { name, kind: 'null', line };

  // 1. Main value.
  let token: string;
  let quoted: string | undefined;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end < 0) return 'незакрытая кавычка в значении';
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
    const m = /^\s*([a-z]+)\b/.exec(rest);
    if (!m || !MODIFIERS.has(m[1]!)) break;
    def[m[1] as 'looped' | 'multiline' | 'bitset'] = true;
    rest = rest.slice(m[0].length);
  }

  // 4. Description: from the first to the last quote (unescaped quotes occur inside).
  rest = rest.trim();
  if (rest.length > 0) {
    const first = rest.indexOf('"');
    const last = rest.lastIndexOf('"');
    if (first !== 0 || last <= first) return `не разобран хвост значения: ${rest}`;
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
    return `неизвестное значение «${token}»`;
  }
  if (def.kind !== 'reference' && def.kind !== 'instance' && groups.length > 0) {
    return 'скобки у поля, которое не является ссылкой';
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
    const warn = (message: string): void => {
      warnings.push({ line: lineNo, message, text: line });
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
      warn('строка до первой секции');
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
      warn('строка без двоеточия');
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
        warn('не разобрано правило TRANSLATE');
        return;
      }
      const rule: TranslateRule = { mode: m[1]!, line: lineNo };
      if (m[2]) rule.condition = m[2];
      current.translate.push(rule);
      return;
    }

    const parsed = parseFieldValue(value, name, lineNo);
    if (typeof parsed === 'string') {
      warn(parsed);
      return;
    }
    if (category !== undefined) parsed.category = category;
    current.fields.push(parsed);
  });

  return { sections, warnings };
}
