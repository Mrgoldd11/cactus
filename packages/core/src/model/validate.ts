/**
 * Проверка мода: битые ссылки (на несуществующие и удалённые записи), поля, которых нет в
 * схеме, значения не того вида, ссылки на записи не того типа, значения enum вне списка.
 *
 * Проверяется то, что задаёт мод: ключи его записей, а не унаследованные значения ваниль.
 * Отдельно — записи нижних слоёв, которые ссылаются на удалённые модом записи; висячие ссылки
 * на записи, удалённые зависимостью (не ванилью) или модом поверх слоя, где ссылка появилась;
 * диалоги без реплик.
 */
import { itemTypeName } from '../format/item-types.ts';
import type { GameRecord } from '../format/types.ts';
import { DICT_FOR_KIND, findField, type GameSchema, type TypeSchema } from '../schema/game-schema.ts';
import { withInferredFields } from '../schema/infer.ts';
import type { ModContext } from './context.ts';
import { isRemovalMarker, isRemovedRef, SCALAR_DICTS, scalarMap } from './record-ops.ts';
import { isVanillaLayer } from '../vanilla.ts';
import { decodeText } from '../text.ts';

export type IssueCode =
  | 'broken-ref'
  | 'deleted-ref'
  | 'unknown-type'
  | 'unknown-field'
  | 'wrong-kind'
  | 'wrong-target-type'
  | 'enum-value'
  | 'remove-missing'
  | 'empty-dialogue'
  | 'dangling-ref';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: IssueCode;
  stringId: string;
  /** Ключ поля или категория ссылок. */
  key?: string;
  target?: string;
  message: string;
}

export interface ValidateOptions {
  /** Схема; по умолчанию — схема контекста. */
  schema?: GameSchema;
  /**
   * Дополнить схему полями, которые встречаются в нижних слоях (по умолчанию да): так
   * поля, которые игра знает, но fcs.def не описывает, не считаются ошибкой.
   */
  inferFromLayers?: boolean;
}

const inferredCache = new WeakMap<ModContext, WeakMap<GameSchema, GameSchema>>();

function effectiveSchema(ctx: ModContext, options: ValidateOptions): GameSchema | undefined {
  const schema = options.schema ?? ctx.schema;
  if (!schema || options.inferFromLayers === false) return schema;
  let byCtx = inferredCache.get(ctx);
  if (!byCtx) inferredCache.set(ctx, (byCtx = new WeakMap()));
  let s = byCtx.get(schema);
  if (!s) {
    s = withInferredFields(schema, ctx.layers.map((l) => l.file));
    byCtx.set(schema, s);
  }
  return s;
}

export function validateMod(ctx: ModContext, options: ValidateOptions = {}): ValidationIssue[] {
  const schema = effectiveSchema(ctx, options);
  const issues: ValidationIssue[] = [];
  const deletedByMod: string[] = [];
  for (const delta of ctx.modRecords()) {
    const sid = delta.stringId;
    if (isRemovalMarker(delta)) {
      if (ctx.lower(sid)) deletedByMod.push(sid);
      else issues.push({ severity: 'warning', code: 'remove-missing', stringId: sid, message: 'удаляет запись, которой нет в нижних слоях' });
      continue;
    }
    const rec = ctx.get(sid);
    if (!rec) continue;
    checkRefs(ctx, delta, issues);
    if (schema) checkSchema(ctx, schema, delta, rec, issues);
  }
  checkDependencyDeletions(ctx, issues);
  checkEmptyDialogues(ctx, issues);
  for (const sid of deletedByMod) {
    for (const e of ctx.referencesTo(sid)) {
      if (ctx.status(e.source) === 'deleted') continue;
      issues.push({
        severity: 'error',
        code: 'deleted-ref',
        stringId: e.source,
        key: e.category,
        target: sid,
        message: `ссылается на запись ${sid}, которую мод удаляет`,
      });
    }
  }
  return dedupe(issues);
}

/**
 * Записи, удалённые зависимостями (слоями после ванили, кроме самого мода), на которые в
 * итоговом состоянии ещё ссылаются живые записи. Так выглядит `CHARACTER.dialogue`, когда
 * поздний мод удалил диалог: игра получит ссылку в никуда.
 */
function checkDependencyDeletions(ctx: ModContext, issues: ValidationIssue[]): void {
  for (const layer of ctx.layers) {
    if (isVanillaLayer(layer.name)) continue;
    for (const rec of layer.file.records) {
      if (!isRemovalMarker(rec) || ctx.has(rec.stringId)) continue;
      for (const e of ctx.referencesTo(rec.stringId)) {
        if (!ctx.has(e.source)) continue;
        issues.push({
          severity: 'warning',
          code: 'dangling-ref',
          stringId: e.source,
          key: e.category,
          target: rec.stringId,
          message: `ссылается на ${rec.stringId} «${decodeText(rec.name)}», которую удаляет ${layer.name}`,
        });
      }
    }
  }
}

/** DIALOGUE без реплик: свои и те, на которые мод ссылается. В игре такой диалог молчит. */
function checkEmptyDialogues(ctx: ModContext, issues: ValidationIssue[]): void {
  const empty = (sid: string): boolean => {
    const rec = ctx.get(sid);
    return rec !== undefined && itemTypeName(rec.type) === 'DIALOGUE' && (rec.refs.get('lines') ?? []).length === 0;
  };
  for (const delta of ctx.modRecords()) {
    if (isRemovalMarker(delta)) continue;
    if (empty(delta.stringId)) {
      issues.push({ severity: 'warning', code: 'empty-dialogue', stringId: delta.stringId, key: 'lines', message: 'диалог без реплик (lines пуст) — в игре ничего не скажет' });
    }
    for (const [cat, list] of delta.refs) {
      for (const r of list) {
        if (isRemovedRef(r) || r.target === delta.stringId || ctx.delta(r.target) !== undefined || !empty(r.target)) continue;
        issues.push({
          severity: 'warning',
          code: 'empty-dialogue',
          stringId: delta.stringId,
          key: cat,
          target: r.target,
          message: `ссылка на диалог ${r.target} без реплик — в игре он ничего не скажет`,
        });
      }
    }
  }
}

function dedupe(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${i.stringId}|${i.key ?? ''}|${i.target ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function checkTarget(ctx: ModContext, sid: string, key: string, target: string, issues: ValidationIssue[]): void {
  if (ctx.has(target)) return;
  if (ctx.lower(target) || ctx.status(target) === 'deleted') {
    issues.push({ severity: 'error', code: 'deleted-ref', stringId: sid, key, target, message: `ссылка на удалённую запись ${target}` });
  } else {
    issues.push({ severity: 'error', code: 'broken-ref', stringId: sid, key, target, message: `ссылка на несуществующую запись ${target}` });
  }
}

function checkRefs(ctx: ModContext, delta: GameRecord, issues: ValidationIssue[]): void {
  for (const [cat, list] of delta.refs) {
    for (const r of list) if (!isRemovedRef(r)) checkTarget(ctx, delta.stringId, cat, r.target, issues);
  }
  for (const [k, i] of delta.instances) checkTarget(ctx, delta.stringId, `instance:${k}`, i.target, issues);
}

function checkSchema(ctx: ModContext, schema: GameSchema, delta: GameRecord, rec: GameRecord, issues: ValidationIssue[]): void {
  const sid = delta.stringId;
  const typeName = itemTypeName(rec.type);
  const ts: TypeSchema | undefined = schema.types.get(typeName);
  if (!ts) {
    issues.push({ severity: 'warning', code: 'unknown-type', stringId: sid, message: `тип ${typeName} не описан в схеме` });
    return;
  }
  for (const dict of SCALAR_DICTS) {
    for (const [key, value] of scalarMap(delta, dict)) {
      const f = findField(ts, key);
      if (!f) {
        issues.push({ severity: 'warning', code: 'unknown-field', stringId: sid, key, message: `поля ${key} нет у типа ${typeName}` });
        continue;
      }
      const want = DICT_FOR_KIND[f.kind];
      // У выведенных полей и полей вида null (FCS рисует их особо) вид не проверяется.
      if (f.inferred || want === undefined) continue;
      if (want !== dict) {
        issues.push({ severity: 'error', code: 'wrong-kind', stringId: sid, key, message: `поле ${key} должно быть ${f.kind}, а записано в ${dict}` });
        continue;
      }
      if (f.kind === 'enum' && f.enumName && !f.bitset) {
        const e = schema.enums.get(f.enumName);
        if (e && !e.values.some((v) => v.value === value)) {
          issues.push({ severity: 'warning', code: 'enum-value', stringId: sid, key, message: `значение ${String(value)} не входит в ${f.enumName}` });
        }
      }
    }
  }
  for (const [cat, list] of delta.refs) {
    const f = findField(ts, cat);
    if (!f) {
      issues.push({ severity: 'warning', code: 'unknown-field', stringId: sid, key: cat, message: `категории ссылок ${cat} нет у типа ${typeName}` });
      continue;
    }
    if (f.kind !== 'reference') {
      if (!f.inferred) issues.push({ severity: 'error', code: 'wrong-kind', stringId: sid, key: cat, message: `поле ${cat} — ${f.kind}, а не ссылка` });
      continue;
    }
    if (!f.targetType || f.targetType === 'NULL_ITEM' || f.inferred) continue;
    for (const r of list) {
      if (isRemovedRef(r)) continue;
      const t = ctx.get(r.target);
      if (t && itemTypeName(t.type) !== f.targetType) {
        issues.push({
          severity: 'warning',
          code: 'wrong-target-type',
          stringId: sid,
          key: cat,
          target: r.target,
          message: `${cat} ждёт ${f.targetType}, а ${r.target} — ${itemTypeName(t.type)}`,
        });
      }
    }
  }
}

export function formatIssue(ctx: ModContext, i: ValidationIssue): string {
  const name = ctx.name(i.stringId);
  return `${i.severity === 'error' ? 'ОШИБКА' : 'предупр.'} ${i.code} ${i.stringId}${name !== undefined ? ` «${name}»` : ''}${i.key ? ` [${i.key}]` : ''}: ${i.message}`;
}
