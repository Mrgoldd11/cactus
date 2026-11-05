/**
 * Вкладка «Граф» у DIALOGUE_PACKAGE, DIALOGUE и DIALOGUE_LINE: реплики узлами (кто говорит,
 * тексты по-русски из перевода игры, условия, действия, очки и шанс), ссылки `dialogs`/`lines`
 * рёбрами; петли (ссылка на уже показанную реплику) — пунктиром. Сверху — проблемы:
 * нет записи, диалог без реплик, реплика, которую игра не выберет.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { buildDialogueGraph, type DialogueGraph, type DialogueGraphNode, type TranslationIndex } from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import type { Project } from '../project.ts';
import { layoutDialogue, NODE_WIDTH, type Placed } from '../dialogue-layout.ts';

interface Props {
  project: Project;
  sid: string;
  version: number;
  onGo: (sid: string) => void;
}

const MAX_TEXTS = 2;
const INITIAL_ZOOM = 0.85;

type LineData = { node: DialogueGraphNode; ru: boolean; onGo: (sid: string) => void };
type LineNode = Node<LineData, 'line'>;

export function DialogueGraphTab(props: Props): ReactNode {
  return (
    // Новый провайдер на каждую запись — стартовый вид заново.
    <ReactFlowProvider key={props.sid}>
      <GraphView {...props} />
    </ReactFlowProvider>
  );
}

function GraphView({ project, sid, version, onGo }: Props): ReactNode {
  const t = useT();
  const lang = useLang();
  const [translation, setTranslation] = useState<TranslationIndex | undefined | null>(null);
  const flow = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);

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

  const graph = useMemo((): DialogueGraph => buildDialogueGraph(project.ctx, sid, translation ? { translation } : {}), [project, sid, version, translation]);

  const { nodes, edges, pos } = useMemo(() => {
    const pos = layoutDialogue(graph, MAX_TEXTS);
    const ru = lang === 'ru';
    const nodes: LineNode[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'line',
      position: { x: pos.get(n.id)?.x ?? 0, y: pos.get(n.id)?.y ?? 0 },
      data: { node: n, ru, onGo },
      style: { width: NODE_WIDTH },
      // Размер для мини-карты: узлы не управляются через onNodesChange, `measured` у них нет.
      initialWidth: NODE_WIDTH,
      initialHeight: pos.get(n.id)?.height ?? 60,
    }));
    const edges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.back ? 'default' : 'smoothstep',
      className: e.back ? 'dg-edge-back' : 'dg-edge',
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      ...(e.back ? { animated: true } : {}),
    }));
    return { nodes, edges, pos };
  }, [graph, lang, onGo]);

  // Стартовый вид в читаемом масштабе: граф целиком, если влезает, иначе корень у левого края
  // по центру высоты (раньше вид центрировался по первым репликам, и в узком окне в середине
  // могло не оказаться ни одного узла).
  const startView = useRef<(inst: ReactFlowInstance<LineNode>) => void>(() => undefined);
  startView.current = (inst) => {
    const el = canvasRef.current;
    void inst.setViewport(initialViewport(pos, graph.root, el?.clientWidth ?? 800, el?.clientHeight ?? 600));
  };

  const focus = useCallback(
    (id: string) => {
      const n = nodes.find((x) => x.id === id);
      if (n) void flow.setCenter(n.position.x + NODE_WIDTH / 2, n.position.y + 40, { zoom: 1 });
    },
    [flow, nodes],
  );


  const choices = graph.nodes.filter((n) => n.choice).length;
  return (
    <div className="dg" data-testid="dialogue-graph" data-sid={sid}>
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
      {graph.issues.length > 0 && (
        <ul className="dg-issues" data-testid="dg-issues">
          {graph.issues.slice(0, 30).map((i, k) => (
            <li key={`${i.node}:${i.kind}:${k}`} className={`dg-issue dg-issue-${i.kind}`} data-kind={i.kind} data-node={i.node}>
              ⚠{' '}
              <button
                className="link mono"
                onClick={() => {
                  focus(i.node);
                }}
              >
                {i.node}
              </button>{' '}
              {lang === 'ru' ? i.text : t[`dgIssue_${i.kind}`]}
            </li>
          ))}
          {graph.issues.length > 30 && <li className="muted">… {graph.issues.length - 30}</li>}
        </ul>
      )}
      <div className="dg-canvas" ref={canvasRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          nodesConnectable={false}
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

const LineCard = memo(function LineCard({ data }: NodeProps<LineNode>): ReactNode {
  const t = useT();
  const n = data.node;
  const kind = n.type === 'DIALOGUE_LINE' ? (n.choice ? 'choice' : 'npc') : 'head';
  const bad = n.issues.length > 0;
  return (
    <div className={`dg-node dg-${kind}${bad ? ' dg-bad' : ''}`} data-testid="dg-node" data-id={n.id}>
      <Handle type="target" position={Position.Left} />
      <div className="dg-title">
        <span className={`dg-chip ${kind}`}>
          {n.type === 'DIALOGUE_LINE' ? (n.choice ? t.dgPlayer : (n.speakerLabel ?? t.dgNpc)) : n.type}
        </span>
        {n.eventLabel !== undefined && <span className="dg-event mono">{n.eventLabel}</span>}
        {n.type !== 'DIALOGUE_LINE' && <span className="dg-name">{n.ru ?? n.name}</span>}
        <span className="dg-score muted mono">
          {n.score ? `+${n.score}` : ''}
          {n.chance !== undefined && n.chance < 100 ? ` ${n.chance}%` : ''}
        </span>
        <button
          className="link small nodrag"
          title={n.id}
          onClick={() => {
            data.onGo(n.id);
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
      {n.issues.map((x, i) => (
        <div key={`i${i}`} className="dg-warn">
          ⚠ {data.ru ? x.text : t[`dgIssue_${x.kind}`]}
        </div>
      ))}
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
