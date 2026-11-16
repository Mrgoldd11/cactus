/**
 * Tree layout of a graph from left to right (shared by the dialogue graph and the stage 5 graphs): column —
 * node depth, within a column nodes follow the walk order, a parent is centred on its children.
 */

export interface Placed {
  x: number;
  y: number;
  height: number;
}

export interface TreeLayout {
  /** Column (card) width and gaps, px. */
  width: number;
  columnGap: number;
  rowGap: number;
  /** Node children (tree edges only, no back edges). */
  kids: (id: string) => readonly string[];
  depth: (id: string) => number;
  height: (id: string) => number;
}

/** Lay out trees from `roots` one after another, top to bottom. */
export function layoutTree(roots: readonly string[], o: TreeLayout): Map<string, Placed> {
  const out = new Map<string, Placed>();
  let cursor = 0;
  const place = (id: string): { top: number; bottom: number } => {
    const h = o.height(id);
    const x = o.depth(id) * (o.width + o.columnGap);
    const children = o.kids(id);
    if (children.length === 0) {
      const y = cursor;
      cursor += h + o.rowGap;
      out.set(id, { x, y, height: h });
      return { top: y, bottom: y + h };
    }
    const spans = children.map(place);
    const top = spans[0]!.top;
    const bottom = spans[spans.length - 1]!.bottom;
    // Parent centred on its children, but not above an already taken place.
    const y = Math.max(top, (top + bottom) / 2 - h / 2);
    out.set(id, { x, y, height: h });
    if (y + h + o.rowGap > cursor) cursor = y + h + o.rowGap;
    return { top: Math.min(top, y), bottom: Math.max(bottom, y + h) };
  };
  for (const r of roots) place(r);
  return out;
}

/**
 * Layout of an arbitrary graph (nodes may have several parents, cycles happen): a depth-first
 * walk tree from nodes without incoming edges (in `ids` order), other edges are cross edges.
 */
export function layoutForest(ids: readonly string[], edges: readonly { source: string; target: string }[], o: Omit<TreeLayout, 'kids' | 'depth'>): Map<string, Placed> {
  const known = new Set(ids);
  const out = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target) || e.source === e.target) continue;
    let list = out.get(e.source);
    if (!list) out.set(e.source, (list = []));
    list.push(e.target);
    incoming.add(e.target);
  }
  const depth = new Map<string, number>();
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  const walk = (id: string, d: number): void => {
    depth.set(id, d);
    const mine: string[] = [];
    for (const k of out.get(id) ?? []) {
      if (depth.has(k)) continue;
      mine.push(k);
      walk(k, d + 1);
    }
    kids.set(id, mine);
  };
  for (const id of ids) {
    if (incoming.has(id) || depth.has(id)) continue;
    roots.push(id);
    walk(id, 0);
  }
  // Cycles with no entry from outside.
  for (const id of ids) {
    if (depth.has(id)) continue;
    roots.push(id);
    walk(id, 0);
  }
  return layoutTree(roots, { ...o, kids: (id) => kids.get(id) ?? [], depth: (id) => depth.get(id) ?? 0 });
}
