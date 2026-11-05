/**
 * kedit — данные Kenshi из командной строки. Заменяет tools/kdata.py (find/show/tree/mod)
 * и добавляет refs, diff, validate, schema, build.
 */
import { parseArgs } from 'node:util';
import {
  buildDialogueTree,
  diffDataFiles,
  findTypeSchema,
  formatEnum,
  formatFieldChange,
  formatHit,
  formatIssue,
  formatRecord,
  formatRecordDiff,
  formatDialogueTree,
  formatTypeSchema,
  listTypes,
  modRecordDiff,
  page,
  pageFooter,
  parseFieldFilter,
  recordHeadline,
  recordHaystack,
  recordToJson,
  refLabel,
  formatRefValues,
  searchRecords,
  lookupRecord,
  filterDiffs,
  formatDiffSummary,
  parseDiffStatuses,
  validateMod,
  type ModContext,
  type Page,
  type RecordDiff,
  type RecordStatus,
} from '@kenshi-editor/core';
import { readDataFileSync } from '@kenshi-editor/core/node';
import { runBuild } from './build.ts';
import { UsageError, Workspace } from './workspace.ts';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export const processIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  cwd: process.cwd(),
  env: process.env,
};

export const HELP = `kedit — данные Kenshi: поиск, просмотр, проверка и сборка модов

Команды:
  find [текст] [ТИП]      записи по имени (англ. или рус.) или id; ТИП — имя или номер
      --type ТИП  --field ключ=знач (~ подстрока, != < > <= >=, ключ? — поле есть; можно несколько)
      --status new,changed,deleted,base  --anywhere текст  --exact  --mod-only
  show <id|имя>...        поля и ссылки (с именами целей)  --layers  --max-refs N
  tree <id|имя>           дерево диалога (dialogs/lines)  --full  --depth N  --max-nodes N
  mod <файл.mod> [текст]  записи файла мода со статусом; текст — подстрока где угодно  --brief
  refs <id|имя>           ссылки из записи и на неё  --from  --to
  diff                    что мод (--mod) меняет относительно нижних слоёв; итог «новых N, изменённых M»
      --status added,changed,removed  только записи с такими изменениями
  diff <a.mod> <b.mod>    разница двух файлов
  validate                битые ссылки, поля вне схемы, не тот вид; код выхода 1 при ошибках
  schema [ТИП]            типы записей / поля типа с описаниями из fcs.def  --enum ИМЯ
  build <скрипт.ts|план.json> --out <файл.mod> [--name Имя.mod] [--mod исходный] [-- аргументы]

Общие:
  --game <папка Kenshi>   иначе KENSHI_DIR, kenshi-paths.json или D:/SteamLibrary/...
  --mod <путь|имя.mod>    мод поверх ванили (и его зависимостей)
  --deps a.mod,b.mod      зависимости вместо записанных в моде ("" — без зависимостей)
  --json  --offset N  --limit N (по умолчанию 50, 0 — все)
`;

const OPTIONS = {
  game: { type: 'string' },
  mod: { type: 'string' },
  deps: { type: 'string' },
  json: { type: 'boolean' },
  offset: { type: 'string' },
  limit: { type: 'string' },
  type: { type: 'string' },
  field: { type: 'string', multiple: true },
  status: { type: 'string' },
  anywhere: { type: 'string' },
  exact: { type: 'boolean' },
  'mod-only': { type: 'boolean' },
  layers: { type: 'boolean' },
  'max-refs': { type: 'string' },
  full: { type: 'boolean' },
  depth: { type: 'string' },
  'max-nodes': { type: 'string' },
  brief: { type: 'boolean' },
  from: { type: 'boolean' },
  to: { type: 'boolean' },
  enum: { type: 'string' },
  out: { type: 'string' },
  name: { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parse>['values'];

function parse(argv: string[]): ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>> {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

function int(v: string | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name}: нужно целое ≥ 0, а не «${v}»`);
  return n;
}

const STATUSES: readonly RecordStatus[] = ['base', 'new', 'changed', 'deleted'];

class Command {
  readonly ws: Workspace;
  readonly io: Io;
  readonly values: Values;
  readonly args: string[];
  private ctxCache?: ModContext;

  constructor(io: Io, values: Values, args: string[]) {
    this.io = io;
    this.values = values;
    this.args = args;
    this.ws = new Workspace({ cwd: io.cwd, env: io.env, ...(values.game !== undefined ? { game: values.game } : {}) });
  }

  get deps(): string[] | undefined {
    const d = this.values.deps;
    if (d === undefined) return undefined;
    return d
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Контекст: ваниль → зависимости → мод из --mod (если задан). */
  ctx(): ModContext {
    if (this.ctxCache) return this.ctxCache;
    const deps = this.deps;
    const { ctx, missingDependencies } = this.ws.open({
      ...(this.values.mod !== undefined ? { mod: this.values.mod } : {}),
      ...(deps ? { dependencies: deps } : {}),
    });
    if (missingDependencies.length) this.io.err(`нет зависимостей: ${missingDependencies.join(', ')}`);
    return (this.ctxCache = ctx);
  }

  arg(i: number, what: string): string {
    const v = this.args[i];
    if (v === undefined) throw new UsageError(`Нужен аргумент: ${what}`);
    return v;
  }

  record(ctx: ModContext, sid: string): ReturnType<ModContext['get']> & object {
    const rec = ctx.get(sid) ?? ctx.lower(sid);
    if (!rec) throw new UsageError(`Нет записи ${sid}`);
    return rec;
  }

  /** Строковый id по id или имени; при нескольких совпадениях — список и ошибка. */
  resolve(ctx: ModContext, spec: string, preferTypes?: readonly string[]): string {
    const found = lookupRecord(ctx, spec, preferTypes ? { preferTypes } : {});
    if (found.stringId !== undefined) return found.stringId;
    if (found.candidates.length === 0) throw new UsageError(`Нет записи «${spec}» (ни id, ни имени)`);
    const shown = found.candidates.slice(0, 20);
    for (const h of shown) this.io.err(`  ${formatHit(h)}`);
    if (found.candidates.length > shown.length) this.io.err(`  … ещё ${found.candidates.length - shown.length}`);
    throw new UsageError(`«${spec}»: подходит записей ${found.candidates.length} — укажите id из списка`);
  }

  /** Страница строк (или объектов в --json). */
  paged<T>(items: readonly T[], text: (item: T) => string[], json: (item: T) => unknown = (x) => x): void {
    const limit = int(this.values.limit, 'limit', 50);
    const p: Page<T> = page(items, int(this.values.offset, 'offset', 0), limit === 0 ? Infinity : limit);
    if (this.values.json) {
      this.io.out(JSON.stringify({ ...p, items: p.items.map(json) }, null, 1));
      return;
    }
    for (const it of p.items) for (const l of text(it)) this.io.out(l);
    if (p.total > p.items.length || p.total === 0) this.io.out(pageFooter(p));
  }
}

type Handler = (c: Command) => number | Promise<number>;

const COMMANDS: Record<string, Handler> = {
  find(c) {
    const v = c.values;
    const ctx = c.ctx();
    const status = v.status?.split(',').map((s) => s.trim()) ?? undefined;
    for (const s of status ?? []) if (!STATUSES.includes(s as RecordStatus)) throw new UsageError(`--status: ${s}? (${STATUSES.join(', ')})`);
    const type = v.type ?? c.args[1];
    const hits = searchRecords(ctx, {
      ...(c.args[0] !== undefined && c.args[0] !== '' ? { text: c.args[0] } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(v.exact ? { exact: true } : {}),
      ...(v.field ? { fields: v.field.map(parseFieldFilter) } : {}),
      ...(status ? { status: status as RecordStatus[] } : {}),
      ...(v.anywhere !== undefined ? { anywhere: v.anywhere } : {}),
      ...(v['mod-only'] ? { modOnly: true } : {}),
    });
    c.paged(hits, (h) => [formatHit(h)]);
    return 0;
  },

  show(c) {
    const ctx = c.ctx();
    const ids = c.args.length ? c.args : [c.arg(0, '<id>')];
    const max = c.values['max-refs'] !== undefined ? int(c.values['max-refs'], 'max-refs', 0) : undefined;
    const recs = ids.map((spec) => c.record(ctx, c.resolve(ctx, spec)));
    if (c.values.json) {
      c.io.out(JSON.stringify(recs.length === 1 ? recordToJson(ctx, recs[0]!, max !== undefined ? { maxRefsPerCategory: max } : {}) : recs.map((r) => recordToJson(ctx, r)), null, 1));
      return 0;
    }
    for (const rec of recs) {
      const lines = formatRecord(ctx, rec, { showLayers: c.values.layers ?? false, ...(max !== undefined ? { maxRefsPerCategory: max } : {}) });
      for (const l of lines) c.io.out(l);
    }
    return 0;
  },

  tree(c) {
    const ctx = c.ctx();
    const sid = c.resolve(ctx, c.arg(0, '<id>'), ['DIALOGUE_PACKAGE', 'DIALOGUE', 'DIALOGUE_LINE', 'WORD_SWAPS']);
    const tree = buildDialogueTree(ctx, sid, {
      ...(c.values.depth !== undefined ? { maxDepth: int(c.values.depth, 'depth', 0) } : {}),
      ...(c.values['max-nodes'] !== undefined ? { maxNodes: int(c.values['max-nodes'], 'max-nodes', 0) } : {}),
    });
    if (c.values.json) c.io.out(JSON.stringify(tree, null, 1));
    else for (const l of formatDialogueTree(ctx, tree, { full: c.values.full ?? false })) c.io.out(l);
    return 0;
  },

  mod(c) {
    const path = c.ws.modPath(c.arg(0, '<файл.mod>'));
    const q = c.args[1]?.toLowerCase();
    // С игрой — статусы и имена целей ссылок; без неё — просто содержимое файла.
    const ctx = c.ws.hasGame ? c.ws.open({ mod: path, ...(c.deps ? { dependencies: c.deps } : {}) }).ctx : c.ws.openStandalone(path);
    // Как kdata.py: подстрока в чём угодно из записи файла (не итоговой).
    const recs = ctx.modRecords().filter((r) => q === undefined || recordHaystack(ctx, r).includes(q));
    c.paged(
      recs,
      (r) => (c.values.brief ? [recordHeadline(ctx, r)] : formatRecord(ctx, r)),
      (r) => recordToJson(ctx, r),
    );
    return 0;
  },

  refs(c) {
    const ctx = c.ctx();
    const sid = c.resolve(ctx, c.arg(0, '<id>'));
    const both = !c.values.from && !c.values.to;
    type Row = { dir: 'from' | 'to'; source: string; category: string; target: string; values?: number[] };
    const rows: Row[] = [];
    const add = (dir: Row['dir'], e: ReturnType<ModContext['referencesFrom']>[number]): void => {
      rows.push({ dir, source: e.source, category: e.category, target: e.target, ...(e.ref ? { values: [e.ref.v0, e.ref.v1, e.ref.v2] } : {}) });
    };
    if (both || c.values.from) for (const e of ctx.referencesFrom(sid)) add('from', e);
    if (both || c.values.to) for (const e of ctx.referencesTo(sid)) add('to', e);
    c.paged(
      rows,
      (r) => [
        r.dir === 'from'
          ? `→ ${r.category}: ${refLabel(ctx, r.target)}${r.values ? `  ${formatRefValues({ target: r.target, v0: r.values[0]!, v1: r.values[1]!, v2: r.values[2]! })}` : ''}`
          : `← ${refLabel(ctx, r.source)} ${r.category}${r.values ? `  ${r.values.join(' ')}` : ''}`,
      ],
      (r) => ({ ...r, name: ctx.name(r.dir === 'from' ? r.target : r.source) }),
    );
    return 0;
  },

  diff(c) {
    let ctx: ModContext;
    let diffs: RecordDiff[];
    if (c.args.length >= 2) {
      const a = readDataFileSync(c.ws.modPath(c.args[0]!));
      const b = readDataFileSync(c.ws.modPath(c.args[1]!));
      diffs = diffDataFiles(a, b);
      ctx = c.ws.hasGame ? c.ws.open({ dependencies: [], schema: false }).ctx : c.ws.openStandalone(c.ws.modPath(c.args[1]!));
    } else {
      if (c.values.mod === undefined && c.args[0] !== undefined) c.values.mod = c.args[0];
      if (c.values.mod === undefined) throw new UsageError('diff: укажите --mod или два файла');
      ctx = c.ctx();
      diffs = ctx.modRecords().flatMap((r) => modRecordDiff(ctx, r.stringId) ?? []);
    }
    let changes;
    try {
      changes = c.values.status !== undefined ? parseDiffStatuses(c.values.status) : undefined;
    } catch (e) {
      throw new UsageError(`--status: ${(e as Error).message}`);
    }
    const shown = filterDiffs(diffs, changes);
    if (c.values.json) {
      c.paged(shown, () => [], (d) => ({ stringId: d.stringId, change: d.change, name: ctx.name(d.stringId), changes: d.fields.map((f) => formatFieldChange(ctx, f, d.after ?? d.before)) }));
      return 0;
    }
    c.paged(shown, (d) => formatRecordDiff(ctx, d));
    c.io.out(`${formatDiffSummary(diffs)}${changes ? `; показаны: ${changes.join(', ')}` : ''}`);
    return 0;
  },

  validate(c) {
    if (c.values.mod === undefined && c.args[0] !== undefined) c.values.mod = c.args[0];
    if (c.values.mod === undefined) throw new UsageError('validate: укажите --mod');
    const ctx = c.ctx();
    const issues = validateMod(ctx);
    const errors = issues.filter((i) => i.severity === 'error').length;
    if (issues.length || c.values.json) c.paged(issues, (i) => [formatIssue(ctx, i)]);
    if (!c.values.json) c.io.out(`ошибок ${errors}, предупреждений ${issues.length - errors}`);
    return errors > 0 ? 1 : 0;
  },

  schema(c) {
    const { ctx } = c.ws.open({ dependencies: [], po: false, schema: true });
    const schema = ctx.schema;
    if (!schema) throw new UsageError('Нет fcs.def в папке игры');
    if (c.values.enum !== undefined) {
      const lines = formatEnum(schema, c.values.enum);
      if (!lines) throw new UsageError(`Нет перечисления ${c.values.enum}`);
      if (c.values.json) c.io.out(JSON.stringify(schema.enums.get(c.values.enum) ?? null, null, 1));
      else for (const l of lines) c.io.out(l);
      return 0;
    }
    if (c.args[0] === undefined) {
      c.paged(listTypes(schema), (t) => [`${t.name}  полей ${t.fields}, ссылок ${t.references}${t.inferred ? ' (из данных)' : ''}`]);
      return 0;
    }
    const t = findTypeSchema(schema, c.args[0]);
    if (!t) throw new UsageError(`Нет типа ${c.args[0]}`);
    if (c.values.json) c.io.out(JSON.stringify({ ...t, fields: [...t.fields.values()] }, null, 1));
    else for (const l of formatTypeSchema(t)) c.io.out(l);
    return 0;
  },

  async build(c) {
    const out = c.values.out;
    if (out === undefined) throw new UsageError('build: нужен --out <файл.mod>');
    const r = await runBuild(
      c.ws,
      {
        source: c.arg(0, '<скрипт.ts|план.json>'),
        out,
        args: c.args.slice(1),
        force: c.values.force ?? false,
        ...(c.values.name !== undefined ? { name: c.values.name } : {}),
        ...(c.values.mod !== undefined ? { mod: c.values.mod } : {}),
      },
      (l) => {
        c.io.err(l);
      },
    );
    const counts = new Map<string, number>();
    for (const rec of r.ctx.modRecords()) {
      const s = r.ctx.status(rec.stringId) ?? '?';
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const issues = validateMod(r.ctx);
    const errors = issues.filter((i) => i.severity === 'error');
    c.io.out(`${r.outPath}: ${r.bytes} байт, записей ${r.ctx.modRecords().length} (${[...counts].map(([k, n]) => `${k} ${n}`).join(', ')})`);
    for (const i of errors.slice(0, 20)) c.io.out(formatIssue(r.ctx, i));
    if (errors.length) c.io.out(`ошибок проверки: ${errors.length}`);
    return 0;
  },
};

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      io.out(HELP);
      return 0;
    }
    const handler = COMMANDS[cmd];
    if (!handler) throw new UsageError(`Неизвестная команда «${cmd}». kedit help — список команд`);
    const { values, positionals } = parse(rest);
    if (values.help) {
      io.out(HELP);
      return 0;
    }
    return await handler(new Command(io, values, positionals));
  } catch (e) {
    if (e instanceof UsageError || (e instanceof Error && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS'))) {
      io.err(`kedit: ${e.message}`);
      return 2;
    }
    io.err(`kedit: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
