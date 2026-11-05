/**
 * Проверки диалога для показа прямо на графе: битые ссылки, диалог без реплик, реплика, которую
 * игра не выберет, запертый диалог, который ничто не отпирает, реплика без текста и продолжения,
 * ответ игрока, после которого разговор кончается, мод перебивает ванильный диалог с действием,
 * реплики мода, ни к чему не привязанные.
 */
import { itemTypeName } from '../format/item-types.ts';
import { isRemovalMarker } from '../model/record-ops.ts';
import type { ModContext } from '../model/context.ts';
import type { DialogueGraph } from '../model/dialogue-graph.ts';
import { isEmptyNode } from '../model/dialogue-score.ts';
import { validateMod } from '../model/validate.ts';
import { lineParents } from './edit.ts';

export type DialogCheckKind =
  | 'missing'
  | 'no-lines'
  | 'shadowed'
  | 'truncated'
  | 'locked'
  | 'silent'
  | 'end'
  | 'overrides-action'
  | 'orphan';

export type DialogCheckSeverity = 'error' | 'warning' | 'info';

export interface DialogCheck {
  kind: DialogCheckKind;
  severity: DialogCheckSeverity;
  /** Узел графа (или запись мода вне графа для `orphan`). */
  node: string;
  /** Связанная запись: кто перебивает, кто затеняет. */
  other?: string;
  text: string;
}

const SEVERITY: Record<DialogCheckKind, DialogCheckSeverity> = {
  missing: 'error',
  'no-lines': 'error',
  shadowed: 'warning',
  truncated: 'info',
  locked: 'warning',
  silent: 'info',
  end: 'info',
  'overrides-action': 'warning',
  orphan: 'warning',
};

/** Категории ссылок, которые отпирают диалог. */
const UNLOCK_CATEGORIES: ReadonlySet<string> = new Set(['unlocks', 'unlock but keep me']);

/** Реплики мода (новые), на которые не ведёт ни диалог, ни другая реплика. */
export function orphanLines(ctx: ModContext): string[] {
  const out: string[] = [];
  for (const d of ctx.modRecords()) {
    if (isRemovalMarker(d) || itemTypeName(d.type) !== 'DIALOGUE_LINE' || ctx.status(d.stringId) !== 'new') continue;
    if (lineParents(ctx, d.stringId).length === 0) out.push(d.stringId);
  }
  return out;
}

export function dialogueChecks(ctx: ModContext, graph: DialogueGraph): DialogCheck[] {
  const out: DialogCheck[] = [];
  const push = (kind: DialogCheckKind, node: string, text: string, other?: string): void => {
    out.push({ kind, severity: SEVERITY[kind], node, text, ...(other !== undefined ? { other } : {}) });
  };
  for (const i of graph.issues) push(i.kind, i.node, i.text, i.by);

  const children = new Map<string, number>();
  for (const e of graph.edges) children.set(e.source, (children.get(e.source) ?? 0) + 1);
  const inGraph = new Set(graph.nodes.map((n) => n.id));

  for (const n of graph.nodes) {
    const rec = ctx.get(n.id);
    if (!rec) continue;
    if (n.type === 'DIALOGUE' && rec.bools.get('locked') && !ctx.referencesTo(n.id).some((e) => UNLOCK_CATEGORIES.has(e.category)))
      push('locked', n.id, 'диалог заперт (locked), и в данных его ничто не отпирает (unlocks) — скорее всего, не прозвучит');
    if (n.type !== 'DIALOGUE_LINE' || n.truncated) continue;
    const kids = children.get(n.id) ?? 0;
    if (isEmptyNode(rec) && kids === 0 && n.effects.length === 0) push('silent', n.id, 'пустая реплика без действий и продолжения: ничего не скажет, разговор на ней закончится');
    else if (n.choice && kids === 0) push('end', n.id, 'после этого ответа разговор заканчивается');
  }

  for (const v of validateMod(ctx)) {
    if (v.code !== 'overrides-action') continue;
    const node = v.target !== undefined && inGraph.has(v.target) ? v.target : inGraph.has(v.stringId) ? v.stringId : undefined;
    if (node !== undefined) push('overrides-action', node, v.message, v.stringId);
  }
  for (const sid of orphanLines(ctx)) push('orphan', sid, 'реплика мода ни к чему не привязана — игра её не скажет');
  return out;
}
