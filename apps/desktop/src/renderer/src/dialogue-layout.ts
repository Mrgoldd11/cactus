/**
 * Dialogue graph layout from left to right: column — node depth, within a column nodes follow the
 * tree walk order (without back edges), a parent is centred on its children.
 * Node height is the measured card height when the canvas reported it, otherwise an estimate.
 */
import type { DialogueGraph, DialogueGraphNode } from '@kenshi-editor/core';
import { layoutTree, type Placed } from './tree-layout.ts';

export type { Placed };

export const NODE_WIDTH = 300;
const COLUMN_GAP = 90;
// Room for the toolbar shown above a selected node.
const ROW_GAP = 32;
const CHARS_PER_LINE = 42;

/** Estimated node card height (px): one text shown, clamped to `maxLines` lines. */
export function nodeHeight(n: DialogueGraphNode, maxLines: number): number {
  let lines = 1;
  const first = n.texts[0];
  if (first) lines += Math.min(maxLines, Math.ceil(Math.max(1, (first.localized ?? first.en).length) / CHARS_PER_LINE));
  lines += n.conditions.length + n.filters.length + n.effects.length + n.issues.length;
  return 28 + lines * 17;
}

/** `measured` — card heights reported by the canvas (override the estimate). */
export function layoutDialogue(graph: DialogueGraph, maxLines: number, measured?: ReadonlyMap<string, number>): Map<string, Placed> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.back || !byId.has(e.target)) continue;
    const list = kids.get(e.source) ?? [];
    list.push(e.target);
    kids.set(e.source, list);
  }
  return layoutTree([graph.root], {
    width: NODE_WIDTH,
    columnGap: COLUMN_GAP,
    rowGap: ROW_GAP,
    kids: (id) => kids.get(id) ?? [],
    depth: (id) => byId.get(id)!.depth,
    height: (id) => measured?.get(id) ?? nodeHeight(byId.get(id)!, maxLines),
  });
}
