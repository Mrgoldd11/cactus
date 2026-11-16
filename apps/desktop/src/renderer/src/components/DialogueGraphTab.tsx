/**
 * Граф диалога (DIALOGUE_PACKAGE, DIALOGUE, DIALOGUE_LINE) с правкой: реплики узлами (кто говорит,
 * тексты по-русски из перевода игры, условия, действия, очки и шанс), ссылки `dialogs`/`lines`
 * рёбрами, петли — пунктиром.
 *
 * Правка прямо в графе:
 * - ПКМ по узлу, связи или пустому месту — меню действий (изменить текст, добавить ответ или
 *   реплику, связать, копия, удалить, вставить реплику между, вернуть как в игре…);
 * - двойной клик или F2 — текст прямо в узле (Enter — сохранить, Esc — отмена);
 * - Delete — удалить выделенное (реплики и связи), Ctrl+D — копия, Ctrl+C/Ctrl+V — копировать
 *   и вставить, Shift+рамка или Ctrl+клик — выделить несколько, Esc — снять выделение;
 * - «+» на узле — новый ответ или реплика; протянуть от правого края узла к другому — связь.
 * Всё через команды ядра: одна правка — одна отмена (Ctrl+Z / Ctrl+Y).
 * Метки «новая» / «изменена», убранные из ветки реплики игры. Проверки (битые ссылки, тупики,
 * запертые диалоги, перебивание ванили…) — на узлах и списком. Поиск по тексту, свернуть ветку,
 * показать только ветку, разложить заново, мини-карта.
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
  addLine,
  buildDialogueGraph,
  deleteGraphItems,
  dialogueChecks,
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
} from '@kenshi-editor/core';
import { inLang, useLang, useT } from '../i18n.ts';
import { useGameTexts } from '../data-names.ts';
import type { Project } from '../project.ts';
import { tryEdit } from '../hooks.ts';
import { isTypingIn, shortcut } from '../keys.ts';
import { layoutDialogue, NODE_WIDTH, type Placed } from '../dialogue-layout.ts';

interface Props {
  project: Project;
  sid: string;
  version: number;
  onGo: (sid: string) => void;
  /** Выбранная реплика (подсвечивается; при выборе извне граф к ней подъезжает). */
  selected?: string | undefined;
  /** Выбрать реплику или диалог графа; `parent` — откуда к ней пришли. */
  onSelect?: (sid: string, parent?: string) => void;
  onReport?: (err: string | undefined) => void;
  /** Открыть (или показать) панель «Реплика». */
  onShowLine?: () => void;
  /** Открыта ли панель «Реплика» (кнопка «Открыть реплику» выделяется, если нет). */
  isLineOpen?: () => boolean;
}

const MAX_TEXTS = 2;
const INITIAL_ZOOM = 0.85;
const MENU_WIDTH = 240;

interface Actions {
  go: (sid: string) => void;
  add: (sid: string) => void;
  toggle: (sid: string) => void;
  commit: (sid: string, text: string) => void;
  cancel: () => void;
}

type LineData = {
  node: DialogueGraphNode;
  status: string | undefined;
  checks: DialogCheck[];
  removed: number;
  /** Сколько потомков по дереву (для «свернуть»). */
  kids: number;
  /** Свёрнут: сколько узлов скрыто. */
  hidden?: number;
  matched: boolean;
  editable: boolean;
  /** Текст правится прямо в узле; `raw` — текущий первый текст записи. */
  editing: boolean;
  raw?: string;
  actions: { current: Actions };
};
type LineNode = Node<LineData, 'line'>;

interface Menu {
  /** Место меню на холсте (от левого верхнего угла). */
  x: number;
  y: number;
  kind: 'node' | 'edge' | 'pane';
  id?: string;
  /** Точка графа под мышью (для «новая реплика» и «вставить»). */
  at?: { x: number; y: number };
}

interface Ask {
  text: string;
  run: () => void;
}

/** Скопированные реплики (Ctrl+C / «Копировать») — общие для всех графов окна. */
let clipboard: string[] = [];

export function DialogueGraphTab(props: Props): ReactNode {
  return (
    // Новый провайдер на каждую запись — стартовый вид заново.
    <ReactFlowProvider key={props.sid}>
      <GraphView {...props} />
    </ReactFlowProvider>
  );
}

/** Узлы, скрытые свёрнутыми ветками (потомки по дереву, без петель), и сколько скрыл каждый. */
function hiddenBy(graph: DialogueGraph, collapsed: ReadonlySet<string>): { hidden: Set<string>; count: Map<string, number> } {
  const kids = new Map<string, string[]>();
  for (const e of graph.edges) if (!e.back) kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
  const hidden = new Set<string>();
  const count = new Map<string, number>();
  for (const c of collapsed) {
    if (hidden.has(c)) continue;
    let n = 0;
    const stack = [...(kids.get(c) ?? [])];
    while (stack.length) {
      const x = stack.pop()!;
      if (hidden.has(x) || x === c) continue;
      hidden.add(x);
      n++;
      stack.push(...(kids.get(x) ?? []));
    }
    count.set(c, n);
  }
  return { hidden, count };
}

function GraphView({ project, sid, version, onGo, selected, onSelect, onReport, onShowLine, isLineOpen }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const translation = useGameTexts(project);
  const flow = useReactFlow();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusRoot, setFocusRoot] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
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
  /** Последний узел, выбранный кликом в самом графе (к нему не подъезжаем). */
  const clicked = useRef<string | undefined>(undefined);


  const root = focusRoot !== undefined && ctx.get(focusRoot) ? focusRoot : sid;
  const graph = useMemo((): DialogueGraph => buildDialogueGraph(ctx, root, translation ? { translation } : {}), [ctx, root, version, translation]);
  const checks = useMemo(() => dialogueChecks(ctx, graph), [ctx, graph, version]);
  const checksByNode = useMemo(() => {
    const m = new Map<string, DialogCheck[]>();
    for (const c of checks) m.set(c.node, [...(m.get(c.node) ?? []), c]);
    return m;
  }, [checks]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

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

  // ── что можно с узлом ──
  const isLine = (id: string): boolean => {
    const n = byId.get(id);
    return n !== undefined && !n.missing && n.type === 'DIALOGUE_LINE' && ctx.get(id) !== undefined;
  };
  const canParent = (id: string): boolean => {
    const n = byId.get(id);
    return n !== undefined && !n.missing && (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE') && ctx.get(id) !== undefined;
  };
  /** После реплики NPC — ответ игрока, после ответа игрока или в начале диалога — реплика NPC. */
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

  /** Новая реплика создана: развернуть родителя, выделить, сразу править текст. */
  const created = (id: string, parent: string, at?: { x: number; y: number }): void => {
    setCollapsed((c) => {
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
      if ((old[0] ?? '') !== text) report(tryEdit(() => { setLineTexts(ctx, id, [text, ...old.slice(1)]); }));
    }
    refocus();
  };

  /** Выделенные в графе реплики (или одна `id`, если её нет в выделении). */
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
      setCollapsed((c) => {
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

  /** Куда вставлять: единственный выделенный узел, который может вести дальше, иначе корень. */
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
    // Панель открывается в раскладке окна — перерисовать кнопку после этого.
    requestAnimationFrame(() => { setTick((x) => x + 1); });
  };

  const actions = useRef<Actions>({ go: onGo, add: () => undefined, toggle: () => undefined, commit: () => undefined, cancel: () => undefined });
  actions.current = {
    go: onGo,
    add: (id) => { add(id); },
    toggle: (id) => {
      setCollapsed((c) => {
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
    const { hidden, count } = hiddenBy(graph, collapsed);
    const visible: DialogueGraph = { ...graph, nodes: graph.nodes.filter((n) => !hidden.has(n.id)), edges: graph.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target)) };
    const pos = layoutDialogue(visible, MAX_TEXTS);
    const nodes: LineNode[] = visible.nodes.map((n) => {
      const p = moved.get(n.id) ?? pos.get(n.id) ?? { x: 0, y: 0 };
      const editable = !n.missing && (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE');
      const h = count.get(n.id);
      const rec = n.id === editing ? ctx.get(n.id) : undefined;
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
          ...(rec ? { raw: lineTexts(rec)[0] ?? '' } : {}),
          actions,
        },
        selected: selNodes.has(n.id),
        style: { width: NODE_WIDTH },
        // Размер для мини-карты: `measured` у узлов нет, пока его не пришлёт поле.
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
    return { nodes, edges, pos };
  }, [graph, collapsed, moved, checksByNode, matchSet, selNodes, selEdges, editing, tree, version]);

  // Стартовый вид в читаемом масштабе: граф целиком, если влезает, иначе корень у левого края.
  const startView = useRef<(inst: ReactFlowInstance<LineNode>) => void>(() => undefined);
  startView.current = (inst) => {
    const el = canvasRef.current;
    void inst.setViewport(initialViewport(pos, graph.root, el?.clientWidth ?? 800, el?.clientHeight ?? 600));
  };

  const focus = (id: string): void => {
    const n = nodes.find((x) => x.id === id);
    if (n) void flow.setCenter(n.position.x + NODE_WIDTH / 2, n.position.y + 40, { zoom: 1 });
  };
  const focusRef = useRef(focus);
  focusRef.current = focus;

  // Реплику выбрали извне (инспектор, поиск, список проверок) — подъехать к ней и выделить.
  useEffect(() => {
    if (selected === undefined || !byId.has(selected)) return;
    setSelNodes((s) => (s.has(selected) ? s : new Set([selected])));
    if (selected === clicked.current) return;
    clicked.current = selected;
    focusRef.current(selected);
  }, [selected, nodes]);

  // Меню закрывается щелчком мимо него.
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
    // Найденное в свёрнутой ветке — развернуть.
    setCollapsed(new Set());
    clicked.current = undefined;
    const n = byId.get(id);
    if (n && (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE')) onSelect?.(id, tree.parent.get(id));
    else focus(id);
  };

  const onConnect = (c: Connection): void => {
    const p = linkProblem(ctx, c.source, c.target);
    report(p ?? tryEdit(() => { linkLine(ctx, c.source, c.target); }));
  };

  const finishLink = (to: string): void => {
    const from = linkFrom!;
    setLinkFrom(undefined);
    if (to === from) return;
    const p = linkProblem(ctx, from, to);
    report(p ?? tryEdit(() => { linkLine(ctx, from, to); }));
  };

  const onNodesChange = (changes: NodeChange<LineNode>[]): void => {
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

  // ── меню ──
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
    // Разделители не в начале, не в конце и не подряд.
    return out.filter((x, i, a) => {
      const isSep = (y: ReactNode): boolean => typeof y === 'object' && y !== null && 'key' in y && String(y.key).startsWith('sep');
      if (!isSep(x)) return true;
      return i > 0 && i < a.length - 1 && !isSep(a[i - 1]) && a.slice(i + 1).some((y) => !isSep(y));
    });
  };

  const relayout = (): void => {
    setMoved(new Map());
    setCollapsed(new Set());
    window.setTimeout(() => void flow.fitView({ padding: 0.1, maxZoom: 1 }), 30);
  };

  const shown = checks.filter((c) => showInfo || c.severity !== 'info');
  const infos = checks.filter((c) => c.severity === 'info').length;
  const choices = graph.nodes.filter((n) => n.choice).length;
  const selInGraph = selected !== undefined && byId.has(selected);
  const lineOpen = isLineOpen?.() ?? true;
  const selLines = [...selNodes].filter(isLine);
  return (
    <div className="dg" data-testid="dialogue-graph" data-sid={sid} ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="dg-bar">
        <span className="muted small" data-testid="dg-stats">
          {t.dgNodes} {graph.nodes.length}, {t.dgChoices} {choices}, {t.dgLoops} {graph.edges.filter((e) => e.back).length}
          {translation === null ? ` · ${t.dgLoadingTr}` : translation === undefined ? ` · ${t.dgNoTr}` : ''}
        </span>
        <span className="dg-legend small">
          <span className="dg-chip npc">{t.dgNpc}</span>
          <span className="dg-chip choice">{t.dgPlayer}</span>
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
        <button className="small" title={t.dgRelayoutHint} data-testid="dg-relayout" onClick={relayout}>
          ⟲ {t.dgRelayout}
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
        {selInGraph && onShowLine && (
          <button className={`small${lineOpen ? '' : ' primary dg-call'}`} data-testid="dg-open-line" title={t.dgOpenLineHint} onClick={() => { showLine(); }}>
            ❝ {t.dgOpenLine}
          </button>
        )}
        {selLines.length > 0 && (
          <button className="small danger" data-testid="dg-delete" title="Del" onClick={() => { removeSelection(selLines, [...selEdges]); }}>
            🗑 {t.dgMenuDelete}
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
              {i.severity === 'error' ? '⛔' : i.severity === 'warning' ? '⚠' : 'ℹ'}{' '}
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
            if (linkFrom !== undefined) finishLink(n.id);
            else pick(n.id);
          }}
          onNodeDoubleClick={(_, n) => {
            if (isLine(n.id)) startEdit(n.id);
          }}
          onNodeContextMenu={(e, n) => {
            if (!selNodes.has(n.id)) {
              selectOnly(n.id);
              pick(n.id);
            }
            openMenu(e, { kind: 'node', id: n.id });
          }}
          onEdgeContextMenu={(e, ed) => {
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
          // Колесо листает (как страницу), Ctrl+колесо — масштаб.
          panOnScroll
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => ((n.data as LineData).node.choice ? '#4b6f9e' : '#5d6168')} />
        </ReactFlow>
        {linkFrom !== undefined && (
          <div className="dg-banner" data-testid="dg-link-mode">
            🔗 {t.dgLinkMode}
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

/** Правка текста прямо в узле: Enter — сохранить, Shift+Enter — новая строка, Esc — отмена. */
function InlineText({ sid, value, actions }: { sid: string; value: string; actions: { current: Actions } }): ReactNode {
  const t = useT();
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);
  const finish = (save: boolean): void => {
    if (done.current) return;
    done.current = true;
    if (save) actions.current.commit(sid, text);
    else actions.current.cancel();
  };
  return (
    <>
      <textarea
        ref={ref}
        className="dg-edit nodrag nowheel nopan"
        data-testid="dg-edit"
        rows={Math.min(6, Math.max(2, text.split('\n').length))}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => {
          finish(true);
        }}
      />
      <div className="dg-edit-hint muted small">{t.dgEditHint}</div>
    </>
  );
}

const LineCard = memo(function LineCard({ data, selected }: NodeProps<LineNode>): ReactNode {
  const t = useT();
  const lang = useLang();
  const n = data.node;
  const kind = n.type === 'DIALOGUE_LINE' ? (n.choice ? 'choice' : 'npc') : 'head';
  const worst = data.checks.some((c) => c.severity === 'error') ? ' dg-bad' : data.checks.some((c) => c.severity === 'warning') ? ' dg-warnnode' : '';
  const st = data.status === 'new' || data.status === 'changed' ? ` dg-st-${data.status}` : '';
  const end = data.checks.some((c) => c.kind === 'end');
  const notes = data.checks.filter((c) => c.kind !== 'end');
  return (
    <div
      className={`dg-node dg-${kind}${worst}${st}${selected ? ' dg-selected' : ''}${data.matched ? ' dg-matched' : ''}${data.editing ? ' dg-editing' : ''}`}
      data-testid="dg-node"
      data-id={n.id}
      data-status={data.status}
    >
      <Handle type="target" position={Position.Left} />
      <div className="dg-title">
        {data.kids > 0 && (
          <button
            className="link small nodrag dg-toggle"
            data-testid="dg-toggle"
            title={data.hidden !== undefined ? t.dgExpand : t.dgCollapse}
            onClick={(e) => {
              e.stopPropagation();
              data.actions.current.toggle(n.id);
            }}
          >
            {data.hidden !== undefined ? '▸' : '▾'}
          </button>
        )}
        <span className={`dg-chip ${kind}`}>{n.type === 'DIALOGUE_LINE' ? (n.choice ? t.dgPlayer : (n.speakerLabel ?? t.dgNpc)) : n.type}</span>
        {data.status === 'new' && <span className="st-badge st-new">{t.lineStatus_new}</span>}
        {data.status === 'changed' && <span className="st-badge st-changed">{t.lineStatus_changed}</span>}
        {n.eventLabel !== undefined && <span className="dg-event mono">{n.eventLabel}</span>}
        {n.type !== 'DIALOGUE_LINE' && <span className="dg-name">{n.localized ?? n.name}</span>}
        <span className="dg-score muted mono">
          {n.score ? `+${n.score}` : ''}
          {n.chance !== undefined && n.chance < 100 ? ` ${n.chance}%` : ''}
        </span>
        {data.editable && (
          <button
            className="link small nodrag"
            data-testid="dg-add"
            title={`${n.type === 'DIALOGUE_LINE' && !n.choice ? t.dgAddAnswer : t.dgAddNpc} (${t.dgAddTip})`}
            onClick={(e) => {
              e.stopPropagation();
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
            e.stopPropagation();
            data.actions.current.go(n.id);
          }}
        >
          ↗
        </button>
      </div>
      {data.editing ? (
        <InlineText sid={n.id} value={data.raw ?? ''} actions={data.actions} />
      ) : (
        <>
          {n.texts.slice(0, MAX_TEXTS).map((x, i) => (
            <div key={i} className="dg-text" title={x.localized !== undefined ? x.en : ''}>
              «{x.localized ?? x.en}»
            </div>
          ))}
          {n.type === 'DIALOGUE_LINE' && n.texts.length === 0 && <div className="dg-text muted">{t.dgEmptyText}</div>}
        </>
      )}
      {n.texts.length > MAX_TEXTS && (
        <div className="muted small">
          +{n.texts.length - MAX_TEXTS} {t.dgVariants}
        </div>
      )}
      {n.conditions.map((c, i) => (
        <div key={`c${i}`} className="dg-cond mono">
          ? {c}
        </div>
      ))}
      {n.filters.map((c, i) => (
        <div key={`f${i}`} className="dg-cond mono">
          ? {c}
        </div>
      ))}
      {n.effects.map((c, i) => (
        <div key={`e${i}`} className="dg-effect mono">
          ! {c}
        </div>
      ))}
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
      {end && <div className="dg-end small muted">⏹ {t.dgEnd}</div>}
      {data.hidden !== undefined && (
        <div className="dg-hidden small muted">
          ▸ {t.dgHidden} {data.hidden}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const NODE_TYPES = { line: LineCard };

const MARGIN = 24;

/** Вид при открытии графа (масштаб `INITIAL_ZOOM`) для холста `width`×`height`. */
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
  const x = w + 2 * MARGIN <= width ? (width - w) / 2 - minX * z : MARGIN - (pos.get(root)?.x ?? minX) * z;
  let y: number;
  if (h + 2 * MARGIN <= height) y = (height - h) / 2 - minY * z;
  else {
    const r = pos.get(root);
    const center = r ? r.y + r.height / 2 : minY;
    // Корень по центру, но без пустоты над верхним узлом.
    y = Math.min(height / 2 - center * z, MARGIN - minY * z);
  }
  return { x, y, zoom: z };
}

/** Типы записей, у которых есть вкладка графа. */
export const DIALOGUE_GRAPH_TYPES: ReadonlySet<string> = new Set(['DIALOGUE_PACKAGE', 'DIALOGUE', 'DIALOGUE_LINE']);
