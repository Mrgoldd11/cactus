/**
 * Mod cleanup (as FCS "Cleanup"): find what can be removed from the mod without changing what the
 * game sees, or what is broken anyway. Only the mod's own data is touched.
 *
 * Groups and their rules (conservative):
 * - `obsolete-field` — a field or reference category the mod sets that the schema of the record type does
 *   not know (fcs.def + FCS Extended files + fields the lower layers use). Records of unknown types are skipped.
 * - `no-op` — a value or reference the mod writes that equals the lower layer (the game sees no change).
 * - `deleted-base` — the mod changes a record that a lower layer (a dependency) deleted: the change
 *   lands on nothing (FCS: "Modified item undefined", partial item).
 * - `orphaned` — a record the mod created, of a type that only exists as owned by another record
 *   (fcs.def `OWNED:` targets: dialogue lines, dialogue conditions/effects), that nothing references.
 * - `invalid-refs` — references and placed objects the mod writes whose target does not exist.
 * - `undefined-type` — a record the mod created whose type the schema does not define (and that is
 *   not an owned type).
 * Records deleted by mods loaded later cannot be found: the editor loads only the layers below the mod.
 */
import { findField, type GameSchema } from '../schema/game-schema.ts';
import { uiText, type UiText } from '../ui-text.ts';
import type { ModContext } from './context.ts';
import { applyOps, type ApplyOpsResult, type EditOp } from './ops.ts';
import { isRemovalMarker, isRemovedRef, SCALAR_DICTS, scalarEqual, scalarMap } from './record-ops.ts';
import { effectiveSchema } from './validate.ts';

export type CleanupGroup = 'obsolete-field' | 'no-op' | 'deleted-base' | 'orphaned' | 'invalid-refs' | 'undefined-type';

export const CLEANUP_GROUPS: readonly CleanupGroup[] = ['obsolete-field', 'no-op', 'deleted-base', 'orphaned', 'invalid-refs', 'undefined-type'];

export const CLEANUP_GROUP_LABELS: Readonly<Record<CleanupGroup, UiText>> = {
  'obsolete-field': { en: 'Fields not in the schema', ru: 'Поля, которых нет в схеме', zh: '架构中没有的字段' },
  'no-op': { en: 'Changes equal to the lower layer', ru: 'Правки, равные нижнему слою', zh: '与下层相同的修改' },
  'deleted-base': { en: 'Changes to records a dependency deleted', ru: 'Правки записей, удалённых зависимостью', zh: '对被依赖项删除的记录的修改' },
  orphaned: { en: 'Orphaned owned records', ru: 'Осиротевшие вложенные записи', zh: '孤立的从属记录' },
  'invalid-refs': { en: 'References to missing records', ru: 'Ссылки на несуществующие записи', zh: '指向不存在记录的引用' },
  'undefined-type': { en: 'Records of types the schema does not define', ru: 'Записи типов, которых нет в схеме', zh: '架构未定义类型的记录' },
};

/** The rule of each group, shown next to it. */
export const CLEANUP_GROUP_RULES: Readonly<Record<CleanupGroup, UiText>> = {
  'obsolete-field': {
    en: 'The mod sets a field the record type does not have in fcs.def, FCS Extended files or the game data. Records of unknown types are skipped.',
    ru: 'Мод задаёт поле, которого у типа записи нет ни в fcs.def, ни в файлах FCS Extended, ни в данных игры. Записи неизвестных типов пропускаются.',
    zh: '本 Mod 设置了记录类型在 fcs.def、FCS Extended 文件和游戏数据中都没有的字段。未知类型的记录会被跳过。',
  },
  'no-op': {
    en: 'The value or reference is the same as in the layers below the mod: the game sees no change.',
    ru: 'Значение или ссылка такие же, как в слоях под модом: игра не видит изменения.',
    zh: '该值或引用与 Mod 下方各层相同：游戏看不到任何变化。',
  },
  'deleted-base': {
    en: 'The mod changes a record that a dependency deleted: the change lands on nothing.',
    ru: 'Мод меняет запись, которую удалила зависимость: правка ни на что не ложится.',
    zh: '本 Mod 修改了被依赖项删除的记录：该修改没有作用对象。',
  },
  orphaned: {
    en: 'A record the mod created, of a type that only lives inside another record (dialogue line, condition, effect), and nothing references it.',
    ru: 'Запись, созданная модом, типа, который живёт только внутри другой записи (реплика, условие, действие), и на неё никто не ссылается.',
    zh: '本 Mod 创建的、只能从属于其他记录的类型（台词、条件、效果）的记录，且没有任何引用指向它。',
  },
  'invalid-refs': {
    en: 'The mod writes a reference or a placed object whose target record does not exist.',
    ru: 'Мод записывает ссылку или объект, запись-цель которых не существует.',
    zh: '本 Mod 写入的引用或放置对象的目标记录不存在。',
  },
  'undefined-type': {
    en: 'A record the mod created whose type the schema does not define; owned types are skipped.',
    ru: 'Запись, созданная модом, тип которой не описан в схеме; вложенные типы пропускаются.',
    zh: '本 Mod 创建的记录，其类型未在架构中定义；从属类型会被跳过。',
  },
};

export interface CleanupItem {
  /** Stable id within one scan (selection in the window, `--only`). */
  id: string;
  group: CleanupGroup;
  stringId: string;
  key?: string;
  target?: string;
  texts: UiText;
  ops: EditOp[];
}

export interface CleanupScan {
  items: CleanupItem[];
  counts: Record<CleanupGroup, number>;
}

/** Record types that only exist as owned by another record (targets of `OWNED:` categories). */
export function ownedTypes(schema: GameSchema | undefined): Set<string> {
  const out = new Set<string>();
  for (const t of schema?.types.values() ?? []) {
    for (const o of t.owned) {
      const target = t.fields.get(o)?.targetType;
      if (target && target !== 'NULL_ITEM') out.add(target);
    }
  }
  return out;
}

function deletedByLayer(ctx: ModContext): Set<string> {
  const out = new Set<string>();
  for (const l of ctx.layers) for (const r of l.file.records) if (isRemovalMarker(r)) out.add(r.stringId);
  return out;
}

/** Scan the mod. Changes nothing. */
export function scanCleanup(ctx: ModContext): CleanupScan {
  const schema = effectiveSchema(ctx);
  const owned = ownedTypes(schema);
  const deleted = deletedByLayer(ctx);
  const items: CleanupItem[] = [];
  const add = (it: Omit<CleanupItem, 'id'>): void => {
    items.push({ ...it, id: `${it.group}|${it.stringId}|${it.key ?? ''}|${it.target ?? ''}` });
  };
  for (const delta of ctx.modRecords()) {
    if (isRemovalMarker(delta)) continue;
    const sid = delta.stringId;
    const lower = ctx.lower(sid);
    const typeName = ctx.typeName(delta.type);
    const ts = schema?.types.get(typeName);

    if (!lower && deleted.has(sid)) {
      add({ group: 'deleted-base', stringId: sid, texts: { en: `Drop the change of ${sid} (deleted below)`, ru: `Убрать правку ${sid} (удалена ниже)`, zh: `移除对 ${sid} 的修改（下层已删除）` }, ops: [{ op: 'revert', id: sid }] });
      continue;
    }
    if (!lower && schema && !ts && !owned.has(typeName)) {
      add({ group: 'undefined-type', stringId: sid, key: typeName, texts: { en: `Delete ${sid} (type ${typeName})`, ru: `Удалить ${sid} (тип ${typeName})`, zh: `删除 ${sid}（类型 ${typeName}）` }, ops: [{ op: 'delete', id: sid }] });
      continue;
    }
    if (!lower && owned.has(typeName) && ctx.referencesTo(sid).every((e) => e.source === sid || !ctx.has(e.source))) {
      add({ group: 'orphaned', stringId: sid, key: typeName, texts: { en: `Delete ${sid} (${typeName}, not referenced)`, ru: `Удалить ${sid} (${typeName}, без ссылок)`, zh: `删除 ${sid}（${typeName}，无引用）` }, ops: [{ op: 'delete', id: sid }] });
      continue;
    }

    // Fields.
    for (const dict of SCALAR_DICTS) {
      for (const [key, value] of scalarMap(delta, dict)) {
        if (ts && !findField(ts, key)) {
          add({ group: 'obsolete-field', stringId: sid, key, texts: { en: `Remove field ${key}`, ru: `Убрать поле ${key}`, zh: `移除字段 ${key}` }, ops: [{ op: 'reset', id: sid, field: key, dict }] });
        } else if (lower && scalarEqual(scalarMap(lower, dict).get(key), value)) {
          add({ group: 'no-op', stringId: sid, key, texts: { en: `${key}: same as below`, ru: `${key}: как в нижнем слое`, zh: `${key}：与下层相同` }, ops: [{ op: 'reset', id: sid, field: key, dict }] });
        }
      }
    }
    const rec = ctx.get(sid);
    for (const [cat, list] of delta.refs) {
      if (ts && !findField(ts, cat)) {
        add({ group: 'obsolete-field', stringId: sid, key: cat, texts: { en: `Remove reference category ${cat}`, ru: `Убрать категорию ссылок ${cat}`, zh: `移除引用类别 ${cat}` }, ops: [{ op: 'resetRefs', id: sid, category: cat }] });
        continue;
      }
      const lowerList = lower?.refs.get(cat) ?? [];
      const noop = list.filter((r) => !isRemovedRef(r) && lowerList.some((l) => l.target === r.target && l.v0 === r.v0 && l.v1 === r.v1 && l.v2 === r.v2));
      if (noop.length && rec) {
        const resolved = rec.refs.get(cat) ?? [];
        add({
          group: 'no-op',
          stringId: sid,
          key: cat,
          texts: { en: `${cat}: ${noop.length} references same as below`, ru: `${cat}: ссылок как в нижнем слое — ${noop.length}`, zh: `${cat}：${noop.length} 个引用与下层相同` },
          // Writing the same resulting list makes the diff drop the entries equal to the lower layer.
          ops: [{ op: 'setRefs', id: sid, category: cat, refs: resolved.map((r) => ({ target: r.target, values: [r.v0, r.v1, r.v2] })) }],
        });
      }
      for (const r of list) {
        if (isRemovedRef(r) || ctx.has(r.target)) continue;
        add({ group: 'invalid-refs', stringId: sid, key: cat, target: r.target, texts: { en: `Remove ${cat} → ${r.target}`, ru: `Убрать ${cat} → ${r.target}`, zh: `移除 ${cat} → ${r.target}` }, ops: [{ op: 'removeRef', id: sid, category: cat, target: r.target }] });
      }
    }
    for (const [k, inst] of delta.instances) {
      if (ctx.has(inst.target)) continue;
      add({ group: 'invalid-refs', stringId: sid, key: `instance:${k}`, target: inst.target, texts: { en: `Remove placed object ${k} → ${inst.target}`, ru: `Убрать объект ${k} → ${inst.target}`, zh: `移除放置的对象 ${k} → ${inst.target}` }, ops: [{ op: 'removeInstance', id: sid, key: k }] });
    }
  }
  const counts = Object.fromEntries(CLEANUP_GROUPS.map((g) => [g, 0])) as Record<CleanupGroup, number>;
  for (const it of items) counts[it.group]++;
  return { items, counts };
}

const RECORD_OPS = new Set<EditOp['op']>(['delete', 'revert']);

/** Operations for the chosen items, ordered so they do not trip over each other. */
export function cleanupOps(items: readonly CleanupItem[]): EditOp[] {
  const whole = new Set(items.flatMap((i) => i.ops.filter((o) => RECORD_OPS.has(o.op)).map((o) => (o as { id: string }).id)));
  const rank = (o: EditOp): number => (o.op === 'setRefs' ? 0 : RECORD_OPS.has(o.op) ? 2 : 1);
  const ops = items.flatMap((i) => i.ops).filter((o) => RECORD_OPS.has(o.op) || !whole.has((o as { id: string }).id));
  return ops.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o);
}

/** Apply the chosen items as one history step; undefined when nothing is chosen. */
export function applyCleanup(ctx: ModContext, items: readonly CleanupItem[]): ApplyOpsResult | undefined {
  if (!items.length) return undefined;
  return applyOps(ctx, cleanupOps(items), `очистка: ${items.length}`);
}

/** Lines of a cleanup preview grouped by kind. */
export function formatCleanup(ctx: ModContext, scan: CleanupScan, lang = 'en'): string[] {
  const out: string[] = [];
  for (const g of CLEANUP_GROUPS) {
    const list = scan.items.filter((i) => i.group === g);
    if (!list.length) continue;
    out.push(`${uiText(CLEANUP_GROUP_LABELS[g], lang)} (${list.length})`);
    for (const it of list) {
      const name = ctx.name(it.stringId);
      out.push(`  ${it.stringId}${name !== undefined ? ` «${name}»` : ''}: ${uiText(it.texts, lang)}`);
    }
  }
  return out;
}

