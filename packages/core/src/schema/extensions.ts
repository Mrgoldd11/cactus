/**
 * Schema extensions: what FCS Extended (https://github.com/BFrizzleFoShizzle/FCS_extended) lets
 * a mod add to the editor's schema, read without running any of the mod's code.
 *
 * A mod folder may contain:
 * - `fcs.def` — loaded after the game's def files. One file may mix all three kinds of content:
 *   `enum` blocks, `[TYPE]` sections with fields and a `[FCS_LAYOUT]` tree.
 * - `fcs_preload.def` — the same, loaded before the game's def files.
 * - `<name>.def.patch` — regex patches for the text of the def file `<name>.def`.
 * - `FCS_extended.json` — a list of .NET plugins (DLLs) for FCS. Cactus never loads them; the
 *   names are only shown to the user.
 *
 * Nothing here touches the disk: `node/extensions.ts` finds and reads the files, this module
 * turns their texts into schema parts and builds the schema (`buildGameSchemaFromParts`).
 * The game's own files are parsed once (`prepareSchemaBase`) and reused for every mod; they
 * are parsed again only when a patch changes their text.
 */
import { compileDotnetRegex, type DotnetRegex } from './dotnet-regex.ts';
import type { UiText } from '../ui-text.ts';
import { parseFcsDef, warnText, warnTexts, type FcsDef } from './fcs-def.ts';
import { parseFcsEnums, type FcsEnums } from './fcs-enums.ts';
import { parseFcsLayout, type FcsLayout } from './fcs-layout.ts';
import {
  buildGameSchema,
  buildGameSchemaFromParts,
  ITEM_TYPE_ENUM,
  type GameSchema,
  type ItemTypeDecl,
  type SchemaPart,
  type SchemaSources,
  type SchemaWarning,
} from './game-schema.ts';

export interface ExtensionFile {
  /** Full path, used as the source of warnings. */
  path: string;
  text: string;
}

export interface ExtensionPatchFile extends ExtensionFile {
  /** Name of the def file the patch is for: the patch file name without `.patch`, case as on disk. */
  target: string;
}

/** Everything one mod folder adds to the schema. */
export interface ExtensionLayer {
  /** Mod folder name. */
  name: string;
  dir?: string;
  def?: ExtensionFile;
  preload?: ExtensionFile;
  patches?: readonly ExtensionPatchFile[];
  /** DLL names from `FCS_extended.json`. Never loaded by Cactus. */
  plugins?: readonly string[];
}

/** The game's own schema files, parsed once. */
export interface SchemaBase {
  sources: SchemaSources;
  parsed: { def: FcsDef; enums?: FcsEnums; layout?: FcsLayout };
  /** The schema without extensions. */
  schema: GameSchema;
}

export function prepareSchemaBase(sources: SchemaSources): SchemaBase {
  const parsed: SchemaBase['parsed'] = { def: parseFcsDef(sources.fcsDef) };
  if (sources.fcsEnums !== undefined) parsed.enums = parseFcsEnums(sources.fcsEnums);
  if (sources.fcsLayout !== undefined) parsed.layout = parseFcsLayout(sources.fcsLayout);
  return { sources, parsed, schema: buildGameSchema(parsed.def, parsed.enums, parsed.layout) };
}

// ---------------------------------------------------------------------------------------------
// Mixed def files

export interface SplitDef {
  /** `[TYPE]` sections; every other line is blank, so line numbers match the original file. */
  def: string;
  /** `enum` blocks, the same way. */
  enums: string;
  /** Lines of `[FCS_LAYOUT]` sections, the same way. */
  layout: string;
  hasDef: boolean;
  hasEnums: boolean;
  hasLayout: boolean;
  /** Record type numbers from `// enum itemType { NAME=N }` comment lines. */
  itemTypeHints: ItemTypeDecl[];
}

const ENUM_START_RE = /^\s*enum\s+(?:shared\s+)?[A-Za-z_]\w*\s*(?:\{|\/\/|$)/;
const SECTION_RE = /^\[([^\]]*)\]$/;
const ITEM_TYPE_HINT_RE = new RegExp(`^\\s*//\\s*(enum\\s+${ITEM_TYPE_ENUM}\\s*\\{[^}]*\\})`);

/**
 * Cut a def file that mixes enums, type sections and layout into three texts for the three
 * existing parsers (`parseFcsEnums`, `parseFcsDef`, `parseFcsLayout`). Each text has as many
 * lines as the original, with the lines of the other two kinds blanked, so the parsers report
 * the original line numbers.
 *
 * Rules (as FCS reads a def file): a line starting with `enum` opens an enum that lasts until
 * its closing `}`; `[FCS_LAYOUT]` switches to layout lines; any other `[…]` line switches back
 * to type sections. Lines before the first `[…]` belong to type sections (the parser reports
 * them). Comment and empty lines are dropped, except inside enums, where a comment names a
 * group or describes a value.
 */
export function splitDefText(text: string): SplitDef {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const def: string[] = [];
  const enums: string[] = [];
  const layout: string[] = [];
  const out: SplitDef = { def: '', enums: '', layout: '', hasDef: false, hasEnums: false, hasLayout: false, itemTypeHints: [] };
  let mode: 'def' | 'layout' = 'def';
  let inEnum = false;

  lines.forEach((line, index) => {
    let toDef = '';
    let toEnums = '';
    let toLayout = '';
    const trimmed = line.trim();
    const comment = line.indexOf('//');
    const code = comment >= 0 ? line.slice(0, comment) : line;
    if (inEnum || ENUM_START_RE.test(line)) {
      toEnums = line;
      out.hasEnums = true;
      inEnum = !code.includes('}');
    } else if (trimmed === '') {
      // nothing
    } else if (trimmed.startsWith('//')) {
      const hint = ITEM_TYPE_HINT_RE.exec(line);
      if (hint) {
        for (const v of parseFcsEnums(hint[1]!).blocks[0]?.values ?? []) out.itemTypeHints.push({ name: v.name, value: v.value, line: index + 1 });
      }
    } else {
      const section = SECTION_RE.exec(trimmed);
      if (section) mode = section[1]!.trim() === 'FCS_LAYOUT' ? 'layout' : 'def';
      if (mode === 'layout') {
        toLayout = line;
        out.hasLayout = true;
      } else {
        toDef = line;
        out.hasDef = true;
      }
    }
    def.push(toDef);
    enums.push(toEnums);
    layout.push(toLayout);
  });
  out.def = def.join('\n');
  out.enums = enums.join('\n');
  out.layout = layout.join('\n');
  return out;
}

/** Parse one def file (possibly mixed) into a schema part. */
export function parseDefFile(source: string, text: string, extension?: string): SchemaPart {
  const split = splitDefText(text);
  const part: SchemaPart = { source };
  if (extension !== undefined) part.extension = extension;
  if (split.hasDef) part.def = parseFcsDef(split.def);
  if (split.hasEnums) part.enums = parseFcsEnums(split.enums, { allowRepeats: extension !== undefined });
  if (split.hasLayout) part.layout = parseFcsLayout(split.layout);
  if (split.itemTypeHints.length > 0) part.itemTypeHints = split.itemTypeHints;
  return part;
}

// ---------------------------------------------------------------------------------------------
// Patches

export interface PatchRule {
  /** Line of the regex in the patch file (from 1); the replacement is on the next line. */
  line: number;
  pattern: string;
  replacement: string;
}

export interface PatchFile {
  rules: PatchRule[];
  /** Line of the first non-empty line that is never read, because an empty line came before it. */
  ignoredFrom?: number;
}

/**
 * Read a `.def.patch` file the way FCS Extended does: pairs of lines "regex, replacement" until
 * the first empty line or the end of the file. A missing last replacement is an empty string.
 * A line of spaces is not empty: it is a regex.
 */
export function parsePatchFile(text: string): PatchFile {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const rules: PatchRule[] = [];
  let i = 0;
  while (i < lines.length && lines[i] !== '') {
    rules.push({ line: i + 1, pattern: lines[i]!, replacement: lines[i + 1] ?? '' });
    i += 2;
  }
  const rest = lines.findIndex((l, n) => n > i && l !== '');
  return rest >= 0 ? { rules, ignoredFrom: rest + 1 } : { rules };
}

/**
 * The def files Cactus reads. FCS Extended applies a patch to every def file it opens whose file
 * name equals the target, comparing case-sensitively: the game's file and the files of the same
 * name in all extensions (`fcs.def`, `fcs_preload.def`).
 */
const PATCH_TARGETS = ['fcs.def', 'fcs_enums.def', 'fcs_layout.def', 'fcs_preload.def'] as const;

interface CompiledPatch {
  regex: DotnetRegex;
  rule: PatchRule;
  file: ExtensionPatchFile;
  extension: string;
  /** How many file texts the patch changed. */
  hits: number;
}

// ---------------------------------------------------------------------------------------------
// Layers

/**
 * The schema of the game with extensions applied. Order, as in FCS Extended: patches of all
 * layers are collected first; then `fcs_preload.def` of every layer, the game's files, `fcs.def`
 * of every layer — each text patched before parsing. `layers` come in load order.
 *
 * With no layers the cached base schema is returned as is.
 */
export function applyExtensionLayers(base: SchemaBase, layers: readonly ExtensionLayer[]): GameSchema {
  if (layers.length === 0) return base.schema;

  const pre: SchemaWarning[] = [];
  const patches = new Map<string, CompiledPatch[]>();
  for (const layer of layers) {
    for (const file of layer.patches ?? []) {
      const warn = (line: number, texts: UiText, text = ''): void => {
        pre.push({ source: file.path, extension: layer.name, line, message: texts.en, texts, text });
      };
      if (!PATCH_TARGETS.some((t) => t === file.target)) {
        const near = PATCH_TARGETS.find((t) => t.toLowerCase() === file.target.toLowerCase());
        warn(
          0,
          near !== undefined
            ? warnText(
                `patch target "${file.target}" differs from "${near}" in letter case: FCS Extended compares names exactly and never applies this patch`,
                `цель патча "${file.target}" отличается от "${near}" регистром букв: FCS Extended сравнивает имена точно и этот патч не применит`,
                `补丁目标 "${file.target}" 与 "${near}" 的大小写不同：FCS Extended 精确比较名称，永远不会应用此补丁`,
              )
            : warnText(
                `patch target "${file.target}" is not a schema file; Cactus does not use this patch`,
                `цель патча "${file.target}" — не файл схемы; Cactus этот патч не использует`,
                `补丁目标 "${file.target}" 不是架构文件；Cactus 不使用此补丁`,
              ),
        );
        continue;
      }
      const parsed = parsePatchFile(file.text);
      if (parsed.ignoredFrom !== undefined) {
        warn(
          parsed.ignoredFrom,
          warnText(
            'lines after the first empty line are never read (FCS Extended stops at an empty line)',
            'строки после первой пустой строки не читаются (FCS Extended останавливается на пустой строке)',
            '第一个空行之后的行不会被读取（FCS Extended 在空行处停止）',
          ),
        );
      }
      for (const rule of parsed.rules) {
        const compiled = compileDotnetRegex(rule.pattern);
        if (!compiled.ok) {
          warn(
            rule.line,
            warnText(
              `the regular expression cannot be used in Cactus (${compiled.reason}); this patch is skipped`,
              `регулярное выражение нельзя использовать в Cactus (${compiled.reason}); патч пропущен`,
              `该正则表达式无法在 Cactus 中使用（${compiled.reason}）；已跳过此补丁`,
            ),
            rule.pattern,
          );
          continue;
        }
        const list = patches.get(file.target) ?? [];
        list.push({ regex: compiled.regex, rule, file, extension: layer.name, hits: 0 });
        patches.set(file.target, list);
      }
    }
  }

  /** The patched text, or undefined when no patch changes it. */
  const patched = (target: string, text: string): string | undefined => {
    let out = text;
    for (const p of patches.get(target) ?? []) {
      const next = p.regex.replace(out, p.rule.replacement);
      if (next !== out) p.hits++;
      out = next;
    }
    return out === text ? undefined : out;
  };

  const parts: SchemaPart[] = [];
  for (const layer of layers) {
    if (layer.preload) parts.push(parseDefFile(layer.preload.path, patched('fcs_preload.def', layer.preload.text) ?? layer.preload.text, layer.name));
  }

  // The game's files: the cached parse, or a fresh one when a patch changed the text. A patched
  // file goes through the splitter like an extension file, because a patch may add anything.
  const { sources, parsed } = base;
  const defText = patched('fcs.def', sources.fcsDef);
  parts.push(defText !== undefined ? parseDefFile('fcs.def', defText) : { source: 'fcs.def', def: parsed.def });
  if (sources.fcsEnums !== undefined && parsed.enums) {
    const text = patched('fcs_enums.def', sources.fcsEnums);
    parts.push(text !== undefined ? parseDefFile('fcs_enums.def', text) : { source: 'fcs_enums.def', enums: parsed.enums });
  }
  if (sources.fcsLayout !== undefined && parsed.layout) {
    const text = patched('fcs_layout.def', sources.fcsLayout);
    parts.push(text !== undefined ? parseDefFile('fcs_layout.def', text) : { source: 'fcs_layout.def', layout: parsed.layout });
  }

  for (const layer of layers) {
    if (layer.def) parts.push(parseDefFile(layer.def.path, patched('fcs.def', layer.def.text) ?? layer.def.text, layer.name));
  }

  for (const list of patches.values()) {
    for (const p of list) {
      if (p.hits > 0) continue;
      pre.push({
        source: p.file.path,
        extension: p.extension,
        line: p.rule.line,
        ...warnTexts(
          `the patch matched nothing in ${p.file.target}`,
          `патч ничего не нашёл в ${p.file.target}`,
          `补丁在 ${p.file.target} 中没有匹配到任何内容`,
        ),
        text: p.rule.pattern,
      });
    }
  }

  return { ...buildGameSchemaFromParts(parts, pre), extensions: layers.map((l) => l.name) };
}

/** Parse the game's files and apply extension layers in one call (tests and one-off use). */
export function parseExtendedSchema(sources: SchemaSources, layers: readonly ExtensionLayer[]): GameSchema {
  return applyExtensionLayers(prepareSchemaBase(sources), layers);
}
