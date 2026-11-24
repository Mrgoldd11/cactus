/**
 * Rows of the «Tree (as in FCS)» view of a dialogue graph (UI review G5): the same graph read top to
 * bottom like a script. Every node is shown once, under the first branch that reaches it (depth-first,
 * children in the order of the parent's references). A link to a node shown in another place becomes a
 * short link row: `loop` — back up to an ancestor of the row, `shared` — to a line that several branches
 * share. Folded nodes hide what is under them. Reads the graph only.
 */
import type { DialogueGraph, DialogueGraphEdge } from './dialogue-graph.ts';

export interface DialogueTreeRow {
  /** Node id; for a link row — the node the link goes to. */
  id: string;
  depth: number;
  /** The row this one hangs under (absent at the root). */
  parent?: string;
  /** Graph edge that leads to this row (absent at the root). */
  edge?: string;
  /** A link to a node shown in another place instead of the node itself. */
  link?: 'loop' | 'shared';
  /** Rows directly under this one (children and links), folded or not. */
  kids: number;
  /** Has kids, and they are hidden. */
  folded: boolean;
}

/** Outgoing edges of each node in the order of the source's references. */
export function dialogueEdgesBySource(graph: DialogueGraph): Map<string, DialogueGraphEdge[]> {
  const out = new Map<string, DialogueGraphEdge[]>();
  for (const e of graph.edges) {
    const list = out.get(e.source);
    if (list) list.push(e);
    else out.set(e.source, [e]);
  }
  for (const list of out.values()) list.sort((a, b) => a.order - b.order);
  return out;
}

/** Tree rows of the graph with the `folded` nodes closed. */
export function dialogueTreeRows(graph: DialogueGraph, folded: ReadonlySet<string> = new Set()): DialogueTreeRow[] {
  const bySource = dialogueEdgesBySource(graph);
  const known = new Set(graph.nodes.map((n) => n.id));
  // Who is shown as a whole row: the first time depth-first reaches it.
  const placed = new Set<string>();
  const rows: DialogueTreeRow[] = [];
  const path = new Set<string>();
  const walk = (id: string, depth: number, parent: string | undefined, edge: string | undefined, hidden: boolean): void => {
    const linkKind = path.has(id) ? 'loop' : placed.has(id) ? 'shared' : undefined;
    if (linkKind !== undefined) {
      if (!hidden) rows.push({ id, depth, ...(parent !== undefined ? { parent } : {}), ...(edge !== undefined ? { edge } : {}), link: linkKind, kids: 0, folded: false });
      return;
    }
    placed.add(id);
    const out = (bySource.get(id) ?? []).filter((e) => known.has(e.target));
    const isFolded = out.length > 0 && folded.has(id);
    if (!hidden) rows.push({ id, depth, ...(parent !== undefined ? { parent } : {}), ...(edge !== undefined ? { edge } : {}), kids: out.length, folded: isFolded });
    path.add(id);
    // Hidden subtrees are still walked: a line placed there must not reappear as a whole row elsewhere.
    for (const e of out) walk(e.target, depth + 1, id, e.id, hidden || isFolded);
    path.delete(id);
  };
  if (known.has(graph.root)) walk(graph.root, 0, undefined, undefined, false);
  return rows;
}

/**
 * Lines whose children are folded at first: `depth` deep from the nearest dialogue (NPC line → answer →
 * reply), the outermost ones. Shared by the graph and the tree views.
 */
export function dialogueDeepFolds(graph: DialogueGraph, depth = 3): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, string[]>();
  for (const e of graph.edges) if (!e.back) kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string, d: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = byId.get(id);
    const at = n && n.type !== 'DIALOGUE_LINE' ? 0 : d;
    const ks = kids.get(id) ?? [];
    if (at >= depth && ks.length > 0) {
      out.add(id);
      return;
    }
    for (const k of ks) walk(k, at + 1);
  };
  walk(graph.root, 0);
  return out;
}

/** Rows above `id` in the tree (its parent first); empty if `id` is the root or not in the tree. */
export function dialogueTreeAncestors(graph: DialogueGraph, id: string): string[] {
  const rows = dialogueTreeRows(graph);
  const parent = new Map<string, string>();
  for (const r of rows) if (r.link === undefined && r.parent !== undefined) parent.set(r.id, r.parent);
  const out: string[] = [];
  const seen = new Set<string>([id]);
  for (let p = parent.get(id); p !== undefined && !seen.has(p); p = parent.get(p)) {
    seen.add(p);
    out.push(p);
  }
  return out;
}
