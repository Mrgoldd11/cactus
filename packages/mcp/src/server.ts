/**
 * MCP-сервер: поиск, просмотр, проверка, правка и сохранение мода через ядро редактора.
 * Ответы — компактный текст: ссылки с именами целей, длинные списки страницами.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  applyBulk,
  applyMerge,
  applyOps,
  formatMergePlan,
  formatMergeResult,
  planMerge,
  rejectMerge,
  selectMergeChanges,
  unrejectMerge,
  formatBulkPreview,
  previewBulk,
  buildDialogueTree,
  findTypeSchema,
  formatChangeset,
  formatDialogueTree,
  formatEnum,
  formatHit,
  formatIssue,
  formatRecord,
  formatRecordDiff,
  formatRefValues,
  formatTypeSchema,
  filterDiffs,
  formatDiffSummary,
  listTypes,
  lookupRecord,
  modRecordDiff,
  page,
  pageFooter,
  parseFieldFilter,
  refLabel,
  searchRecords,
  validateMod,
  type GameRecord,
  type ModContext,
  formatWhere,
  whereInGame,
  formatInside,
  inspectRecord,
  modelOfRecord,
  formatTalk,
  simulateTalk,
  describeChangeset,
  formatPlay,
  playConversation,
  type Changeset,
  findConflicts,
  formatConflict,
  formatTouches,
  touchedBy,
  isVanillaLayer,
} from '@kenshi-editor/core';
import { SessionError, type Session } from './session.ts';
import { GameBridge } from '@kenshi-editor/core/node';
import { registerGameTools } from './game-tools.ts';
import { registerWorldTools } from './world-tools.ts';

export const SERVER_NAME = 'kenshi-mod-editor';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function text(lines: readonly string[]): ToolResult {
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/** Ошибки ядра и сессии — ответом с isError (модель их видит и может исправиться). */
async function guarded(fn: () => string[] | Promise<string[]>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (e) {
    return { ...text([e instanceof Error ? e.message : String(e)]), isError: true };
  }
}

function paged<T>(items: readonly T[], offset: number, limit: number, line: (item: T) => string[]): string[] {
  const p = page(items, offset, limit === 0 ? Infinity : limit);
  const out = p.items.flatMap(line);
  if (p.total > p.items.length || p.total === 0) out.push(pageFooter(p));
  return out;
}

function record(ctx: ModContext, sid: string): GameRecord {
  const rec = ctx.get(sid) ?? ctx.lower(sid);
  if (!rec) throw new SessionError(`Нет записи ${sid}`);
  return rec;
}

/** Id записи по id или имени (англ. или рус.); если подходит несколько — ошибка со списком. */
function resolveId(ctx: ModContext, spec: string, preferTypes?: readonly string[]): string {
  const r = lookupRecord(ctx, spec, preferTypes ? { preferTypes } : {});
  if (r.stringId !== undefined) return r.stringId;
  if (!r.candidates.length) throw new SessionError(`Нет записи «${spec}» (ни id, ни имени)`);
  const list = r.candidates.slice(0, 20).map(formatHit);
  if (r.candidates.length > 20) list.push(`… ещё ${r.candidates.length - 20}`);
  throw new SessionError([`«${spec}»: подходит записей ${r.candidates.length} — укажите id:`, ...list].join('\n'));
}

const DIALOGUE_TYPES = ['DIALOGUE_PACKAGE', 'DIALOGUE', 'DIALOGUE_LINE', 'WORD_SWAPS'] as const;

function statusSummary(ctx: ModContext): string {
  const counts = new Map<string, number>();
  for (const rec of ctx.modRecords()) {
    const s = ctx.status(rec.stringId) ?? '?';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const parts = [...counts].map(([k, n]) => `${k} ${n}`);
  return `записей ${ctx.modRecords().length}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

const offset = z.number().int().min(0).optional().describe('Смещение страницы (из «дальше offset=…»)');
const limit = (d: number): z.ZodOptional<z.ZodNumber> => z.number().int().min(0).optional().describe(`Размер страницы, по умолчанию ${d}; 0 — все`);
const values = z.array(z.number().int()).max(3).optional().describe('Значения ссылки (до трёх чисел); по умолчанию — из схемы');
const scalar = z.union([z.boolean(), z.number(), z.string(), z.array(z.number())]);
const dict = z.string().optional().describe('Словарь: bool, int, float, str, file, vec3, vec4 (если не ясно из схемы)');
const enumIn = z.union([z.number().int(), z.string()]);
const speaker = enumIn.optional().describe('Кто говорит: npc, player или TalkerEnum (T_ME, T_TARGET, …); по умолчанию после реплики NPC — ответ игрока, иначе NPC');
const lineText = { text: z.string().optional(), texts: z.array(z.string()).optional().describe('Несколько формулировок (игра выбирает случайно)') };
const as = z.string().optional().describe('Псевдоним новой записи ($x)');

const editOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), type: z.union([z.string(), z.number()]), name: z.string(), id: z.string().optional(), as: z.string().optional() }),
  z.object({ op: z.literal('duplicate'), from: z.string(), name: z.string().optional(), id: z.string().optional(), as: z.string().optional() }),
  z.object({ op: z.literal('delete'), id: z.string(), removeReferences: z.boolean().optional() }),
  z.object({ op: z.literal('restore'), id: z.string() }),
  z.object({ op: z.literal('revert'), id: z.string() }),
  z.object({ op: z.literal('rename'), id: z.string(), name: z.string() }),
  z.object({ op: z.literal('set'), id: z.string(), field: z.string(), value: scalar, dict }),
  z.object({ op: z.literal('reset'), id: z.string(), field: z.string(), dict }),
  z.object({ op: z.literal('addRef'), id: z.string(), category: z.string(), target: z.string(), values }),
  z.object({ op: z.literal('removeRef'), id: z.string(), category: z.string(), target: z.string() }),
  z.object({ op: z.literal('setRefs'), id: z.string(), category: z.string(), refs: z.array(z.object({ target: z.string(), values })) }),
  z.object({
    op: z.literal('info'),
    author: z.string().optional(),
    description: z.string().optional(),
    version: z.number().int().optional(),
    fileType: z.number().int().optional(),
    dependencies: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
    lastId: z.number().int().optional(),
  }),
  z.object({ op: z.literal('addLine'), parent: z.string(), speaker, ...lineText, as }),
  z.object({ op: z.literal('insertLine'), parent: z.string(), child: z.string(), speaker, ...lineText, as }),
  z.object({ op: z.literal('link'), parent: z.string(), child: z.string() }),
  z.object({ op: z.literal('unlink'), parent: z.string(), child: z.string() }),
  z.object({ op: z.literal('setText'), id: z.string(), ...lineText }),
  z.object({ op: z.literal('duplicateLine'), id: z.string(), parent: z.string().optional(), as }),
  z.object({ op: z.literal('deleteLines'), lines: z.array(z.string()).optional(), links: z.array(z.object({ parent: z.string(), child: z.string() })).optional() }),
  z.object({ op: z.literal('revertLine'), id: z.string() }),
  z.object({ op: z.literal('addCondition'), id: z.string(), cond: enumIn, value: z.number().int(), who: enumIn.optional(), cmp: enumIn.optional(), tag: z.number().int().optional(), as }),
  z.object({ op: z.literal('addEffect'), id: z.string(), action: enumIn, values: z.array(z.number().int()).max(3).optional(), as }),
  z.object({ op: z.literal('removeAction'), id: z.string(), category: z.enum(['conditions', 'effects']), action: z.string() }),
]);

/** Убрать ключи со значением undefined (exactOptionalPropertyTypes). */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function createServer(session: Session, opts: { game?: GameBridge } = {}): McpServer {
  // Подключены к редактору — перед командой взять свежее состояние окна.
  const run = (fn: () => string[] | Promise<string[]>): Promise<ToolResult> =>
    guarded(async () => {
      await session.sync();
      return fn();
    });
  const server = new McpServer(
    { name: SERVER_NAME, version: '0.1.0-beta.1' },
    {
      instructions: [
        'Данные Kenshi: ваниль (gamedata.base → Newwworld.mod → Dialogue.mod → rebirth.mod), зависимости мода, сам мод.',
        'Сначала open_mod (или работайте по ванили без него). Записи — по строковому id или имени (show, tree, refs, diff); find ищет по англ. и рус. имени.',
        'Правки (edit) — пачкой операций, одна отмена на пачку; save пишет только изменения. В папку игры save пишет только с force: true.',
        'Схема типов и полей с описаниями из fcs.def — инструмент schema и ресурсы kenshi://schema/…',
        'Диалоги: tree — дерево, talk — какой диалог выберет игра у персонажа, play — разговор по шагам с ответами игрока; правки графа — операции edit addLine, insertLine, link, unlink, setText, duplicateLine, deleteLines, addCondition, addEffect.',
        'Массовые правки — bulk: сначала предпросмотр «было → станет», применяет только с apply: true.',
        'history — шаги понятными словами; undo/redo с to — отмена или повтор до шага.',
        'Если запущена игра с плагином Kenshi Bridge — game_state (что в игре), game_trace (какой диалог выбрала игра и почему), game_command (телепорт, камера, скорость, пауза — только с согласия пользователя, confirm: true).',
        'Если открыт Kenshi Mod Editor — connect_editor: дальше всё читается из окна редактора, а edit отправляет правки в окно набором изменений; пользователь их принимает или откатывает (editor_changes — их состояние). save и undo в этом режиме делает пользователь.',
        'Мир: list_in_area — что стоит вокруг точки или города; place / move / remove — правки мира мода (y — над землёй), своя отмена world_undo и world_history; save пишет и файлы уровня в leveldata.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'open_mod',
    {
      title: 'Открыть мод',
      description: 'Открыть .mod (путь или имя установленного мода) поверх ванили и его зависимостей. Без mod — новый пустой мод с именем name.',
      inputSchema: {
        mod: z.string().optional().describe('Путь к .mod или имя мода из mods/ или мастерской; если файла нет — новый мод по этому пути'),
        name: z.string().optional().describe('Имя файла нового мода (Мой мод.mod), если mod не задан'),
        dependencies: z.array(z.string()).optional().describe('Зависимости вместо записанных в заголовке мода'),
      },
      annotations: { ...READ, title: 'Открыть мод' },
    },
    (a) =>
      run(() => {
        const r = session.open(compact({ mod: a.mod, name: a.name, dependencies: a.dependencies }));
        const lines = [`${r.ctx.modName}${r.path ? ` — ${r.path}` : ' — новый, путь укажите в save'}`, statusSummary(r.ctx)];
        if (r.dependencyPaths.length) lines.push(`зависимости: ${r.dependencyPaths.join(', ')}`);
        if (r.missingDependencies.length) lines.push(`нет зависимостей: ${r.missingDependencies.join(', ')}`);
        if (r.ctx.dirty) lines.push('есть несохранённые изменения');
        return lines;
      }),
  );

  server.registerTool(
    'find',
    {
      title: 'Найти записи',
      description: 'Записи по имени (англ. или рус.) или id, типу, значениям полей, статусу. Строка: id  ТИП  «имя» (рус.)  [статус].',
      inputSchema: {
        text: z.string().optional().describe('Подстрока имени или id'),
        type: z.union([z.string(), z.number()]).optional().describe('Тип: имя (DIALOGUE) или номер'),
        fields: z.array(z.string()).optional().describe('Условия: ключ=знач, ключ~подстрока (или ключ:подстрока), ключ!:подстрока — не содержит, ключ?регэксп, != < > <= >=, ключ? — поле есть; для ссылок: список>5, список.v0=4, Ref>0'),
        status: z.array(z.enum(['base', 'new', 'changed', 'deleted'])).optional(),
        anywhere: z.string().optional().describe('Подстрока где угодно в записи'),
        exact: z.boolean().optional().describe('Только точное совпадение имени'),
        mod_only: z.boolean().optional().describe('Только записи мода'),
        offset,
        limit: limit(30),
      },
      annotations: { ...READ, title: 'Найти записи' },
    },
    (a) =>
      run(() => {
        const hits = searchRecords(
          session.ctx(),
          compact({
            text: a.text === '' ? undefined : a.text,
            type: a.type,
            fields: a.fields?.map(parseFieldFilter),
            status: a.status,
            anywhere: a.anywhere,
            exact: a.exact,
            modOnly: a.mod_only,
          }),
        );
        return paged(hits, a.offset ?? 0, a.limit ?? 30, (h) => [formatHit(h)]);
      }),
  );

  server.registerTool(
    'show',
    {
      title: 'Показать запись',
      description: 'Итоговые поля и ссылки записи (ссылки с именами целей), статус; layers — какие слои её задают.',
      inputSchema: {
        id: z.string().describe('Строковый id или имя записи (англ. или рус.)'),
        max_refs: z.number().int().min(0).optional().describe('Ссылок на категорию, по умолчанию 20; 0 — все'),
        layers: z.boolean().optional(),
      },
      annotations: { ...READ, title: 'Показать запись' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const max = a.max_refs ?? 20;
        return formatRecord(ctx, record(ctx, resolveId(ctx, a.id)), { showLayers: a.layers ?? false, ...(max > 0 ? { maxRefsPerCategory: max } : {}) });
      }),
  );

  server.registerTool(
    'tree',
    {
      title: 'Дерево диалога',
      description: 'Дерево диалога по ссылкам dialogs/lines: реплики, условия, действия. Повторы и циклы не разворачиваются.',
      inputSchema: {
        id: z.string().describe('Id или имя диалога, пакета или реплики'),
        depth: z.number().int().min(1).optional().describe('Глубина, по умолчанию 6'),
        max_nodes: z.number().int().min(1).optional().describe('Узлов, по умолчанию 60'),
        full: z.boolean().optional().describe('Все поля реплик'),
      },
      annotations: { ...READ, title: 'Дерево диалога' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id, DIALOGUE_TYPES);
        const tree = buildDialogueTree(ctx, id, { maxDepth: a.depth ?? 6, maxNodes: a.max_nodes ?? 60 });
        return formatDialogueTree(ctx, tree, { full: a.full ?? false });
      }),
  );

  server.registerTool(
    'refs',
    {
      title: 'Ссылки записи',
      description: 'Ссылки из записи (→ категория: цель) и на неё (← источник категория).',
      inputSchema: {
        id: z.string().describe('Id или имя записи'),
        direction: z.enum(['from', 'to', 'both']).optional().describe('По умолчанию both'),
        offset,
        limit: limit(50),
      },
      annotations: { ...READ, title: 'Ссылки записи' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id);
        const dir = a.direction ?? 'both';
        const lines: string[] = [];
        if (dir !== 'to') {
          for (const e of ctx.referencesFrom(id)) lines.push(`→ ${e.category}: ${refLabel(ctx, e.target)}${e.ref ? `  ${formatRefValues(e.ref)}` : ''}`);
        }
        if (dir !== 'from') {
          for (const e of ctx.referencesTo(id)) lines.push(`← ${refLabel(ctx, e.source)} ${e.category}${e.ref ? `  ${e.ref.v0} ${e.ref.v1} ${e.ref.v2}` : ''}`);
        }
        return paged(lines, a.offset ?? 0, a.limit ?? 50, (l) => [l]);
      }),
  );

  server.registerTool(
    'where',
    {
      title: 'Где в игре',
      description:
        'Где запись встречается в игре: цепочка обратных ссылок (предмет ← список торговца ← отряд ← город) до городов, зданий, фракций и биомов, с координатами из файлов уровня. Каждый шаг пути — с категорией ссылки. Итог вида «Продаётся у «Оружейник» (отряд …): Груз, Хэн». `tree` — ещё и дерево обратных ссылок.',
      inputSchema: {
        id: z.string().describe('Id или имя записи'),
        tree: z.boolean().optional().describe('Показать и дерево обратных ссылок'),
        limit: limit(20),
      },
      annotations: { ...READ, title: 'Где в игре' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id);
        const res = whereInGame(ctx, id, { world: session.world() });
        const max = a.limit ?? 20;
        return formatWhere(res, { tree: a.tree ?? false, maxFacts: max === 0 ? Infinity : max }).split('\n');
      }),
  );

  server.registerTool(
    'inspect',
    {
      title: 'Что внутри',
      description:
        'Карточка объекта, как по клику в сцене или в панели «Модель»: что это (имя, тип, из какого мода, меняют ли его моды), что внутри и на что ссылается (части здания, интерьер, мебель, товары, отряды, диалоги… по категориям, у размещённых объектов — координаты), кто ссылается на него, и из каких файлов модели он собран. Скриптов у объектов Kenshi нет — «внутри» только данные записи. Пустое так и помечено.',
      inputSchema: {
        id: z.string().describe('Id или имя записи (объекта сцены, здания, части, предмета)'),
        limit: limit(20),
      },
      annotations: { ...READ, title: 'Что внутри' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id);
        const max = a.limit ?? 20;
        const lines = formatInside(inspectRecord(ctx, id, { limit: max === 0 ? Infinity : max })).split('\n');
        const model = modelOfRecord(ctx, id);
        if (model.pieces.length > 0) {
          lines.push('модель:');
          for (const p of model.pieces) lines.push(`  ${p.mesh}${p.texture ? ` + ${p.texture}` : ''}${p.source !== id ? `  (часть ${refLabel(ctx, p.source)})` : ''}`);
        }
        for (const n of model.notes) lines.push(`  ${n}`);
        return lines;
      }),
  );

  server.registerTool(
    'talk',
    {
      title: 'Разговор с персонажем',
      description:
        'Симулятор разговора: какие диалоги есть у персонажа на событие (1 — игрок заговорил, по умолчанию), откуда каждый (персонаж, его пакет, отряд, фракция; слой-источник), очки, условия, действия (арест, атака, торговля, найм) и вердикт: какой выберет игра, какой сработает только при условиях, какой не прозвучит. Затем начало разговора победителя с русским текстом и выбором игрока. Выбор считается по правилу из кода игры (очки, порядок, розыгрыш поровну, шансы). Разговор дальше по шагам — play.',
      inputSchema: {
        id: z.string().describe('Id или имя персонажа (CHARACTER)'),
        event: z.number().int().min(0).optional().describe('Событие (DIALOGUE_PACKAGE dialogs v0); 1 — разговор по клику'),
      },
      annotations: { ...READ, title: 'Разговор с персонажем' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id, ['CHARACTER']);
        const translation = session.translation();
        return formatTalk(simulateTalk(ctx, id, a.event ?? 1, translation ? { translation } : {}));
      }),
  );

  server.registerTool(
    'diff',
    {
      title: 'Что меняет мод',
      description: 'Изменения мода относительно нижних слоёв: по всем записям мода или по одной (id). Последняя строка — итог «новых N, изменённых M, удалённых K».',
      inputSchema: {
        id: z.string().optional().describe('Id или имя записи'),
        status: z.array(z.enum(['added', 'changed', 'removed'])).optional().describe('Только такие изменения'),
        offset,
        limit: limit(20),
      },
      annotations: { ...READ, title: 'Что меняет мод' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const ids = a.id !== undefined ? [resolveId(ctx, a.id)] : ctx.modRecords().map((r) => r.stringId);
        const diffs = ids.flatMap((sid) => modRecordDiff(ctx, sid) ?? []);
        const shown = filterDiffs(diffs, a.status);
        const lines = paged(shown, a.offset ?? 0, a.limit ?? 20, (d) => formatRecordDiff(ctx, d));
        lines.push(`${formatDiffSummary(diffs)}${a.status ? `; показаны: ${a.status.join(', ')}` : ''}`);
        return lines;
      }),
  );

  server.registerTool(
    'validate',
    {
      title: 'Проверить мод',
      description: 'Битые ссылки, поля вне схемы, ссылки не на тот тип, значения вне enum, диалоги без реплик, висячие ссылки на записи, удалённые зависимостями.',
      inputSchema: { offset, limit: limit(50) },
      annotations: { ...READ, title: 'Проверить мод' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const issues = validateMod(ctx);
        const errors = issues.filter((i) => i.severity === 'error').length;
        const lines = issues.length ? paged(issues, a.offset ?? 0, a.limit ?? 50, (i) => [formatIssue(ctx, i)]) : [];
        lines.push(`ошибок ${errors}, предупреждений ${issues.length - errors}`);
        return lines;
      }),
  );

  /** Название шага понятными словами, как в окне редактора. */
  const title = (ctx: ModContext, cs: Changeset): string => {
    const tr = session.translation();
    return `#${String(cs.id)} ${describeChangeset(ctx, cs, tr ? { translation: tr } : {}).ru}`;
  };
  server.registerTool(
    'edit',
    {
      title: 'Править мод',
      description: [
        'Пачка операций одной правкой (одна отмена). Новые записи можно назвать псевдонимом as: "$x" и ссылаться на него дальше (id/target: "$x").',
        'create {type,name,id?,as?}; duplicate {from,name?,id?,as?}; delete {id,removeReferences?}; restore {id}; revert {id} — убрать запись из мода;',
        'rename {id,name}; set {id,field,value,dict?} — enum-поле можно задать именем (DR_ONCE_ONLY, ONCE_ONLY) или числом; reset {id,field,dict?} — вернуть значение нижнего слоя;',
        'addRef {id,category,target,values?}; removeRef {id,category,target}; setRefs {id,category,refs:[{target,values?}]};',
        'info {author?,description?,dependencies?,references?,version?,lastId?} — заголовок мода.',
        'Граф диалога (как в редакторе; parent — диалог или реплика, child — реплика):',
        'addLine {parent,speaker?,text?|texts?,as?} — новая реплика в конце ветки; insertLine {parent,child,speaker?,text?,as?} — вместо связи parent→child: parent→новая→child;',
        'link {parent,child} — связь (петля, общий ответ); unlink {parent,child}; setText {id,text|texts}; duplicateLine {id,parent?,as?} — копия со своими условиями;',
        'deleteLines {lines?,links?:[{parent,child}]} — удалить реплики (с их условиями) и связи; revertLine {id} — реплику игры как в игре;',
        'addCondition {id,cond,value,who?,cmp?,tag?} — cond: DialogConditionEnum (DC_…), who: TalkerEnum, cmp: ComparisonEnum (CE_EQUALS, CE_LESS, CE_MORE); addEffect {id,action,values?} — DialogActionEnum (DA_…); removeAction {id,category,action}.',
        'Ванильные реплики можно править: правка ложится слоем мода поверх игры.',
      ].join('\n'),
      inputSchema: {
        ops: z.array(editOp).min(1),
        label: z.string().optional().describe('Подпись правки в истории'),
      },
      annotations: { ...EDIT, title: 'Править мод' },
    },
    (a) =>
      run(async () => {
        if (session.editor) {
          const r = await session.propose(a.label ?? `${a.ops.length} правок`, a.ops.map((op) => compact(op)));
          const lines = [`в редакторе: набор изменений #${r.changeset.id} «${r.changeset.title}» — ждёт решения пользователя (принять / откатить)`];
          const aliases = Object.entries(r.aliases);
          if (aliases.length) lines.push(`псевдонимы: ${aliases.map(([k, v]) => `${k} = ${v}`).join(', ')}`);
          lines.push(...r.changeset.summary);
          return lines;
        }
        const ctx = session.ctx();
        const before = ctx.history().undo.length;
        const r = applyOps(ctx, a.ops.map((op) => compact(op)), a.label);
        const lines: string[] = [];
        const aliases = Object.entries(r.aliases);
        if (aliases.length) lines.push(`псевдонимы: ${aliases.map(([k, v]) => `${k} = ${v}`).join(', ')}`);
        const cs = ctx.history().undo.at(-1);
        if (cs && ctx.history().undo.length > before) lines.push(title(ctx, cs), ...formatChangeset(ctx, cs).slice(1));
        else lines.push('ничего не изменилось');
        return lines;
      }),
  );

  server.registerTool(
    'bulk',
    {
      title: 'Массовая правка',
      description: [
        'Записи одного типа по условиям → одна операция над полем: set (задать), mul (умножить), add (прибавить), replace (заменить текст; field "name" — имя записи), refAdd / refRemove (добавить или убрать ссылку: field — список ссылок, например items; value — id или имя цели; values — v0..v2).',
        'По умолчанию только предпросмотр «было → станет», ничего не меняет. apply: true — применить одной правкой (одна отмена);',
        'если подключён редактор — отправляет набор изменений в окно, пользователь принимает или откатывает. Сохранение — отдельно (save).',
      ].join('\n'),
      inputSchema: {
        type: z.union([z.string(), z.number()]).describe('Тип записей: имя (WEAPON) или номер'),
        text: z.string().optional().describe('Подстрока имени (англ. или рус.) или id'),
        fields: z.array(z.string()).optional().describe('Условия: ключ=знач, ключ~подстрока (или ключ:подстрока), ключ!:подстрока — не содержит, ключ?регэксп, != < > <= >=, ключ? — поле есть; для ссылок: список>5, список.v0=4, Ref>0'),
        mod_only: z.boolean().optional().describe('Только записи, которые уже есть в моде'),
        op: z.enum(['set', 'mul', 'add', 'replace', 'refAdd', 'refRemove']),
        field: z.string().describe('Ключ поля (для replace можно name)'),
        value: z.string().describe('set — значение (enum — имя или число); mul/add — число; replace — на что заменить'),
        find: z.string().optional().describe('replace: что искать'),
        values: z.array(z.number()).optional().describe('refAdd: значения ссылки v0, v1, v2'),
        regex: z.boolean().optional().describe('replace: find — регулярное выражение ($1 — группы)'),
        case_sensitive: z.boolean().optional(),
        apply: z.boolean().optional().describe('true — применить; без него только предпросмотр'),
        limit: limit(50),
      },
      annotations: { ...EDIT, title: 'Массовая правка' },
    },
    (a) =>
      run(async () => {
        const ctx = session.ctx();
        const p = previewBulk(
          ctx,
          compact({ type: a.type, text: a.text === '' ? undefined : a.text, fields: a.fields?.map(parseFieldFilter), modOnly: a.mod_only }),
          compact({ kind: a.op, field: a.field, value: a.value, find: a.find, regex: a.regex, caseSensitive: a.case_sensitive, values: a.values }),
        );
        const lines = formatBulkPreview(p, a.limit === 0 ? Infinity : (a.limit ?? 50));
        if (!a.apply) return [...lines, 'предпросмотр: ничего не изменено (apply: true — применить)'];
        if (p.ops.length === 0) return [...lines, 'менять нечего'];
        if (session.editor) {
          const r = await session.propose(p.label, p.ops);
          return [...lines, `в редакторе: набор изменений #${r.changeset.id} «${r.changeset.title}» — ждёт решения пользователя (принять / откатить)`];
        }
        applyBulk(ctx, p);
        const cs = ctx.history().undo.at(-1);
        return [...lines, cs ? `применено: ${title(ctx, cs)}` : 'применено'];
      }),
  );

  server.registerTool(
    'merge',
    {
      title: 'Слияние модов',
      description: [
        'Слияние: что другой мод (source — имя установленного мода или путь к .mod/.base) меняет относительно открытого мода: новые, изменённые (с полями «было → станет») и удалённые записи; конфликты — когда поле меняли и вы, и источник.',
        'По умолчанию только предпросмотр. apply: true — слить выбранное одной правкой (одна отмена), выбор: ids / types / kinds / all. recursive — вместе с записями, на которые ссылаются (целый диалог); fix_refs — добавить и новые записи, на которые ссылаются принятые.',
        'conflicts: mine (по умолчанию, остаются ваши значения) | source; resolutions — по записям и полям (ключ из предпросмотра, например ints:value; для удаления — record).',
        'reject / unreject — отклонить и не показывать при следующих слияниях (show_rejected: показать их). Слияние данных уровня (leveldata, *.zone) не поддержано: levels: true только сообщает о них.',
        'Нельзя слить мод, открытый как зависимость. Мод и файл решений <мод>.kedit-merge.json пишет save (в папку игры — с force). Подключён редактор: только предпросмотр, слить — панелью «Слияние» в окне.',
      ].join('\n'),
      inputSchema: {
        source: z.string().describe('Мод-источник: имя установленного мода или путь к файлу'),
        ids: z.array(z.string()).optional().describe('Какие записи слить (id из предпросмотра)'),
        types: z.array(z.string()).optional().describe('Слить записи этих типов (имя или номер)'),
        kinds: z.array(z.enum(['new', 'changed', 'deleted'])).optional().describe('Слить записи этого вида изменения'),
        all: z.boolean().optional().describe('Слить всё из списка'),
        recursive: z.boolean().optional(),
        fix_refs: z.boolean().optional(),
        conflicts: z.enum(['mine', 'source']).optional(),
        resolutions: z.record(z.string(), z.record(z.string(), z.enum(['mine', 'source']))).optional().describe('id записи → ключ поля → mine | source'),
        reject: z.array(z.string()).optional(),
        unreject: z.array(z.string()).optional(),
        show_rejected: z.boolean().optional(),
        levels: z.boolean().optional().describe('Показать данные уровня источника (они не сливаются)'),
        apply: z.boolean().optional().describe('true — слить; без него только предпросмотр'),
        limit: limit(50),
      },
      annotations: { ...EDIT, title: 'Слияние модов' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const ledger = session.mergeLedger();
        const { source, levelData } = session.mergeSource(a.source, a.levels ?? false);
        const options = { showRejected: a.show_rejected ?? false, ...(levelData ? { levelData } : {}) };
        const lines: string[] = [];
        if (a.reject?.length || a.unreject?.length) {
          if (session.editor) throw new SessionError('Подключены к редактору: решения слияния принимаются в панели «Слияние»');
          const done = a.reject?.length ? rejectMerge(ctx, source, ledger, a.reject, options) : [];
          if (a.unreject?.length) unrejectMerge(ledger, source, a.unreject);
          lines.push(`отклонено ${done.length}, возвращено ${a.unreject?.length ?? 0} (запишутся вместе с модом: save)`);
        }
        const plan = planMerge(ctx, source, ledger, options);
        lines.push(...formatMergePlan(plan, a.limit === 0 ? Infinity : (a.limit ?? 50)));
        if (!a.apply) return [...lines, 'предпросмотр: ничего не изменено (apply: true с ids / types / kinds / all — слить)'];
        if (session.editor) throw new SessionError('Подключены к редактору: слияние применяется в панели «Слияние» окна (здесь доступен предпросмотр)');
        const accept = selectMergeChanges(plan, compact({ ids: a.ids, types: a.types, kinds: a.kinds, all: a.all }));
        if (accept.length === 0) throw new SessionError('Что сливать? Укажите ids, types, kinds или all: true');
        const result = applyMerge(
          ctx,
          source,
          ledger,
          compact({ accept, recursive: a.recursive, fixReferences: a.fix_refs, levelData: a.levels, conflicts: a.conflicts, resolutions: a.resolutions }),
          options,
        );
        const cs = ctx.history().undo.at(-1);
        return [...formatMergeResult(result), cs && result.changesetId !== undefined ? `применено: ${title(ctx, cs)}` : 'менять нечего', 'сохранение — отдельно (save)'];
      }),
  );

  const stepTo = {
    to: z.number().int().min(0).optional().describe('Номер шага #N из history: отменить/повторить всё до него включительно (undo to: 0 — мод как при открытии)'),
  };
  const step = (dir: 'undo' | 'redo', to: number | undefined): Promise<ToolResult> =>
    run(() => {
      if (session.editor) throw new SessionError('Подключены к редактору: отмену делает пользователь в окне (или откатывает набор изменений)');
      const ctx = session.ctx();
      let done: Changeset[];
      if (to === undefined) {
        const cs = dir === 'undo' ? ctx.undo() : ctx.redo();
        done = cs ? [cs] : [];
      } else if (dir === 'undo') {
        const first = ctx.history().undo[0];
        done = to === 0 ? (first ? ctx.undoTo(first.id) : []) : ctx.undoTo(to);
      } else done = ctx.redoTo(to);
      if (!done.length) return [dir === 'undo' ? 'отменять нечего' : 'повторять нечего'];
      return [`${dir === 'undo' ? 'отменено' : 'повторено'}:`, ...done.map((cs) => `  ${title(ctx, cs)}`)];
    });
  server.registerTool(
    'undo',
    {
      title: 'Отменить',
      description: 'Отменить последнюю правку или (to) все правки до шага #N включительно. Ответ — отменённые шаги понятными словами.',
      inputSchema: stepTo,
      annotations: { ...EDIT, title: 'Отменить' },
    },
    (a) => step('undo', a.to),
  );
  server.registerTool(
    'redo',
    {
      title: 'Повторить',
      description: 'Повторить отменённую правку или (to) все отменённые до шага #N включительно.',
      inputSchema: stepTo,
      annotations: { ...EDIT, title: 'Повторить' },
    },
    (a) => step('redo', a.to),
  );

  server.registerTool(
    'history',
    {
      title: 'История правок',
      description:
        'Шаги правок понятными словами, как в окне редактора («Добавлен ответ игрока „…“», «Изменено «damage» у «Катана» → 20»): действующие по порядку до «вы здесь», ниже — отменённые (их вернёт redo). detail — изменения одного шага по номеру.',
      inputSchema: { detail: z.number().int().optional().describe('Номер шага (#N)') },
      annotations: { ...READ, title: 'История правок' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const { undo, redo } = ctx.history();
        if (a.detail !== undefined) {
          const cs = [...undo, ...redo].find((c) => c.id === a.detail);
          if (!cs) throw new SessionError(`Нет правки #${a.detail}`);
          return [title(ctx, cs), ...formatChangeset(ctx, cs).slice(1)];
        }
        const state = ctx.dirty ? 'есть несохранённые изменения' : 'всё сохранено';
        if (!undo.length && !redo.length) return ['правок нет', state];
        const done = ['#0 мод как при открытии', ...undo.map((c) => title(ctx, c))];
        const lines = [...done.slice(0, -1), `${done.at(-1) ?? ''}  ← вы здесь`];
        if (redo.length) lines.push('отменено (redo вернёт):', ...[...redo].reverse().map((c) => `  ${title(ctx, c)}`));
        lines.push(state);
        return lines;
      }),
  );

  server.registerTool(
    'play',
    {
      title: 'Разговор по шагам',
      description:
        'Проигрыватель разговора, как в окне редактора: персонаж + событие → какой диалог игра выберет и почему остальные нет (по правилу из кода игры), что скажет NPC, какие ответы увидит игрок. answers — id ответов игрока по порядку (или @npc — «NPC продолжает сам»), чтобы пройти дальше. mode: met — условия считаются выполненными (по умолчанию), none — проходят только реплики без условий; assume — для отдельных записей: условия выполнены (true) или нет (false).',
      inputSchema: {
        id: z.string().describe('Id или имя персонажа (CHARACTER)'),
        event: z.number().int().min(0).optional().describe('Событие; 1 — игрок заговорил (по умолчанию)'),
        answers: z.array(z.string()).optional().describe('Ответы игрока по порядку: id реплик из прошлого вывода или @npc'),
        mode: z.enum(['met', 'none']).optional(),
        assume: z.record(z.string(), z.boolean()).optional().describe('id диалога или реплики → условия выполнены (true) или нет (false)'),
      },
      annotations: { ...READ, title: 'Разговор по шагам' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id, ['CHARACTER']);
        const res = playConversation(ctx, id, {
          event: a.event ?? 1,
          ...(a.mode ? { mode: a.mode } : {}),
          ...(a.answers ? { answers: a.answers } : {}),
          ...(a.assume ? { assume: new Map(Object.entries(a.assume)) } : {}),
        });
        const tr = session.translation();
        return formatPlay(ctx, res, { ...(tr ? { translation: tr } : {}), ...(a.mode ? { mode: a.mode } : {}) });
      }),
  );

  server.registerTool(
    'save',
    {
      title: 'Сохранить мод',
      description: 'Записать мод (только изменения относительно нижних слоёв). Без path — туда, откуда открыт. В папку игры или мастерской — только с force: true.',
      inputSchema: {
        path: z.string().optional(),
        force: z.boolean().optional().describe('Разрешить запись в папку игры или мастерской'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false, title: 'Сохранить мод' },
    },
    (a) =>
      run(() => {
        const r = session.save(a.path, a.force ?? false);
        const ctx = session.ctx();
        const errors = validateMod(ctx).filter((i) => i.severity === 'error');
        const lines = [`${r.path}: ${statusSummary(ctx)}`];
        if (errors.length) lines.push(`ошибок проверки: ${errors.length} (validate)`);
        if (r.mergeStore) lines.push(`решения слияния: ${r.mergeStore}`);
        if (r.world) lines.push(`файлы уровня: ${r.world.map((f) => `leveldata/${f}`).join(', ')}`);
        return lines;
      }),
  );

  server.registerTool(
    'connect_editor',
    {
      title: 'Подключиться к редактору',
      description:
        'Подключиться к открытому окну Kenshi Mod Editor (локально): дальше find/show/… читают мод из окна, edit отправляет правки в окно набором изменений, который пользователь принимает или откатывает. disconnect: true — отключиться.',
      inputSchema: { disconnect: z.boolean().optional() },
      annotations: { ...READ, title: 'Подключиться к редактору' },
    },
    (a) =>
      guarded(async () => {
        if (a.disconnect) {
          const was = session.editor !== undefined;
          session.disconnectEditor();
          return [was ? 'отключено от редактора; дальше — по ванили (open_mod — открыть мод)' : 'редактор и так не подключён'];
        }
        const st = await session.connectEditor();
        const ctx = session.ctx();
        const lines = [`подключено к редактору: ${st.modName}${st.modPath ? ` — ${st.modPath}` : ' (новый, не сохранён)'}`, statusSummary(ctx)];
        if (st.dependencies.length) lines.push(`зависимости: ${st.dependencies.map((d) => d.name).join(', ')}`);
        if (st.game !== undefined && st.game.toLowerCase() !== session.paths.kenshi.toLowerCase()) lines.push(`внимание: в редакторе игра ${st.game}, у сервера — ${session.paths.kenshi}`);
        if (st.dirty) lines.push('в окне есть несохранённые изменения');
        return lines;
      }),
  );

  server.registerTool(
    'editor_changes',
    {
      title: 'Наборы изменений в редакторе',
      description: 'Наборы изменений, отправленные в редактор (edit при connect_editor), и решение пользователя по каждому: ждёт, принят, откачен, отменён.',
      annotations: { ...READ, title: 'Наборы изменений в редакторе' },
    },
    () =>
      run(async () => {
        const list = await session.editorChangesets();
        if (!list.length) return ['наборов изменений нет'];
        const label: Record<string, string> = { pending: 'ждёт решения', accepted: 'принят', 'rolled-back': 'откачен', undone: 'отменён в окне' };
        return list.map((c) => `#${c.id} «${c.title}» — ${label[c.status] ?? c.status}; записи: ${c.touched.join(', ')}`);
      }),
  );

  server.registerTool(
    'touched',
    {
      title: 'Кто меняет запись',
      description:
        'Какие моды игрока (по порядку mods.cfg; all — все установленные) и открытый мод меняют запись и что именно: поля, ссылки, удаление. Поздний мод побеждает. Только чтение.',
      inputSchema: {
        id: z.string().describe('Строковый id или имя записи'),
        all: z.boolean().optional().describe('Все установленные моды, не только включённые в mods.cfg'),
      },
      annotations: { ...READ, title: 'Кто меняет запись' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        let sid = a.id;
        try {
          sid = resolveId(ctx, a.id);
        } catch (e) {
          if (!(e instanceof SessionError) || !e.message.startsWith('Нет записи')) throw e;
        }
        const { layers, broken } = session.modLayers(a.all ?? false);
        const r = touchedBy(layers, sid);
        const nameOf = (s: string): string => refLabel(ctx, s);
        const lines = [`${sid} ${ctx.name(sid) ?? ''} — модов: ${r.touches.length}${r.base ? '' : ' (записи нет в ванили)'}`, ...formatTouches(r, nameOf)];
        for (const b of broken) lines.push(`не прочитан ${b.name}: ${b.error}`);
        return lines;
      }),
  );

  server.registerTool(
    'conflicts',
    {
      title: 'Конфликты модов',
      description:
        'Записи и поля, которые несколько модов меняют по-разному, значения каждого мода и кто победит (поздний в mods.cfg). mod_only — только конфликты открытого мода. Только чтение.',
      inputSchema: {
        mod_only: z.boolean().optional().describe('Только конфликты открытого мода (его несохранённые правки тоже)'),
        all: z.boolean().optional().describe('Все установленные моды, не только включённые в mods.cfg'),
        offset,
        limit: limit(20),
      },
      annotations: { ...READ, title: 'Конфликты модов' },
    },
    (a) =>
      run(() => {
        const ctx = session.ctx();
        const { layers, broken, opened } = session.modLayers(a.all ?? false);
        if (a.mod_only && opened === undefined) throw new SessionError('Мод не открыт или в нём нет записей: open_mod');
        const found = findConflicts(layers, a.mod_only && opened !== undefined ? { only: opened } : {});
        const nameOf = (s: string): string => refLabel(ctx, s);
        const fields = found.reduce((n, x) => n + x.fields.length, 0);
        const head = [`модов ${layers.filter((l) => !isVanillaLayer(l.name)).length}; записей с конфликтами ${found.length}, полей ${fields}`];
        for (const b of broken) head.push(`не прочитан ${b.name}: ${b.error}`);
        return [...head, ...paged(found, a.offset ?? 0, a.limit ?? 20, (x) => formatConflict(x, nameOf))];
      }),
  );

  server.registerTool(
    'schema',
    {
      title: 'Схема',
      description: 'Без аргументов — типы записей; type — поля типа с описаниями из fcs.def; enum — значения перечисления.',
      inputSchema: { type: z.string().optional(), enum: z.string().optional(), offset, limit: limit(100) },
      annotations: { ...READ, title: 'Схема' },
    },
    (a) =>
      run(() => {
        const schema = session.schema();
        if (a.enum !== undefined) {
          const lines = formatEnum(schema, a.enum);
          if (!lines) throw new SessionError(`Нет перечисления ${a.enum}`);
          return lines;
        }
        if (a.type !== undefined) {
          const t = findTypeSchema(schema, a.type);
          if (!t) throw new SessionError(`Нет типа ${a.type}`);
          return formatTypeSchema(t);
        }
        return paged(listTypes(schema), a.offset ?? 0, a.limit ?? 100, (t) => [typeLine(t)]);
      }),
  );

  // ------------------------------------------------------------------ ресурсы

  const resourceText = (uri: URL, lines: readonly string[]): { contents: { uri: string; mimeType: string; text: string }[] } => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: lines.join('\n') }],
  });
  const one = (v: string | string[] | undefined): string => decodeURIComponent((Array.isArray(v) ? v[0] : v) ?? '');

  server.registerResource(
    'schema-types',
    'kenshi://schema/types',
    { title: 'Типы записей', description: 'Все типы записей: число полей и ссылок', mimeType: 'text/plain' },
    (uri) => resourceText(uri, listTypes(session.schema()).map(typeLine)),
  );

  server.registerResource(
    'schema-type',
    new ResourceTemplate('kenshi://schema/type/{name}', {
      list: () => ({
        resources: listTypes(session.schema()).map((t) => ({ uri: `kenshi://schema/type/${t.name}`, name: t.name, mimeType: 'text/plain' })),
      }),
    }),
    { title: 'Поля типа', description: 'Поля типа записи с видами, значениями по умолчанию и описаниями из fcs.def', mimeType: 'text/plain' },
    (uri, vars) => {
      const name = one(vars['name']);
      const t = findTypeSchema(session.schema(), name);
      if (!t) throw new SessionError(`Нет типа ${name}`);
      return resourceText(uri, formatTypeSchema(t));
    },
  );

  server.registerResource(
    'schema-enum',
    new ResourceTemplate('kenshi://schema/enum/{name}', { list: undefined }),
    { title: 'Перечисление', description: 'Значения перечисления из fcs_enums.def', mimeType: 'text/plain' },
    (uri, vars) => {
      const name = one(vars['name']);
      const lines = formatEnum(session.schema(), name);
      if (!lines) throw new SessionError(`Нет перечисления ${name}`);
      return resourceText(uri, lines);
    },
  );

  registerGameTools(server, opts.game ?? new GameBridge());
  registerWorldTools(server, session, { run, resolveId });

  return server;
}

function typeLine(t: ReturnType<typeof listTypes>[number]): string {
  return `${t.name}  полей ${t.fields}, ссылок ${t.references}${t.inferred ? ' (из данных)' : ''}`;
}
