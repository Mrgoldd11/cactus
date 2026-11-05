/**
 * Раскладка графа деревом слева направо (общая для графа диалога и графов этапа 5): столбец —
 * глубина узла, внутри столбца узлы идут в порядке обхода, родитель — по центру своих потомков.
 */

export interface Placed {
  x: number;
  y: number;
  height: number;
}

export interface TreeLayout {
  /** Ширина столбца (карточки) и промежутки, px. */
  width: number;
  columnGap: number;
  rowGap: number;
  /** Дети узла (только рёбра дерева, без обратных). */
  kids: (id: string) => readonly string[];
  depth: (id: string) => number;
  height: (id: string) => number;
}

/** Разложить деревья от корней `roots` по очереди сверху вниз. */
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
    // Родитель по центру потомков, но не выше уже занятого места.
    const y = Math.max(top, (top + bottom) / 2 - h / 2);
    out.set(id, { x, y, height: h });
    if (y + h + o.rowGap > cursor) cursor = y + h + o.rowGap;
    return { top: Math.min(top, y), bottom: Math.max(bottom, y + h) };
  };
  for (const r of roots) place(r);
  return out;
}

/**
 * Раскладка произвольного графа (узлы могут иметь несколько родителей, бывают циклы): дерево
 * обхода в глубину от узлов без входящих рёбер (в порядке `ids`), остальные рёбра — поперечные.
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
  // Циклы без входа извне.
  for (const id of ids) {
    if (depth.has(id)) continue;
    roots.push(id);
    walk(id, 0);
  }
  return layoutTree(roots, { ...o, kids: (id) => kids.get(id) ?? [], depth: (id) => depth.get(id) ?? 0 });
}
