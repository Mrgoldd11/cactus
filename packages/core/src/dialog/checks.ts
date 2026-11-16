/**
 * Проверки диалога для показа прямо на графе: битые ссылки, диалог без реплик, реплика, которую
 * игра не выберет, запертый диалог, который ничто не отпирает, реплика без текста и продолжения,
 * ответ игрока, после которого разговор кончается, мод перебивает ванильный диалог с действием,
 * реплики мода, ни к чему не привязанные.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { UiText } from '../ui-text.ts';
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
  /** English text. */
  text: string;
  /** The text in every interface language. */
  texts: UiText;
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
  const push = (kind: DialogCheckKind, node: string, texts: UiText, other?: string): void => {
    out.push({ kind, severity: SEVERITY[kind], node, text: texts.en, texts, ...(other !== undefined ? { other } : {}) });
  };
  for (const i of graph.issues) push(i.kind, i.node, i.texts, i.by);

  const children = new Map<string, number>();
  for (const e of graph.edges) children.set(e.source, (children.get(e.source) ?? 0) + 1);
  const inGraph = new Set(graph.nodes.map((n) => n.id));

  for (const n of graph.nodes) {
    const rec = ctx.get(n.id);
    if (!rec) continue;
    if (n.type === 'DIALOGUE' && rec.bools.get('locked') && !ctx.referencesTo(n.id).some((e) => UNLOCK_CATEGORIES.has(e.category)))
      push('locked', n.id, {
        en: 'dialogue is locked, and nothing in the data unlocks it (unlocks) — it will probably never play',
        ru: 'диалог заперт (locked), и в данных его ничто не отпирает (unlocks) — скорее всего, не прозвучит',
        zh: '对话已锁定（locked），数据中没有任何东西解锁它（unlocks）— 很可能永远不会出现',
      });
    if (n.type !== 'DIALOGUE_LINE' || n.truncated) continue;
    const kids = children.get(n.id) ?? 0;
    if (isEmptyNode(rec) && kids === 0 && n.effects.length === 0) push('silent', n.id, {
        en: 'empty line without actions or continuation: says nothing, the conversation ends on it',
        ru: 'пустая реплика без действий и продолжения: ничего не скажет, разговор на ней закончится',
        zh: '空台词，没有动作也没有后续：不会说任何话，对话在此结束',
      });
    else if (n.choice && kids === 0) push('end', n.id, { en: 'the conversation ends after this answer', ru: 'после этого ответа разговор заканчивается', zh: '此回答之后对话结束' });
  }

  for (const v of validateMod(ctx)) {
    if (v.code !== 'overrides-action') continue;
    const node = v.target !== undefined && inGraph.has(v.target) ? v.target : inGraph.has(v.stringId) ? v.stringId : undefined;
    if (node !== undefined) push('overrides-action', node, v.texts ?? { en: v.message }, v.stringId);
  }
  for (const sid of orphanLines(ctx)) push('orphan', sid, { en: 'mod line is not linked to anything — the game will never say it', ru: 'реплика мода ни к чему не привязана — игра её не скажет', zh: 'Mod 台词没有连接到任何地方 — 游戏永远不会说出它' });
  return out;
}
