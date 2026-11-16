/**
 * Граф только для просмотра (панель «Графы»): карточки записей и связи между ними на React
 * Flow, раскладка деревом слева направо (общая с графом диалога). Щелчок — выбрать карточку,
 * двойной щелчок — открыть запись. Правки идут из панели, не из графа.
 */
import { memo, useMemo, type ReactNode } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphLink, RecordStatus } from '@kenshi-editor/core';
import { layoutForest } from '../tree-layout.ts';

export const CARD_WIDTH = 240;
const MAX_LINES = 5;

export interface FlowCard {
  /** Узел графа (обычно строковый id записи). */
  id: string;
  sid: string;
  /** Вид: research, station, item, town, squad, char, vendor… — для цвета. */
  kind: string;
  title: string;
  sub?: string;
  lines: string[];
  status?: RecordStatus | undefined;
  missing?: boolean | undefined;
  /** Совпало с поиском. */
  matched?: boolean;
  /** Узел, от которого строится граф. */
  root?: boolean;
}

export interface FlowLink {
  id: string;
  source: string;
  target: string;
  label?: string;
  dashed?: boolean;
  /** Ссылка в данных (значения можно править). */
  link?: GraphLink;
}

type CardData = { card: FlowCard; picked: boolean };
type CardNode = Node<CardData, 'card'>;

const cardHeight = (c: FlowCard): number => 30 + (c.sub ? 16 : 0) + Math.min(MAX_LINES, c.lines.length) * 16;

const CardView = memo(function CardView({ data }: NodeProps<CardNode>): ReactNode {
  const c = data.card;
  const cls = ['gr-node', `gr-${c.kind}`, c.root ? 'gr-root' : '', c.matched ? 'gr-matched' : '', data.picked ? 'gr-picked' : '', c.missing ? 'gr-missing' : '', c.status === 'new' || c.status === 'changed' ? `gr-st-${c.status}` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} data-testid="graph-node" data-sid={c.sid} data-kind={c.kind} title={c.sid}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="gr-title">{c.title}</div>
      {c.sub !== undefined && <div className="gr-sub">{c.sub}</div>}
      {c.lines.slice(0, MAX_LINES).map((l, i) => (
        <div key={i} className="gr-line">
          {l}
        </div>
      ))}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const NODE_TYPES = { card: CardView };

interface Props {
  cards: FlowCard[];
  links: FlowLink[];
  picked?: string | undefined;
  onPick: (id: string) => void;
  onOpen: (sid: string) => void;
  /** Смена ключа — заново разложить и вписать в окно. */
  layoutKey: string;
}

export function FlowGraph(props: Props): ReactNode {
  return (
    <ReactFlowProvider key={props.layoutKey}>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

function Inner({ cards, links, picked, onPick, onOpen }: Props): ReactNode {
  const placed = useMemo(() => {
    const byId = new Map(cards.map((c) => [c.id, c]));
    return layoutForest(
      cards.map((c) => c.id),
      links,
      { width: CARD_WIDTH, columnGap: 80, rowGap: 14, height: (id) => cardHeight(byId.get(id)!) },
    );
  }, [cards, links]);
  const nodes = useMemo(
    (): CardNode[] =>
      cards.map((c) => {
        const p = placed.get(c.id) ?? { x: 0, y: 0, height: 0 };
        return { id: c.id, type: 'card', position: { x: p.x, y: p.y }, data: { card: c, picked: c.id === picked }, width: CARD_WIDTH, initialHeight: p.height, draggable: false, connectable: false };
      }),
    [cards, placed, picked],
  );
  const edges = useMemo(
    (): Edge[] =>
      links.map((l) => {
        const e: Edge = {
          id: l.id,
          source: l.source,
          target: l.target,
          markerEnd: { type: MarkerType.ArrowClosed },
          className: l.source === picked || l.target === picked ? 'gr-edge-picked' : undefined,
          focusable: false,
        };
        if (l.label !== undefined) e.label = l.label;
        if (l.dashed) e.style = { strokeDasharray: '5 4' };
        return e;
      }),
    [links, picked],
  );
  return (
    <div className="dg-canvas" data-testid="graph-canvas" data-nodes={cards.length} data-links={links.length}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={(_, n) => {
          onPick(n.id);
        }}
        onNodeDoubleClick={(_, n) => {
          onOpen(n.data.card.sid);
        }}
        onEdgeClick={(_, e) => {
          onPick(e.target);
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        minZoom={0.05}
        maxZoom={2}
        colorMode="dark"
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        panOnScroll
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        {/* Off-screen cards are not rendered, so the minimap sizes them by initialHeight; the default
            dark node colour is nearly invisible on the dark minimap, hence an explicit one. */}
        <MiniMap pannable zoomable nodeColor="#5d6168" />
      </ReactFlow>
    </div>
  );
}
