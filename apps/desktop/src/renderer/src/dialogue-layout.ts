/**
 * Раскладка графа диалога слева направо: столбец — глубина узла, внутри столбца узлы идут в
 * порядке обхода дерева (без обратных рёбер), родитель — по центру своих потомков.
 * Высота узла оценивается по числу строк текста.
 */
import type { DialogueGraph, DialogueGraphNode } from '@kenshi-editor/core';

export const NODE_WIDTH = 300;
const COLUMN_GAP = 90;
const ROW_GAP = 18;
const CHARS_PER_LINE = 42;

export interface Placed {
  x: number;
  y: number;
  height: number;
}

/** Оценка высоты карточки узла (px). */
export function nodeHeight(n: DialogueGraphNode, maxTexts: number): number {
  let lines = 1;
  for (const t of n.texts.slice(0, maxTexts)) lines += Math.min(4, Math.ceil(Math.max(1, (t.ru ?? t.en).length) / CHARS_PER_LINE));
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
  const out = new Map<string, Placed>();
  let cursor = 0;
  const place = (id: string): { top: number; bottom: number } => {
    const n = byId.get(id)!;
    const h = nodeHeight(n, maxTexts);
    const x = n.depth * (NODE_WIDTH + COLUMN_GAP);
    const children = kids.get(id) ?? [];
    if (children.length === 0) {
      const y = cursor;
      cursor += h + ROW_GAP;
      out.set(id, { x, y, height: h });
      return { top: y, bottom: y + h };
    }
    const spans = children.map(place);
    const top = spans[0]!.top;
    const bottom = spans[spans.length - 1]!.bottom;
    // Родитель по центру потомков, но не выше уже занятого места.
    const y = Math.max(top, (top + bottom) / 2 - h / 2);
    out.set(id, { x, y, height: h });
    if (y + h + ROW_GAP > cursor) cursor = y + h + ROW_GAP;
    return { top: Math.min(top, y), bottom: Math.max(bottom, y + h) };
  };
  place(graph.root);
  return out;
}
