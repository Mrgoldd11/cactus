/**
 * «Tree (as in FCS)» view of a dialogue (UI review G5): the same graph as `DialogueGraphTab`, read top to
 * bottom like a script. Rows are indented by depth, the colour label says who speaks (NPC / player /
 * interjection), texts are shown whole; conditions, effects and properties stand in columns, «conversation
 * ends» marks the answers with nothing after them. Toolbar as in FCS: add an NPC line / player answer /
 * interjection under the selected row, ↑↓ to reorder in the branch, unfold all, text search. Selection is the
 * workbench one (kind «line»), so the graph, the tree and the line panel show the same line. At the bottom
 * the transitions to other dialogues (G3). Every edit is a core command: one edit — one undo.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  addLine,
  buildDialogueGraph,
  canMoveLine,
  deleteGraphItems,
  dialogueChecks,
  dialogueDeepFolds,
  dialogueTransitions,
  dialogueTreeRows,
  dialogueLineViews,
  lineParents,
  lineTexts,
  moveCopies,
  moveLine,
  quote,
  setLineTexts,
  type DialogCheck,
  type DialogueGraph,
  type DialogueGraphNode,
  type DialogueTreeRow,
  type LineView,
  type TransitionKind,
} from '@kenshi-editor/core';
import { inLang, useLang, useT } from '../i18n.ts';
import { recordName, useGameTexts } from '../data-names.ts';
import type { Project } from '../project.ts';
import { tryEdit } from '../hooks.ts';
import { isTypingIn } from '../keys.ts';
import { InlineText } from './DialogueInlineText.tsx';

export interface TreeProps {
  project: Project;
  sid: string;
  version: number;
  onGo: (sid: string) => void;
  selected?: string | undefined;
  onSelect?: (sid: string, parent?: string) => void;
  onReport?: (err: string | undefined) => void;
  /** Open (or show) the «Line» panel. */
  onShowLine?: () => void;
}

/** Same rules as the graph: bigger dialogues open with deep branches folded. */
const FOLD_MIN_NODES = 20;
/** Speaker of the lines added by «+ interjection» (T_INTERJECTOR1). */
const INTERJECTOR = 3;
/** Shared with the graph: FCS codes next to the plain words. */
const CODES_KEY = 'kedit.graph.codes';
const EMPTY: ReadonlySet<string> = new Set();

type Phrase = LineView['conditions'][number];

interface Ask {
  text: string;
  list?: string[];
  note?: string;
  yes: string;
  danger?: boolean;
  run: () => void;
}

/** A transition a line holds toward another dialogue (shown in its «Effects» column). */
interface LineTransition {
  dialogue: string;
  kinds: TransitionKind[];
}

export function DialogueTreeView({ project, sid, version, onGo, selected, onSelect, onReport, onShowLine }: TreeProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const ctx = project.ctx;
  const translation = useGameTexts(project);
  const report = onReport ?? (() => undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const graph = useMemo((): DialogueGraph => buildDialogueGraph(ctx, sid, { lang, ...(translation ? { translation } : {}) }), [ctx, sid, version, translation, lang]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const checks = useMemo(() => dialogueChecks(ctx, graph), [ctx, graph, version]);
  const checksByNode = useMemo(() => {
    const m = new Map<string, DialogCheck[]>();
    for (const c of checks) m.set(c.node, [...(m.get(c.node) ?? []), c]);
    return m;
  }, [checks]);
  const views = useMemo(() => dialogueLineViews(ctx, graph, lang), [ctx, graph, lang, version]);
  const transitions = useMemo(() => dialogueTransitions(ctx, graph), [ctx, graph, version]);
  const lineTransitions = useMemo(() => {
    const m = new Map<string, LineTransition[]>();
    const put = (line: string, x: LineTransition): void => { m.set(line, [...(m.get(line) ?? []), x]); };
    for (const p of transitions.exits) for (const l of p.lines) put(l.line, { dialogue: p.dialogue, kinds: l.kinds });
    for (const x of transitions.inner) put(x.line, { dialogue: x.target, kinds: x.kinds });
    return m;
  }, [transitions]);
  const outgoing = useMemo(() => new Set(graph.edges.map((e) => e.source)), [graph]);

  const deep = useMemo(() => dialogueDeepFolds(graph), [graph]);
  /** Folded rows; `undefined` — as at first (deep branches of a big dialogue folded, like the graph). */
  const [foldedState, setFolded] = useState<ReadonlySet<string> | undefined>(undefined);
  const folded = foldedState ?? (graph.nodes.length > FOLD_MIN_NODES ? deep : EMPTY);
  const fold = (f: (c: ReadonlySet<string>) => ReadonlySet<string>): void => {
    setFolded((c) => f(c ?? folded));
  };
  const rows = useMemo(() => dialogueTreeRows(graph, folded), [graph, folded]);
  const allRows = useMemo(() => dialogueTreeRows(graph), [graph]);
  /** Where each node stands as a whole row: its tree parent and the edge to it. */
  const place = useMemo(() => new Map(allRows.filter((r) => r.link === undefined).map((r) => [r.id, r])), [allRows]);

  const [codes, setCodesState] = useState(() => localStorage.getItem(CODES_KEY) !== '0');
  const setCodes = (on: boolean): void => {
    localStorage.setItem(CODES_KEY, on ? '1' : '0');
    setCodesState(on);
  };
  const [sel, setSel] = useState<string | undefined>(selected !== undefined && byId.has(selected) ? selected : undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [variantsOpen, setVariantsOpen] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [ask, setAsk] = useState<Ask | undefined>(undefined);
  /** The last row selected by a click in the tree itself (no scrolling to it). */
  const clicked = useRef<string | undefined>(undefined);
  /** A row to scroll to once it is rendered. */
  const pendingScroll = useRef<string | undefined>(undefined);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return [];
    const order = allRows.filter((r) => r.link === undefined).map((r) => r.id);
    return order.filter((id) => {
      const n = byId.get(id);
      return n !== undefined && [n.id, n.name, n.localized ?? '', ...n.texts.flatMap((x) => [x.en, x.localized ?? ''])].some((s) => s.toLowerCase().includes(q));
    });
  }, [allRows, byId, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);

  // ── what can be done with a row ──
  const isLine = (id: string): boolean => {
    const n = byId.get(id);
    return n !== undefined && !n.missing && n.type === 'DIALOGUE_LINE' && ctx.get(id) !== undefined;
  };
  const canParent = (id: string): boolean => {
    const n = byId.get(id);
    return n !== undefined && !n.missing && (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE') && ctx.get(id) !== undefined;
  };

  /** Unfold the rows that hide `id`. */
  const reveal = (id: string): void => {
    const up = new Set<string>();
    for (let p = place.get(id)?.parent; p !== undefined && !up.has(p); p = place.get(p)?.parent) up.add(p);
    if ([...up].some((u) => folded.has(u))) fold((c) => new Set([...c].filter((x) => !up.has(x))));
  };
  const scrollTo = (id: string): void => {
    pendingScroll.current = id;
  };
  const refocus = (): void => {
    rootRef.current?.focus({ preventScroll: true });
  };

  /** Select a row; dialogues and lines go to the workbench selection (graph and line panel follow). */
  const pick = (id: string, opts: { scroll?: boolean } = {}): void => {
    const n = byId.get(id);
    if (!n) return;
    setSel(id);
    if (opts.scroll) {
      reveal(id);
      scrollTo(id);
      clicked.current = undefined;
    } else clicked.current = id;
    if (n.type === 'DIALOGUE' || n.type === 'DIALOGUE_LINE') onSelect?.(id, place.get(id)?.parent);
  };

  // Selected from outside (the graph, the line panel, the check list) — select, unfold and scroll to it.
  useEffect(() => {
    if (selected === undefined || !byId.has(selected)) return;
    setSel(selected);
    if (selected === clicked.current) return;
    clicked.current = selected;
    reveal(selected);
    scrollTo(selected);
  }, [selected, byId]);

  useEffect(() => {
    const id = pendingScroll.current;
    if (id === undefined) return;
    const el = bodyRef.current?.querySelector(`[data-testid="dt-row"][data-id="${CSS.escape(id)}"]:not([data-link])`);
    if (!el) return;
    pendingScroll.current = undefined;
    el.scrollIntoView({ block: 'nearest' });
  });

  const add = (speaker: number): void => {
    const parent = sel !== undefined && canParent(sel) ? sel : graph.root;
    if (!canParent(parent)) {
      report(t.dgNewNeedsDialog);
      return;
    }
    let id: string | undefined;
    report(tryEdit(() => { id = addLine(ctx, parent, { speaker, text: '' }); }));
    if (id === undefined) return;
    fold((c) => new Set([...c].filter((x) => x !== parent)));
    setSel(id);
    clicked.current = id;
    scrollTo(id);
    onSelect?.(id, parent);
    setEditing(id);
  };

  const startEdit = (id: string): void => {
    if (!isLine(id)) {
      report(t.dgNotALine);
      return;
    }
    setSel(id);
    setEditing(id);
  };

  const commit = (id: string, text: string): void => {
    setEditing(undefined);
    const rec = ctx.get(id);
    if (rec) {
      // The first variant is the one the row shows; the others are edited in the line panel.
      const old = lineTexts(rec);
      if ((old[0] ?? '') !== text) report(tryEdit(() => { setLineTexts(ctx, id, old.length === 0 ? [text] : old.map((x, k) => (k === 0 ? text : x))); }));
    }
    refocus();
  };

  /** The selected line, its tree parent and whether the link between them is a `lines` reference (movable). */
  const movable = (): { child: string; parent: string } | undefined => {
    if (sel === undefined || !isLine(sel)) return undefined;
    const r = place.get(sel);
    if (r?.parent === undefined || r.edge === undefined) return undefined;
    const e = graph.edges.find((x) => x.id === r.edge);
    return e?.category === 'lines' && ctx.get(r.parent) ? { child: sel, parent: r.parent } : undefined;
  };
  const mv = movable();

  const move = (dir: -1 | 1): void => {
    if (!mv || !canMoveLine(ctx, mv.parent, mv.child, dir)) return;
    const run = (): void => {
      setAsk(undefined);
      let replaced = new Map<string, string>();
      report(tryEdit(() => { replaced = moveLine(ctx, mv.parent, mv.child, dir); }));
      const now = replaced.get(mv.child);
      if (now !== undefined) {
        setSel(now);
        clicked.current = now;
        onSelect?.(now, mv.parent);
      }
      scrollTo(now ?? mv.child);
      refocus();
    };
    const copies = moveCopies(ctx, mv.parent, mv.child, dir);
    if (copies.length === 0) run();
    else setAsk({ text: t.lnMoveCopy, list: copies.map((c) => recordName(ctx, c)), note: t.lnMoveCopyTr, yes: t.lnMoveYes, run });
  };

  const remove = (id: string): void => {
    if (!isLine(id)) {
      report(t.dgNotALine);
      return;
    }
    const run = (): void => {
      setAsk(undefined);
      const err = tryEdit(() => { deleteGraphItems(ctx, { lines: [id] }); });
      report(err);
      if (err === undefined) setSel(undefined);
      refocus();
    };
    const game = ctx.status(id) !== 'new' ? 1 : 0;
    const shared = lineParents(ctx, id).length > 1 ? 1 : 0;
    if (game > 0 || shared > 0) setAsk({ text: t.dgDeleteAsk(1, game, shared), yes: t.dgMenuDelete, danger: true, run });
    else run();
  };

  const toggle = (id: string): void => {
    fold((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const goHit = (k: number): void => {
    if (matches.length === 0) return;
    const i = ((k % matches.length) + matches.length) % matches.length;
    setHit(i);
    pick(matches[i]!, { scroll: true });
  };

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (isTypingIn(e.target)) return;
    if (ask) {
      if (e.key === 'Escape') setAsk(undefined);
      else if (e.key === 'Enter') ask.run();
      else return;
      e.preventDefault();
      return;
    }
    const whole = rows.filter((r) => r.link === undefined);
    const at = sel === undefined ? -1 : whole.findIndex((r) => r.id === sel);
    const row = at >= 0 ? whole[at] : undefined;
    let done = true;
    if (e.key === 'ArrowDown') {
      const next = whole[Math.min(whole.length - 1, at + 1)];
      if (next) pick(next.id, { scroll: true });
    } else if (e.key === 'ArrowUp') {
      const prev = whole[Math.max(0, at - 1)];
      if (prev) pick(prev.id, { scroll: true });
    } else if (e.key === 'ArrowLeft' && row) {
      if (row.kids > 0 && !row.folded) toggle(row.id);
      else if (row.parent !== undefined) pick(row.parent, { scroll: true });
    } else if (e.key === 'ArrowRight' && row) {
      if (row.folded) toggle(row.id);
      else if (row.kids > 0 && whole[at + 1]) pick(whole[at + 1]!.id, { scroll: true });
    } else if ((e.key === 'F2' || e.key === 'Enter') && sel !== undefined) startEdit(sel);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel !== undefined) remove(sel);
    else if (e.key === 'Escape') setSel(undefined);
    else done = false;
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const shownText = (n: DialogueGraphNode): string => {
    const x = n.texts[0];
    return x ? quote(x.localized ?? x.en, lang) : recordName(ctx, n.id);
  };

  const phrase = (p: Phrase, key: string): ReactNode => (
    <div key={key} className="dt-ph" title={p.text}>
      {p.short}
      {p.code !== p.short && (
        <>
          {' '}
          <span className="dg-code mono">{p.code}</span>
        </>
      )}
    </div>
  );

  const rowView = (r: DialogueTreeRow, i: number): ReactNode => {
    const n = byId.get(r.id);
    if (!n) return null;
    const indent = { paddingLeft: r.depth * 18 };
    if (r.link !== undefined) {
      const target = shownText(n);
      return (
        <div key={`l${i}`} className="dt-row dt-link" data-testid="dt-row" data-id={r.id} data-link={r.link}>
          <div className="dt-line" style={indent}>
            <span className="dt-tw" />
            <button className="link" data-testid="dt-link" title={t.dtLinkTip} onClick={() => { pick(r.id, { scroll: true }); }}>
              {r.link === 'loop' ? t.dtLoop(target) : t.dtShared(target)}
            </button>
          </div>
          <div />
          <div />
          <div />
        </div>
      );
    }
    const v = views.get(r.id);
    const lk = v?.kind ?? (n.type === 'DIALOGUE_LINE' ? (n.choice ? 'player' : 'npc') : 'head');
    const kind = lk === 'player' ? 'choice' : lk === 'inter' || lk === 'npc' ? lk : 'head';
    const who = lk === 'player' ? t.dnPlayer : lk === 'inter' ? t.dnInter : lk === 'npc' ? t.dnNpc : n.type === 'DIALOGUE' ? t.dnDialogue : n.type === 'DIALOGUE_PACKAGE' ? t.dnPackage : n.type;
    const whoSub = (lk === 'npc' || lk === 'inter') && n.speakerLabel !== undefined ? ` · ${n.speakerLabel}` : '';
    const whoCode = lk === 'head' || lk === 'missing' ? n.type : v?.speakerCode;
    const phrased = v !== undefined && lk !== 'missing' && (lk !== 'head' || n.type === 'DIALOGUE');
    const plain = (c: string): Phrase => ({ text: c, short: c, code: c });
    const conds: Phrase[] = phrased ? v.conditions : [...n.conditions, ...n.filters].map(plain);
    const effects: Phrase[] = phrased ? v.effects : n.effects.map(plain);
    const isLineKind = lk === 'npc' || lk === 'inter' || lk === 'player';
    const nodeChecks = checksByNode.get(r.id) ?? [];
    const end = nodeChecks.some((c) => c.kind === 'end') || (isLineKind && !outgoing.has(r.id));
    const notes = nodeChecks.filter((c) => c.kind !== 'end');
    const status = ctx.status(r.id);
    const open = variantsOpen.has(r.id);
    const first = n.texts[0];
    const rec = editing === r.id ? ctx.get(r.id) : undefined;
    const trs = lineTransitions.get(r.id) ?? [];
    return (
      <div
        key={`r${i}`}
        className={`dt-row dt-${kind}${sel === r.id ? ' dt-sel' : ''}${matchSet.has(r.id) ? ' dt-matched' : ''}`}
        data-testid="dt-row"
        data-id={r.id}
        data-kind={lk}
        data-depth={r.depth}
        data-status={status}
        onClick={() => { pick(r.id); }}
        onDoubleClick={() => { if (isLine(r.id)) startEdit(r.id); }}
      >
        <div className="dt-line" style={indent}>
          <span className="dt-head">
            {r.kids > 0 ? (
              <button
                className="link dt-tw"
                data-testid="dt-toggle"
                title={r.folded ? t.dgExpand : t.dgCollapse}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(r.id);
                }}
              >
                {r.folded ? '▸' : '▾'}
              </button>
            ) : (
              <span className="dt-tw" />
            )}
            {v?.order !== undefined && (
              <span className="dg-ord" data-testid="dt-order" title={t.dnOrderTip(v.order) + (n.score ? ` (+${n.score})` : '')}>
                {v.order}
              </span>
            )}
            {v?.tie === true && (
              <span className="dg-tie small" title={t.dnTieTip}>
                {t.dnTie}
              </span>
            )}
            <span className={`dg-chip ${kind}`}>
              {who}
              {whoSub}
            </span>
            {whoCode !== undefined && whoCode !== who && <span className="dg-code mono">{whoCode}</span>}
            {status === 'new' && <span className="st-badge st-new">{t.lineStatus_new}</span>}
            {status === 'changed' && <span className="st-badge st-changed">{t.lineStatus_changed}</span>}
            {n.eventLabel !== undefined && <span className="dg-event mono">{n.eventLabel}</span>}
            {n.type !== 'DIALOGUE_LINE' && <b className="dt-name">{n.localized ?? n.name}</b>}
          </span>
          {rec ? (
            <div className="dt-edit" onClick={(e) => { e.stopPropagation(); }}>
              <InlineText value={lineTexts(rec)[0] ?? ''} onCommit={(text) => { commit(r.id, text); }} onCancel={() => { setEditing(undefined); refocus(); }} />
            </div>
          ) : first !== undefined ? (
            <div className="dt-texts">
              <div className="dt-text" data-testid="dt-text" title={first.localized !== undefined ? first.en : ''}>
                {quote(first.localized ?? first.en, lang)}
              </div>
              {open &&
                n.texts.slice(1).map((x, k) => (
                  <div key={k} className="dt-text dt-variant" data-testid="dt-variant" title={x.localized !== undefined ? x.en : ''}>
                    <span className="muted">{k + 2}.</span> {quote(x.localized ?? x.en, lang)}
                  </div>
                ))}
              {n.texts.length > 1 && (
                <button
                  className="link small"
                  data-testid="dt-variants"
                  title={t.dtVariantsTip}
                  onClick={(e) => {
                    e.stopPropagation();
                    setVariantsOpen((s) => {
                      const x = new Set(s);
                      if (x.has(r.id)) x.delete(r.id);
                      else x.add(r.id);
                      return x;
                    });
                  }}
                >
                  {open ? t.dtLessVariants : t.dtMoreVariants(n.texts.length - 1)}
                </button>
              )}
            </div>
          ) : (
            n.type === 'DIALOGUE_LINE' && <div className="dt-text muted">{t.dgEmptyText}</div>
          )}
          {notes.map((x, k) => (
            <div key={`n${k}`} className={`dg-warn dg-sev-${x.severity} small`} data-kind={x.kind}>
              {x.severity === 'info' ? 'ℹ' : '⚠'} {inLang(x.texts, lang)}
            </div>
          ))}
        </div>
        <div className="dt-col dt-conds" data-testid="dt-conds">
          {conds.map((p, k) => phrase(p, `c${k}`))}
        </div>
        <div className="dt-col dt-effects" data-testid="dt-effects">
          {effects.map((p, k) => phrase(p, `e${k}`))}
          {trs.map((x, k) => (
            <div key={`t${k}`} className="dt-ph dt-tr-ph">
              {x.kinds.map((kd) => (
                <span key={kd} className="dg-portal-kind" title={t.dpKindTip(kd)}>
                  {t.dpKind(kd)} <span className="dg-code mono">{kd}</span>
                </span>
              ))}{' '}
              {t.dtTo(quote(recordName(ctx, x.dialogue), lang))}
            </div>
          ))}
        </div>
        <div className="dt-col dt-props" data-testid="dt-props">
          {v?.badges.map((b) => (
            <span key={b.field} className={`dg-badge${b.field === 'locked' ? ' dg-badge-lock' : ''}`} data-field={b.field} title={b.code}>
              {b.label} <span className="dg-code mono">{b.code}</span>
            </span>
          ))}
          {end && (
            <span className="dg-end small" data-testid="dt-end" title={t.dnEndTip}>
              ⏹ {t.dnEnd}
            </span>
          )}
        </div>
      </div>
    );
  };

  const portalRow = (dir: 'in' | 'out', dialogue: string, kinds: readonly TransitionKind[], lines: number): ReactNode => {
    const name = quote(recordName(ctx, dialogue), lang);
    return (
      <div key={`${dir}:${dialogue}`} className={`dt-tr dt-tr-${dir}`} data-testid="dt-transition" data-dir={dir} data-sid={dialogue}>
        <span className="dt-tr-name">{dir === 'in' ? t.dtEntry(name) : t.dtExit(name)}</span>
        {kinds.map((k) => (
          <span key={k} className="dg-portal-kind" title={t.dpKindTip(k)}>
            {t.dpKind(k)} <span className="dg-code mono">{k}</span>
          </span>
        ))}
        <span className="muted small">· {t.dtLines(lines)}</span>
        <button className="link small" data-testid="dt-transition-open" title={t.dpOpenTip(name)} onClick={() => { onGo(dialogue); }}>
          {t.dpOpen}
        </button>
      </div>
    );
  };

  const hasTransitions = transitions.entries.length > 0 || transitions.exits.length > 0;
  return (
    <div className={`dt${codes ? '' : ' dg-nocodes'}`} data-testid="dialogue-tree" data-sid={sid} ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="dt-tools">
        <button className="small" data-testid="dt-add-npc" title={t.dtAddTip} onClick={() => { add(0); }}>
          {t.dnAddNpc}
        </button>
        <button className="small" data-testid="dt-add-answer" title={t.dtAddTip} onClick={() => { add(1); }}>
          {t.dnAddAnswer}
        </button>
        <button className="small" data-testid="dt-add-inter" title={`${t.dnAddInterTip} ${t.dtAddTip}`} onClick={() => { add(INTERJECTOR); }}>
          {t.dnAddInter}
        </button>
        <span className="dt-sep" />
        <button className="small" data-testid="dt-up" title={t.dtUpTip} disabled={!mv || !canMoveLine(ctx, mv.parent, mv.child, -1)} onClick={() => { move(-1); }}>
          {t.dtUp}
        </button>
        <button className="small" data-testid="dt-down" title={t.dtDownTip} disabled={!mv || !canMoveLine(ctx, mv.parent, mv.child, 1)} onClick={() => { move(1); }}>
          {t.dtDown}
        </button>
        {folded.size > 0 ? (
          <button className="small" data-testid="dt-expand-all" title={t.dnExpandAllTip} onClick={() => { setFolded(new Set()); }}>
            ⊞ {t.dnExpandAll}
          </button>
        ) : (
          <button className="small" data-testid="dt-fold-all" title={t.dtFoldAllTip} onClick={() => { setFolded(new Set(allRows.filter((r) => r.link === undefined && r.kids > 0 && r.depth >= 1).map((r) => r.id))); }}>
            ⊟ {t.dtFoldAll}
          </button>
        )}
        <button className={`small${codes ? ' active' : ''}`} data-testid="dt-codes" aria-pressed={codes} title={t.dnCodesTip} onClick={() => { setCodes(!codes); }}>
          {'</>'} {t.dnCodes}
        </button>
        {sel !== undefined && onShowLine && (
          <button className="small" data-testid="dt-open-line" title={t.dgOpenLineHint} onClick={onShowLine}>
            ❝ {t.dgOpenLine}
          </button>
        )}
        <span className="dg-grow" />
        <input
          className="dg-search"
          data-testid="dt-search"
          placeholder={t.dgSearch}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHit(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') goHit(e.shiftKey ? hit - 1 : matches[hit] === sel ? hit + 1 : hit);
            else if (e.key === 'Escape') setQuery('');
          }}
        />
        {query.trim() !== '' && (
          <span className="small muted" data-testid="dt-search-count">
            {matches.length === 0 ? t.dgNotFound : `${hit + 1}/${matches.length}`}
          </span>
        )}
      </div>
      <div className="dt-th">
        <div>{t.dtColLine}</div>
        <div>{t.dtColConds}</div>
        <div>{t.dtColEffects}</div>
        <div>{t.dtColProps}</div>
      </div>
      <div className="dt-body" ref={bodyRef}>
        {rows.map(rowView)}
        {hasTransitions && (
          <div className="dt-trs" data-testid="dt-transitions">
            <div className="dt-trs-hd small muted">{t.dtTransitions}</div>
            {transitions.entries.map((p) => portalRow('in', p.dialogue, p.kinds, p.lines.length))}
            {transitions.exits.map((p) => portalRow('out', p.dialogue, p.kinds, p.lines.length))}
          </div>
        )}
        {ask && (
          <div className="dg-ask-shade">
            <div className="dg-ask" data-testid="dt-ask" role="alertdialog">
              <div className="dg-ask-text">{ask.text}</div>
              {ask.list && (
                <ul>
                  {ask.list.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
              {ask.note !== undefined && <div className="small muted">{ask.note}</div>}
              <div className="dg-ask-buttons">
                <button className={ask.danger ? 'danger' : ''} data-testid="dt-ask-yes" autoFocus onClick={ask.run}>
                  {ask.yes}
                </button>
                <button
                  data-testid="dt-ask-no"
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
      <div className="dg-hint small muted">{t.dtHint}</div>
    </div>
  );
}
