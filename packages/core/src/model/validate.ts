/**
 * Mod check: broken references (to missing and deleted records), fields absent from the
 * schema, values of the wrong kind, references to records of the wrong type, enum values out of range.
 *
 * What the mod sets is checked: the keys of its records, not values inherited from vanilla.
 * Separately — lower-layer records that reference records the mod deleted; dangling references
 * to records deleted by a dependency (not vanilla) or by a mod above the layer where the reference appeared;
 * dialogues without lines; own dialogues that score no lower than vanilla ones with an effect (arrest,
 * attack, trade, recruit).
 * As in FCS: a record whose type differs from the lower layer's; a record saved as new whose string id
 * a lower layer already defines; a reference list longer than the schema limit (`SINGLE`).
 */
import { itemTypeName } from '../format/item-types.ts';
import { FileType, type GameRecord } from '../format/types.ts';
import { DICT_FOR_KIND, findField, type GameSchema, type TypeSchema } from '../schema/game-schema.ts';
import { withInferredFields } from '../schema/infer.ts';
import type { ModContext } from './context.ts';
import { isRemovalMarker, isRemovedRef, SCALAR_DICTS, scalarMap } from './record-ops.ts';
import { isVanillaLayer } from '../vanilla.ts';
import { decodeText } from '../text.ts';
import { uiText, type UiText } from '../ui-text.ts';
import { ACTION_KIND_LABELS, dialogActionKinds, dialogBestTotal, dialogSortKey, EVENT_TALK, packageDialogs, squadIndex, talkSources, type ActionKind, type SquadIndex } from '../dialog/talk.ts';

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
  | 'dangling-ref'
  | 'overrides-action'
  | 'type-changed'
  | 'id-taken'
  | 'too-many-refs';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: IssueCode;
  stringId: string;
  /** Field key or reference category. */
  key?: string;
  target?: string;
  /** For scalar-field issues: the dictionary the key is written to (`ints`, `floats`, …). */
  dict?: string;
  /** English text (logs, MCP, JSON). */
  message: string;
  /** The text in every interface language. */
  texts?: UiText;
}

const msg = (t: UiText): { message: string; texts: UiText } => ({ message: t.en, texts: t });

export interface ValidateOptions {
  /** Schema; defaults to the context schema. */
  schema?: GameSchema;
  /**
   * Extend the schema with fields found in the lower layers (yes by default): so
   * fields the game knows but fcs.def does not describe are not treated as errors.
   */
  inferFromLayers?: boolean;
}

const inferredCache = new WeakMap<ModContext, WeakMap<GameSchema, GameSchema>>();

/** The schema validation uses: the context schema extended with fields found in the lower layers. */
export function effectiveSchema(ctx: ModContext, options: ValidateOptions = {}): GameSchema | undefined {
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
      else issues.push({ severity: 'warning', code: 'remove-missing', stringId: sid, ...msg({ en: 'removes a record that is not in the lower layers', ru: 'удаляет запись, которой нет в нижних слоях', zh: '删除了下层中不存在的记录' }) });
      continue;
    }
    const rec = ctx.get(sid);
    if (!rec) continue;
    checkLayerClash(ctx, delta, issues);
    checkRefs(ctx, delta, issues);
    if (schema) checkSchema(ctx, schema, delta, rec, issues);
  }
  checkDependencyDeletions(ctx, issues);
  checkEmptyDialogues(ctx, issues);
  checkActionOverrides(ctx, issues);
  for (const sid of deletedByMod) {
    for (const e of ctx.referencesTo(sid)) {
      if (ctx.status(e.source) === 'deleted') continue;
      issues.push({
        severity: 'error',
        code: 'deleted-ref',
        stringId: e.source,
        key: e.category,
        target: sid,
        ...msg({ en: `refers to record ${sid}, which the mod removes`, ru: `ссылается на запись ${sid}, которую мод удаляет`, zh: `引用了被本 Mod 删除的记录 ${sid}` }),
      });
    }
  }
  return dedupe(issues);
}

/**
 * Records deleted by dependencies (layers after vanilla, except the mod itself) that live
 * records still reference in the final state. This is what `CHARACTER.dialogue` looks like when
 * a later mod deleted the dialogue: the game gets a reference to nowhere.
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
          ...msg({ en: `refers to ${rec.stringId} “${decodeText(rec.name)}”, which ${layer.name} removes`, ru: `ссылается на ${rec.stringId} «${decodeText(rec.name)}», которую удаляет ${layer.name}`, zh: `引用了被 ${layer.name} 删除的 ${rec.stringId} “${decodeText(rec.name)}”` }),
        });
      }
    }
  }
}

/** DIALOGUE without lines: own ones and those the mod references. In game such a dialogue stays silent. */
function checkEmptyDialogues(ctx: ModContext, issues: ValidationIssue[]): void {
  const empty = (sid: string): boolean => {
    const rec = ctx.get(sid);
    return rec !== undefined && itemTypeName(rec.type) === 'DIALOGUE' && (rec.refs.get('lines') ?? []).length === 0;
  };
  for (const delta of ctx.modRecords()) {
    if (isRemovalMarker(delta)) continue;
    if (empty(delta.stringId)) {
      issues.push({ severity: 'warning', code: 'empty-dialogue', stringId: delta.stringId, key: 'lines', ...msg({ en: 'dialogue without lines (lines is empty) — says nothing in the game', ru: 'диалог без реплик (lines пуст) — в игре ничего не скажет', zh: '对话没有台词（lines 为空）— 在游戏中不会说任何话' }) });
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
          ...msg({ en: `reference to dialogue ${r.target} without lines — it says nothing in the game`, ru: `ссылка на диалог ${r.target} без реплик — в игре он ничего не скажет`, zh: `引用了没有台词的对话 ${r.target} — 在游戏中不会说任何话` }),
        });
      }
    }
  }
}

/**
 * A dialogue the mod added to a package (`dialogs`) or a character (`dialogue`, click) may enter the
 * draw together with an existing dialogue of the same event that has an effect (arrest, attack, trade,
 * recruit): its best score (with the first line, as the game does) is not lower, or the game lists it
 * earlier. Then the game may pick the mod's dialogue and the effect will not happen (paladins won't arrest,
 * the trader won't open the menu). Make your dialogue a fallback — lower `score bonus`, e.g. −100.
 */
function checkActionOverrides(ctx: ModContext, issues: ValidationIssue[]): void {
  let sq: SquadIndex | undefined;
  const kinds = new Map<string, ActionKind[]>();
  const kindsOf = (d: string): ActionKind[] => {
    let k = kinds.get(d);
    if (!k) kinds.set(d, (k = dialogActionKinds(ctx, d)));
    return k;
  };
  const playable = (d: string): boolean => {
    const r = ctx.get(d);
    return r !== undefined && !r.bools.get('locked') && (r.refs.get('lines') ?? []).length > 0;
  };
  const check = (holder: string, key: string, added: { dialog: string; event: number }, rivals: readonly string[]): void => {
    const mine = ctx.get(added.dialog);
    if (!mine || !playable(added.dialog)) return;
    const my = dialogBestTotal(ctx, added.dialog) ?? 0;
    const myKey = dialogSortKey(ctx, added.dialog);
    for (const rv of new Set(rivals)) {
      if (rv === added.dialog || ctx.status(rv) === 'new' || !playable(rv)) continue;
      const act = kindsOf(rv);
      const theirs = dialogBestTotal(ctx, rv) ?? 0;
      if (!act.length || (my < theirs && myKey <= dialogSortKey(ctx, rv))) continue;
      const acts = (lang: string): string => act.map((a) => uiText(ACTION_KIND_LABELS[a], lang)).join(lang === 'zh' ? '、' : ', ');
      issues.push({
        severity: 'warning',
        code: 'overrides-action',
        stringId: holder,
        key,
        target: added.dialog,
        ...msg({
          en: `dialogue ${added.dialog} “${ctx.name(added.dialog) ?? ''}” (score ${my}) is not below ${rv} “${ctx.name(rv) ?? ''}” (score ${theirs}, ${acts('en')}) on event ${added.event}: the game may pick the mod dialogue and the action will not happen; make your dialogue a fallback (lower score bonus)`,
          ru: `диалог ${added.dialog} «${ctx.name(added.dialog) ?? ''}» (очки ${my}) не уступает ${rv} «${ctx.name(rv) ?? ''}» (очки ${theirs}, ${acts('ru')}) на событии ${added.event}: игра может выбрать диалог мода, и действие не случится; сделайте свой диалог запасным (score bonus ниже)`,
          zh: `对话 ${added.dialog} “${ctx.name(added.dialog) ?? ''}”（分数 ${my}）不低于 ${rv} “${ctx.name(rv) ?? ''}”（分数 ${theirs}，${acts('zh')}），事件 ${added.event}：游戏可能选择 Mod 的对话，动作将不会发生；请把你的对话设为备用（降低 score bonus）`,
        }),
      });
    }
  };
  for (const delta of ctx.modRecords()) {
    if (isRemovalMarker(delta)) continue;
    const t = itemTypeName(delta.type);
    if (t !== 'DIALOGUE_PACKAGE' && t !== 'CHARACTER') continue;
    const cat = t === 'CHARACTER' ? 'dialogue' : 'dialogs';
    const before = new Set((ctx.lower(delta.stringId)?.refs.get(cat) ?? []).map((r) => `${r.target}|${t === 'CHARACTER' ? 0 : r.v0}`));
    const added = (delta.refs.get(cat) ?? []).filter((r) => !isRemovedRef(r) && !before.has(`${r.target}|${t === 'CHARACTER' ? 0 : r.v0}`));
    if (!added.length) continue;
    const rec = ctx.get(delta.stringId);
    if (!rec) continue;
    for (const a of added) {
      if (t === 'DIALOGUE_PACKAGE') {
        const rivals = packageDialogs(ctx, delta.stringId).filter((d) => d.event === a.v0).map((d) => d.dialog);
        check(delta.stringId, cat, { dialog: a.target, event: a.v0 }, rivals);
      } else {
        sq ??= squadIndex(ctx);
        check(delta.stringId, cat, { dialog: a.target, event: EVENT_TALK }, talkSources(ctx, rec, EVENT_TALK, sq).map((x) => x.dialog));
      }
    }
  }
}

/** The mod file marks the record as new (not as a change). Records created in the editor have no flags yet. */
export function savedAsNew(ctx: ModContext, delta: GameRecord): boolean {
  if (ctx.info.fileType === FileType.MergeMod) return delta.lead !== 0 && (delta.changeFlags & 15) === 0;
  return (delta.changeFlags & 0x7fffffff) === 2;
}

/** The topmost lower layer that has the record. */
function definingLayer(ctx: ModContext, sid: string): string | undefined {
  for (let i = ctx.layers.length - 1; i >= 0; i--) {
    const l = ctx.layers[i]!;
    if (l.file.records.some((r) => r.stringId === sid && !isRemovalMarker(r))) return l.name;
  }
  return undefined;
}

/** Type changed between layers; string id already defined by a lower layer although the mod creates the record. */
function checkLayerClash(ctx: ModContext, delta: GameRecord, issues: ValidationIssue[]): void {
  const sid = delta.stringId;
  const lower = ctx.lower(sid);
  if (!lower) return;
  if (savedAsNew(ctx, delta)) {
    const by = definingLayer(ctx, sid) ?? '?';
    issues.push({
      severity: 'error',
      code: 'id-taken',
      stringId: sid,
      ...msg({
        en: `the mod creates this record, but ${by} already defines id ${sid} (“${decodeText(lower.name)}”): on save it becomes a change of that record`,
        ru: `мод создаёт эту запись, но id ${sid} уже есть в ${by} («${decodeText(lower.name)}»): при сохранении она станет правкой той записи`,
        zh: `本 Mod 创建了这条记录，但 ${by} 已定义 ID ${sid}（“${decodeText(lower.name)}”）：保存时它会变成对那条记录的修改`,
      }),
    });
  }
  if (delta.type !== lower.type) {
    const from = ctx.typeName(lower.type);
    const to = ctx.typeName(delta.type);
    issues.push({
      severity: 'error',
      code: 'type-changed',
      stringId: sid,
      ...msg({ en: `record type changed: ${from} → ${to}`, ru: `тип записи изменён: ${from} → ${to}`, zh: `记录类型已更改：${from} → ${to}` }),
    });
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
    issues.push({ severity: 'error', code: 'deleted-ref', stringId: sid, key, target, ...msg({ en: `reference to a removed record ${target}`, ru: `ссылка на удалённую запись ${target}`, zh: `引用了已删除的记录 ${target}` }) });
  } else {
    issues.push({ severity: 'error', code: 'broken-ref', stringId: sid, key, target, ...msg({ en: `reference to a missing record ${target}`, ru: `ссылка на несуществующую запись ${target}`, zh: `引用了不存在的记录 ${target}` }) });
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
  const typeName = itemTypeName(rec.type, schema.itemTypes);
  const ts: TypeSchema | undefined = schema.types.get(typeName);
  if (!ts) {
    issues.push({ severity: 'warning', code: 'unknown-type', stringId: sid, ...msg({ en: `type ${typeName} is not described in the schema`, ru: `тип ${typeName} не описан в схеме`, zh: `架构中没有描述类型 ${typeName}` }) });
    return;
  }
  for (const dict of SCALAR_DICTS) {
    for (const [key, value] of scalarMap(delta, dict)) {
      const f = findField(ts, key);
      if (!f) {
        issues.push({ severity: 'warning', code: 'unknown-field', stringId: sid, key, dict, ...msg({ en: `type ${typeName} has no field ${key}`, ru: `поля ${key} нет у типа ${typeName}`, zh: `类型 ${typeName} 没有字段 ${key}` }) });
        continue;
      }
      const want = DICT_FOR_KIND[f.kind];
      // Kind is not checked for derived fields and null-kind fields (FCS draws them specially).
      if (f.inferred || want === undefined) continue;
      if (want !== dict) {
        issues.push({ severity: 'error', code: 'wrong-kind', stringId: sid, key, dict, ...msg({ en: `field ${key} must be ${f.kind} but is written to ${dict}`, ru: `поле ${key} должно быть ${f.kind}, а записано в ${dict}`, zh: `字段 ${key} 应为 ${f.kind}，却写入了 ${dict}` }) });
        continue;
      }
      if (f.kind === 'enum' && f.enumName && !f.bitset) {
        const e = schema.enums.get(f.enumName);
        if (e && !e.values.some((v) => v.value === value)) {
          issues.push({ severity: 'warning', code: 'enum-value', stringId: sid, key, dict, ...msg({ en: `value ${String(value)} is not in ${f.enumName}`, ru: `значение ${String(value)} не входит в ${f.enumName}`, zh: `值 ${String(value)} 不在 ${f.enumName} 中` }) });
        }
      }
    }
  }
  for (const [cat, list] of delta.refs) {
    const f = findField(ts, cat);
    if (!f) {
      issues.push({ severity: 'warning', code: 'unknown-field', stringId: sid, key: cat, ...msg({ en: `type ${typeName} has no reference category ${cat}`, ru: `категории ссылок ${cat} нет у типа ${typeName}`, zh: `类型 ${typeName} 没有引用类别 ${cat}` }) });
      continue;
    }
    if (f.kind !== 'reference') {
      if (!f.inferred) issues.push({ severity: 'error', code: 'wrong-kind', stringId: sid, key: cat, ...msg({ en: `field ${cat} is ${f.kind}, not a reference`, ru: `поле ${cat} — ${f.kind}, а не ссылка`, zh: `字段 ${cat} 是 ${f.kind}，不是引用` }) });
      continue;
    }
    if (f.limit !== undefined && f.limit > 0) {
      const count = (rec.refs.get(cat) ?? []).filter((r) => !isRemovedRef(r)).length;
      if (count > f.limit) {
        issues.push({
          severity: 'error',
          code: 'too-many-refs',
          stringId: sid,
          key: cat,
          ...msg({ en: `reference list ${cat} has ${count} entries, the limit is ${f.limit}`, ru: `в списке ссылок ${cat} ${count} шт., предел — ${f.limit}`, zh: `引用列表 ${cat} 有 ${count} 项，上限为 ${f.limit}` }),
        });
      }
    }
    if (!f.targetType || f.targetType === 'NULL_ITEM' || f.inferred) continue;
    for (const r of list) {
      if (isRemovedRef(r)) continue;
      const t = ctx.get(r.target);
      if (t && itemTypeName(t.type, schema.itemTypes) !== f.targetType) {
        issues.push({
          severity: 'warning',
          code: 'wrong-target-type',
          stringId: sid,
          key: cat,
          target: r.target,
          ...msg({
            en: `${cat} expects ${f.targetType}, but ${r.target} is ${itemTypeName(t.type, schema.itemTypes)}`,
            ru: `${cat} ждёт ${f.targetType}, а ${r.target} — ${itemTypeName(t.type, schema.itemTypes)}`,
            zh: `${cat} 需要 ${f.targetType}，而 ${r.target} 是 ${itemTypeName(t.type, schema.itemTypes)}`,
          }),
        });
      }
    }
  }
}

const SEVERITY: Readonly<Record<ValidationIssue['severity'], UiText>> = {
  error: { en: 'ERROR', ru: 'ОШИБКА', zh: '错误' },
  warning: { en: 'warning', ru: 'предупр.', zh: '警告' },
};

/** Human names of the issue kinds (the window shows these; CLI and MCP keep the codes). */
export const ISSUE_CODE_LABELS: Readonly<Record<IssueCode, UiText>> = {
  'broken-ref': { en: 'Reference to a missing record', ru: 'Ссылка на несуществующую запись', zh: '引用了不存在的记录' },
  'deleted-ref': { en: 'Reference to a deleted record', ru: 'Ссылка на удалённую запись', zh: '引用了已删除的记录' },
  'unknown-type': { en: 'Type not in the schema', ru: 'Тип не описан в схеме', zh: '架构中没有的类型' },
  'unknown-field': { en: 'Field not in the schema', ru: 'Поле не описано в схеме', zh: '架构中没有的字段' },
  'wrong-kind': { en: 'Field written as the wrong kind', ru: 'Поле записано не того вида', zh: '字段写入的类别错误' },
  'wrong-target-type': { en: 'Reference to a record of the wrong type', ru: 'Ссылка на запись не того типа', zh: '引用了类型错误的记录' },
  'enum-value': { en: 'Value outside the list', ru: 'Значение не из списка', zh: '值不在列表中' },
  'remove-missing': { en: 'Removes a record that does not exist', ru: 'Удаляет несуществующую запись', zh: '删除了不存在的记录' },
  'empty-dialogue': { en: 'Dialogue without lines', ru: 'Диалог без реплик', zh: '没有台词的对话' },
  'dangling-ref': { en: 'Reference to a record removed by a dependency', ru: 'Ссылка на запись, удалённую зависимостью', zh: '引用了被依赖项删除的记录' },
  'overrides-action': { en: 'Dialogue overrides a vanilla action', ru: 'Диалог перекрывает действие ванили', zh: '对话覆盖了原版动作' },
  'type-changed': { en: 'Record type changed between layers', ru: 'Тип записи сменился между слоями', zh: '记录类型在层之间改变' },
  'id-taken': { en: 'String id taken by another mod', ru: 'Строковый id занят другим модом', zh: '字符串 id 已被其他 Mod 占用' },
  'too-many-refs': { en: 'Too many references in a list', ru: 'Слишком много ссылок в списке', zh: '列表中的引用过多' },
};

/** Severity word of an issue in an interface language. */
export function issueSeverityText(i: ValidationIssue, lang = 'en'): string {
  return uiText(SEVERITY[i.severity], lang);
}

/** One issue without severity and code: «sid «name» [key]: message». */
export function formatIssueText(ctx: ModContext, i: ValidationIssue, lang = 'en'): string {
  const name = ctx.name(i.stringId);
  const message = i.texts ? uiText(i.texts, lang) : i.message;
  return `${i.stringId}${name !== undefined ? ` «${name}»` : ''}${i.key ? ` [${i.key}]` : ''}: ${message}`;
}

/** One issue as a line of text in an interface language (English by default). */
export function formatIssue(ctx: ModContext, i: ValidationIssue, lang = 'en'): string {
  const name = ctx.name(i.stringId);
  const message = i.texts ? uiText(i.texts, lang) : i.message;
  return `${uiText(SEVERITY[i.severity], lang)} ${i.code} ${i.stringId}${name !== undefined ? ` «${name}»` : ''}${i.key ? ` [${i.key}]` : ''}: ${message}`;
}
