/**
 * Dialogue graph (DIALOGUE_PACKAGE, DIALOGUE, DIALOGUE_LINE) with editing: lines as nodes (speaker,
 * Russian texts from the game translation, conditions, effects, score and chance), `dialogs`/`lines` references
 * as edges, loops dashed.
 *
 * Editing right in the graph:
 * - right-click on a node, edge or empty space — effect menu (edit text, add answer or
 *   line, link, copy, delete, insert line between, restore as in game…);
 * - double-click or F2 — text right in the node (Enter — save, Esc — cancel);
 * - Delete — delete selection (lines and links), Ctrl+D — copy, Ctrl+C/Ctrl+V — copy
 *   and paste, Shift+box or Ctrl+click — multi-select, Esc — clear selection;
 * - «+» on a node — new answer or line; drag from a node's right edge to another — link.
 * Everything goes through core commands: one edit — one undo (Ctrl+Z / Ctrl+Y).
 * A node shows who speaks (yellow stripe — NPC, blue — player, green — interjection), ①② — the order in
 * which the game tries NPC lines, «if …» / «→ …» phrases with FCS codes, badges for non-default
 * properties and «conversation ends» where nothing follows; deep branches are folded at first.
 * Marks «new» / «changed», game lines removed from a branch. Checks (broken references, dead ends,
 * locked dialogues, vanilla overrides…) — on nodes and as a list. Text search, collapse branch,
 * show branch only, re-layout, minimap.
 */
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  quote,
  addLine,
  buildDialogueGraph,
  deleteGraphItems,
  dialogueChecks,
  dialogueDeepFolds,
  dialogueLineViews,
  dialogueTransitions,
  duplicateLines,
  insertLineBetween,
  lineParents,
  lineTexts,
  linkLine,
  linkProblem,
  removedLinks,
  revertLine,
  setLineTexts,
  type DialogCheck,
  type DialogueGraph,
  type DialogueGraphNode,
  type LineLink,
  type LineView,
} from '@kenshi-editor/core';
import { inLang, useLang, useT } from '../i18n.ts';
import { useGameTexts } from '../data-names.ts';
import type { Project } from '../project.ts';
import { tryEdit } from '../hooks.ts';
import { isTypingIn, shortcut } from '../keys.ts';
import { layoutDialogue, NODE_WIDTH, type Placed } from '../dialogue-layout.ts';
import { InlineText } from './DialogueInlineText.tsx';
import { DialogueTreeView } from './DialogueTreeView.tsx';
import { isPortalId, isTransitionEdge, PortalCard, portalElements, type PortalNode } from './DialoguePortals.tsx';

interface Props {
  project: Project;
  sid: string;
  version: number;
  onGo: (sid: string) => void;
  /** Selected line (highlighted; when selected from outside the graph pans to it). */
  selected?: string | undefined;
  /** Select a graph line or dialogue; `parent` — where it was reached from. */
  onSelect?: (sid: string, parent?: string) => void;
  onReport?: (err: string | undefined) => void;
  /** Open (or show) the «Line» panel. */
  onShowLine?: () => void;
  /** Whether the «Line» panel is open (the «Open line» button is highlighted if not). */
  isLineOpen?: () => boolean;
  /** Open or close the «▶ Play» strip (the button is shown only with it). */
  onPlay?: () => void;
  /** The strip is open (the button is pressed). */
  playOpen?: boolean;
  /** The «▶ Play» strip, shown under the graph or the tree. */
  strip?: ReactNode;
  /** The line the played conversation is at: highlighted, unfolded and brought into view. */
  playing?: string | undefined;
}

/** Text lines on a node before «full text ▾». */
const TEXT_LINES = 3;
/** Longer texts (or with line breaks) get «full text ▾». */
const LONG_TEXT = 120;
const INITIAL_ZOOM = 1;
/** Whether FCS codes are shown next to the plain words (on by default). */
const CODES_KEY = 'kedit.graph.codes';
/** Graphs with more nodes open with deep branches folded. */
const FOLD_MIN_NODES = 20;
/** Lines this deep from the dialogue (NPC line → answer → reply) keep their children folded at first. */
const FOLD_DEPTH = 3;
/** Speaker of the lines added by «+ interjection» (T_INTERJECTOR1). */
const INTERJECTOR = 3;
/** Whether the minimap is shown (off by default: the graph gets the whole canvas). */
const MINIMAP_KEY = 'kedit.graph.minimap';
const MENU_WIDTH = 240;

interface Actions {
  go: (sid: string) => void;
  add: (sid: string, speaker?: number) => void;
  toggle: (sid: string) => void;
  commit: (sid: string, text: string) => void;
  cancel: () => void;
  /** Node menu at the mouse (the «…» button). */
  menu: (sid: string, e: ReactMouseEvent) => void;
  /** Show text variant `i` on the node. */
  variant: (sid: string, i: number) => void;
  /** Show the whole text or clamp it again. */
  full: (sid: string) => void;
}

interface Hidden {
  all: number;
  answers: number;
  lines: number;
}

type LineData = {
  node: DialogueGraphNode;
  status: string | undefined;
  checks: DialogCheck[];
  removed: number;
  /** How many descendants in the tree (for «collapse»). */
  kids: number;
  /** Collapsed: how many nodes are hidden. */
  hidden?: Hidden;
  view: LineView | undefined;
  /** Text variant shown on the node. */
  variant: number;
  /** The whole text is shown (no clamp). */
  full: boolean;
  /** Nothing follows this line: the conversation ends. */
  end: boolean;
  /** The only selected node: the toolbar is shown above it. */
  tools: boolean;
  /** The «▶ Play» strip is at this line. */
  playing: boolean;
  matched: boolean;
  editable: boolean;
  /** Text is edited right in the node; `raw` — the record's current first text. */
  editing: boolean;
  raw?: string;
  actions: { current: Actions };
};
type LineNode = Node<LineData, 'line'>;
/** Graph nodes: lines and the portals to other dialogues (G3). */
type GraphNode = LineNode | PortalNode;

interface Menu {
  /** Menu position on the canvas (from the top-left corner). */
  x: number;
  y: number;
  kind: 'node' | 'edge' | 'pane';
  id?: string;
  /** Graph point under the mouse (for «new line» and «paste»). */
  at?: { x: number; y: number };
}

interface Ask {
  text: string;
  run: () => void;
}

const EMPTY: ReadonlySet<string> = new Set();

/** Copied lines (Ctrl+C / «Copy») — shared by all graphs of the window. */
let clipboard: string[] = [];

/** «Graph | Tree» choice (UI review G5), remembered for all dialogues. */
const VIEW_KEY = 'kedit.graph.view';
type View = 'graph' | 'tree';

export function DialogueGraphTab(props: Props): ReactNode {
  const t = useT();
  const [view, setViewState] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'graph'));
  const setView = (v: View): void => {
    localStorage.setItem(VIEW_KEY, v);
    setViewState(v);
  };
  return (
    <div className="dg-views" data-view={view}>
      <div className="dg-view-switch" role="tablist" title={t.dtViewTip}>
        <button role="tab" className={`small${view === 'graph' ? ' active' : ''}`} aria-selected={view === 'graph'} data-testid="dg-view-graph" onClick={() => { setView('graph'); }}>
          {t.dtViewGraph}
        </button>
        <button role="tab" className={`small${view === 'tree' ? ' active' : ''}`} aria-selected={view === 'tree'} data-testid="dg-view-tree" onClick={() => { setView('tree'); }}>
          {t.dtViewTree}
        </button>
        {props.onPlay && (
          <button className={`small dg-play${props.playOpen ? ' active' : ''}`} data-testid="dg-play" aria-pressed={props.playOpen === true} title={t.dgPlayHint} onClick={props.onPlay}>
            ▶ {t.dgPlay}
          </button>
        )}
      </div>
      <div className="dg-view-body">
        {view === 'tree' ? (
          <DialogueTreeView key={props.sid} {...props} />
        ) : (
          // New provider for each record — the initial view starts over.
          <ReactFlowProvider key={props.sid}>
            <GraphView {...props} />
          </ReactFlowProvider>
        )}
      </div>
      {props.playOpen && props.strip}
    </div>
  );
}

function treeKids(graph: DialogueGraph): Map<string, string[]> {
  const kids = new Map<string, string[]>();
  for (const e of graph.edges) if (!e.back) kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
  return kids;
}

/** Nodes hidden by collapsed branches (tree descendants, without loops), and how many each one hid. */
function hiddenBy(graph: DialogueGraph, collapsed: ReadonlySet<string>): { hidden: Set<string>; count: Map<string, Hidden> } {
  const kids = treeKids(graph);
  const choice = new Set(graph.nodes.filter((n) => n.choice).map((n) => n.id));
  const hidden = new Set<string>();
  const count = new Map<string, Hidden>();
  for (const c of collapsed) {
    if (hidden.has(c)) continue;
    const h: Hidden = { all: 0, answers: 0, lines: 0 };
    const stack = [...(kids.get(c) ?? [])];
    while (stack.length) {
      const x = stack.pop()!;
      if (hidden.has(x) || x === c) continue;
      hidden.add(x);
      h.all++;
      if (choice.has(x)) h.answers++;
      else h.lines++;
      stack.push(...(kids.get(x) ?? []));
    }
    count.set(c, h);
  }
  return { hidden, count };
}

/** Lines whose children are folded at first: `FOLD_DEPTH` deep from the nearest dialogue, the outermost ones. */
export function deepFolds(graph: DialogueGraph): Set<string> {
  return dialogueDeepFolds(graph, FOLD_DEPTH);
}

function GraphView({ project, sid, version, onGo, selected, onSelect, onReport, onShowLine, isLineOpen, playing }: Props): ReactNode {
  const t = useT();
  const [minimap, setMinimapState] = useState(() => localStorage.getItem(MINIMAP_KEY) === '1');
  const setMinimap = (on: boolean): void => {
    localStorage.setItem(MINIMAP_KEY, on ? '1' : '0');
    setMinimapState(on);
  };
  const lang = useLang();
  const ctx = project.ctx;
  const translation = useGameTexts(project);
  const flow = useReactFlow();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusRoot, setFocusRoot] = useState<string | undefined>(undefined);
  /** Folded branches; `undefined` — as at first (deep branches of a big graph folded). */
  const [collapsedState, setCollapsed] = useState<ReadonlySet<string> | undefined>(undefined);
  const [codes, setCodesState] = useState(() => localStorage.getItem(CODES_KEY) !== '0');
  const setCodes = (on: boolean): void => {
    localStorage.setItem(CODES_KEY, on ? '1' : '0');
    setCodesState(on);
  };
  const [variants, setVariants] = useState<ReadonlyMap<string, number>>(new Map());
  const [fullTexts, setFullTexts] = useState<ReadonlySet<string>>(new Set());
  /** Card heights reported by the canvas (the layout uses them instead of the estimate). */
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  /** A node to pan to once it is shown (it was in a folded branch). */
  const pendingFocus = useRef<string | undefined>(undefined);
  const [moved, setMoved] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const [selNodes, setSelNodes] = useState<ReadonlySet<string>>(() => new Set(selected !== undefined ? [selected] : []));
  const [selEdges, setSelEdges] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [menu, setMenu] = useState<Menu | undefined>(undefined);
  const [linkFrom, setLinkFrom] = useState<string | undefined>(undefined);
  const [ask, setAsk] = useState<Ask | undefined>(undefined);
  const [, setTick] = useState(0);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [showInfo, setShowInfo] = useState(false);
  const report = onReport ?? (() => undefined);
  /** The last node selected by a click in the graph itself (no panning to it). */
  const clicked = useRef<string | undefined>(undefined);


  const root = focusRoot !== undefined && ctx.get(focusRoot) ? focusRoot : sid;
  const graph = useMemo((): DialogueGraph => buildDialogueGraph(ctx, root, { lang, ...(translation ? { translation } : {}) }), [ctx, root, version, translation, lang]);
  const checks = useMemo(() => dialogueChecks(ctx, graph), [ctx, graph, version]);
  const checksByNode = useMemo(() => {
    const m = new Map<string, DialogCheck[]>();
    for (const c of checks) m.set(c.node, [...(m.get(c.node) ?? []), c]);
    return m;
  }, [checks]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const views = useMemo(() => dialogueLineViews(ctx, graph, lang), [ctx, graph, lang, version]);
  const transitions = useMemo(() => dialogueTransitions(ctx, graph), [ctx, graph, version]);
  const deep = useMemo(() => deepFolds(graph), [graph]);
  const collapsed = collapsedState ?? (graph.nodes.length > FOLD_MIN_NODES ? deep : EMPTY);
  /** Change the folded branches (starting from the first-time folding). */
  const fold = (f: (c: ReadonlySet<string>) => ReadonlySet<string>): void => {
    setCollapsed((c) => f(c ?? collapsed));
  };
  const folding = useMemo(() => hiddenBy(graph, collapsed), [graph, collapsed]);
  /** Nodes with links going out (loops too): the conversation goes on after them. */
  const outgoing = useMemo(() => new Set(graph.edges.map((e) => e.source)), [graph]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    return graph.nodes
      .filter((n) => [n.id, n.name, n.localized ?? '', ...n.texts.flatMap((x) => [x.en, x.localized ?? ''])].some((s) => s.toLowerCase().includes(q)))
      .map((n) => n.id);
  }, [graph, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);

  const tree = useMemo(() => {
    const parent = new Map<string, string>();
    const kids = new Map<string, number>();
    for (const e of graph.edges)
      if (!e.back) {
        if (!parent.has(e.target)) parent.set(e.target, e.source);
        kids.set(e.source, (kids.get(e.source) ?? 0) + 1);
      }
    return { parent, kids };
  }, [graph]);

  /** Unfold the branches that hide `id`; true if it was hidden. */
  const reveal = (id: string): boolean => {
    if (!folding.hidden.has(id)) return false;
    const up = new Set<string>();
    for (let p = tree.parent.get(id); p !== undefined && !up.has(p); p = tree.parent.get(p)) up.add(p);
    fold((c) => new Set([...c].filter((x) => !up.has(x))));
    return true;
  };

  // ── what can be done with a node ──
  const isLine = (id: string): boolean => {
    const n = byId.get(id);
    return n !== undefined && !n.missing && n.type === 'DIALOGUE_LINE' && ctx.get(id) !== undefined;
  };
  const canParent = (id: string): boolean => {
    const n = byId.get(id);
    return n !== undefined && !n.missing && (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE') && ctx.get(id) !== undefined;
  };
  /** After an NPC line — a player answer; after a player answer or at dialogue start — an NPC line. */
  const nextSpeaker = (id: string): number => {
    const n = byId.get(id);
    return n?.type === 'DIALOGUE_LINE' && !n.choice ? 1 : 0;
  };

  const refocus = (): void => {
    rootRef.current?.focus({ preventScroll: true });
  };

  const selectOnly = (id: string): void => {
    setSelNodes(new Set([id]));
    setSelEdges(new Set());
  };

  /** A new line was created: expand the parent, select it, edit the text at once. */
  const created = (id: string, parent: string, at?: { x: number; y: number }): void => {
    fold((c) => {
      const n = new Set(c);
      n.delete(parent);
      return n;
    });
    if (at) {
      setMoved((m) => new Map(m).set(id, at));
      clicked.current = id;
    } else clicked.current = undefined;
    selectOnly(id);
    onSelect?.(id, parent);
    setEditing(id);
  };

  const add = (parent: string, speaker?: number, at?: { x: number; y: number }): void => {
    if (!canParent(parent)) {
      report(t.dgNewNeedsDialog);
      return;
    }
    let id: string | undefined;
    const err = tryEdit(() => {
      id = addLine(ctx, parent, { speaker: speaker ?? nextSpeaker(parent), text: '' });
    });
    report(err);
    if (id !== undefined) created(id, parent, at);
  };

  const startEdit = (id: string): void => {
    if (!isLine(id)) {
      report(t.dgNotALine);
      return;
    }
    setMenu(undefined);
    selectOnly(id);
    setEditing(id);
  };

  const commit = (id: string, text: string): void => {
    setEditing(undefined);
    const rec = ctx.get(id);
    if (rec) {
      const old = lineTexts(rec);
      // The variant shown on the node is edited.
      const i = Math.min(variants.get(id) ?? 0, Math.max(0, old.length - 1));
      if ((old[i] ?? '') !== text) report(tryEdit(() => { setLineTexts(ctx, id, old.length === 0 ? [text] : old.map((x, k) => (k === i ? text : x))); }));
    }
    refocus();
  };

  /** Lines selected in the graph (or the single `id` if it is not in the selection). */
  const targets = (id?: string): string[] => (id === undefined || selNodes.has(id) ? [...selNodes] : [id]);

  const removeSelection = (nodeIds: readonly string[], edgeIds: readonly string[]): void => {
    setMenu(undefined);
    const lines = nodeIds.filter(isLine);
    const links: LineLink[] = [];
    let foreign = nodeIds.length - lines.length;
    for (const eid of edgeIds) {
      const e = graph.edges.find((x) => x.id === eid);
      if (!e) continue;
      if (e.category === 'lines') links.push({ parent: e.source, child: e.target });
      else foreign++;
    }
    if (lines.length === 0 && links.length === 0) {
      report(foreign > 0 && edgeIds.length > 0 && nodeIds.length === 0 ? t.dgUnlinkPackage : t.dgNothingToDelete);
      return;
    }
    const run = (): void => {
      setAsk(undefined);
      const err = tryEdit(() => { deleteGraphItems(ctx, { lines, links }); });
      report(err ?? (foreign > 0 ? t.dgNothingToDelete : undefined));
      if (err === undefined) {
        setSelNodes(new Set());
        setSelEdges(new Set());
      }
      refocus();
    };
    const picked = new Set(lines);
    const game = lines.filter((s) => ctx.status(s) !== 'new').length;
    const shared = lines.filter((s) => lineParents(ctx, s).filter((p) => !picked.has(p)).length > 1).length;
    if (lines.length > 0 && (game > 0 || shared > 0)) setAsk({ text: t.dgDeleteAsk(lines.length, game, shared), run });
    else run();
  };

  const duplicate = (ids: readonly string[]): void => {
    setMenu(undefined);
    const lines = ids.filter(isLine);
    if (lines.length === 0) {
      report(t.dgNotALine);
      return;
    }
    let copies: string[] = [];
    const items = lines.map((s) => {
      const p = tree.parent.get(s);
      return { sid: s, parent: p !== undefined && canParent(p) ? p : undefined };
    });
    report(tryEdit(() => { copies = duplicateLines(ctx, items); }));
    if (copies.length > 0) {
      setSelNodes(new Set(copies));
      setSelEdges(new Set());
      clicked.current = undefined;
      onSelect?.(copies.at(-1)!, items.at(-1)?.parent);
    }
  };

  const copy = (ids: readonly string[]): void => {
    setMenu(undefined);
    const lines = ids.filter(isLine);
    if (lines.length === 0) report(t.dgNotALine);
    else clipboard = lines;
  };

  const paste = (parent: string): void => {
    setMenu(undefined);
    if (!canParent(parent)) {
      report(t.dgNewNeedsDialog);
      return;
    }
    const items = clipboard.filter((s) => ctx.get(s) !== undefined).map((s) => ({ sid: s, parent }));
    if (items.length === 0) return;
    let copies: string[] = [];
    report(tryEdit(() => { copies = duplicateLines(ctx, items); }));
    if (copies.length > 0) {
      fold((c) => {
        const n = new Set(c);
        n.delete(parent);
        return n;
      });
      setSelNodes(new Set(copies));
      setSelEdges(new Set());
      clicked.current = undefined;
      onSelect?.(copies.at(-1)!, parent);
    }
  };

  /** Where to paste: the only selected node that can lead further, otherwise the root. */
  const pasteTarget = (): string => {
    const only = selNodes.size === 1 ? [...selNodes][0]! : undefined;
    return only !== undefined && canParent(only) ? only : graph.root;
  };

  const insert = (edgeId: string): void => {
    setMenu(undefined);
    const e = graph.edges.find((x) => x.id === edgeId);
    if (!e) return;
    if (e.category !== 'lines') {
      report(t.dgUnlinkPackage);
      return;
    }
    let id: string | undefined;
    report(tryEdit(() => { id = insertLineBetween(ctx, e.source, e.target, { speaker: nextSpeaker(e.source), text: '' }); }));
    if (id !== undefined) created(id, e.source);
  };

  const revert = (id: string): void => {
    setMenu(undefined);
    const n = byId.get(id);
    report(tryEdit(() => { if (n?.type === 'DIALOGUE_LINE') revertLine(ctx, id); else ctx.revertRecord(id); }));
  };

  const showLine = (id?: string): void => {
    setMenu(undefined);
    if (id !== undefined && canParent(id)) {
      clicked.current = id;
      onSelect?.(id, tree.parent.get(id));
    }
    onShowLine?.();
    // The panel opens in the window layout — redraw the button after that.
    requestAnimationFrame(() => { setTick((x) => x + 1); });
  };

  const noop = (): void => undefined;
  const actions = useRef<Actions>({ go: onGo, add: noop, toggle: noop, commit: noop, cancel: noop, menu: noop, variant: noop, full: noop });
  actions.current = {
    go: onGo,
    add: (id, speaker) => { add(id, speaker); },
    menu: (id, e) => {
      selectOnly(id);
      openMenu(e, { kind: 'node', id });
    },
    variant: (id, i) => {
      setVariants((m) => new Map(m).set(id, i));
    },
    full: (id) => {
      setFullTexts((f) => {
        const n = new Set(f);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    },
    toggle: (id) => {
      fold((c) => {
        const n = new Set(c);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    },
    commit,
    cancel: () => {
      setEditing(undefined);
      refocus();
    },
  };

  const { nodes, edges, pos } = useMemo(() => {
    const { hidden, count } = folding;
    const visible: DialogueGraph = { ...graph, nodes: graph.nodes.filter((n) => !hidden.has(n.id)), edges: graph.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target)) };
    const pos = layoutDialogue(visible, TEXT_LINES, heights);
    const nodes: LineNode[] = visible.nodes.map((n) => {
      const p = moved.get(n.id) ?? pos.get(n.id) ?? { x: 0, y: 0 };
      const editable = !n.missing && (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE');
      const h = count.get(n.id);
      const rec = n.id === editing ? ctx.get(n.id) : undefined;
      const view = views.get(n.id);
      const variant = Math.min(variants.get(n.id) ?? 0, Math.max(0, n.texts.length - 1));
      const isLineKind = view?.kind === 'npc' || view?.kind === 'inter' || view?.kind === 'player';
      return {
        id: n.id,
        type: 'line',
        position: { x: p.x, y: p.y },
        data: {
          node: n,
          status: ctx.status(n.id),
          checks: checksByNode.get(n.id) ?? [],
          removed: editable ? removedLinks(ctx, n.id).length : 0,
          kids: tree.kids.get(n.id) ?? 0,
          ...(h !== undefined ? { hidden: h } : {}),
          matched: matchSet.has(n.id),
          editable,
          editing: rec !== undefined,
          ...(rec ? { raw: lineTexts(rec)[variant] ?? '' } : {}),
          view,
          variant,
          full: fullTexts.has(n.id),
          end: (checksByNode.get(n.id) ?? []).some((c) => c.kind === 'end') || (isLineKind && !outgoing.has(n.id)),
          tools: editable && selNodes.size === 1 && selNodes.has(n.id) && n.id !== editing,
          playing: n.id === playing,
          actions,
        },
        selected: selNodes.has(n.id),
        style: { width: NODE_WIDTH },
        // Size for the minimap: nodes have no `measured` until the canvas reports it.
        initialWidth: NODE_WIDTH,
        initialHeight: pos.get(n.id)?.height ?? 60,
      };
    });
    const edges: Edge[] = visible.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.back ? 'default' : 'smoothstep',
      className: `${e.back ? 'dg-edge-back' : 'dg-edge'}${selEdges.has(e.id) ? ' dg-edge-sel' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      selected: selEdges.has(e.id),
      interactionWidth: 14,
      ...(e.back ? { animated: true } : {}),
    }));
    // Portals to other dialogues and the transition arrows (G3).
    const visibleFor = (line: string): string | undefined => {
      let cur: string | undefined = line;
      const seen = new Set<string>();
      while (cur !== undefined && hidden.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = tree.parent.get(cur);
      }
      return cur !== undefined && pos.has(cur) ? cur : undefined;
    };
    const portals = portalElements({
      ctx,
      lang,
      translation,
      transitions,
      root: graph.root,
      pos,
      nodeWidth: NODE_WIDTH,
      heights,
      moved,
      visibleFor,
      // Short arrow label: one verb per kind, both unlock kinds read as «unlocks»; the portal chips list them all.
      kindWords: (kinds) => [...new Set(kinds.map((k) => t.dpKind(k === 'unlock but keep me' ? 'unlocks' : k)))].join(' · '),
    });
    const all: GraphNode[] = [...nodes, ...portals.nodes];
    const allPos = new Map([...pos, ...portals.placed]);
    return { nodes: all, edges: [...edges, ...portals.edges], pos: allPos };
  }, [graph, folding, moved, checksByNode, matchSet, selNodes, selEdges, editing, tree, version, views, variants, fullTexts, heights, outgoing, transitions, translation, lang, t, playing]);

  // Initial view at a readable zoom: the whole graph if it fits, otherwise the root at the left edge.
  const startView = useRef<(inst: ReactFlowInstance<GraphNode>) => void>(() => undefined);
  startView.current = (inst) => {
    const el = canvasRef.current;
    void inst.setViewport(initialViewport(pos, graph.root, el?.clientWidth ?? 800, el?.clientHeight ?? 600));
  };

  const focus = (id: string): void => {
    const n = nodes.find((x) => x.id === id);
    if (n) void flow.setCenter(n.position.x + NODE_WIDTH / 2, n.position.y + 40, { zoom: 1 });
    else if (reveal(id)) pendingFocus.current = id;
  };
  const focusRef = useRef(focus);
  focusRef.current = focus;

  // The line was selected from outside (inspector, search, check list) — pan to it and select it.
  useEffect(() => {
    if (selected === undefined || !byId.has(selected)) return;
    setSelNodes((s) => (s.has(selected) ? s : new Set([selected])));
    if (selected === clicked.current) return;
    clicked.current = selected;
    focusRef.current(selected);
  }, [selected, nodes]);

  // The played conversation moved on — bring its line into view (unfolding its branch if needed).
  useEffect(() => {
    if (playing === undefined || !byId.has(playing)) return;
    focusRef.current(playing);
  }, [playing]);

  // A node from a folded branch is shown now — pan to it.
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === undefined || !nodes.some((n) => n.id === id)) return;
    pendingFocus.current = undefined;
    focusRef.current(id);
  }, [nodes]);

  // The menu closes on a click outside it.
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent): void => {
      if (menuRef.current && e.target instanceof globalThis.Node && menuRef.current.contains(e.target)) return;
      setMenu(undefined);
    };
    document.addEventListener('mousedown', h, true);
    return () => {
      document.removeEventListener('mousedown', h, true);
    };
  }, [menu]);

  const pick = (id: string): void => {
    const n = byId.get(id);
    if (!n) return;
    if (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE') {
      clicked.current = id;
      onSelect?.(id, tree.parent.get(id));
    } else onGo(id);
  };

  const goHit = (k: number): void => {
    if (matches.length === 0) return;
    const i = ((k % matches.length) + matches.length) % matches.length;
    setHit(i);
    const id = matches[i]!;
    // A hit in a collapsed branch — expand it.
    reveal(id);
    clicked.current = undefined;
    const n = byId.get(id);
    if (n && (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE')) onSelect?.(id, tree.parent.get(id));
    else focus(id);
  };

  const onConnect = (c: Connection): void => {
    const p = linkProblem(ctx, c.source, c.target);
    report(p ? inLang(p, lang) : tryEdit(() => { linkLine(ctx, c.source, c.target); }));
  };

  const finishLink = (to: string): void => {
    const from = linkFrom!;
    setLinkFrom(undefined);
    if (to === from) return;
    const p = linkProblem(ctx, from, to);
    report(p ? inLang(p, lang) : tryEdit(() => { linkLine(ctx, from, to); }));
  };

  const onNodesChange = (changes: NodeChange<GraphNode>[]): void => {
    const dims = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
    if (dims.length > 0)
      setHeights((m) => {
        let n: Map<string, number> | undefined;
        for (const c of dims) {
          if (c.type !== 'dimensions' || !c.dimensions) continue;
          const h = Math.round(c.dimensions.height);
          if (Math.abs((m.get(c.id) ?? -10) - h) <= 1) continue;
          n ??= new Map(m);
          n.set(c.id, h);
        }
        return n ?? m;
      });
    const posCh = changes.filter((c) => c.type === 'position' && c.position);
    if (posCh.length > 0)
      setMoved((m) => {
        const n = new Map(m);
        for (const c of posCh) if (c.type === 'position' && c.position) n.set(c.id, c.position);
        return n;
      });
    const sel = changes.filter((c) => c.type === 'select');
    if (sel.length > 0)
      setSelNodes((s) => {
        const n = new Set(s);
        for (const c of sel) {
          if (c.selected) n.add(c.id);
          else n.delete(c.id);
        }
        return n;
      });
  };

  const onEdgesChange = (changes: EdgeChange[]): void => {
    const sel = changes.filter((c) => c.type === 'select');
    if (sel.length > 0)
      setSelEdges((s) => {
        const n = new Set(s);
        for (const c of sel) {
          if (c.selected) n.add(c.id);
          else n.delete(c.id);
        }
        return n;
      });
  };

  const openMenu = (e: ReactMouseEvent | MouseEvent, m: Omit<Menu, 'x' | 'y' | 'at'>): void => {
    e.preventDefault();
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.max(4, Math.min(e.clientX - r.left, r.width - MENU_WIDTH - 4));
    const y = Math.max(4, Math.min(e.clientY - r.top, r.height - 40));
    setLinkFrom(undefined);
    setMenu({ ...m, x, y, at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
    refocus();
  };

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (isTypingIn(e.target)) return;
    const sc = shortcut(e);
    let done = true;
    if (e.key === 'Escape') {
      if (ask) setAsk(undefined);
      else if (menu) setMenu(undefined);
      else if (linkFrom !== undefined) setLinkFrom(undefined);
      else {
        setSelNodes(new Set());
        setSelEdges(new Set());
      }
    } else if (ask && e.key === 'Enter') ask.run();
    else if (ask) done = false;
    else if (e.key === 'Delete' || e.key === 'Backspace') removeSelection([...selNodes], [...selEdges]);
    else if (e.key === 'F2' && selNodes.size === 1) startEdit([...selNodes][0]!);
    else if (sc === 'ctrl+d' && selNodes.size > 0) duplicate([...selNodes]);
    else if (sc === 'ctrl+c' && selNodes.size > 0) copy([...selNodes]);
    else if (sc === 'ctrl+v' && clipboard.length > 0) paste(pasteTarget());
    else done = false;
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ── menu ──
  const item = (id: string, label: string, run: () => void, opt: { keys?: string; danger?: boolean; disabled?: boolean } = {}): ReactNode => (
    <button key={id} className={`dg-menu-item${opt.danger ? ' danger' : ''}`} data-testid={`dg-menu-${id}`} disabled={opt.disabled} onClick={run}>
      <span>{label}</span>
      {opt.keys !== undefined && <span className="dg-menu-keys">{opt.keys}</span>}
    </button>
  );
  const sep = (k: string): ReactNode => <div key={k} className="dg-menu-sep" />;

  const menuItems = (m: Menu): ReactNode[] => {
    const out: ReactNode[] = [];
    if (m.kind === 'node' && m.id !== undefined) {
      const id = m.id;
      const many = selNodes.has(id) && selNodes.size > 1;
      const n = byId.get(id);
      const st = ctx.status(id);
      const revertable = (st === 'changed' || st === 'deleted') && canParent(id);
      if (isLine(id)) {
        const cnt = many ? ` (${selNodes.size})` : '';
        if (!many) out.push(item('edit', t.dgMenuEdit, () => { startEdit(id); }, { keys: 'F2' }));
        if (!many) out.push(item('add-answer', t.dgMenuAddAnswer, () => { setMenu(undefined); add(id, 1); }));
        if (!many) out.push(item('add-npc', t.dgMenuAddNpc, () => { setMenu(undefined); add(id, 0); }));
        if (!many) out.push(item('add-inter', t.dnMenuAddInter, () => { setMenu(undefined); add(id, INTERJECTOR); }));
        if (!many) out.push(item('link', t.dgMenuLink, () => { setMenu(undefined); setLinkFrom(id); }));
        out.push(sep('sep1'));
        out.push(item('duplicate', t.dgMenuDuplicate + cnt, () => { duplicate(targets(id)); }, { keys: 'Ctrl+D' }));
        out.push(item('copy', t.dgMenuCopy + cnt, () => { copy(targets(id)); }, { keys: 'Ctrl+C' }));
        if (!many && clipboard.length > 0) out.push(item('paste', t.dgMenuPaste, () => { paste(id); }, { keys: 'Ctrl+V' }));
        out.push(sep('sep2'));
        if (!many) out.push(item('show-line', t.dgMenuShowLine, () => { showLine(id); }));
        if (!many) out.push(item('inspector', t.dgMenuInspector, () => { setMenu(undefined); onGo(id); }));
        if (!many && revertable) out.push(item('revert', t.dgMenuRevert, () => { revert(id); }));
        out.push(sep('sep3'));
        out.push(item('delete', t.dgMenuDelete + cnt, () => { removeSelection(targets(id), many ? [...selEdges] : []); }, { keys: 'Del', danger: true }));
      } else if (canParent(id)) {
        out.push(item('add-npc', t.dgMenuAddNpc, () => { setMenu(undefined); add(id, 0); }));
        out.push(item('add-answer', t.dgMenuAddAnswer, () => { setMenu(undefined); add(id, 1); }));
        out.push(item('add-inter', t.dnMenuAddInter, () => { setMenu(undefined); add(id, INTERJECTOR); }));
        if (clipboard.length > 0) out.push(item('paste', t.dgMenuPaste, () => { paste(id); }, { keys: 'Ctrl+V' }));
        out.push(sep('sep1'));
        out.push(item('show-line', t.dgMenuShowLine, () => { showLine(id); }));
        out.push(item('inspector', t.dgMenuInspector, () => { setMenu(undefined); onGo(id); }));
        if (revertable) out.push(item('revert', t.dgMenuRevert, () => { revert(id); }));
      } else if (n && !n.missing) {
        out.push(item('inspector', t.dgMenuInspector, () => { setMenu(undefined); onGo(id); }));
      } else out.push(<div key="none" className="dg-menu-note muted small">{t.dgNotALine}</div>);
    } else if (m.kind === 'edge' && m.id !== undefined) {
      const id = m.id;
      const e = graph.edges.find((x) => x.id === id);
      const lines = e?.category === 'lines';
      out.push(item('insert', t.dgMenuInsert, () => { insert(id); }, { disabled: !lines }));
      out.push(item('unlink', t.dgMenuUnlink, () => { removeSelection([], selEdges.has(id) ? [...selEdges] : [id]); }, { keys: 'Del', danger: true }));
      if (!lines) out.push(<div key="pkg" className="dg-menu-note muted small">{t.dgUnlinkPackage}</div>);
    } else {
      const at = m.at;
      out.push(item('new', t.dgMenuNew, () => { setMenu(undefined); add(graph.root, undefined, at); }, { disabled: !canParent(graph.root) }));
      if (clipboard.length > 0) out.push(item('paste', t.dgMenuPaste, () => { paste(graph.root); }, { keys: 'Ctrl+V' }));
      out.push(sep('sep1'));
      out.push(item('relayout', t.dgRelayout, () => { setMenu(undefined); relayout(); }));
      out.push(item('fit', t.dgFit, () => { setMenu(undefined); void flow.fitView({ padding: 0.1, maxZoom: 1 }); }));
    }
    // Separators not at the start, not at the end and not in a row.
    return out.filter((x, i, a) => {
      const isSep = (y: ReactNode): boolean => typeof y === 'object' && y !== null && 'key' in y && String(y.key).startsWith('sep');
      if (!isSep(x)) return true;
      return i > 0 && i < a.length - 1 && !isSep(a[i - 1]) && a.slice(i + 1).some((y) => !isSep(y));
    });
  };

  const relayout = (): void => {
    setMoved(new Map());
    window.setTimeout(() => void flow.fitView({ padding: 0.1, maxZoom: 1 }), 30);
  };

  const shown = checks.filter((c) => showInfo || c.severity !== 'info');
  const infos = checks.filter((c) => c.severity === 'info').length;
  const choices = graph.nodes.filter((n) => n.choice).length;
  const selInGraph = selected !== undefined && byId.has(selected);
  const lineOpen = isLineOpen?.() ?? true;
  const selLines = [...selNodes].filter(isLine);
  return (
    <div className={`dg${codes ? '' : ' dg-nocodes'}`} data-testid="dialogue-graph" data-sid={sid} ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="dg-bar">
        <span className="muted small" data-testid="dg-stats">
          {t.dgNodes} {graph.nodes.length}, {t.dgChoices} {choices}, {t.dgLoops} {graph.edges.filter((e) => e.back).length}
          {translation === null ? ` · ${t.dgLoadingTr}` : translation === undefined ? ` · ${t.dgNoTr}` : ''}
        </span>
        <span className="dg-legend small">
          <span className="dg-chip npc">{t.dgNpc}</span>
          <span className="dg-chip choice">{t.dgPlayer}</span>
          <span className="dg-chip inter">{t.dnLegendInter}</span>
          <span className="muted">{t.dnLegendOrder}</span>
          <span className="muted">{t.dgLegendLoop}</span>
        </span>
      </div>
      <div className="dg-tools">
        <input
          className="dg-search"
          data-testid="dg-search"
          placeholder={t.dgSearch}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHit(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') goHit(e.shiftKey ? hit - 1 : matches[hit] === selected ? hit + 1 : hit);
            else if (e.key === 'Escape') setQuery('');
          }}
        />
        {query.trim() !== '' && (
          <span className="small muted" data-testid="dg-search-count">
            {matches.length === 0 ? t.dgNotFound : `${hit + 1}/${matches.length}`}
          </span>
        )}
        <button className="small" title={t.dgFitHint} onClick={() => void flow.fitView({ padding: 0.1, maxZoom: 1 })}>
          ⤢ {t.dgFit}
        </button>
        <button className="small" title={t.dnRelayoutHint} data-testid="dg-relayout" onClick={relayout}>
          ⟲ {t.dgRelayout}
        </button>
        {deep.size > 0 &&
          (collapsed.size > 0 ? (
            <button className="small" data-testid="dg-expand-all" title={t.dnExpandAllTip} onClick={() => { setCollapsed(new Set()); }}>
              ⊞ {t.dnExpandAll}
            </button>
          ) : (
            <button className="small" data-testid="dg-fold-deep" title={t.dnFoldDeepTip} onClick={() => { setCollapsed(new Set(deep)); }}>
              ⊟ {t.dnFoldDeep}
            </button>
          ))}
        <button className={`small${codes ? ' active' : ''}`} data-testid="dg-codes" aria-pressed={codes} title={t.dnCodesTip} onClick={() => { setCodes(!codes); }}>
          {'</>'} {t.dnCodes}
        </button>
        {focusRoot !== undefined ? (
          <button className="small active" data-testid="dg-unfocus" onClick={() => { setFocusRoot(undefined); }}>
            ← {t.dgWholeDialog}
          </button>
        ) : (
          <button className="small" data-testid="dg-focus" disabled={!selInGraph || selected === graph.root} title={t.dgFocusHint} onClick={() => { setFocusRoot(selected); }}>
            ◎ {t.dgFocus}
          </button>
        )}
        <button className={`small${minimap ? ' active' : ''}`} data-testid="dg-minimap" aria-pressed={minimap} title={t.dgMinimapHint} onClick={() => { setMinimap(!minimap); }}>
          ▣ {t.dgMinimap}
        </button>
        {selInGraph && onShowLine && (
          <button className={`small${lineOpen ? '' : ' primary dg-call'}`} data-testid="dg-open-line" title={t.dgOpenLineHint} onClick={() => { showLine(); }}>
            ❝ {t.dgOpenLine}
          </button>
        )}
        {selLines.length > 0 && (
          <button className="small danger" data-testid="dg-delete" title="Del" onClick={() => { removeSelection(selLines, [...selEdges]); }}>
            ✕ {t.dgMenuDelete}
            {selLines.length > 1 ? ` (${selLines.length})` : ''}
          </button>
        )}
        {selEdges.size > 0 && (
          <button className="small danger" data-testid="dg-unlink" title="Del" onClick={() => { removeSelection([], [...selEdges]); }}>
            ✂ {t.dgUnlink}
          </button>
        )}
      </div>
      {(shown.length > 0 || infos > 0) && (
        <ul className="dg-issues" data-testid="dg-issues">
          {shown.slice(0, 30).map((i, k) => (
            <li key={`${i.node}:${i.kind}:${k}`} className={`dg-issue dg-issue-${i.kind} dg-sev-${i.severity}`} data-kind={i.kind} data-node={i.node}>
              {i.severity === 'error' ? '✖' : i.severity === 'warning' ? '⚠' : 'ℹ'}{' '}
              <button
                className="link mono"
                onClick={() => {
                  clicked.current = undefined;
                  if (byId.has(i.node)) pick(i.node);
                  else onSelect?.(i.node);
                  focus(i.node);
                }}
              >
                {i.node}
              </button>{' '}
              {inLang(i.texts, lang)}
            </li>
          ))}
          {shown.length > 30 && <li className="muted">… {shown.length - 30}</li>}
          {infos > 0 && (
            <li>
              <button className="link small" data-testid="dg-show-info" onClick={() => { setShowInfo(!showInfo); }}>
                {showInfo ? t.dgHideInfo : `${t.dgShowInfo} (${infos})`}
              </button>
            </li>
          )}
        </ul>
      )}
      <div className="dg-canvas" ref={canvasRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={(c) => linkProblem(ctx, c.source, c.target) === undefined}
          onNodeClick={(_, n) => {
            if (n.type === 'portal') {
              // A portal opens the other dialogue.
              setLinkFrom(undefined);
              if (n.data.dialogue !== undefined) onGo(n.data.dialogue);
              return;
            }
            if (linkFrom !== undefined) finishLink(n.id);
            else pick(n.id);
          }}
          onNodeDoubleClick={(_, n) => {
            if (isLine(n.id)) startEdit(n.id);
          }}
          onNodeContextMenu={(e, n) => {
            if (isPortalId(n.id)) {
              e.preventDefault();
              return;
            }
            if (!selNodes.has(n.id)) {
              selectOnly(n.id);
              pick(n.id);
            }
            openMenu(e, { kind: 'node', id: n.id });
          }}
          onEdgeContextMenu={(e, ed) => {
            if (isTransitionEdge(ed.id)) {
              e.preventDefault();
              return;
            }
            if (!selEdges.has(ed.id)) {
              setSelNodes(new Set());
              setSelEdges(new Set([ed.id]));
            }
            openMenu(e, { kind: 'edge', id: ed.id });
          }}
          onPaneContextMenu={(e) => {
            openMenu(e, { kind: 'pane' });
          }}
          onPaneClick={() => {
            setLinkFrom(undefined);
          }}
          onMoveStart={() => {
            setMenu(undefined);
          }}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          selectionMode={SelectionMode.Partial}
          minZoom={0.1}
          maxZoom={2}
          colorMode="dark"
          onInit={(inst) => {
            startView.current(inst);
          }}
          // The wheel scrolls (like a page), Ctrl+wheel zooms.
          panOnScroll
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          {minimap && <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'portal' ? '#7a5ea6' : (MINIMAP_COLORS[(n.data as LineData).view?.kind ?? 'npc'] ?? '#5d6168'))} />}
        </ReactFlow>
        {linkFrom !== undefined && (
          <div className="dg-banner" data-testid="dg-link-mode">
            ⇢ {t.dgLinkMode}
          </div>
        )}
        {menu && (
          <div className="dg-menu" data-testid="dg-menu" data-kind={menu.kind} ref={menuRef} style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }} onContextMenu={(e) => { e.preventDefault(); }}>
            {menuItems(menu)}
          </div>
        )}
        {ask && (
          <div className="dg-ask-shade">
            <div
              className="dg-ask"
              data-testid="dg-ask"
              role="alertdialog"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setAsk(undefined);
                else if (e.key === 'Enter') ask.run();
                else return;
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <div className="dg-ask-text">{ask.text}</div>
              <div className="dg-ask-buttons">
                <button className="danger" data-testid="dg-ask-yes" autoFocus onClick={ask.run}>
                  {t.dgMenuDelete}
                </button>
                <button
                  data-testid="dg-ask-no"
                  onClick={() => {
                    setAsk(undefined);
                    refocus();
                  }}
                >
                  {t.cancel}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="dg-hint small muted" data-testid="dg-hint">
        {t.dgHint}
      </div>
    </div>
  );
}

type Phrase = LineView['conditions'][number];

const MINIMAP_COLORS: Readonly<Record<string, string>> = { npc: '#8a6a35', player: '#4b6f9e', inter: '#3f7a52', head: '#7d6a3a', missing: '#5d6168' };

const LineCard = memo(function LineCard({ data, selected }: NodeProps<LineNode>): ReactNode {
  const t = useT();
  const lang = useLang();
  const [pickVariant, setPickVariant] = useState(false);
  const n = data.node;
  const v = data.view;
  const lk = v?.kind ?? (n.type === 'DIALOGUE_LINE' ? (n.choice ? 'player' : 'npc') : 'head');
  // Class names kept from before: `dg-choice` — a player answer.
  const kind = lk === 'player' ? 'choice' : lk === 'inter' || lk === 'npc' ? lk : 'head';
  const worst = data.checks.some((c) => c.severity === 'error') ? ' dg-bad' : data.checks.some((c) => c.severity === 'warning') ? ' dg-warnnode' : '';
  const st = data.status === 'new' || data.status === 'changed' ? ` dg-st-${data.status}` : '';
  const notes = data.checks.filter((c) => c.kind !== 'end');
  const text = n.texts[data.variant];
  const shown = text ? (text.localized ?? text.en) : undefined;
  const long = shown !== undefined && (shown.length > LONG_TEXT || shown.includes('\n'));
  const stop = (e: ReactMouseEvent): void => {
    e.stopPropagation();
  };
  const who =
    lk === 'player' ? t.dnPlayer : lk === 'inter' ? t.dnInter : lk === 'npc' ? t.dnNpc : n.type === 'DIALOGUE' ? t.dnDialogue : n.type === 'DIALOGUE_PACKAGE' ? t.dnPackage : n.type;
  const whoSub = (lk === 'npc' || lk === 'inter') && n.speakerLabel !== undefined ? ` · ${n.speakerLabel}` : '';
  const whoCode = lk === 'head' || lk === 'missing' ? n.type : v?.speakerCode;
  // Phrases of the view; package and other records keep the plain FCS lines.
  const phrased = v !== undefined && lk !== 'missing' && (lk !== 'head' || n.type === 'DIALOGUE');
  const plain = (c: string): Phrase => ({ text: c, short: c, code: c });
  const conds: Phrase[] = phrased ? v.conditions : [...n.conditions, ...n.filters].map(plain);
  const effects: Phrase[] = phrased ? v.effects : n.effects.map(plain);
  const phrase = (p: Phrase, key: string, cls: string, k: string): ReactNode => (
    <div key={key} className={`dg-ln ${cls}`} title={p.text}>
      <span className="dg-k">{k}</span>
      <span className="dg-v">
        {p.short}
        {p.code !== p.short && (
          <>
            {' '}
            <span className="dg-code mono">{p.code}</span>
          </>
        )}
      </span>
    </div>
  );
  const add = (speaker: number) => (e: ReactMouseEvent): void => {
    stop(e);
    data.actions.current.add(n.id, speaker);
  };
  return (
    <div
      className={`dg-node dg-${kind}${worst}${st}${selected ? ' dg-selected' : ''}${data.matched ? ' dg-matched' : ''}${data.editing ? ' dg-editing' : ''}${data.playing ? ' dg-playing' : ''}`}
      data-testid="dg-node"
      data-id={n.id}
      data-playing={data.playing ? 'true' : undefined}
      data-kind={lk}
      data-status={data.status}
    >
      <Handle type="target" position={Position.Left} />
      {data.tools && selected && (
        <div className="dg-ntools nodrag" data-testid="dg-node-tools">
          {lk !== 'head' && (
            <button className="small" data-testid="dg-add-answer" onClick={add(1)}>
              {t.dnAddAnswer}
            </button>
          )}
          <button className="small" data-testid="dg-add-npc" onClick={add(0)}>
            {t.dnAddNpc}
          </button>
          <button className="small" data-testid="dg-add-inter" title={t.dnAddInterTip} onClick={add(INTERJECTOR)}>
            {t.dnAddInter}
          </button>
          <button
            className="small"
            data-testid="dg-more"
            title={t.dnMoreActions}
            onClick={(e) => {
              stop(e);
              data.actions.current.menu(n.id, e);
            }}
          >
            …
          </button>
        </div>
      )}
      <div className="dg-title">
        {data.kids > 0 && (
          <button
            className="link small nodrag dg-toggle"
            data-testid="dg-toggle"
            title={data.hidden !== undefined ? t.dgExpand : t.dgCollapse}
            onClick={(e) => {
              stop(e);
              data.actions.current.toggle(n.id);
            }}
          >
            {data.hidden !== undefined ? '▸' : '▾'}
          </button>
        )}
        {v?.order !== undefined && (
          <span className="dg-ord" data-testid="dg-order" title={t.dnOrderTip(v.order) + (n.score ? ` (+${n.score})` : '')}>
            {v.order}
          </span>
        )}
        {v?.tie === true && (
          <span className="dg-tie small" data-testid="dg-tie" title={t.dnTieTip}>
            {t.dnTie}
          </span>
        )}
        <span className={`dg-chip ${kind}`}>
          {who}
          {whoSub}
        </span>
        {whoCode !== undefined && whoCode !== who && <span className="dg-code mono">{whoCode}</span>}
        {data.status === 'new' && <span className="st-badge st-new">{t.lineStatus_new}</span>}
        {data.status === 'changed' && <span className="st-badge st-changed">{t.lineStatus_changed}</span>}
        {n.eventLabel !== undefined && <span className="dg-event mono">{n.eventLabel}</span>}
        {n.type !== 'DIALOGUE_LINE' && <span className="dg-name">{n.localized ?? n.name}</span>}
        <span className="dg-grow" />
        {n.score ? <span className="dg-score muted mono dg-code">+{n.score}</span> : null}
        {n.texts.length > 1 && (
          <span className="dg-var-wrap">
            <button
              className="link small nodrag dg-variant"
              data-testid="dg-variant"
              title={t.dnVariantTip}
              onClick={(e) => {
                stop(e);
                setPickVariant(!pickVariant);
              }}
            >
              {t.dnVariant(data.variant + 1, n.texts.length)} ▾
            </button>
            {pickVariant && (
              <div className="dg-var-list nodrag nowheel" data-testid="dg-variant-list">
                {n.texts.map((x, i) => (
                  <button
                    key={i}
                    className={`dg-var-item${i === data.variant ? ' active' : ''}`}
                    data-testid="dg-variant-item"
                    onClick={(e) => {
                      stop(e);
                      setPickVariant(false);
                      data.actions.current.variant(n.id, i);
                    }}
                  >
                    <span className="muted">{i + 1}.</span> {quote(x.localized ?? x.en, lang)}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        {data.editable && (
          <button
            className="link small nodrag"
            data-testid="dg-add"
            title={`${lk === 'npc' || lk === 'inter' ? t.dgAddAnswer : t.dgAddNpc} (${t.dgAddTip})`}
            onClick={(e) => {
              stop(e);
              data.actions.current.add(n.id);
            }}
          >
            ＋
          </button>
        )}
        <button
          className="link small nodrag"
          title={`${t.lnOpenInspector} (${n.id})`}
          onClick={(e) => {
            stop(e);
            data.actions.current.go(n.id);
          }}
        >
          ↗
        </button>
      </div>
      {data.editing ? (
        <InlineText value={data.raw ?? ''} onCommit={(text) => { data.actions.current.commit(n.id, text); }} onCancel={() => { data.actions.current.cancel(); }} />
      ) : shown !== undefined ? (
        <>
          <div className={`dg-text${data.full ? '' : ' dg-clamp'}`} title={text?.localized !== undefined ? text.en : ''}>
            {quote(shown, lang)}
          </div>
          {long && (
            <button
              className="link small nodrag dg-more"
              data-testid="dg-full"
              onClick={(e) => {
                stop(e);
                data.actions.current.full(n.id);
              }}
            >
              {data.full ? t.dnLessText : t.dnFullText}
            </button>
          )}
        </>
      ) : (
        n.type === 'DIALOGUE_LINE' && <div className="dg-text muted">{t.dgEmptyText}</div>
      )}
      {conds.map((p, i) => phrase(p, `c${i}`, 'dg-cond', t.dnIf))}
      {effects.map((p, i) => phrase(p, `e${i}`, 'dg-effect', t.dnThen))}
      {v !== undefined && v.badges.length > 0 && (
        <div className="dg-badges">
          {v.badges.map((b) => (
            <span key={b.field} className={`dg-badge${b.field === 'locked' ? ' dg-badge-lock' : ''}`} data-testid="dg-badge" data-field={b.field} title={b.code}>
              {b.label}{' '}
              <span className="dg-code mono">{b.code}</span>
            </span>
          ))}
        </div>
      )}
      {data.removed > 0 && (
        <div className="dg-removed small">
          ✂ {t.dgRemovedLinks}: {data.removed}
        </div>
      )}
      {notes.map((x, i) => (
        <div key={`i${i}`} className={`dg-warn dg-sev-${x.severity}`} data-kind={x.kind}>
          {x.severity === 'info' ? 'ℹ' : '⚠'} {inLang(x.texts, lang)}
        </div>
      ))}
      {data.end && (
        <div className="dg-end small" data-testid="dg-end" title={t.dnEndTip}>
          ⏹ {t.dnEnd}
        </div>
      )}
      {data.hidden !== undefined && (
        <button
          className="link small nodrag dg-hidden"
          data-testid="dg-fold"
          title={t.dnMoreTip}
          onClick={(e) => {
            stop(e);
            data.actions.current.toggle(n.id);
          }}
        >
          ▸ {t.dnMore(data.hidden.answers, data.hidden.lines)}
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const NODE_TYPES = { line: LineCard, portal: PortalCard };

const MARGIN = 24;

/** View when the graph opens (zoom `INITIAL_ZOOM`) for a `width`×`height` canvas; too wide — the leftmost card (an entry portal or the root) at the left edge. */
export function initialViewport(pos: ReadonlyMap<string, Placed>, root: string, width: number, height: number): { x: number; y: number; zoom: number } {
  const z = INITIAL_ZOOM;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_WIDTH);
    maxY = Math.max(maxY, p.y + p.height);
  }
  if (!Number.isFinite(minX)) return { x: MARGIN, y: MARGIN, zoom: z };
  const w = (maxX - minX) * z;
  const h = (maxY - minY) * z;
  const x = w + 2 * MARGIN <= width ? (width - w) / 2 - minX * z : MARGIN - minX * z;
  let y: number;
  if (h + 2 * MARGIN <= height) y = (height - h) / 2 - minY * z;
  else {
    const r = pos.get(root);
    const center = r ? r.y + r.height / 2 : minY;
    // Root centred, but without empty space above the top node.
    y = Math.min(height / 2 - center * z, MARGIN - minY * z);
  }
  return { x, y, zoom: z };
}

/** Record types that have a graph tab. */
export const DIALOGUE_GRAPH_TYPES: ReadonlySet<string> = new Set(['DIALOGUE_PACKAGE', 'DIALOGUE', 'DIALOGUE_LINE']);
