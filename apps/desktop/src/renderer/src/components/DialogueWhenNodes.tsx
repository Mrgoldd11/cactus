/**
 * «When it plays» chain in the dialogue graph (UI review G8): the graph of a DIALOGUE reads left to right —
 * event → who has the package → the dialogue → its lines. Built from the same core as the «Plays when» block
 * (`dialogueWhen`). One «who» card per package (or direct character field), at most `MAX_SOURCES` of them;
 * the rest goes to one «and N more» card. Event cards are shared by the packages that use the event.
 */
import { memo, type MouseEvent, type ReactNode } from 'react';
import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { dialogueWhen, enumValue, eventHelp, eventIcon, shortEnumLabel, type ModContext, type WhenSource } from '@kenshi-editor/core';
import { useT } from '../i18n.ts';
import { recordName } from '../data-names.ts';
import { eventEnum, eventTip } from './EventUi.tsx';
import type { Placed } from '../dialogue-layout.ts';

export const WHEN_WIDTH = 210;
const GAP = 56;
const ROW_GAP = 20;
/** «Who» cards shown; with more sources the last place goes to the «and N more» card. */
const MAX_SOURCES = 4;
/** Holders named on one «who» card. */
const HOLDER_NAMES = 3;

interface Link {
  sid: string;
  name: string;
}

export type WhenData =
  | { kind: 'event'; icon: string; label: string; code?: string; tip: string; warn?: boolean; unused?: boolean }
  | { kind: 'who'; holders: Link[]; moreHolders: number; pkg?: Link; field?: string; nobody: boolean; tip: string; go: (sid: string) => void }
  | { kind: 'more'; n: number };
export type WhenNode = Node<WhenData, 'when'>;

export const isWhenId = (id: string): boolean => id.startsWith('when:');

function estimate(d: WhenData): number {
  if (d.kind === 'event') return d.code !== undefined ? 70 : 54;
  if (d.kind === 'who') return 74;
  return 40;
}

function stack(items: { id: string; want: number; h: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  let floor = -Infinity;
  for (const it of [...items].sort((a, b) => a.want - b.want)) {
    const y = Math.max(it.want, floor);
    out.set(it.id, y);
    floor = y + it.h + ROW_GAP;
  }
  return out;
}

const EDGE_BASE = {
  type: 'smoothstep',
  className: 'dg-edge-when',
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  selectable: false,
  deletable: false,
  focusable: false,
} as const;

export interface WhenWords {
  targetWord: string;
  noTarget: string;
  nowhere: string;
  nowhereTip: string;
  announcement: string;
}

interface WhenArgs {
  ctx: ModContext;
  lang: string;
  root: string;
  rootPos: Placed;
  heights: ReadonlyMap<string, number>;
  moved: ReadonlyMap<string, { x: number; y: number }>;
  words: WhenWords;
  go: (sid: string) => void;
}

function whoData(ctx: ModContext, s: WhenSource, go: (sid: string) => void): WhenData {
  const sids = [...new Set(s.holders.map((h) => h.sid))];
  const holders = sids.slice(0, HOLDER_NAMES).map((sid) => ({ sid, name: recordName(ctx, sid) }));
  const tip = s.holders.map((h) => `${recordName(ctx, h.sid)} — ${h.type} · ${h.field}${h.through !== undefined ? ` · ${recordName(ctx, h.through)}` : ''}`).slice(0, 12).join('\n');
  return {
    kind: 'who',
    holders,
    moreHolders: Math.max(0, sids.length - HOLDER_NAMES),
    ...(s.pkg !== undefined ? { pkg: { sid: s.pkg, name: recordName(ctx, s.pkg) } } : { field: s.holders[0]?.field ?? '' }),
    nobody: sids.length === 0,
    tip,
    go,
  };
}

/** Event and «who» cards left of the dialogue head, with arrows event → who → head. */
export interface WhenElements {
  nodes: WhenNode[];
  edges: Edge[];
  placed: Map<string, Placed>;
  /** Top for cards that go under the «who» column (entry portals). */
  below: number;
  /** Right edge of the «who» column. */
  right: number;
}

export function whenElements(a: WhenArgs): WhenElements {
  const nodes: WhenNode[] = [];
  const edges: Edge[] = [];
  const placed = new Map<string, Placed>();
  const def = eventEnum(a.ctx);
  const sources = dialogueWhen(a.ctx, a.root);
  const height = (id: string, d: WhenData): number => a.heights.get(id) ?? estimate(d);
  const add = (id: string, d: WhenData, x: number, y: number): void => {
    const p = a.moved.get(id) ?? { x, y };
    const h = height(id, d);
    placed.set(id, { x: p.x, y: p.y, height: h });
    nodes.push({ id, type: 'when', position: p, data: d, selectable: false, connectable: false, deletable: false, style: { width: WHEN_WIDTH }, initialWidth: WHEN_WIDTH, initialHeight: h });
  };
  const edge = (source: string, target: string): void => {
    edges.push({ ...EDGE_BASE, id: `wh:${source}>${target}`, source, target });
  };
  const center = a.rootPos.y + a.rootPos.height / 2;
  const right = a.rootPos.x - GAP;
  const whoX = right - WHEN_WIDTH;
  const evX = whoX - GAP - WHEN_WIDTH;

  if (sources.length === 0) {
    // In no package: one warning card in place of the event.
    const d: WhenData = { kind: 'event', icon: '⚠', label: a.words.nowhere, tip: a.words.nowhereTip, warn: true };
    add('when:nowhere', d, whoX, center - height('when:nowhere', d) / 2);
    edge('when:nowhere', a.root);
    return { nodes, edges, placed, below: center + height('when:nowhere', d) / 2 + ROW_GAP, right };
  }

  const shown = sources.length <= MAX_SOURCES ? sources : sources.slice(0, MAX_SOURCES - 1);
  const more = sources.length - shown.length;
  const who: { id: string; d: WhenData; s?: WhenSource }[] = shown.map((s, i) => ({ id: `when:who:${s.pkg ?? `field${i}`}`, d: whoData(a.ctx, s, a.go), s }));
  if (more > 0) who.push({ id: 'when:more', d: { kind: 'more', n: more } });
  const total = who.reduce((sum, w) => sum + height(w.id, w.d) + ROW_GAP, -ROW_GAP);
  let y = center - total / 2;
  const whoY = new Map<string, number>();
  for (const w of who) {
    add(w.id, w.d, whoX, y);
    whoY.set(w.id, y + height(w.id, w.d) / 2);
    edge(w.id, a.root);
    y += height(w.id, w.d) + ROW_GAP;
  }

  // Events: one card per event of the shown packages, next to the packages that use it.
  const byEvent = new Map<string, { d: WhenData; who: string[] }>();
  for (const w of who) {
    if (!w.s) continue;
    const evs = w.s.events.length > 0 ? w.s.events : [-1];
    for (const ev of evs) {
      const id = `when:ev:${ev}`;
      let e = byEvent.get(id);
      if (!e) {
        let d: WhenData;
        if (ev < 0) d = { kind: 'event', icon: '📢', label: a.words.announcement, tip: '' };
        else {
          const v = def ? enumValue(def, ev) : undefined;
          d = {
            kind: 'event',
            icon: eventIcon(v?.name ?? ''),
            label: def ? shortEnumLabel(def, ev, a.lang) : String(ev),
            code: `${v?.name ?? ''} (${ev})`.trim(),
            tip: eventTip(def, ev, a.lang, a.words.targetWord, a.words.noTarget),
            ...(v && eventHelp(v.name)?.unused ? { unused: true } : {}),
          };
        }
        e = { d, who: [] };
        byEvent.set(id, e);
      }
      e.who.push(w.id);
    }
  }
  const evItems = [...byEvent].map(([id, e]) => {
    const mid = e.who.reduce((s, w) => s + whoY.get(w)!, 0) / e.who.length;
    return { id, want: mid - height(id, e.d) / 2, h: height(id, e.d) };
  });
  const tops = stack(evItems);
  for (const [id, e] of byEvent) {
    add(id, e.d, evX, tops.get(id)!);
    for (const w of e.who) edge(id, w);
  }
  return { nodes, edges, placed, below: y, right };
}

export const WhenCard = memo(function WhenCard({ data }: NodeProps<WhenNode>): ReactNode {
  const t = useT();
  const d = data;
  if (d.kind === 'more')
    return (
      <div className="dg-node dg-when dg-when-more" data-testid="dg-when-more" title={t.dwMoreTip}>
        {t.dwMore(d.n)}
        <Handle type="source" position={Position.Right} isConnectable={false} />
      </div>
    );
  if (d.kind === 'event')
    return (
      <div className={`dg-node dg-when dg-when-ev${d.warn ? ' dg-when-warn' : ''}`} data-testid="dg-when-event" title={d.tip}>
        <div className="dg-when-hd">{t.dwEvent}</div>
        <div className="dg-when-ev-name">
          <span className="dg-when-icon">{d.icon}</span> {d.label}
        </div>
        {d.code !== undefined && <div className="dg-code mono">{d.code}</div>}
        {d.unused && <div className="warn small">{t.dwUnused}</div>}
        <Handle type="source" position={Position.Right} isConnectable={false} />
      </div>
    );
  const link = (l: Link): ReactNode => (
    <button
      key={l.sid}
      className="link dg-when-link nodrag"
      data-testid="dg-when-link"
      data-sid={l.sid}
      title={l.sid}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        d.go(l.sid);
      }}
    >
      {l.name}
    </button>
  );
  return (
    <div className="dg-node dg-when dg-when-who" data-testid="dg-when-who" title={d.tip}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="dg-when-hd">{t.dwWho}</div>
      <div className="dg-when-names">
        {d.nobody ? (
          <span className="warn">{t.dwNobody}</span>
        ) : (
          d.holders.map((h, i) => (
            <span key={h.sid}>
              {i > 0 ? ', ' : ''}
              {link(h)}
            </span>
          ))
        )}
        {d.moreHolders > 0 && <span className="muted"> {t.pwMore(d.moreHolders)}</span>}
      </div>
      <div className="dg-when-pkg muted">
        {d.pkg ? (
          <>
            {t.dwPkg} {link(d.pkg)}
          </>
        ) : (
          t.pwDirect(d.field ?? '')
        )}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
