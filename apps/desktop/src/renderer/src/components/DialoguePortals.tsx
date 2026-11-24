/**
 * Transitions between dialogues in the dialogue graph (UI review G3): portal nodes and their arrows.
 * An entry portal (lines of another dialogue that interrupt / unlock / lock this one) stands left of the
 * dialogue head; an exit portal (a dialogue the lines of this graph lead to) stands right of the graph.
 * A click on a portal opens that dialogue (handled by the graph).
 */
import { memo, type ReactNode } from 'react';
import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import {
  dialogueWhen,
  enumValue,
  lineTexts,
  shortEnumLabel,
  translatedText,
  type DialoguePortal,
  type DialogueTransitions,
  type ModContext,
  type TransitionKind,
  type TranslationIndex,
} from '@kenshi-editor/core';
import { useT } from '../i18n.ts';
import { recordName } from '../data-names.ts';
import { eventEnum } from './EventUi.tsx';
import type { Placed } from '../dialogue-layout.ts';

export const PORTAL_WIDTH = 260;
const GAP = 170;
const ROW_GAP = 24;
/** Lines listed on one portal; the rest is «+ N more». */
const PORTAL_LINES = 3;
/** Portals per side; the rest goes to one «N more dialogues» card. */
const MAX_PORTALS = 8;

export interface PortalLine {
  line: string;
  text: string;
  kinds: TransitionKind[];
  crowd?: number;
}

export type PortalData = {
  dir: 'in' | 'out';
  /** The dialogue a click opens; absent on the «N more» card. */
  dialogue?: string;
  name: string;
  /** Event label and code of the other dialogue, if it hangs on a package event. */
  event?: { label: string; code: string };
  lines: PortalLine[];
  moreLines: number;
  /** «N more dialogues» card. */
  morePortals?: number;
};
export type PortalNode = Node<PortalData, 'portal'>;

export const portalId = (dir: 'in' | 'out', dialogue: string): string => `portal:${dir}:${dialogue}`;
export const isPortalId = (id: string): boolean => id.startsWith('portal:');
export const isTransitionEdge = (id: string): boolean => id.startsWith('tr:');

function firstText(ctx: ModContext, sid: string, translation: TranslationIndex | undefined | null): string {
  const rec = ctx.get(sid);
  if (!rec) return sid;
  const en = lineTexts(rec).find((s) => s !== '');
  if (en === undefined) return recordName(ctx, sid);
  return translatedText(translation ?? undefined, sid, 'text0', en) ?? en;
}

function eventOf(ctx: ModContext, dialogue: string, lang: string): PortalData['event'] {
  const def = eventEnum(ctx);
  const ev = dialogueWhen(ctx, dialogue).find((w) => w.events.length > 0)?.events[0];
  if (!def || ev === undefined) return undefined;
  const v = enumValue(def, ev);
  return { label: shortEnumLabel(def, ev, lang), code: `${v?.name ?? ''} (${ev})`.trim() };
}

function portalData(ctx: ModContext, p: DialoguePortal, dir: 'in' | 'out', lang: string, translation: TranslationIndex | undefined | null): PortalData {
  const ev = ctx.get(p.dialogue) ? eventOf(ctx, p.dialogue, lang) : undefined;
  return {
    dir,
    dialogue: p.dialogue,
    name: recordName(ctx, p.dialogue),
    ...(ev ? { event: ev } : {}),
    lines: p.lines.slice(0, PORTAL_LINES).map((l) => ({
      line: l.line,
      text: firstText(ctx, l.line, translation),
      kinds: l.kinds,
      ...(l.crowd !== undefined ? { crowd: l.crowd } : {}),
    })),
    moreLines: Math.max(0, p.lines.length - PORTAL_LINES),
  };
}

/** Estimated card height until the canvas measures it. */
function portalHeight(d: PortalData): number {
  return 46 + d.lines.length * 44 + (d.moreLines > 0 ? 18 : 0) + (d.event ? 16 : 0);
}

interface PortalArgs {
  ctx: ModContext;
  lang: string;
  translation: TranslationIndex | undefined | null;
  transitions: DialogueTransitions;
  root: string;
  /** Positions of the visible graph nodes. */
  pos: ReadonlyMap<string, Placed>;
  nodeWidth: number;
  /** Measured card heights (portals too). */
  heights: ReadonlyMap<string, number>;
  /** Positions of nodes the user dragged (portals too). */
  moved: ReadonlyMap<string, { x: number; y: number }>;
  /** The visible node that stands for a line (itself, or the folded branch that hides it). */
  visibleFor: (line: string) => string | undefined;
  kindWords: (kinds: readonly TransitionKind[]) => string;
}

/** Stack cards at their wanted tops without overlaps. */
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

function capped(list: DialoguePortal[]): { shown: DialoguePortal[]; more: number } {
  if (list.length <= MAX_PORTALS) return { shown: list, more: 0 };
  return { shown: list.slice(0, MAX_PORTALS - 1), more: list.length - (MAX_PORTALS - 1) };
}

const EDGE_BASE = {
  type: 'smoothstep',
  className: 'dg-edge-portal',
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  selectable: false,
  deletable: false,
  focusable: false,
  labelBgPadding: [4, 2] as [number, number],
  labelBgBorderRadius: 3,
  labelClassName: 'dg-edge-portal-label',
} as const;

/** Portal nodes, their positions and the transition arrows (entries, exits and inner transitions). */
export function portalElements(a: PortalArgs): { nodes: PortalNode[]; edges: Edge[]; placed: Map<string, Placed> } {
  const nodes: PortalNode[] = [];
  const edges: Edge[] = [];
  const placed = new Map<string, Placed>();
  const rootPos = a.pos.get(a.root);
  if (!rootPos) return { nodes, edges, placed };
  const height = (id: string, d: PortalData): number => a.heights.get(id) ?? portalHeight(d);
  const add = (id: string, d: PortalData, x: number, y: number): void => {
    const p = a.moved.get(id) ?? { x, y };
    const h = height(id, d);
    placed.set(id, { x: p.x, y: p.y, height: h });
    nodes.push({
      id,
      type: 'portal',
      position: p,
      data: d,
      selectable: false,
      connectable: false,
      deletable: false,
      style: { width: PORTAL_WIDTH },
      initialWidth: PORTAL_WIDTH,
      initialHeight: h,
    });
  };
  const moreCard = (dir: 'in' | 'out', n: number): PortalData => ({ dir, name: '', lines: [], moreLines: 0, morePortals: n });

  // Entries: a column left of the head, centred on it.
  const ins = capped(a.transitions.entries);
  const inData: [string, PortalData][] = ins.shown.map((p) => [portalId('in', p.dialogue), portalData(a.ctx, p, 'in', a.lang, a.translation)]);
  if (ins.more > 0) inData.push(['portal:in:+more', moreCard('in', ins.more)]);
  const total = inData.reduce((s, [id, d]) => s + height(id, d) + ROW_GAP, -ROW_GAP);
  let y = rootPos.y + rootPos.height / 2 - total / 2;
  const inX = rootPos.x - PORTAL_WIDTH - GAP;
  for (const [id, d] of inData) {
    add(id, d, inX, y);
    y += height(id, d) + ROW_GAP;
    if (d.dialogue !== undefined)
      edges.push({ ...EDGE_BASE, id: `tr:${id}`, source: id, target: a.root, label: a.kindWords(a.transitions.entries.find((p) => p.dialogue === d.dialogue)!.kinds) });
  }

  // Exits: a column right of the whole graph, each card next to its first line.
  let maxX = -Infinity;
  for (const p of a.pos.values()) maxX = Math.max(maxX, p.x + a.nodeWidth);
  const outX = maxX + GAP;
  const outs = capped(a.transitions.exits);
  const outData: { id: string; d: PortalData; p?: DialoguePortal; want: number }[] = outs.shown.map((p) => {
    const id = portalId('out', p.dialogue);
    const from = p.lines.map((l) => a.visibleFor(l.line)).find((v) => v !== undefined);
    return { id, d: portalData(a.ctx, p, 'out', a.lang, a.translation), p, want: (from !== undefined ? a.pos.get(from)?.y : undefined) ?? rootPos.y };
  });
  // The «N more» card goes last.
  if (outs.more > 0) outData.push({ id: 'portal:out:+more', d: moreCard('out', outs.more), want: Math.max(rootPos.y, ...outData.map((o) => o.want)) + 1 });
  const tops = stack(outData.map((o) => ({ id: o.id, want: o.want, h: height(o.id, o.d) })));
  for (const o of outData) {
    add(o.id, o.d, outX, tops.get(o.id)!);
    if (!o.p) continue;
    // One arrow per visible source node (lines in a folded branch share the branch node).
    const bySource = new Map<string, TransitionKind[]>();
    for (const l of o.p.lines) {
      const v = a.visibleFor(l.line);
      if (v !== undefined) bySource.set(v, [...(bySource.get(v) ?? []), ...l.kinds]);
    }
    for (const [src, kinds] of bySource)
      edges.push({ ...EDGE_BASE, id: `tr:${src}>${o.id}`, source: src, target: o.id, label: a.kindWords([...new Set(kinds)]) });
  }

  // Inner transitions (a line that locks its own dialogue, …): an arrow inside the graph.
  for (const it of a.transitions.inner) {
    const src = a.visibleFor(it.line);
    const dst = a.visibleFor(it.target);
    if (src === undefined || dst === undefined || src === dst) continue;
    edges.push({ ...EDGE_BASE, id: `tr:${src}>${dst}`, source: src, target: dst, type: 'default', label: a.kindWords(it.kinds) });
  }
  return { nodes, edges, placed };
}

/** Kind chip: the verb, the FCS code (hidden with «FCS codes» off) and the crowd share. */
export function KindChip({ kind, crowd }: { kind: TransitionKind; crowd?: number }): ReactNode {
  const t = useT();
  return (
    <span className="dg-portal-kind" data-testid="dg-portal-kind" data-kind={kind} title={t.dpKindTip(kind)}>
      {t.dpKind(kind)}
      {crowd !== undefined && ` ${t.dpCrowd(crowd)}`} <span className="dg-code mono">{kind}</span>
    </span>
  );
}

export const PortalCard = memo(function PortalCard({ data }: NodeProps<PortalNode>): ReactNode {
  const t = useT();
  const d = data;
  if (d.morePortals !== undefined)
    return (
      <div className="dg-node dg-portal dg-portal-more" data-testid="dg-portal-more" title={t.dpMorePortalsTip}>
        {d.dir === 'out' && <Handle type="target" position={Position.Left} isConnectable={false} />}
        {t.dpMorePortals(d.morePortals)}
        {d.dir === 'in' && <Handle type="source" position={Position.Right} isConnectable={false} />}
      </div>
    );
  return (
    <div className="dg-node dg-portal" data-testid="dg-portal" data-dir={d.dir} data-sid={d.dialogue} title={t.dpOpenTip(d.name)}>
      {d.dir === 'out' && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <div className="dg-portal-hd">
        <span className="dg-portal-tag">{d.dir === 'in' ? t.dpEntry : t.dpExit}</span>
        {d.dir === 'in' ? t.dpEntrySub : t.dpExitSub}
      </div>
      <div className="dg-portal-name" data-testid="dg-portal-name">
        «{d.name}»
      </div>
      {d.event && (
        <div className="dg-portal-ev muted">
          {t.dpSpoken(d.event.label)} <span className="dg-code mono">{d.event.code}</span>
        </div>
      )}
      {d.lines.map((l) => (
        <div key={l.line} className="dg-portal-line" data-testid="dg-portal-line" data-sid={l.line} title={t.dpLineTip(l.line)}>
          <div className="dg-portal-text">«{l.text}»</div>
          <div className="dg-portal-kinds">
            {l.kinds.map((k) => (
              <KindChip key={k} kind={k} {...(k === 'crowd trigger' && l.crowd !== undefined ? { crowd: l.crowd } : {})} />
            ))}
          </div>
        </div>
      ))}
      {d.moreLines > 0 && <div className="dg-portal-more-lines muted">{t.dpMoreLines(d.moreLines)}</div>}
      <div className="dg-portal-open link">{t.dpOpen}</div>
      {d.dir === 'in' && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </div>
  );
});
