/**
 * Деревья диалогов: DIALOGUE_PACKAGE → (`dialogs`) DIALOGUE → (`lines`) DIALOGUE_LINE → ...
 * Повторно встреченная запись не разворачивается второй раз (диалоги бывают с циклами).
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import type { ModContext } from './context.ts';
import { formatRecord, formatScalar, refLabel } from './present.ts';
import { SCALAR_DICTS, scalarMap } from './record-ops.ts';

/** Категории ссылок, по которым идёт дерево. */
export const TREE_CATEGORIES = ['dialogs', 'lines'] as const;

export interface DialogueAction {
  stringId: string;
  name: string;
  /** Поля записи DIALOG_ACTION (`condition name`, `who`, `action name`, ...) и значения ссылки. */
  fields: string[];
}

export interface DialogueNode {
  stringId: string;
  type: string;
  name: string;
  /** text0, text1, ... */
  texts: string[];
  speaker?: number;
  conditions: DialogueAction[];
  effects: DialogueAction[];
  /** Прочие ссылки: категория → подписи целей. */
  refs: { category: string; targets: string[] }[];
  /** Прочие поля текстом (`one at a time = true`, ...). */
  fields: string[];
  children: DialogueNode[];
  /** Запись уже показана выше — не развёрнута. */
  repeated?: boolean;
  /** Записи нет. */
  missing?: boolean;
  /** Дальше не развёрнуто из-за ограничений. */
  truncated?: boolean;
}

export interface DialogueTreeOptions {
  maxDepth?: number;
  maxNodes?: number;
}

const SKIP_FIELDS = new Set(['speaker']);

function actions(ctx: ModContext, rec: GameRecord, category: string): DialogueAction[] {
  return (rec.refs.get(category) ?? []).map((r) => {
    const a = ctx.get(r.target);
    const fields: string[] = [];
    if (a) {
      for (const dict of SCALAR_DICTS) for (const [k, v] of scalarMap(a, dict)) fields.push(`${k}=${formatScalar(dict, v)}`);
    }
    fields.push(`ref=${r.v0}/${r.v1}/${r.v2}`);
    return { stringId: r.target, name: a ? decodeText(a.name) : '<нет>', fields };
  });
}

export function buildDialogueTree(ctx: ModContext, stringId: string, options: DialogueTreeOptions = {}): DialogueNode {
  const seen = new Set<string>();
  const maxDepth = options.maxDepth ?? Infinity;
  const maxNodes = options.maxNodes ?? Infinity;
  let count = 0;
  const visit = (sid: string, depth: number): DialogueNode => {
    const rec = ctx.get(sid);
    const node: DialogueNode = {
      stringId: sid,
      type: rec ? itemTypeName(rec.type) : '?',
      name: rec ? decodeText(rec.name) : '',
      texts: [],
      conditions: [],
      effects: [],
      refs: [],
      fields: [],
      children: [],
    };
    if (!rec) {
      node.missing = true;
      return node;
    }
    if (seen.has(sid)) {
      node.repeated = true;
      return node;
    }
    seen.add(sid);
    count++;
    for (const dict of SCALAR_DICTS) {
      for (const [k, v] of scalarMap(rec, dict)) {
        if (dict === 'strings' && /^text\d+$/.test(k)) node.texts.push(decodeText(v as Uint8Array));
        else if (k === 'speaker' && dict === 'ints') node.speaker = v as number;
        else if (!SKIP_FIELDS.has(k)) node.fields.push(`${k}=${formatScalar(dict, v)}`);
      }
    }
    node.conditions = actions(ctx, rec, 'conditions');
    node.effects = actions(ctx, rec, 'effects');
    for (const [cat, list] of rec.refs) {
      if (cat === 'conditions' || cat === 'effects' || (TREE_CATEGORIES as readonly string[]).includes(cat) || list.length === 0) continue;
      node.refs.push({ category: cat, targets: list.map((r) => refLabel(ctx, r.target) + (r.v0 || r.v1 || r.v2 ? ` =${r.v0}/${r.v1}/${r.v2}` : '')) });
    }
    const childIds = TREE_CATEGORIES.flatMap((c) => (rec.refs.get(c) ?? []).map((r) => r.target));
    if (childIds.length > 0 && (depth >= maxDepth || count >= maxNodes)) node.truncated = true;
    else for (const c of childIds) node.children.push(visit(c, depth + 1));
    return node;
  };
  return visit(stringId, 0);
}

export interface FormatTreeOptions {
  /** Как `kdata.py tree`: все поля и ссылки каждой записи. */
  full?: boolean;
}

/** Дерево текстом с отступами по два пробела на уровень. */
export function formatDialogueTree(ctx: ModContext, root: DialogueNode, options: FormatTreeOptions = {}): string[] {
  const out: string[] = [];
  const walk = (n: DialogueNode, depth: number): void => {
    const pad = '  '.repeat(depth);
    if (n.missing) {
      out.push(`${pad}<нет записи ${n.stringId}>`);
      return;
    }
    if (n.repeated) {
      out.push(`${pad}↻ ${n.type} ${n.stringId} «${n.name}» (уже выше)`);
      return;
    }
    if (options.full) {
      const rec = ctx.get(n.stringId)!;
      out.push(...formatRecord(ctx, rec, { hideCategories: [...TREE_CATEGORIES] }).map((l) => pad + l));
    } else {
      const who = n.speaker !== undefined ? ` speaker=${n.speaker}` : '';
      out.push(`${pad}${n.type} ${n.stringId} «${n.name}»${who}`);
      for (const t of n.texts) out.push(`${pad}  "${t}"`);
      if (n.fields.length) out.push(`${pad}  · ${n.fields.join(', ')}`);
      for (const c of n.conditions) out.push(`${pad}  ? ${c.name} [${c.stringId}] ${c.fields.join(' ')}`);
      for (const e of n.effects) out.push(`${pad}  ! ${e.name} [${e.stringId}] ${e.fields.join(' ')}`);
      for (const r of n.refs) out.push(`${pad}  → ${r.category}: ${r.targets.join('; ')}`);
    }
    if (n.truncated) out.push(`${pad}  … (не развёрнуто)`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}
