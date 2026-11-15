/**
 * Раскладка графа диалога слева направо: столбец — глубина узла, внутри столбца узлы идут в
 * порядке обхода дерева (без обратных рёбер), родитель — по центру своих потомков.
 * Высота узла оценивается по числу строк текста.
 */
import type { DialogueGraph, DialogueGraphNode } from '@kenshi-editor/core';
import { layoutTree, type Placed } from './tree-layout.ts';

export type { Placed };

export const NODE_WIDTH = 300;
const COLUMN_GAP = 90;
const ROW_GAP = 18;
const CHARS_PER_LINE = 42;

/** Оценка высоты карточки узла (px). */
export function nodeHeight(n: DialogueGraphNode, maxTexts: number): number {
  let lines = 1;
  for (const t of n.texts.slice(0, maxTexts)) lines += Math.min(4, Math.ceil(Math.max(1, (t.localized ?? t.en).length) / CHARS_PER_LINE));
  if (n.texts.length > maxTexts) lines += 1;
  lines += n.conditions.length + n.filters.length + n.effects.length + n.issues.length;
  return 28 + lines * 17;
}

export function layoutDialogue(graph: DialogueGraph, maxTexts: number): Map<string, Placed> {
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
    height: (id) => nodeHeight(byId.get(id)!, maxTexts),
  });
}
