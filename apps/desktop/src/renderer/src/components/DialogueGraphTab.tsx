/**
 * Граф диалога (DIALOGUE_PACKAGE, DIALOGUE, DIALOGUE_LINE) с правкой: реплики узлами (кто говорит,
 * тексты по-русски из перевода игры, условия, действия, очки и шанс), ссылки `dialogs`/`lines`
 * рёбрами, петли — пунктиром.
 *
 * Правка: клик по узлу — реплика в инспекторе «Реплика»; «+» на узле — новый ответ или реплика;
 * протянуть от правого края узла к другому — связь (петля, общий ответ); клик по связи и
 * «разорвать» (или Delete) — убрать её. Метки «новая» / «изменена», убранные из ветки реплики игры.
 * Проверки (битые ссылки, тупики, запертые диалоги, перебивание ванили…) — на узлах и списком.
 * Поиск по тексту, свернуть ветку, показать только ветку, разложить заново, мини-карта.
 */
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  addLine,
  buildDialogueGraph,
  dialogueChecks,
  linkLine,
  linkProblem,
  removedLinks,
  unlinkLine,
  type DialogCheck,
  type DialogueGraph,
  type DialogueGraphNode,
  type TranslationIndex,
} from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import type { Project } from '../project.ts';
import { tryEdit } from '../hooks.ts';
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
}

const MAX_TEXTS = 2;
const INITIAL_ZOOM = 0.85;

interface Actions {
  go: (sid: string) => void;
  add: (sid: string) => void;
  toggle: (sid: string) => void;
}

type LineData = {
  node: DialogueGraphNode;
  ru: boolean;
  status: string | undefined;
  checks: DialogCheck[];
  removed: number;
  /** Сколько потомков по дереву (для «свернуть»). */
  kids: number;
  /** Свёрнут: сколько узлов скрыто. */
  hidden?: number;
  matched: boolean;
  editable: boolean;
  actions: { current: Actions };
};
type LineNode = Node<LineData, 'line'>;

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

function GraphView({ project, sid, version, onGo, selected, onSelect, onReport }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const ru = lang === 'ru';
  const ctx = project.ctx;
  const [translation, setTranslation] = useState<TranslationIndex | undefined | null>(null);
  const flow = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [focusRoot, setFocusRoot] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [moved, setMoved] = useState<ReadonlyMap<string, { x: number; y: number }>>(new Map());
  const [selEdge, setSelEdge] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [showInfo, setShowInfo] = useState(false);
  const report = onReport ?? (() => undefined);
  /** Последний узел, выбранный кликом в самом графе (к нему не подъезжаем). */
  const clicked = useRef<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    project.translation().then(
      (tr) => {
        if (alive) setTranslation(tr);
      },
      () => {
        if (alive) setTranslation(undefined);
      },
    );
    return () => {
      alive = false;
    };
  }, [project]);

  const root = focusRoot !== undefined && ctx.get(focusRoot) ? focusRoot : sid;
  const graph = useMemo((): DialogueGraph => buildDialogueGraph(ctx, root, translation ? { translation } : {}), [ctx, root, version, translation]);
  const checks = useMemo(() => dialogueChecks(ctx, graph), [ctx, graph, version]);
  const checksByNode = useMemo(() => {
    const m = new Map<string, DialogCheck[]>();
    for (const c of checks) m.set(c.node, [...(m.get(c.node) ?? []), c]);
    return m;
  }, [checks]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    return graph.nodes
      .filter((n) => [n.id, n.name, n.ru ?? '', ...n.texts.flatMap((x) => [x.en, x.ru ?? ''])].some((s) => s.toLowerCase().includes(q)))
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

  const actions = useRef<Actions>({ go: onGo, add: () => undefined, toggle: () => undefined });
  actions.current = {
    go: onGo,
    add: (id) => {
      const node = graph.nodes.find((n) => n.id === id);
      // После реплики NPC — ответ игрока, после ответа игрока или в начале диалога — реплика NPC.
      const speaker = node?.type === 'DIALOGUE_LINE' && !node.choice ? 1 : 0;
      let created: string | undefined;
      report(
        tryEdit(() => {
          created = addLine(ctx, id, { speaker, text: '' });
        }),
      );
      if (created !== undefined) {
        clicked.current = undefined;
        setCollapsed((c) => {
          const n = new Set(c);
          n.delete(id);
          return n;
        });
        onSelect?.(created, id);
      }
    },
    toggle: (id) => {
      setCollapsed((c) => {
        const n = new Set(c);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
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
      return {
        id: n.id,
        type: 'line',
        position: { x: p.x, y: p.y },
        data: {
          node: n,
          ru,
          status: ctx.status(n.id),
          checks: checksByNode.get(n.id) ?? [],
          removed: editable ? removedLinks(ctx, n.id).length : 0,
          kids: tree.kids.get(n.id) ?? 0,
          ...(h !== undefined ? { hidden: h } : {}),
          matched: matchSet.has(n.id),
          editable,
          actions,
        },
        selected: n.id === selected,
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
      className: `${e.back ? 'dg-edge-back' : 'dg-edge'}${e.id === selEdge ? ' dg-edge-sel' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      selected: e.id === selEdge,
      interactionWidth: 14,
      ...(e.back ? { animated: true } : {}),
    }));
    return { nodes, edges, pos };
  }, [graph, collapsed, moved, ru, checksByNode, matchSet, selected, selEdge, tree, version]);

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

  // Реплику выбрали извне (инспектор, поиск, список проверок) — подъехать к ней.
  useEffect(() => {
    if (selected === undefined || selected === clicked.current) return;
    clicked.current = selected;
    focusRef.current(selected);
  }, [selected, nodes]);

  const pick = (id: string): void => {
    const n = graph.nodes.find((x) => x.id === id);
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
    const n = graph.nodes.find((x) => x.id === id);
    if (n && (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE')) onSelect?.(id, tree.parent.get(id));
    else focus(id);
  };

  const unlinkSelected = (): void => {
    const e = graph.edges.find((x) => x.id === selEdge);
    if (!e) return;
    if (e.category !== 'lines') {
      report(t.dgUnlinkPackage);
      return;
    }
    report(tryEdit(() => { unlinkLine(ctx, e.source, e.target); }));
    setSelEdge(undefined);
  };

  const onConnect = (c: Connection): void => {
    const p = linkProblem(ctx, c.source, c.target);
    report(p ?? tryEdit(() => { linkLine(ctx, c.source, c.target); }));
  };

  const onNodesChange = (changes: NodeChange<LineNode>[]): void => {
    const pos = changes.filter((c) => c.type === 'position' && c.position);
    if (pos.length === 0) return;
    setMoved((m) => {
      const n = new Map(m);
      for (const c of pos) if (c.type === 'position' && c.position) n.set(c.id, c.position);
      return n;
    });
  };

  const shown = checks.filter((c) => showInfo || c.severity !== 'info');
  const infos = checks.filter((c) => c.severity === 'info').length;
  const choices = graph.nodes.filter((n) => n.choice).length;
  const selInGraph = selected !== undefined && graph.nodes.some((n) => n.id === selected);
  return (
    <div
      className="dg"
      data-testid="dialogue-graph"
      data-sid={sid}
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && selEdge !== undefined && !(e.target instanceof HTMLInputElement)) unlinkSelected();
      }}
    >
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
        <button
          className="small"
          title={t.dgRelayoutHint}
          data-testid="dg-relayout"
          onClick={() => {
            setMoved(new Map());
            setCollapsed(new Set());
            window.setTimeout(() => void flow.fitView({ padding: 0.1, maxZoom: 1 }), 30);
          }}
        >
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
        {selEdge !== undefined && (
          <button className="small danger" data-testid="dg-unlink" onClick={unlinkSelected}>
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
                  if (graph.nodes.some((n) => n.id === i.node)) pick(i.node);
                  else onSelect?.(i.node);
                  focus(i.node);
                }}
              >
                {i.node}
              </button>{' '}
              {ru ? i.text : t[`dgIssue_${i.kind}`]}
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
          onConnect={onConnect}
          isValidConnection={(c) => linkProblem(ctx, c.source, c.target) === undefined}
          onNodeClick={(_, n) => {
            setSelEdge(undefined);
            pick(n.id);
          }}
          onEdgeClick={(_, e) => {
            setSelEdge(e.id);
          }}
          onPaneClick={() => {
            setSelEdge(undefined);
          }}
          deleteKeyCode={null}
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
      </div>
    </div>
  );
}

const LineCard = memo(function LineCard({ data, selected }: NodeProps<LineNode>): ReactNode {
  const t = useT();
  const n = data.node;
  const kind = n.type === 'DIALOGUE_LINE' ? (n.choice ? 'choice' : 'npc') : 'head';
  const worst = data.checks.some((c) => c.severity === 'error') ? ' dg-bad' : data.checks.some((c) => c.severity === 'warning') ? ' dg-warnnode' : '';
  const st = data.status === 'new' || data.status === 'changed' ? ` dg-st-${data.status}` : '';
  const end = data.checks.some((c) => c.kind === 'end');
  const notes = data.checks.filter((c) => c.kind !== 'end');
  return (
    <div
      className={`dg-node dg-${kind}${worst}${st}${selected ? ' dg-selected' : ''}${data.matched ? ' dg-matched' : ''}`}
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
        {n.type !== 'DIALOGUE_LINE' && <span className="dg-name">{n.ru ?? n.name}</span>}
        <span className="dg-score muted mono">
          {n.score ? `+${n.score}` : ''}
          {n.chance !== undefined && n.chance < 100 ? ` ${n.chance}%` : ''}
        </span>
        {data.editable && (
          <button
            className="link small nodrag"
            data-testid="dg-add"
            title={n.type === 'DIALOGUE_LINE' && !n.choice ? t.dgAddAnswer : t.dgAddNpc}
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
      {n.texts.slice(0, MAX_TEXTS).map((x, i) => (
        <div key={i} className="dg-text" title={data.ru ? x.en : (x.ru ?? '')}>
          «{data.ru ? (x.ru ?? x.en) : x.en}»
        </div>
      ))}
      {n.type === 'DIALOGUE_LINE' && n.texts.length === 0 && <div className="dg-text muted">{t.dgEmptyText}</div>}
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
          {x.severity === 'info' ? 'ℹ' : '⚠'} {data.ru ? x.text : t[`dgIssue_${x.kind}`]}
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
