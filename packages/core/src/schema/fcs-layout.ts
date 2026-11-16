/**
 * Parser of `fcs_layout.def` — the category tree in the FCS left panel:
 * ```
 * [FCS_LAYOUT]
 * Items:                 ITEM "item function!=ITEM_BOOK"
 * <TAB>Weapons:          WEAPON
 * <TAB><TAB>Models:      MATERIAL_SPECS_WEAPON
 * ```
 * Nesting is the number of tabs. The filter is conditions separated by `;`: `field==value`,
 * `field=value` (the same) or `field!=value`.
 */
import { warnTexts, type ParseWarning } from './fcs-def.ts';

export interface LayoutFilter {
  field: string;
  op: '==' | '!=';
  value: string;
}

export interface LayoutNode {
  label: string;
  type: string;
  filters: LayoutFilter[];
  children: LayoutNode[];
  line: number;
  /** Schema extension (mod folder name) that added the node; absent for the game's own nodes. */
  extension?: string;
}

export interface FcsLayout {
  roots: LayoutNode[];
  warnings: ParseWarning[];
}

export function parseLayoutFilter(text: string): LayoutFilter[] {
  return text
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((cond) => {
      const m = /^(.*?)\s*(!=|==|=)\s*(.*)$/.exec(cond);
      if (!m) return { field: cond, op: '==' as const, value: '' };
      return { field: m[1]!, op: m[2] === '!=' ? ('!=' as const) : ('==' as const), value: m[3]! };
    });
}

export function parseFcsLayout(text: string): FcsLayout {
  const roots: LayoutNode[] = [];
  const warnings: ParseWarning[] = [];
  const stack: LayoutNode[] = [];

  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const lineNo = index + 1;
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('//') || /^\[.*\]$/.test(trimmed)) return;
      const depth = /^\t*/.exec(raw)![0].length;
      const m = /^([^:]+):\s*([A-Z][A-Z0-9_]*)\s*(?:"([^"]*)")?\s*$/.exec(trimmed);
      if (!m) {
        warnings.push({ line: lineNo, ...warnTexts('line not parsed', 'строка не разобрана', '无法解析的行'), text: raw });
        return;
      }
      const node: LayoutNode = {
        label: m[1]!.trim(),
        type: m[2]!,
        filters: m[3] !== undefined ? parseLayoutFilter(m[3]) : [],
        children: [],
        line: lineNo,
      };
      if (depth > stack.length) {
        warnings.push({ line: lineNo, ...warnTexts('indent too deep', 'слишком глубокий отступ', '缩进过深'), text: raw });
      }
      stack.length = Math.min(depth, stack.length);
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
    });

  return { roots, warnings };
}

/** All tree nodes in traversal order. */
export function* walkLayout(nodes: readonly LayoutNode[]): Generator<LayoutNode> {
  for (const n of nodes) {
    yield n;
    yield* walkLayout(n.children);
  }
}
