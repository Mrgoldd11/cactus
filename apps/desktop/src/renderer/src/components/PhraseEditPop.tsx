/**
 * Editor of one condition or effect, opened by a click on its phrase row on a graph node (UI review G8).
 * A DC_ condition: who, the condition, the comparison, the value; a DA_ effect: the action and its values;
 * a reference condition or effect («my race is …», «give item …»): its list of targets — ✕ removes one,
 * «+ one more» picks another. The same rows as the «Dialogue line» panel, so every change is one undo step
 * and shows on the node and in the panel at once.
 */
import { useEffect, type ReactNode } from 'react';
import { LINE_REF_HELP, type ModContext, type PhraseSource } from '@kenshi-editor/core';
import { useT } from '../i18n.ts';
import { ConditionRow, EffectRow } from './LineInspector.tsx';
import { RefRows, type RefTargetAsk } from './LinePanelParts.tsx';

export const PHRASE_EDIT_WIDTH = 380;

interface Props {
  ctx: ModContext;
  sid: string;
  source: PhraseSource;
  x: number;
  y: number;
  edit: (fn: () => void) => void;
  onGo: (sid: string) => void;
  onAddTarget: (ask: RefTargetAsk) => void;
  onClose: () => void;
}

export function PhraseEditPop({ ctx, sid, source, x, y, edit, onGo, onAddTarget, onClose }: Props): ReactNode {
  const t = useT();
  const rec = ctx.get(sid);
  const refs = rec?.refs.get(source.category) ?? [];
  const r = source.target !== undefined ? refs.find((x) => x.target === source.target) : undefined;
  const help = LINE_REF_HELP[source.category];
  // What the phrase shows is gone (removed here or undone): nothing left to edit.
  const gone = !rec || (source.target !== undefined ? !r : refs.length === 0 || !help);
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (gone) return null;
  const kind = source.category === 'conditions' || help?.kind === 'condition' ? 'condition' : 'effect';
  const on = ctx.typeName(rec.type) === 'DIALOGUE' ? 'dialogue' : 'line';
  return (
    <div
      className="dg-edit-pop nodrag nowheel"
      data-testid="dg-edit-pop"
      data-category={source.category}
      style={{ left: x, top: y, width: PHRASE_EDIT_WIDTH }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="dg-edit-hd">
        <span>{kind === 'condition' ? t.dnEditCond : t.dnEditEffect}</span>
        <span className="spacer" />
        <button className="small" data-testid="dg-edit-close" title={t.close} onClick={onClose}>
          ✕
        </button>
      </div>
      {r && source.category === 'conditions' && <ConditionRow ctx={ctx} sid={sid} r={r} on={on} edit={edit} />}
      {r && source.category === 'effects' && <EffectRow ctx={ctx} sid={sid} r={r} edit={edit} />}
      {source.target === undefined && <RefRows ctx={ctx} sid={sid} rec={rec} kind={kind} edit={edit} onGo={onGo} onAddTarget={onAddTarget} only={source.category} />}
    </div>
  );
}
