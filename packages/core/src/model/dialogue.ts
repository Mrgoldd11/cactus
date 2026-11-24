/**
 * Dialogue trees: DIALOGUE_PACKAGE → (`dialogs`) DIALOGUE → (`lines`) DIALOGUE_LINE → ...
 * A record met again is not expanded a second time (dialogues can have cycles).
 */
import { decodeText } from '../text.ts';
import type { GameRecord } from '../format/types.ts';
import type { ModContext } from './context.ts';
import { describeDialogAction, formatEnumValue, getEnum, packageRefEvents, refValueEnum } from './enums.ts';
import { formatFieldValue, formatRecord, refLabel } from './present.ts';
import { SCALAR_DICTS, scalarMap } from './record-ops.ts';

/** Reference categories the tree follows. */
export const TREE_CATEGORIES = ['dialogs', 'lines'] as const;

export interface DialogueAction {
  stringId: string;
  name: string;
  /** DIALOG_ACTION record fields (`condition name`, `who`, `action name`, ...) and reference values. */
  fields: string[];
  /** Condition/effect as one line with enum names (`target: DC_RELATIONS < 20`). */
  text?: string;
}

export interface DialogueNode {
  stringId: string;
  type: string;
  name: string;
  /** text0, text1, ... */
  texts: string[];
  speaker?: number;
  /** Package event (the first of `events`), if the node is a package dialogue. */
  event?: number;
  /**
   * All package events of the `dialogs` reference (v0, v1, v2 without 0 and 100, `packageRefEvents`);
   * `[v0]` when none of them is an event.
   */
  events?: number[];
  /** DIALOGUE without lines (`lines` empty): says nothing in the game. */
  noLines?: boolean;
  conditions: DialogueAction[];
  effects: DialogueAction[];
  /** Other references: category → target labels. */
  refs: { category: string; targets: string[] }[];
  /** Other fields as text (`one at a time = true`, ...). */
  fields: string[];
  children: DialogueNode[];
  /** The record is already shown above: not expanded. */
  repeated?: boolean;
  /** The record does not exist. */
  missing?: boolean;
  /** Not expanded further because of limits. */
  truncated?: boolean;
}

export interface DialogueTreeOptions {
  maxDepth?: number;
  maxNodes?: number;
  /** Interface language of the condition and effect texts (default English). */
  lang?: string;
}

const SKIP_FIELDS = new Set(['speaker']);

function actions(ctx: ModContext, rec: GameRecord, category: string, lang: string): DialogueAction[] {
  return (rec.refs.get(category) ?? []).map((r) => {
    const a = ctx.get(r.target);
    const fields: string[] = [];
    if (a) {
      for (const dict of SCALAR_DICTS) for (const [k, v] of scalarMap(a, dict)) fields.push(`${k}=${formatFieldValue(ctx, a, dict, k, v)}`);
    }
    fields.push(`ref=${r.v0}/${r.v1}/${r.v2}`);
    const out: DialogueAction = { stringId: r.target, name: a ? decodeText(a.name) : '<нет>', fields };
    const text = describeDialogAction(ctx, r, category, lang);
    if (text !== undefined) out.text = text;
    return out;
  });
}

export function buildDialogueTree(ctx: ModContext, stringId: string, options: DialogueTreeOptions = {}): DialogueNode {
  const seen = new Set<string>();
  const maxDepth = options.maxDepth ?? Infinity;
  const maxNodes = options.maxNodes ?? Infinity;
  const lang = options.lang ?? 'en';
  let count = 0;
  const visit = (sid: string, depth: number, events?: number[]): DialogueNode => {
    const rec = ctx.get(sid);
    const node: DialogueNode = {
      stringId: sid,
      type: rec ? ctx.typeName(rec.type) : '?',
      name: rec ? decodeText(rec.name) : '',
      texts: [],
      conditions: [],
      effects: [],
      refs: [],
      fields: [],
      children: [],
    };
    if (events?.length) {
      node.event = events[0]!;
      node.events = events;
    }
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
    node.conditions = actions(ctx, rec, 'conditions', lang);
    node.effects = actions(ctx, rec, 'effects', lang);
    for (const [cat, list] of rec.refs) {
      if (cat === 'conditions' || cat === 'effects' || (TREE_CATEGORIES as readonly string[]).includes(cat) || list.length === 0) continue;
      node.refs.push({ category: cat, targets: list.map((r) => refLabel(ctx, r.target) + (r.v0 || r.v1 || r.v2 ? ` =${r.v0}/${r.v1}/${r.v2}` : '')) });
    }
    if (node.type === 'DIALOGUE' && (rec.refs.get('lines') ?? []).length === 0) node.noLines = true;
    const eventEnum = refValueEnum(ctx.schema, node.type, 'dialogs', 0) !== undefined;
    const refEvents = (r: { v0: number; v1: number; v2: number }): number[] => {
      const evs = packageRefEvents(r);
      return evs.length ? evs : [r.v0];
    };
    const children = TREE_CATEGORIES.flatMap((c) => (rec.refs.get(c) ?? []).map((r) => ({ target: r.target, events: c === 'dialogs' && eventEnum ? refEvents(r) : undefined })));
    if (children.length > 0 && (depth >= maxDepth || count >= maxNodes)) node.truncated = true;
    else for (const c of children) node.children.push(visit(c.target, depth + 1, c.events));
    return node;
  };
  return visit(stringId, 0);
}

export interface FormatTreeOptions {
  /** Like `kdata.py tree`: all fields and references of each record. */
  full?: boolean;
  /** Interface language of the texts (default English). */
  lang?: string;
}

/** Words of the dialogue tree text per interface language. */
const TREE_WORDS: Record<string, { event: string; missing: string; above: string; noLines: string; unexpanded: string }> = {
  en: { event: 'event', missing: '<no record', above: '(already above)', noLines: 'dialogue without lines (lines is empty) — says nothing in the game', unexpanded: '(not expanded)' },
  ru: { event: 'событие', missing: '<нет записи', above: '(уже выше)', noLines: 'диалог без реплик (lines пуст) — в игре ничего не скажет', unexpanded: '(не развёрнуто)' },
  zh: { event: '事件', missing: '<没有记录', above: '（已在上方）', noLines: '没有台词的对话（lines 为空）——游戏中什么也不会说', unexpanded: '（未展开）' },
};

function eventLabel(ctx: ModContext, events: readonly number[], lang: string): string {
  const def = refValueEnum(ctx.schema, 'DIALOGUE_PACKAGE', 'dialogs', 0);
  return `${(TREE_WORDS[lang] ?? TREE_WORDS.en!).event} ${events.map((e) => (def ? formatEnumValue(def, e, lang) : String(e))).join(', ')}`;
}

/** The tree as text, indented by two spaces per level. */
export function formatDialogueTree(ctx: ModContext, root: DialogueNode, options: FormatTreeOptions = {}): string[] {
  const out: string[] = [];
  const lang = options.lang ?? 'en';
  const w = TREE_WORDS[lang] ?? TREE_WORDS.en!;
  const walk = (n: DialogueNode, depth: number): void => {
    const pad = '  '.repeat(depth);
    const evs = n.events ?? (n.event !== undefined ? [n.event] : []);
    const ev = evs.length ? `[${eventLabel(ctx, evs, lang)}] ` : '';
    if (n.missing) {
      out.push(`${pad}${ev}${w.missing} ${n.stringId}>`);
      return;
    }
    if (n.repeated) {
      out.push(`${pad}${ev}↻ ${n.type} ${n.stringId} «${n.name}» ${w.above}`);
      return;
    }
    if (options.full) {
      const rec = ctx.get(n.stringId)!;
      const lines = formatRecord(ctx, rec, { hideCategories: [...TREE_CATEGORIES], lang });
      if (ev) lines[0] = ev + lines[0]!;
      out.push(...lines.map((l) => pad + l));
    } else {
      const who = n.speaker !== undefined ? ` speaker=${formatEnumValue(getEnum(ctx.schema, 'TalkerEnum')!, n.speaker, lang)}` : '';
      out.push(`${pad}${ev}${n.type} ${n.stringId} «${n.name}»${who}`);
      for (const t of n.texts) out.push(`${pad}  "${t}"`);
      if (n.fields.length) out.push(`${pad}  · ${n.fields.join(', ')}`);
      for (const c of n.conditions) out.push(`${pad}  ? ${c.text ?? `${c.name} ${c.fields.join(' ')}`} [${c.stringId}]`);
      for (const e of n.effects) out.push(`${pad}  ! ${e.text ?? `${e.name} ${e.fields.join(' ')}`} [${e.stringId}]`);
      for (const r of n.refs) out.push(`${pad}  → ${r.category}: ${r.targets.join('; ')}`);
    }
    if (n.noLines) out.push(`${pad}  ⚠ ${w.noLines}`);
    if (n.truncated) out.push(`${pad}  … ${w.unexpanded}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}
