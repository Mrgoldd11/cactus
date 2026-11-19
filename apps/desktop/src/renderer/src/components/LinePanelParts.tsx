/**
 * Parts of the line panel (UI review G4): the one «+ condition» / «+ effect» list with search and
 * groups, the reference condition / effect rows, and the field description at the bottom, as in FCS.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  dialogPickGroups,
  dialogPickItems,
  dialogPickUsage,
  LINE_REF_HELP,
  lineRefPhrases,
  removeLineRef,
  setLineRefValue,
  uiText,
  type DialogPhrase,
  type DialogPickItem,
  type DialogPickKind,
  type DialogPickUsage,
  type GameRecord,
  type ModContext,
} from '@kenshi-editor/core';
import { useLang, useT } from '../i18n.ts';
import { CommitInput } from './widgets.tsx';
import { PhraseLine } from './DialogHelpUi.tsx';

/** What the bottom pane explains: the field the modder clicked last. */
export interface FieldDesc {
  /** «Condition», «Effect», «Field»… */
  kind: string;
  title: string;
  code?: string;
  text: string;
  note?: string;
}

const DescribeContext = createContext<(d: FieldDesc) => void>(() => undefined);
export const DescribeProvider = DescribeContext.Provider;

/** Props that make an element show `d` in the description pane when clicked or focused. */
export function useDescribe(d: FieldDesc | undefined): { onFocusCapture?: () => void; onMouseDownCapture?: () => void } {
  const show = useContext(DescribeContext);
  if (!d) return {};
  const on = (): void => {
    show(d);
  };
  return { onFocusCapture: on, onMouseDownCapture: on };
}

export function DescPane({ desc }: { desc: FieldDesc | undefined }): ReactNode {
  const t = useT();
  return (
    <div className="lp-desc" data-testid="ln-desc">
      {desc ? (
        <>
          <div className="lp-desc-title">
            <span className="muted">{desc.kind}:</span> <b>{desc.title}</b> {desc.code && <span className="mono small muted">{desc.code}</span>}
          </div>
          <div className="lp-desc-text">{desc.text}</div>
          {desc.note && <div className="small muted">{desc.note}</div>}
        </>
      ) : (
        <div className="muted small">{t.lpDescHint}</div>
      )}
    </div>
  );
}

const usageCache = new WeakMap<ModContext, DialogPickUsage>();

/** Usage of conditions, effects and reference categories in the data — computed once per context. */
export function pickUsage(ctx: ModContext): DialogPickUsage {
  let u = usageCache.get(ctx);
  if (!u) usageCache.set(ctx, (u = dialogPickUsage(ctx)));
  return u;
}

/**
 * The one list of «+ condition» / «+ effect»: DC_ / DA_ values and reference categories together,
 * by group, searched in the interface language, English and by code.
 */
export function DialogPicker({ ctx, ownerType, kind, onPick, onClose }: { ctx: ModContext; ownerType: string; kind: DialogPickKind; onPick: (item: DialogPickItem) => void; onClose: () => void }): ReactNode {
  const t = useT();
  const lang = useLang();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const items = useMemo(() => dialogPickItems(ctx, ownerType, kind, lang, pickUsage(ctx)), [ctx, ownerType, kind, lang]);
  const groups = useMemo(() => dialogPickGroups(items, kind, query, lang), [items, kind, query, lang]);
  const flat = groups.flatMap((g) => g.items);
  const cur = Math.min(cursor, flat.length - 1);
  const sel = cur >= 0 ? flat[cur] : undefined;

  useEffect(() => {
    root.current?.querySelector('.lp-pick-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [cur, query]);
  useEffect(() => {
    // A click outside closes the list.
    const down = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', down);
    return () => {
      document.removeEventListener('mousedown', down);
    };
  }, [onClose]);

  let n = 0;
  return (
    <div className="lp-pick" data-testid="ln-pick" data-kind={kind} ref={root}>
      <div className="lp-pick-head">
        <b>{kind === 'condition' ? t.lpPickCondition : t.lpPickEffect}</b>
        <span className="spacer" />
        <button className="small" onClick={onClose}>
          ✕
        </button>
      </div>
      <input
        autoFocus
        className="search"
        data-testid="ln-pick-search"
        placeholder={t.lpPickSearch}
        title={t.lpPickSearchTip}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor(Math.min(cur + 1, flat.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor(Math.max(cur - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (sel) onPick(sel);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="lp-pick-list" data-testid="ln-pick-list">
        {groups.map((g) => (
          <div key={g.key} className="lp-pick-group" data-testid="ln-pick-group" data-group={g.key}>
            <div className="lp-pick-gtitle">{g.label}</div>
            {g.items.map((i) => {
              const idx = n++;
              return (
                <button
                  key={`${g.key}:${i.key}`}
                  className={`lp-pick-item${idx === cur ? ' sel' : ''}`}
                  data-testid="ln-pick-item"
                  data-key={i.key}
                  onMouseEnter={() => {
                    setCursor(idx);
                  }}
                  onClick={() => {
                    onPick(i);
                  }}
                >
                  <span className="lp-pick-label">{i.label}</span>
                  <span className="mono small muted">{i.code}</span>
                  {i.source === 'ref' && <span className="lp-pick-ref small">{t.lpPickRef.replace('{type}', i.targetType ?? '?')}</span>}
                  {i.used === 0 && (
                    <span className="warn small" title={t.lpPickUnused}>
                      ⚠
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && <div className="muted small">{t.lpPickNone}</div>}
      </div>
      {sel && (
        <div className="lp-pick-desc" data-testid="ln-pick-desc">
          <div>
            <b>{sel.label}</b> <span className="mono small muted">{sel.code}</span>
          </div>
          <div>{sel.desc}</div>
          {sel.source === 'ref' && <div className="small muted">{t.lpPickRefTip}</div>}
          {sel.undescribed && <div className="small muted">{t.lpUndescribed}</div>}
          {sel.used === 0 && <div className="small warn">{t.lpPickUnused}</div>}
        </div>
      )}
    </div>
  );
}

/** Which reference target the modder is about to pick (after the picker or «+ one more»). */
export interface RefTargetAsk {
  category: string;
  targetType: string | undefined;
  label: string;
}

/**
 * Reference conditions (or effects) of a record as rows: name · category, the targets (each with ✕,
 * and the value when it matters), «+ one more», the phrase.
 */
export function RefRows({
  ctx,
  sid,
  rec,
  kind,
  edit,
  onGo,
  onAddTarget,
}: {
  ctx: ModContext;
  sid: string;
  rec: GameRecord;
  kind: DialogPickKind;
  edit: (fn: () => void) => void;
  onGo: (sid: string) => void;
  onAddTarget: (ask: RefTargetAsk) => void;
}): ReactNode {
  const t = useT();
  const lang = useLang();
  const on = ctx.typeName(rec.type) === 'DIALOGUE' ? 'dialogue' : 'line';
  const phrases = new Map(lineRefPhrases(ctx, rec, lang, on).map((p) => [p.category, p.phrase]));
  const fields = ctx.schema?.types.get(ctx.typeName(rec.type))?.fields;
  const rows = Object.entries(LINE_REF_HELP).filter(([c, h]) => h.kind === kind && (rec.refs.get(c)?.length ?? 0) > 0);
  return (
    <>
      {rows.map(([c, h]) => (
        <RefRow
          key={c}
          ctx={ctx}
          sid={sid}
          rec={rec}
          category={c}
          label={uiText(h.label, lang)}
          desc={{
            kind: kind === 'condition' ? t.lpDescCondition : t.lpDescEffect,
            title: uiText(h.label, lang),
            code: c,
            text: uiText(h.desc, lang),
            note: [h.value ? `${t.lpRefValue}: ${uiText(h.value, lang)}` : '', kind === 'condition' ? (h.join === 'or' ? t.lpRefJoinOr : t.lpRefJoinAnd) : ''].filter(Boolean).join(' · '),
          }}
          withValue={h.value !== undefined}
          kind={kind}
          phrase={phrases.get(c)}
          edit={edit}
          onGo={onGo}
          onAdd={() => {
            onAddTarget({ category: c, targetType: fields?.get(c)?.targetType, label: uiText(h.label, lang) });
          }}
        />
      ))}
    </>
  );
}

function RefRow({
  ctx,
  sid,
  rec,
  category,
  label,
  desc,
  withValue,
  kind,
  phrase,
  edit,
  onGo,
  onAdd,
}: {
  ctx: ModContext;
  sid: string;
  rec: GameRecord;
  category: string;
  label: string;
  desc: FieldDesc;
  withValue: boolean;
  kind: DialogPickKind;
  phrase: DialogPhrase | undefined;
  edit: (fn: () => void) => void;
  onGo: (sid: string) => void;
  onAdd: () => void;
}): ReactNode {
  const t = useT();
  const describe = useDescribe(desc);
  const refs = rec.refs.get(category) ?? [];
  return (
    <div className="ln-action lp-cond lp-ref" data-testid="ln-ref" data-category={category} {...describe}>
      <div className="lp-row">
        <span className="lp-ref-name">{label}</span>
        <span className="mono small muted">{category}</span>
      </div>
      <div className="lp-row lp-targets">
        {refs.map((r) => (
          <span key={r.target} className="lp-target" data-testid="ln-ref-target" data-sid={r.target}>
            <button
              className="link"
              onClick={() => {
                onGo(r.target);
              }}
            >
              {ctx.localizedName(r.target) ?? ctx.name(r.target) ?? r.target}
            </button>
            {withValue && (
              <CommitInput
                className="ln-num mono lp-ref-value"
                value={String(r.v0)}
                testId="ln-ref-value"
                onCommit={(s) => {
                  const v = Math.round(Number(s.replace(',', '.')));
                  if (Number.isFinite(v)) {
                    edit(() => {
                      setLineRefValue(ctx, sid, category, r.target, v);
                    });
                  }
                }}
              />
            )}
            <button
              className="small"
              title={t.lpRefRemove}
              data-testid="ln-ref-remove"
              onClick={() => {
                edit(() => {
                  removeLineRef(ctx, sid, category, r.target);
                });
              }}
            >
              ✕
            </button>
          </span>
        ))}
        <button className="small" title={t.lpRefAddTargetTip} data-testid="ln-ref-add" onClick={onAdd}>
          + {t.lpRefAddTarget}
        </button>
      </div>
      {phrase && <PhraseLine phrase={phrase} kind={kind === 'effect' ? 'effect' : 'cond'} testId="ln-ref-phrase" />}
    </div>
  );
}
