/**
 * MCP-сервер: поиск, просмотр, проверка, правка и сохранение мода через ядро редактора.
 * Ответы — компактный текст: ссылки с именами целей, длинные списки страницами.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  applyOps,
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
} from '@kenshi-editor/core';
import { SessionError, type Session } from './session.ts';

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
]);

/** Убрать ключи со значением undefined (exactOptionalPropertyTypes). */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function createServer(session: Session): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: '0.1.0' },
    {
      instructions: [
        'Данные Kenshi: ваниль (gamedata.base → Newwworld.mod → Dialogue.mod → rebirth.mod), зависимости мода, сам мод.',
        'Сначала open_mod (или работайте по ванили без него). Записи — по строковому id или имени (show, tree, refs, diff); find ищет по англ. и рус. имени.',
        'Правки (edit) — пачкой операций, одна отмена на пачку; save пишет только изменения. В папку игры save пишет только с force: true.',
        'Схема типов и полей с описаниями из fcs.def — инструмент schema и ресурсы kenshi://schema/…',
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
      guarded(() => {
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
        fields: z.array(z.string()).optional().describe('Условия: ключ=знач, ключ~подстрока, != < > <= >=, ключ? — поле есть'),
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
      guarded(() => {
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
      guarded(() => {
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
      guarded(() => {
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
      guarded(() => {
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
      guarded(() => {
        const ctx = session.ctx();
        const id = resolveId(ctx, a.id);
        const res = whereInGame(ctx, id, { world: session.world() });
        const max = a.limit ?? 20;
        return formatWhere(res, { tree: a.tree ?? false, maxFacts: max === 0 ? Infinity : max }).split('\n');
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
      guarded(() => {
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
      guarded(() => {
        const ctx = session.ctx();
        const issues = validateMod(ctx);
        const errors = issues.filter((i) => i.severity === 'error').length;
        const lines = issues.length ? paged(issues, a.offset ?? 0, a.limit ?? 50, (i) => [formatIssue(ctx, i)]) : [];
        lines.push(`ошибок ${errors}, предупреждений ${issues.length - errors}`);
        return lines;
      }),
  );

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
      ].join('\n'),
      inputSchema: {
        ops: z.array(editOp).min(1),
        label: z.string().optional().describe('Подпись правки в истории'),
      },
      annotations: { ...EDIT, title: 'Править мод' },
    },
    (a) =>
      guarded(() => {
        const ctx = session.ctx();
        const before = ctx.history().undo.length;
        const r = applyOps(ctx, a.ops.map((op) => compact(op)), a.label);
        const lines: string[] = [];
        const aliases = Object.entries(r.aliases);
        if (aliases.length) lines.push(`псевдонимы: ${aliases.map(([k, v]) => `${k} = ${v}`).join(', ')}`);
        const cs = ctx.history().undo.at(-1);
        if (cs && ctx.history().undo.length > before) lines.push(...formatChangeset(ctx, cs));
        else lines.push('ничего не изменилось');
        return lines;
      }),
  );

  const step = (dir: 'undo' | 'redo'): Promise<ToolResult> =>
    guarded(() => {
      const ctx = session.ctx();
      const cs = dir === 'undo' ? ctx.undo() : ctx.redo();
      if (!cs) return [dir === 'undo' ? 'отменять нечего' : 'повторять нечего'];
      return [`${dir === 'undo' ? 'отменено' : 'повторено'}: #${cs.id} ${cs.label}`];
    });
  server.registerTool('undo', { title: 'Отменить', description: 'Отменить последнюю правку.', annotations: { ...EDIT, title: 'Отменить' } }, () => step('undo'));
  server.registerTool('redo', { title: 'Повторить', description: 'Повторить отменённую правку.', annotations: { ...EDIT, title: 'Повторить' } }, () => step('redo'));

  server.registerTool(
    'history',
    {
      title: 'История правок',
      description: 'Правки сессии (последние сверху) и отменённые; detail — изменения одной правки по номеру.',
      inputSchema: { detail: z.number().int().optional().describe('Номер правки (#N)') },
      annotations: { ...READ, title: 'История правок' },
    },
    (a) =>
      guarded(() => {
        const ctx = session.ctx();
        const { undo, redo } = ctx.history();
        if (a.detail !== undefined) {
          const cs = [...undo, ...redo].find((c) => c.id === a.detail);
          if (!cs) throw new SessionError(`Нет правки #${a.detail}`);
          return formatChangeset(ctx, cs);
        }
        const lines = [...undo].reverse().map((c) => `#${c.id} ${c.label}`);
        if (redo.length) lines.push(`отменено: ${[...redo].reverse().map((c) => `#${c.id} ${c.label}`).join(', ')}`);
        if (!lines.length) lines.push('правок нет');
        lines.push(ctx.dirty ? 'есть несохранённые изменения' : 'всё сохранено');
        return lines;
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
      guarded(() => {
        const r = session.save(a.path, a.force ?? false);
        const ctx = session.ctx();
        const errors = validateMod(ctx).filter((i) => i.severity === 'error');
        const lines = [`${r.path}: ${statusSummary(ctx)}`];
        if (errors.length) lines.push(`ошибок проверки: ${errors.length} (validate)`);
        return lines;
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
      guarded(() => {
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

  return server;
}

function typeLine(t: ReturnType<typeof listTypes>[number]): string {
  return `${t.name}  полей ${t.fields}, ссылок ${t.references}${t.inferred ? ' (из данных)' : ''}`;
}
