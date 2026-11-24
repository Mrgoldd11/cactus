/**
 * Transitions between dialogues (UI review G3): the line references that hand the talk over to another
 * dialogue (`interrupt`, `crowd trigger`) or change whether it can start (`unlocks`, `unlock but keep me`,
 * `locks`). The graph draws them as portal nodes: entries from other dialogues on the left, exits on the
 * right; the package list shows who unlocks a locked dialogue.
 *
 * The reverse index is the context back-reference index (`referencesTo`), filtered to these categories.
 */
import { itemTypeName } from '../format/item-types.ts';
import { lineDialogues } from '../dialog/when.ts';
import type { ModContext } from './context.ts';
import type { DialogueGraph } from './dialogue-graph.ts';

/** Transition reference categories, in the order they are listed on a portal. */
export const TRANSITION_KINDS = ['interrupt', 'crowd trigger', 'unlocks', 'unlock but keep me', 'locks'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

const KINDS: ReadonlySet<string> = new Set(TRANSITION_KINDS);
/** Categories that unlock the target dialogue. */
export const UNLOCK_KINDS: ReadonlySet<TransitionKind> = new Set(['unlocks', 'unlock but keep me']);

export function isTransitionKind(category: string): category is TransitionKind {
  return KINDS.has(category);
}

/** One line (or dialogue head) with the transitions it holds toward one dialogue. */
export interface TransitionLink {
  /** The record that holds the references: a DIALOGUE_LINE or a DIALOGUE. */
  line: string;
  kinds: TransitionKind[];
  /** `crowd trigger` value: % of the squad that picks the dialogue up. */
  crowd?: number;
}

/** A portal: the other dialogue and the lines that link this one with it. */
export interface DialoguePortal {
  /** The other dialogue (for an entry — where the lines are; for an exit — the target). */
  dialogue: string;
  lines: TransitionLink[];
  /** Union of the kinds of all lines, in `TRANSITION_KINDS` order. */
  kinds: TransitionKind[];
}

/** A transition between two lines of the same graph (e.g. a line that locks its own dialogue). */
export interface InnerTransition {
  line: string;
  /** The graph node the reference goes to (the dialogue head). */
  target: string;
  kinds: TransitionKind[];
}

export interface DialogueTransitions {
  /** Other dialogues whose lines lead into this one. */
  entries: DialoguePortal[];
  /** Dialogues the lines of this graph lead to. */
  exits: DialoguePortal[];
  /** Transitions whose target is a node of this graph (drawn as an arrow, not a portal). */
  inner: InnerTransition[];
}

function sortKinds(kinds: Iterable<TransitionKind>): TransitionKind[] {
  const set = new Set(kinds);
  return TRANSITION_KINDS.filter((k) => set.has(k));
}

/** Transition references a record holds: target → link. */
export function transitionsFrom(ctx: ModContext, sid: string): Map<string, TransitionLink> {
  const out = new Map<string, TransitionLink>();
  const rec = ctx.get(sid);
  if (!rec) return out;
  for (const [category, list] of rec.refs) {
    if (!isTransitionKind(category)) continue;
    for (const r of list) {
      const link = out.get(r.target) ?? { line: sid, kinds: [] };
      if (!link.kinds.includes(category)) link.kinds = sortKinds([...link.kinds, category]);
      if (category === 'crowd trigger') link.crowd = r.v0;
      out.set(r.target, link);
    }
  }
  return out;
}

/** Dialogues a transition source belongs to: itself for a DIALOGUE, the dialogues above a line. */
function sourceDialogues(ctx: ModContext, sid: string): string[] {
  const rec = ctx.get(sid);
  if (!rec) return [];
  if (itemTypeName(rec.type) === 'DIALOGUE') return [sid];
  return lineDialogues(ctx, sid);
}

/** Transition references that point at `dialogue`: source record → link (kinds toward `dialogue`). */
export function transitionsTo(ctx: ModContext, dialogue: string): TransitionLink[] {
  const bySource = new Map<string, TransitionLink>();
  for (const e of ctx.referencesTo(dialogue)) {
    if (!isTransitionKind(e.category)) continue;
    const link = bySource.get(e.source) ?? { line: e.source, kinds: [] };
    if (!link.kinds.includes(e.category)) link.kinds = sortKinds([...link.kinds, e.category]);
    if (e.category === 'crowd trigger' && e.ref) link.crowd = e.ref.v0;
    bySource.set(e.source, link);
  }
  return [...bySource.values()];
}

function addToPortal(portals: Map<string, DialoguePortal>, dialogue: string, link: TransitionLink): void {
  const p = portals.get(dialogue) ?? { dialogue, lines: [], kinds: [] };
  if (!p.lines.some((l) => l.line === link.line)) p.lines.push(link);
  p.kinds = sortKinds([...p.kinds, ...link.kinds]);
  portals.set(dialogue, p);
}

/**
 * Entries, exits and inner transitions of a dialogue graph. Entries come from the back-reference index
 * (lines outside the graph that point at the graph root); exits — from the references of graph nodes.
 * A source line that belongs to no dialogue is its own portal (`dialogue` = the line).
 */
export function dialogueTransitions(ctx: ModContext, graph: DialogueGraph): DialogueTransitions {
  const inGraph = new Set(graph.nodes.filter((n) => !n.missing).map((n) => n.id));
  const entries = new Map<string, DialoguePortal>();
  const exits = new Map<string, DialoguePortal>();
  const inner: InnerTransition[] = [];
  const root = ctx.get(graph.root);
  if (root && itemTypeName(root.type) === 'DIALOGUE') {
    for (const link of transitionsTo(ctx, graph.root)) {
      if (inGraph.has(link.line)) continue; // drawn as an inner transition below
      const owners = sourceDialogues(ctx, link.line).filter((d) => d !== graph.root);
      for (const d of owners.length > 0 ? owners : [link.line]) addToPortal(entries, d, link);
    }
  }
  for (const n of graph.nodes) {
    if (n.missing || (n.type !== 'DIALOGUE' && n.type !== 'DIALOGUE_LINE')) continue;
    for (const [target, link] of transitionsFrom(ctx, n.id)) {
      if (inGraph.has(target)) inner.push({ line: n.id, target, kinds: link.kinds });
      else addToPortal(exits, target, link);
    }
  }
  return { entries: [...entries.values()], exits: [...exits.values()], inner };
}

/** Who unlocks a dialogue: the dialogues (or stray lines) with `unlocks` / `unlock but keep me` toward it. */
export function dialogueUnlockers(ctx: ModContext, dialogue: string): string[] {
  const out: string[] = [];
  for (const link of transitionsTo(ctx, dialogue)) {
    if (!link.kinds.some((k) => UNLOCK_KINDS.has(k))) continue;
    const owners = sourceDialogues(ctx, link.line);
    for (const d of owners.length > 0 ? owners : [link.line]) if (d !== dialogue && !out.includes(d)) out.push(d);
  }
  return out;
}

/** Dialogues a dialogue unlocks: targets of `unlocks` / `unlock but keep me` held by its head or its lines. */
export function dialogueUnlocks(ctx: ModContext, dialogue: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [dialogue];
  while (queue.length > 0 && seen.size < 2000) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const rec = ctx.get(cur);
    if (!rec) continue;
    for (const [target, link] of transitionsFrom(ctx, cur))
      if (target !== dialogue && link.kinds.some((k) => UNLOCK_KINDS.has(k)) && !out.includes(target)) out.push(target);
    for (const r of rec.refs.get('lines') ?? []) queue.push(r.target);
  }
  return out;
}
