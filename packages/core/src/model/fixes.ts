/**
 * Fixes for validation issues (as in the FCS error window): each issue gets a list of
 * fixes expressed as edit operations, so the CLI, MCP (also in live-editor mode) and the window
 * share them. A fix only touches what the open mod owns or changes: records of the mod, its
 * changes to lower records, its deletions. Nothing is written into vanilla or other mods — the
 * operations change only the mod's own deltas.
 *
 * "Ignore" is not an edit: the caller keeps the issue keys (`issueKey`) in an ignore list
 * (`IgnoreList`), stored outside the `.mod` file.
 */
import type { GameRecord } from '../format/types.ts';
import { uiText, type UiText } from '../ui-text.ts';
import type { ModContext } from './context.ts';
import { applyOps, type ApplyOpsResult, type EditOp } from './ops.ts';
import { isRemovalMarker, isRemovedRef } from './record-ops.ts';
import { findField } from '../schema/game-schema.ts';
import type { IssueCode, ValidationIssue } from './validate.ts';

export type FixKind = 'remove-record' | 'remove-ref' | 'revert' | 'new-id';

export const FIX_KINDS: readonly FixKind[] = ['remove-ref', 'revert', 'remove-record', 'new-id'];

/** Name of a fix kind (buttons "fix all of this kind", CLI `--fix KIND`). */
export const FIX_KIND_LABELS: Readonly<Record<FixKind, UiText>> = {
  'remove-record': { en: 'Delete the record', ru: 'Удалить запись', zh: '删除记录' },
  'remove-ref': { en: 'Remove invalid references', ru: 'Убрать неверные ссылки', zh: '移除无效引用' },
  revert: { en: 'Revert to the lower layer', ru: 'Вернуть как в нижнем слое', zh: '恢复为下层的值' },
  'new-id': { en: 'Give the record a new id', ru: 'Дать записи новый id', zh: '为记录分配新 ID' },
};

export interface IssueFix {
  kind: FixKind;
  /** What exactly the fix does, for this issue. */
  texts: UiText;
  ops: EditOp[];
  /** The fix replaces the whole mod record of these ids (later fixes on them are skipped). */
  whole: string[];
}

/** Stable key of an issue: the ignore list stores these. */
export function issueKey(i: Pick<ValidationIssue, 'code' | 'stringId' | 'key' | 'target'>): string {
  return `${i.code}|${i.stringId}|${i.key ?? ''}|${i.target ?? ''}`;
}

/** Issues that can only be ignored (warnings about the game's choice, not data errors). */
const NO_FIX: ReadonlySet<IssueCode> = new Set(['empty-dialogue', 'overrides-action']);

/** Free string id for a new record, not issued before in this plan. */
function freeId(ctx: ModContext, taken: Set<string>, state: { lastId: number }): string {
  for (;;) {
    state.lastId++;
    const sid = `${state.lastId}-${ctx.modName}`;
    if (!ctx.has(sid) && ctx.delta(sid) === undefined && ctx.lower(sid) === undefined && !taken.has(sid)) {
      taken.add(sid);
      return sid;
    }
  }
}

interface PlanState {
  lastId: number;
  taken: Set<string>;
}

function refInDelta(delta: GameRecord | undefined, cat: string, target: string): boolean {
  return (delta?.refs.get(cat) ?? []).some((r) => r.target === target && !isRemovedRef(r));
}

/** The fixes available for one issue; the first one is the recommended. */
export function issueFixes(ctx: ModContext, issue: ValidationIssue, state?: PlanState): IssueFix[] {
  if (NO_FIX.has(issue.code)) return [];
  const sid = issue.stringId;
  const delta = ctx.delta(sid);
  const status = ctx.status(sid);
  const out: IssueFix[] = [];
  const removeRecord = (): void => {
    if (status === 'new') out.push({ kind: 'remove-record', texts: { en: `Delete record ${sid}`, ru: `Удалить запись ${sid}`, zh: `删除记录 ${sid}` }, ops: [{ op: 'delete', id: sid }], whole: [sid] });
  };
  const revertRecord = (): void => {
    if (delta && ctx.lower(sid)) out.push({ kind: 'revert', texts: { en: `Drop the mod's changes to ${sid}`, ru: `Убрать правки мода у ${sid}`, zh: `撤销本 Mod 对 ${sid} 的修改` }, ops: [{ op: 'revert', id: sid }], whole: [sid] });
  };

  switch (issue.code) {
    case 'broken-ref':
    case 'deleted-ref':
    case 'dangling-ref':
    case 'wrong-target-type': {
      const key = issue.key ?? '';
      const target = issue.target ?? '';
      if (key.startsWith('instance:')) {
        const k = key.slice('instance:'.length);
        if (delta && !isRemovalMarker(delta) && delta.instances.has(k)) {
          out.push({ kind: 'remove-ref', texts: { en: `Remove placed object ${k}`, ru: `Убрать объект ${k}`, zh: `移除放置的对象 ${k}` }, ops: [{ op: 'removeInstance', id: sid, key: k }], whole: [] });
        }
      } else if (delta && !isRemovalMarker(delta) && refInDelta(delta, key, target)) {
        out.push({ kind: 'remove-ref', texts: { en: `Remove reference ${key} → ${target}`, ru: `Убрать ссылку ${key} → ${target}`, zh: `移除引用 ${key} → ${target}` }, ops: [{ op: 'removeRef', id: sid, category: key, target }], whole: [] });
      }
      // The mod itself deleted the target: bring it back.
      const td = ctx.delta(target);
      if (issue.code === 'deleted-ref' && td && isRemovalMarker(td) && ctx.lower(target)) {
        out.push({ kind: 'revert', texts: { en: `Restore deleted record ${target}`, ru: `Вернуть удалённую запись ${target}`, zh: `恢复已删除的记录 ${target}` }, ops: [{ op: 'restore', id: target }], whole: [target] });
      }
      if (delta) removeRecord();
      break;
    }
    case 'unknown-field':
    case 'wrong-kind':
    case 'enum-value': {
      if (!delta || isRemovalMarker(delta) || !issue.key) break;
      const key = issue.key;
      const lowerHas = issue.dict ? ctx.lower(sid) !== undefined : ctx.lower(sid)?.refs.has(key) === true;
      const texts: UiText = lowerHas
        ? { en: `Reset ${key} to the lower layer`, ru: `Вернуть ${key} как в нижнем слое`, zh: `将 ${key} 恢复为下层的值` }
        : { en: `Remove field ${key}`, ru: `Убрать поле ${key}`, zh: `移除字段 ${key}` };
      out.push({ kind: 'revert', texts, ops: [issue.dict ? { op: 'reset', id: sid, field: key, dict: issue.dict } : { op: 'resetRefs', id: sid, category: key }], whole: [] });
      break;
    }
    case 'too-many-refs': {
      const rec = ctx.get(sid);
      const key = issue.key ?? '';
      const ts = rec && ctx.schema?.types.get(ctx.typeName(rec.type));
      const limit = (ts && findField(ts, key)?.limit) ?? 0;
      if (!rec || !delta || limit <= 0) break;
      const extra = (rec.refs.get(key) ?? []).filter((r) => !isRemovedRef(r)).slice(limit);
      if (extra.length) {
        out.push({
          kind: 'remove-ref',
          texts: { en: `Remove ${extra.length} extra references from ${key}`, ru: `Убрать лишние ссылки из ${key}: ${extra.length}`, zh: `从 ${key} 移除 ${extra.length} 个多余引用` },
          ops: [...new Set(extra.map((r) => r.target))].map((target) => ({ op: 'removeRef', id: sid, category: key, target })),
          whole: [],
        });
      }
      const lower = ctx.lower(sid)?.refs.get(key);
      if (lower !== undefined && lower.filter((r) => !isRemovedRef(r)).length <= limit) {
        out.push({ kind: 'revert', texts: { en: `Reset ${key} to the lower layer`, ru: `Вернуть ${key} как в нижнем слое`, zh: `将 ${key} 恢复为下层的值` }, ops: [{ op: 'resetRefs', id: sid, category: key }], whole: [] });
      }
      break;
    }
    case 'unknown-type':
      removeRecord();
      revertRecord();
      break;
    case 'remove-missing':
      if (delta) out.push({ kind: 'revert', texts: { en: 'Drop the deletion marker', ru: 'Убрать пометку удаления', zh: '移除删除标记' }, ops: [{ op: 'revert', id: sid }], whole: [sid] });
      break;
    case 'type-changed':
      revertRecord();
      break;
    case 'id-taken': {
      if (!delta || isRemovalMarker(delta)) break;
      const st = state ?? { lastId: ctx.info.lastId, taken: new Set<string>() };
      const fresh = freeId(ctx, st.taken, st);
      const ops: EditOp[] = [{ op: 'duplicate', from: sid, id: fresh }, { op: 'revert', id: sid }];
      // References the mod itself added to this id now go to the copy.
      for (const own of ctx.modRecords()) {
        if (isRemovalMarker(own) || own.stringId === sid) continue;
        const rec = ctx.get(own.stringId);
        if (!rec) continue;
        for (const [cat, list] of own.refs) {
          if (!list.some((r) => r.target === sid && !isRemovedRef(r))) continue;
          const resolved = rec.refs.get(cat) ?? [];
          ops.push({ op: 'setRefs', id: own.stringId, category: cat, refs: resolved.map((r) => ({ target: r.target === sid ? fresh : r.target, values: [r.v0, r.v1, r.v2] })) });
        }
      }
      ops.push({ op: 'info', lastId: st.lastId });
      out.push({
        kind: 'new-id',
        texts: { en: `Move the mod's record to a new id ${fresh}`, ru: `Перенести запись мода на новый id ${fresh}`, zh: `将本 Mod 的记录移到新 ID ${fresh}` },
        ops,
        whole: [sid, fresh],
      });
      revertRecord();
      break;
    }
  }
  return out;
}

export interface FixPlan {
  ops: EditOp[];
  /** History label (Russian key; `describeChangeset` gives the en/ru/zh title). */
  label: string;
  fixed: { issue: ValidationIssue; fix: IssueFix }[];
  /** Issues without a fix of the asked kind, or already covered by an earlier fix of the same record. */
  skipped: ValidationIssue[];
}

/**
 * Collect fixes for issues: `kind` picks a fix kind (issues without it are skipped);
 * without it the recommended fix of each issue is taken. One plan = one history step.
 */
export function planFixes(ctx: ModContext, issues: readonly ValidationIssue[], kind?: FixKind): FixPlan {
  const state: PlanState = { lastId: ctx.info.lastId, taken: new Set() };
  const whole = new Set<string>();
  const ops: EditOp[] = [];
  const fixed: FixPlan['fixed'] = [];
  const skipped: ValidationIssue[] = [];
  for (const issue of issues) {
    const fixes = issueFixes(ctx, issue, kind === undefined || kind === 'new-id' ? state : undefined);
    const fix = kind ? fixes.find((f) => f.kind === kind) : fixes[0];
    const subjects = fix ? [...new Set(fix.ops.flatMap((o) => ('id' in o && typeof o.id === 'string' ? [o.id] : 'from' in o ? [o.from] : [])))] : [];
    if (!fix || subjects.some((s) => whole.has(s))) {
      skipped.push(issue);
      continue;
    }
    for (const w of fix.whole) whole.add(w);
    ops.push(...fix.ops);
    fixed.push({ issue, fix });
  }
  // Several new-id fixes: one lastId update at the end is enough.
  const info = ops.filter((o) => o.op === 'info');
  const merged = info.length > 1 ? [...ops.filter((o) => o.op !== 'info'), info[info.length - 1]!] : ops;
  return { ops: merged, label: `исправление: ${fixed.length}`, fixed, skipped };
}

/** Apply a plan as one history step; undefined when there is nothing to do. */
export function applyFixPlan(ctx: ModContext, plan: FixPlan): ApplyOpsResult | undefined {
  if (!plan.ops.length) return undefined;
  return applyOps(ctx, plan.ops, plan.label);
}

/** One line of a fix preview: "sid: what the fix does". */
export function formatFix(f: { issue: ValidationIssue; fix: IssueFix }, lang = 'en'): string {
  return `${f.issue.code} ${f.issue.stringId}: ${uiText(f.fix.texts, lang)}`;
}

// ---------------------------------------------------------------- ignore list

/** Ignored issues of one mod (kept outside the `.mod` file, in the editor's data folder). */
export interface IgnoreList {
  version: 1;
  /** `issueKey` values. */
  ignored: string[];
}

export const emptyIgnoreList = (): IgnoreList => ({ version: 1, ignored: [] });

/** Read an ignore list; a broken or foreign file gives an empty list. */
export function parseIgnoreList(text: string): IgnoreList {
  try {
    const j = JSON.parse(text) as Partial<IgnoreList>;
    if (j.version !== 1 || !Array.isArray(j.ignored)) return emptyIgnoreList();
    return { version: 1, ignored: [...new Set(j.ignored.filter((x): x is string => typeof x === 'string'))] };
  } catch {
    return emptyIgnoreList();
  }
}

export function serializeIgnoreList(list: IgnoreList): string {
  return `${JSON.stringify({ version: 1, ignored: [...new Set(list.ignored)].sort() }, null, 2)}\n`;
}
