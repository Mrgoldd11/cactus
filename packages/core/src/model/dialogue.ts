/**
 * Деревья диалогов: DIALOGUE_PACKAGE → (`dialogs`) DIALOGUE → (`lines`) DIALOGUE_LINE → ...
 * Повторно встреченная запись не разворачивается второй раз (диалоги бывают с циклами).
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import type { ModContext } from './context.ts';
import { describeDialogAction, formatEnumValue, getEnum, refValueEnum } from './enums.ts';
import { formatFieldValue, formatRecord, refLabel } from './present.ts';
import { SCALAR_DICTS, scalarMap } from './record-ops.ts';

/** Категории ссылок, по которым идёт дерево. */
export const TREE_CATEGORIES = ['dialogs', 'lines'] as const;

export interface DialogueAction {
  stringId: string;
  name: string;
  /** Поля записи DIALOG_ACTION (`condition name`, `who`, `action name`, ...) и значения ссылки. */
  fields: string[];
  /** Условие/действие одной строкой с именами enum (`собеседник: DC_RELATIONS < 20`). */
  text?: string;
}

export interface DialogueNode {
  stringId: string;
  type: string;
  name: string;
  /** text0, text1, ... */
  texts: string[];
  speaker?: number;
  /** Событие пакета (v0 ссылки `dialogs` у DIALOGUE_PACKAGE), если узел — диалог пакета. */
  event?: number;
  /** DIALOGUE без реплик (`lines` пуст) — в игре ничего не скажет. */
  noLines?: boolean;
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
      for (const dict of SCALAR_DICTS) for (const [k, v] of scalarMap(a, dict)) fields.push(`${k}=${formatFieldValue(ctx, a, dict, k, v)}`);
    }
    fields.push(`ref=${r.v0}/${r.v1}/${r.v2}`);
    const out: DialogueAction = { stringId: r.target, name: a ? decodeText(a.name) : '<нет>', fields };
    const text = describeDialogAction(ctx, r, category);
    if (text !== undefined) out.text = text;
    return out;
  });
}

export function buildDialogueTree(ctx: ModContext, stringId: string, options: DialogueTreeOptions = {}): DialogueNode {
  const seen = new Set<string>();
  const maxDepth = options.maxDepth ?? Infinity;
  const maxNodes = options.maxNodes ?? Infinity;
  let count = 0;
  const visit = (sid: string, depth: number, event?: number): DialogueNode => {
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
    if (event !== undefined) node.event = event;
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
        else if (!SKIP_FIELDS.has(k)) node.fields.push(`${k}=${formatFieldValue(ctx, rec, dict, k, v)}`);
      }
    }
    node.conditions = actions(ctx, rec, 'conditions');
    node.effects = actions(ctx, rec, 'effects');
    for (const [cat, list] of rec.refs) {
      if (cat === 'conditions' || cat === 'effects' || (TREE_CATEGORIES as readonly string[]).includes(cat) || list.length === 0) continue;
      node.refs.push({ category: cat, targets: list.map((r) => refLabel(ctx, r.target) + (r.v0 || r.v1 || r.v2 ? ` =${r.v0}/${r.v1}/${r.v2}` : '')) });
    }
    if (node.type === 'DIALOGUE' && (rec.refs.get('lines') ?? []).length === 0) node.noLines = true;
    const eventEnum = refValueEnum(ctx.schema, node.type, 'dialogs', 0) !== undefined;
    const children = TREE_CATEGORIES.flatMap((c) => (rec.refs.get(c) ?? []).map((r) => ({ target: r.target, event: c === 'dialogs' && eventEnum ? r.v0 : undefined })));
    if (children.length > 0 && (depth >= maxDepth || count >= maxNodes)) node.truncated = true;
    else for (const c of children) node.children.push(visit(c.target, depth + 1, c.event));
    return node;
  };
  return visit(stringId, 0);
}

export interface FormatTreeOptions {
  /** Как `kdata.py tree`: все поля и ссылки каждой записи. */
  full?: boolean;
}

function eventLabel(ctx: ModContext, event: number): string {
  const def = refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
  return `событие ${def ? formatEnumValue(def, event) : String(event)}`;
}

/** Дерево текстом с отступами по два пробела на уровень. */
export function formatDialogueTree(ctx: ModContext, root: DialogueNode, options: FormatTreeOptions = {}): string[] {
  const out: string[] = [];
  const walk = (n: DialogueNode, depth: number): void => {
    const pad = '  '.repeat(depth);
    const ev = n.event !== undefined ? `[${eventLabel(ctx, n.event)}] ` : '';
    if (n.missing) {
      out.push(`${pad}${ev}<нет записи ${n.stringId}>`);
      return;
    }
    if (n.repeated) {
      out.push(`${pad}${ev}↻ ${n.type} ${n.stringId} «${n.name}» (уже выше)`);
      return;
    }
    if (options.full) {
      const rec = ctx.get(n.stringId)!;
      const lines = formatRecord(ctx, rec, { hideCategories: [...TREE_CATEGORIES] });
      if (ev) lines[0] = ev + lines[0]!;
      out.push(...lines.map((l) => pad + l));
    } else {
      const who = n.speaker !== undefined ? ` speaker=${formatEnumValue(getEnum(ctx.schema, 'TalkerEnum')!, n.speaker)}` : '';
      out.push(`${pad}${ev}${n.type} ${n.stringId} «${n.name}»${who}`);
      for (const t of n.texts) out.push(`${pad}  "${t}"`);
      if (n.fields.length) out.push(`${pad}  · ${n.fields.join(', ')}`);
      for (const c of n.conditions) out.push(`${pad}  ? ${c.text ?? `${c.name} ${c.fields.join(' ')}`} [${c.stringId}]`);
      for (const e of n.effects) out.push(`${pad}  ! ${e.text ?? `${e.name} ${e.fields.join(' ')}`} [${e.stringId}]`);
      for (const r of n.refs) out.push(`${pad}  → ${r.category}: ${r.targets.join('; ')}`);
    }
    if (n.noLines) out.push(`${pad}  ⚠ диалог без реплик (lines пуст) — в игре ничего не скажет`);
    if (n.truncated) out.push(`${pad}  … (не развёрнуто)`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}
