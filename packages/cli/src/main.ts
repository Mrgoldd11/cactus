/**
 * kedit — Kenshi data from the command line. Replaces tools/kdata.py (find/show/tree/mod)
 * and adds refs, diff, validate, schema, build.
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
  formatWhere,
  formatTalk,
  simulateTalk,
  whereInGame,
  formatTypeSchema,
  formatExtensionDetail,
  summarizeExtensions,
  typeOriginNote,
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
  findConflicts,
  formatConflict,
  formatTouches,
  touchedBy,
  errorMessage,
  mapUi,
  uiText,
  type ModContext,
  type Page,
  type UiText,
  type RecordDiff,
  type RecordStatus,
} from '@kenshi-editor/core';
import { loadModLayers, loadTranslation, loadWorld, readDataFileSync, readModsCfg } from '@kenshi-editor/core/node';
import { basename } from 'node:path';
import { runBuild } from './build.ts';
import { runBulk } from './bulk.ts';
import { runCleanup, runValidateFix } from './fix.ts';
import { runMerge, splitList } from './merge.ts';
import { modsChange, modsCopy, modsList } from './mods.ts';
import { runStrings } from './strings.ts';
import { resolveCliLang, usageFrom, UsageError, Workspace } from './workspace.ts';

/** No record by that id or name (the `touched` command then looks for it as is). */
class NoRecordError extends UsageError {}

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

/** Help in English (the default output language). */
export const HELP = `kedit — Kenshi data: search, view, check and build mods

Commands:
  find [text] [TYPE]      records by name (English or translated) or id; TYPE — name or number
      --type TYPE  --field key=value (~ or : substring, !: not, ?regex, != < > <= >=, key? — field is set; may repeat)
      --status new,changed,deleted,base  --anywhere text  --exact  --mod-only
      --query "Q"  the record list search syntax: words and conditions split by ;
                   keywords type= state= ref= (ref>N — referenced by N records), list.key=… — through references
                   e.g. --query "bandit; type=CHARACTER; vendors.value>500"
  show <id|name>...       fields and references (with target names)  --layers  --max-refs N
  tree <id|name>          dialogue tree (dialogs/lines)  --full  --depth N  --max-nodes N
  mod <file.mod> [text]   records of a mod file with status; text — substring anywhere  --brief
  refs <id|name>          references from the record and to it  --from  --to
  where <id|name>         where the record is in the game: back-reference chain to towns/buildings with coordinates
      --tree  the whole back-reference tree;  --limit N — facts (default 20)
  talk <character>        which dialogues a character has for an event, from where, which one the game picks, how the talk starts
      --event N  event (default 1 — player click);  --mods  with the player's mods from mods.cfg
  diff                    what the mod (--mod) changes over the lower layers; total «new N, changed M»
      --status added,changed,removed  only records with these changes
  diff <a.mod> <b.mod>    difference of two files
  validate                broken references, fields outside the schema, wrong kind; exit code 1 on errors
      --fix  preview of fixes (--kind remove-ref|revert|remove-record|new-id, --code CODE,…); --apply — write into --out or --mod (one edit)
  cleanup                 what can be removed from the mod (--mod): obsolete fields, no-op changes, orphans, invalid references…
      --group obsolete-field,no-op,deleted-base,orphaned,invalid-refs,undefined-type;  preview by default, --apply — write (one edit)
  schema [TYPE]           record types / fields of a type with descriptions from fcs.def  --enum NAME
      --mod M  with the schema extensions of the mod and its dependencies (FCS Extended files), marked [extension NAME]
  bulk <TYPE> [text]      bulk edit of records of a type (text — substring of name or id), conditions --field, --mod-only
      --set|--mul|--add FIELD=VALUE  or  --replace FIELD --find TEXT --with TEXT [--regex] [--case] (FIELD name — record name)
      preview «was → will be» by default; --apply — write into --out or --mod (one edit)
  merge <source>          merge: what the source mod (name or path) changes over --mod; new / changed / deleted, conflicts
      preview by default; --apply + choice --only id,id | --type TYPE,… | --kind new,changed,deleted | --all — merge in one edit
      --recursive  with the records they reference;  --fix-refs  also add new records the accepted ones reference
      --conflicts source|mine  which side wins conflicts (default mine — your values);  --levels  level data (detected, not merged)
      --reject id,id  reject and do not show again;  --unreject id,id  restore;  --show-rejected  show rejected ones
      writes into --out or --mod, with the decisions file <mod>.kedit-merge.json next to it; never into the workshop, into the game folder with --force
  build <script.ts|plan.json> --out <file.mod> [--name Name.mod] [--mod source] [-- arguments]
  mods [list]             installed mods: mods.cfg order, where from (mods/workshop)  --full  --json
  mods move <mod>         move in mods.cfg:  --top (first) | --bottom (wins) | --after X | --before X
  mods enable|disable <mod>  enable (at the end or --top/--after X…) / disable
      without --force only shows what changes; --force — write mods.cfg (copy next to it, game closed)
  mods copy <mod|path>    someone else's mod → copy for editing in mods/<name>/<name>.mod (+ where the copy came from)  --name Name  --force
      the workshop original is not changed; without --force only shows what will happen
  touched <id|name>       which mods from mods.cfg change the record and what exactly  --all  all installed
  conflicts               mods that change one field differently, and who wins (the later one in mods.cfg)
      --mod <path|name.mod>  only conflicts of this mod;  --all  all installed, not only mods.cfg
  strings <original.mod>  mod texts for translation: original, translation, status; total «translated N of M»
      --mod <translation.mod>  statuses in this translation mod (+ check: extra texts, non-text edits)
      --todo  untranslated only;  --out texts.csv|.json|.po — export (PO — for Poedit)
      --import <file> --out <translation.mod> [--name Name.mod]  build a translation mod from a file (CSV/JSON/PO)

Common:
  --game <Kenshi folder>  otherwise KENSHI_DIR, kenshi-paths.json or the found Steam/GOG install
  --data-locale <code>    language of translated names (de_DE, ru_RU…; none — no translation); otherwise KENSHI_DATA_LOCALE or the game language (settings.cfg)
  --lang <en|ru|zh>       language of the output; otherwise KEDIT_LANG, otherwise English
  --mod <path|name.mod>   mod over vanilla (and its dependencies)
  --deps a.mod,b.mod      dependencies instead of those written in the mod ("" — none)
  --json  --offset N  --limit N (default 50, 0 — all)
`;

/** Help in Russian. */
export const HELP_RU = `kedit — данные Kenshi: поиск, просмотр, проверка и сборка модов

Команды:
  find [текст] [ТИП]      записи по имени (англ. или рус.) или id; ТИП — имя или номер
      --type ТИП  --field ключ=знач (~ или : подстрока, !: нет, ?регвыр, != < > <= >=, ключ? — поле есть; можно несколько)
      --status new,changed,deleted,base  --anywhere текст  --exact  --mod-only
      --query "З"  синтаксис поиска списка записей: слова и условия через ;
                   ключевые слова type= state= ref= (ref>N — на запись ссылаются N записей), список.ключ=… — через ссылки
                   напр. --query "bandit; type=CHARACTER; vendors.value>500"
  show <id|имя>...        поля и ссылки (с именами целей)  --layers  --max-refs N
  tree <id|имя>           дерево диалога (dialogs/lines)  --full  --depth N  --max-nodes N
  mod <файл.mod> [текст]  записи файла мода со статусом; текст — подстрока где угодно  --brief
  refs <id|имя>           ссылки из записи и на неё  --from  --to
  where <id|имя>          где запись в игре: цепочка обратных ссылок до городов/зданий с координатами
      --tree  дерево обратных ссылок целиком;  --limit N — фактов (по умолчанию 20)
  talk <персонаж>         какие диалоги у персонажа на событие, откуда, какой выберет игра, начало разговора
      --event N  событие (по умолчанию 1 — клик игрока);  --mods  с модами игрока из mods.cfg
  diff                    что мод (--mod) меняет относительно нижних слоёв; итог «новых N, изменённых M»
      --status added,changed,removed  только записи с такими изменениями
  diff <a.mod> <b.mod>    разница двух файлов
  validate                битые ссылки, поля вне схемы, не тот вид; код выхода 1 при ошибках
      --fix  предпросмотр исправлений (--kind remove-ref|revert|remove-record|new-id, --code КОД,…); --apply — записать в --out или в --mod (одна правка)
  cleanup                 что можно убрать из мода (--mod): устаревшие поля, пустые изменения, сироты, неверные ссылки…
      --group obsolete-field,no-op,deleted-base,orphaned,invalid-refs,undefined-type;  по умолчанию предпросмотр, --apply — записать (одна правка)
  schema [ТИП]            типы записей / поля типа с описаниями из fcs.def  --enum ИМЯ
      --mod M  with the schema extensions of the mod and its dependencies (FCS Extended files), marked [extension NAME]
  bulk <ТИП> [текст]      массовая правка записей типа (текст — подстрока имени или id), условия --field, --mod-only
      --set|--mul|--add ПОЛЕ=ЗНАЧ  или  --replace ПОЛЕ --find ТЕКСТ --with ТЕКСТ [--regex] [--case] (ПОЛЕ name — имя записи)
      по умолчанию только предпросмотр «было → станет»; --apply — записать в --out или в --mod (одна правка)
  merge <источник>        слияние: что мод-источник (имя или путь) меняет относительно --mod; новые / изменённые / удалённые, конфликты
      по умолчанию только предпросмотр; --apply + выбор --only id,id | --type ТИП,… | --kind new,changed,deleted | --all — слить одной правкой
      --recursive  вместе с записями, на которые ссылаются;  --fix-refs  добавить и новые записи, на которые ссылаются принятые
      --conflicts source|mine  кого брать в конфликтах (по умолчанию mine — ваши значения);  --levels  данные уровня (определяются, не сливаются)
      --reject id,id  отклонить и не показывать снова;  --unreject id,id  вернуть;  --show-rejected  показать отклонённые
      пишет в --out или в --mod, рядом файл решений <мод>.kedit-merge.json; в мастерскую не пишет, в папку игры — с --force
  build <скрипт.ts|план.json> --out <файл.mod> [--name Имя.mod] [--mod исходный] [-- аргументы]
  mods [list]             установленные моды: порядок mods.cfg, откуда (mods/мастерская)  --full  --json
  mods move <мод>         переставить в mods.cfg:  --top (раньше всех) | --bottom (побеждает) | --after X | --before X
  mods enable|disable <мод>  включить (в конец или --top/--after X…) / выключить
      без --force только показывает, что изменится; --force — записать mods.cfg (копия рядом, игра закрыта)
  mods copy <мод|путь>    чужой мод → копия для правки в mods/<имя>/<имя>.mod (+ откуда копия)  --name Имя  --force
      оригинал из мастерской не меняется; без --force только показывает, что будет
  touched <id|имя>        какие моды из mods.cfg меняют запись и что именно  --all  все установленные
  conflicts               моды, которые меняют одно поле по-разному, и кто победит (поздний в mods.cfg)
      --mod <путь|имя.mod>  только конфликты этого мода;  --all  все установленные, не только mods.cfg
  strings <оригинал.mod>  тексты мода для перевода: оригинал, перевод, статус; итог «переведено N из M»
      --mod <перевод.mod>  статусы в этом моде-переводе (+ проверка: лишние тексты, правки не текстов)
      --todo  только непереведённое;  --out тексты.csv|.json|.po — выгрузить (PO — для Poedit)
      --import <файл> --out <перевод.mod> [--name Имя.mod]  собрать мод-перевод из файла (CSV/JSON/PO)

Общие:
  --game <папка Kenshi>   иначе KENSHI_DIR, kenshi-paths.json или найденная установка Steam/GOG
  --data-locale <код>     язык перевода имён (de_DE, ru_RU…; none — без перевода); иначе KENSHI_DATA_LOCALE или язык игры (settings.cfg)
  --lang <en|ru|zh>       язык вывода; иначе KEDIT_LANG, иначе английский
  --mod <путь|имя.mod>    мод поверх ванили (и его зависимостей)
  --deps a.mod,b.mod      зависимости вместо записанных в моде ("" — без зависимостей)
  --json  --offset N  --limit N (по умолчанию 50, 0 — все)
`;

/** Help text in the output language (English when there is none for it). */
export function helpText(lang: string): string {
  return lang === 'ru' ? HELP_RU : HELP;
}

const OPTIONS = {
  game: { type: 'string' },
  'data-locale': { type: 'string' },
  lang: { type: 'string' },
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
  tree: { type: 'boolean' },
  depth: { type: 'string' },
  'max-nodes': { type: 'string' },
  brief: { type: 'boolean' },
  from: { type: 'boolean' },
  to: { type: 'boolean' },
  enum: { type: 'string' },
  event: { type: 'string' },
  mods: { type: 'boolean' },
  out: { type: 'string' },
  name: { type: 'string' },
  force: { type: 'boolean' },
  all: { type: 'boolean' },
  top: { type: 'boolean' },
  bottom: { type: 'boolean' },
  after: { type: 'string' },
  before: { type: 'string' },
  import: { type: 'string' },
  todo: { type: 'boolean' },
  set: { type: 'string' },
  mul: { type: 'string' },
  add: { type: 'string' },
  replace: { type: 'string' },
  find: { type: 'string' },
  query: { type: 'string', short: 'q' },
  with: { type: 'string' },
  regex: { type: 'boolean' },
  case: { type: 'boolean' },
  apply: { type: 'boolean' },
  only: { type: 'string' },
  kind: { type: 'string' },
  recursive: { type: 'boolean' },
  'fix-refs': { type: 'boolean' },
  conflicts: { type: 'string' },
  reject: { type: 'string' },
  unreject: { type: 'string' },
  'show-rejected': { type: 'boolean' },
  levels: { type: 'boolean' },
  fix: { type: 'boolean' },
  code: { type: 'string' },
  group: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parse>['values'];

function parse(argv: string[]): ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>> {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

function writeTarget(v: Values): { apply: boolean; force: boolean; mod?: string; out?: string } {
  return { apply: v.apply ?? false, force: v.force ?? false, ...(v.mod !== undefined ? { mod: v.mod } : {}), ...(v.out !== undefined ? { out: v.out } : {}) };
}

function int(v: string | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError({ en: `--${name}: an integer ≥ 0 is needed, not “${v}”`, ru: `--${name}: нужно целое ≥ 0, а не «${v}»` });
  return n;
}

const STATUSES: readonly RecordStatus[] = ['base', 'new', 'changed', 'deleted'];

class Command {
  readonly ws: Workspace;
  readonly io: Io;
  readonly values: Values;
  readonly args: string[];
  /** Output language. */
  readonly lang: string;
  private ctxCache?: ModContext;
  /** .mod files overlaid on vanilla (dependencies, then the mod) — for the `leveldata` folders. */
  modFiles: string[] = [];

  constructor(io: Io, values: Values, args: string[], lang: string) {
    this.io = io;
    this.values = values;
    this.args = args;
    this.lang = lang;
    this.ws = new Workspace({ cwd: io.cwd, env: io.env, lang, ...(values.game !== undefined ? { game: values.game } : {}), ...(values['data-locale'] !== undefined ? { dataLocale: values['data-locale'] } : {}) });
  }

  get deps(): string[] | undefined {
    if (this.values.mods) {
      // Player mods in mods.cfg order (except --mod itself).
      const own = this.values.mod !== undefined ? basename(this.values.mod).toLowerCase() : undefined;
      return readModsCfg(this.ws.paths).filter((n) => n.toLowerCase() !== own);
    }
    const d = this.values.deps;
    if (d === undefined) return undefined;
    return d
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Context: vanilla → dependencies → the mod from --mod (if given). */
  ctx(): ModContext {
    if (this.ctxCache) return this.ctxCache;
    const deps = this.deps;
    const mod = this.values.mod !== undefined ? this.ws.modPath(this.values.mod) : undefined;
    const { ctx, missingDependencies, dependencyPaths } = this.ws.open({
      ...(mod !== undefined ? { mod } : {}),
      ...(deps ? { dependencies: deps } : {}),
    });
    this.modFiles = [...dependencyPaths, ...(mod !== undefined ? [mod] : [])];
    if (missingDependencies.length) this.io.err(this.t({ en: `missing dependencies: ${missingDependencies.join(', ')}`, ru: `нет зависимостей: ${missingDependencies.join(', ')}` }));
    return (this.ctxCache = ctx);
  }

  /** A text in the output language. */
  t(text: UiText): string {
    return uiText(text, this.lang);
  }

  arg(i: number, what: string): string {
    const v = this.args[i];
    if (v === undefined) throw new UsageError({ en: `Argument needed: ${what}`, ru: `Нужен аргумент: ${what}` });
    return v;
  }

  record(ctx: ModContext, sid: string): ReturnType<ModContext['get']> & object {
    const rec = ctx.get(sid) ?? ctx.lower(sid);
    if (!rec) throw new UsageError({ en: `No record ${sid}`, ru: `Нет записи ${sid}` });
    return rec;
  }

  /** String id by id or name; with several matches — a list and an error. */
  resolve(ctx: ModContext, spec: string, preferTypes?: readonly string[]): string {
    const found = lookupRecord(ctx, spec, preferTypes ? { preferTypes } : {});
    if (found.stringId !== undefined) return found.stringId;
    if (found.candidates.length === 0) throw new NoRecordError({ en: `No record “${spec}” (neither id nor name)`, ru: `Нет записи «${spec}» (ни id, ни имени)` });
    const shown = found.candidates.slice(0, 20);
    for (const h of shown) this.io.err(`  ${formatHit(h)}`);
    const more = found.candidates.length - shown.length;
    if (more > 0) this.io.err(this.t({ en: `  … ${more} more`, ru: `  … ещё ${more}` }));
    throw new UsageError({ en: `“${spec}”: ${found.candidates.length} records match — pass an id from the list`, ru: `«${spec}»: подходит записей ${found.candidates.length} — укажите id из списка` });
  }

  /** A page of lines (or objects with --json). */
  paged<T>(items: readonly T[], text: (item: T) => string[], json: (item: T) => unknown = (x) => x): void {
    const limit = int(this.values.limit, 'limit', 50);
    const p: Page<T> = page(items, int(this.values.offset, 'offset', 0), limit === 0 ? Infinity : limit);
    if (this.values.json) {
      this.io.out(JSON.stringify({ ...p, items: p.items.map(json) }, null, 1));
      return;
    }
    for (const it of p.items) for (const l of text(it)) this.io.out(l);
    if (p.total > p.items.length || p.total === 0) this.io.out(pageFooter(p, this.lang));
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
      ...(v.query !== undefined ? { query: v.query } : {}),
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
      const lines = formatRecord(ctx, rec, { showLayers: c.values.layers ?? false, lang: c.lang, ...(max !== undefined ? { maxRefsPerCategory: max } : {}) });
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
    else for (const l of formatDialogueTree(ctx, tree, { full: c.values.full ?? false, lang: c.lang })) c.io.out(l);
    return 0;
  },

  mod(c) {
    const path = c.ws.modPath(c.arg(0, c.t({ en: '<file.mod>', ru: '<файл.mod>' })));
    const q = c.args[1]?.toLowerCase();
    // With the game — statuses and reference target names; without it — just the file contents.
    const ctx = c.ws.hasGame ? c.ws.open({ mod: path, ...(c.deps ? { dependencies: c.deps } : {}) }).ctx : c.ws.openStandalone(path);
    // Like kdata.py: a substring in anything of the file record (not the final one).
    const recs = ctx.modRecords().filter((r) => q === undefined || recordHaystack(ctx, r).includes(q));
    c.paged(
      recs,
      (r) => (c.values.brief ? [recordHeadline(ctx, r)] : formatRecord(ctx, r, { lang: c.lang })),
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
          ? `→ ${r.category}: ${refLabel(ctx, r.target, c.lang)}${r.values ? `  ${formatRefValues({ target: r.target, v0: r.values[0]!, v1: r.values[1]!, v2: r.values[2]! }, c.lang)}` : ''}`
          : `← ${refLabel(ctx, r.source, c.lang)} ${r.category}${r.values ? `  ${r.values.join(' ')}` : ''}`,
      ],
      (r) => ({ ...r, name: ctx.name(r.dir === 'from' ? r.target : r.source) }),
    );
    return 0;
  },


  where(c) {
    const ctx = c.ctx();
    const sid = c.resolve(ctx, c.arg(0, '<id>'));
    const { world, errors } = loadWorld(c.ws.paths, { modFiles: c.modFiles });
    for (const e of errors) c.io.err(c.t({ en: `level not read: ${e.path}: ${e.message}`, ru: `уровень не прочитан: ${e.path}: ${e.message}` }));
    const res = whereInGame(ctx, sid, { world });
    if (c.values.json) {
      c.io.out(JSON.stringify(res, null, 1));
      return 0;
    }
    const limit = int(c.values.limit, 'limit', 20);
    c.io.out(formatWhere(res, { tree: c.values.tree ?? false, maxFacts: limit === 0 ? Infinity : limit, lang: c.lang }));
    return 0;
  },
  talk(c) {
    const ctx = c.ctx();
    const sid = c.resolve(ctx, c.arg(0, c.t({ en: '<character>', ru: '<персонаж>' })), ['CHARACTER']);
    const translation = c.ws.dataLocale !== undefined ? loadTranslation(c.ws.paths, c.ws.dataLocale) : undefined;
    const sim = simulateTalk(ctx, sid, int(c.values.event, 'event', 1), { lang: c.lang, ...(translation ? { translation } : {}) });
    if (c.values.json) c.io.out(JSON.stringify(sim, null, 1));
    else for (const l of formatTalk(sim, c.lang)) c.io.out(l);
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
      if (c.values.mod === undefined) throw new UsageError({ en: 'diff: pass --mod or two files', ru: 'diff: укажите --mod или два файла' });
      ctx = c.ctx();
      diffs = ctx.modRecords().flatMap((r) => modRecordDiff(ctx, r.stringId) ?? []);
    }
    let changes;
    try {
      changes = c.values.status !== undefined ? parseDiffStatuses(c.values.status) : undefined;
    } catch (e) {
      throw new UsageError(mapUi([usageFrom(e).texts], ([m]) => `--status: ${m}`));
    }
    const shown = filterDiffs(diffs, changes);
    if (c.values.json) {
      c.paged(shown, () => [], (d) => ({ stringId: d.stringId, change: d.change, name: ctx.name(d.stringId), changes: d.fields.map((f) => formatFieldChange(ctx, f, d.after ?? d.before, c.lang)) }));
      return 0;
    }
    c.paged(shown, (d) => formatRecordDiff(ctx, d, c.lang));
    c.io.out(`${formatDiffSummary(diffs, c.lang)}${changes ? c.t({ en: `; shown: ${changes.join(', ')}`, ru: `; показаны: ${changes.join(', ')}` }) : ''}`);
    return 0;
  },

  validate(c) {
    if (c.values.mod === undefined && c.args[0] !== undefined) c.values.mod = c.args[0];
    if (c.values.mod === undefined) throw new UsageError({ en: 'validate: pass --mod', ru: 'validate: укажите --mod' });
    const ctx = c.ctx();
    if (c.values.fix) return runValidateFix(c.ws, ctx, { ...writeTarget(c.values), ...(c.values.kind !== undefined ? { kind: c.values.kind } : {}), ...(c.values.code !== undefined ? { codes: c.values.code } : {}) }, int(c.values.limit, 'limit', 200), (l) => { c.io.out(l); });
    const issues = validateMod(ctx);
    const errors = issues.filter((i) => i.severity === 'error').length;
    if (issues.length || c.values.json) c.paged(issues, (i) => [formatIssue(ctx, i, c.lang)]);
    if (!c.values.json) c.io.out(c.t({ en: `errors ${errors}, warnings ${issues.length - errors}`, ru: `ошибок ${errors}, предупреждений ${issues.length - errors}` }));
    return errors > 0 ? 1 : 0;
  },

  cleanup(c) {
    if (c.values.mod === undefined && c.args[0] !== undefined) c.values.mod = c.args[0];
    if (c.values.mod === undefined) throw new UsageError({ en: 'cleanup: pass --mod', ru: 'cleanup: укажите --mod' });
    return runCleanup(c.ws, c.ctx(), { ...writeTarget(c.values), ...(c.values.group !== undefined ? { groups: c.values.group } : {}) }, int(c.values.limit, 'limit', 200), (l) => { c.io.out(l); });
  },

  schema(c) {
    // With --mod the schema carries the schema extensions of the mod and of its dependencies.
    const deps = c.deps;
    const { ctx } =
      c.values.mod !== undefined
        ? c.ws.open({ mod: c.ws.modPath(c.values.mod), po: false, schema: true, ...(deps ? { dependencies: deps } : {}) })
        : c.ws.open({ dependencies: [], po: false, schema: true });
    const schema = ctx.schema;
    if (!schema) throw new UsageError({ en: 'No fcs.def in the game folder', ru: 'Нет fcs.def в папке игры' });
    if (c.values.enum !== undefined) {
      const lines = formatEnum(schema, c.values.enum, c.lang);
      if (!lines) throw new UsageError({ en: `No enum ${c.values.enum}`, ru: `Нет перечисления ${c.values.enum}` });
      if (c.values.json) c.io.out(JSON.stringify(schema.enums.get(c.values.enum) ?? null, null, 1));
      else for (const l of lines) c.io.out(l);
      return 0;
    }
    if (c.args[0] === undefined) {
      if (!c.values.json) for (const s of summarizeExtensions(schema)) for (const l of formatExtensionDetail(s)) c.io.out(l);
      c.paged(listTypes(schema), (t) => [c.t({ en: `${t.name}  fields ${t.fields}, references ${t.references}${t.inferred ? ' (from data)' : ''}`, ru: `${t.name}  полей ${t.fields}, ссылок ${t.references}${t.inferred ? ' (из данных)' : ''}` }) + typeOriginNote(t)]);
      return 0;
    }
    const t = findTypeSchema(schema, c.args[0]);
    if (!t) throw new UsageError({ en: `No type ${c.args[0]}`, ru: `Нет типа ${c.args[0]}` });
    if (c.values.json) c.io.out(JSON.stringify({ ...t, fields: [...t.fields.values()] }, null, 1));
    else for (const l of formatTypeSchema(t, c.lang)) c.io.out(l);
    return 0;
  },

  touched(c) {
    const spec = c.arg(0, c.t({ en: '<id|name>', ru: '<id|имя>' }));
    const vanilla = c.ws.open({ po: true });
    const nameOf = (sid: string): string => vanilla.ctx.name(sid) ?? sid;
    let sid = spec;
    try {
      sid = c.resolve(vanilla.ctx, spec);
    } catch (e) {
      // The record is not in vanilla — mods may create it: search as is.
      if (!(e instanceof NoRecordError)) throw e;
    }
    const { layers, broken } = loadModLayers(c.ws.paths, c.ws.vanilla(), { all: c.values.all ?? false });
    for (const b of broken) c.io.err(c.t({ en: `not read ${b.name}: ${b.error}`, ru: `не прочитан ${b.name}: ${b.error}` }));
    const r = touchedBy(layers, sid);
    if (c.values.json) {
      c.io.out(JSON.stringify({ sid, name: nameOf(sid), inVanilla: r.base !== undefined, touches: r.touches }, null, 1));
      return 0;
    }
    const vname = vanilla.ctx.name(sid);
    c.io.out(c.t({ en: `${sid} ${vname ?? '(not in vanilla)'} — mods: ${r.touches.length}`, ru: `${sid} ${vname ?? '(нет в ванили)'} — модов: ${r.touches.length}` }));
    for (const l of formatTouches(r, nameOf, c.lang)) c.io.out(l);
    return 0;
  },

  conflicts(c) {
    const extra = c.values.mod !== undefined ? c.ws.modPath(c.values.mod) : undefined;
    const vanilla = c.ws.open({ po: true });
    const nameOf = (sid: string): string => vanilla.ctx.name(sid) ?? sid;
    const { layers, broken } = loadModLayers(c.ws.paths, c.ws.vanilla(), { all: c.values.all ?? false, ...(extra !== undefined ? { extra: { name: basename(extra), path: extra } } : {}) });
    for (const b of broken) c.io.err(c.t({ en: `not read ${b.name}: ${b.error}`, ru: `не прочитан ${b.name}: ${b.error}` }));
    const found = findConflicts(layers, extra !== undefined ? { only: basename(extra) } : {});
    if (!c.values.json) {
      const fields = found.reduce((n, x) => n + x.fields.length, 0);
      const nMods = layers.length - vanilla.ctx.layers.length;
      c.io.out(c.t({ en: `mods ${nMods}; records with conflicts ${found.length}, fields ${fields}`, ru: `модов ${nMods}; записей с конфликтами ${found.length}, полей ${fields}` }));
    }
    c.paged(found, (x) => formatConflict(x, nameOf, c.lang));
    return 0;
  },

  mods(c) {
    const sub = c.args[0] ?? 'list';
    if (sub === 'list') return modsList(c.ws, c.io, { json: c.values.json ?? false, full: c.values.full ?? false });
    if (sub === 'move' || sub === 'enable' || sub === 'disable') {
      const v = c.values;
      return modsChange(c.ws, c.io, sub, c.args[1], {
        ...(v.top !== undefined ? { top: v.top } : {}),
        ...(v.bottom !== undefined ? { bottom: v.bottom } : {}),
        ...(v.after !== undefined ? { after: v.after } : {}),
        ...(v.before !== undefined ? { before: v.before } : {}),
        force: v.force ?? false,
      });
    }
    if (sub === 'copy') {
      return modsCopy(c.ws, c.io, c.args[1], { ...(c.values.name !== undefined ? { name: c.values.name } : {}), force: c.values.force ?? false });
    }
    throw new UsageError(`mods ${sub}? (list, move, enable, disable, copy)`);
  },

  strings(c) {
    const v = c.values;
    return runStrings(c.ws, c.io, c.arg(0, c.t({ en: '<original.mod>', ru: '<оригинал.mod>' })), {
      ...(v.mod !== undefined ? { mod: v.mod } : {}),
      ...(c.deps ? { deps: c.deps } : {}),
      ...(v.out !== undefined ? { out: v.out } : {}),
      ...(v.import !== undefined ? { import: v.import } : {}),
      ...(v.name !== undefined ? { name: v.name } : {}),
      todo: v.todo ?? false,
      force: v.force ?? false,
      json: v.json ?? false,
    });
  },

  bulk(c) {
    const v = c.values;
    const type = v.type ?? c.arg(0, c.t({ en: '<TYPE>', ru: '<ТИП>' }));
    const text = v.type !== undefined ? c.args[0] : c.args[1];
    const limit = int(v.limit, 'limit', 50);
    return runBulk(
      c.ws,
      c.ctx(),
      {
        type,
        ...(text !== undefined && text !== '' ? { text } : {}),
        fields: (v.field ?? []).map(parseFieldFilter),
        modOnly: v['mod-only'] ?? false,
        ...(v.set !== undefined ? { set: v.set } : {}),
        ...(v.mul !== undefined ? { mul: v.mul } : {}),
        ...(v.add !== undefined ? { add: v.add } : {}),
        ...(v.replace !== undefined ? { replace: v.replace } : {}),
        ...(v.find !== undefined ? { find: v.find } : {}),
        ...(v.with !== undefined ? { with: v.with } : {}),
        regex: v.regex ?? false,
        caseSensitive: v.case ?? false,
        apply: v.apply ?? false,
        ...(v.mod !== undefined ? { mod: v.mod } : {}),
        ...(v.out !== undefined ? { out: v.out } : {}),
        force: v.force ?? false,
      },
      limit === 0 ? Infinity : limit,
      (l) => {
        c.io.out(l);
      },
    );
  },

  merge(c) {
    const v = c.values;
    if (v.mod === undefined) throw new UsageError({ en: 'merge: --mod <your mod> is needed (it is merged into)', ru: 'merge: нужен --mod <ваш мод> (в него сливаем)' });
    const limit = int(v.limit, 'limit', 50);
    return runMerge(
      c.ws,
      c.ctx(),
      {
        source: c.arg(0, c.t({ en: '<source>', ru: '<источник>' })),
        mod: v.mod,
        only: splitList(v.only),
        types: splitList(v.type),
        kinds: splitList(v.kind),
        all: v.all ?? false,
        recursive: v.recursive ?? false,
        fixRefs: v['fix-refs'] ?? false,
        ...(v.conflicts !== undefined ? { conflicts: v.conflicts } : {}),
        reject: splitList(v.reject),
        unreject: splitList(v.unreject),
        showRejected: v['show-rejected'] ?? false,
        levels: v.levels ?? false,
        apply: v.apply ?? false,
        ...(v.out !== undefined ? { out: v.out } : {}),
        force: v.force ?? false,
        json: v.json ?? false,
      },
      limit === 0 ? Infinity : limit,
      (l) => {
        c.io.out(l);
      },
    );
  },

  async build(c) {
    const out = c.values.out;
    if (out === undefined) throw new UsageError({ en: 'build: --out <file.mod> is needed', ru: 'build: нужен --out <файл.mod>' });
    const r = await runBuild(
      c.ws,
      {
        source: c.arg(0, c.t({ en: '<script.ts|plan.json>', ru: '<скрипт.ts|план.json>' })),
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
    const byType = [...counts].map(([k, n]) => `${k} ${n}`).join(', ');
    const nRecs = r.ctx.modRecords().length;
    c.io.out(c.t({ en: `${r.outPath}: ${r.bytes} bytes, records ${nRecs} (${byType})`, ru: `${r.outPath}: ${r.bytes} байт, записей ${nRecs} (${byType})` }));
    for (const i of errors.slice(0, 20)) c.io.out(formatIssue(r.ctx, i, c.lang));
    if (errors.length) c.io.out(c.t({ en: `validation errors: ${errors.length}`, ru: `ошибок проверки: ${errors.length}` }));
    return 0;
  },
};

/** `--lang X` / `--lang=X` from the raw arguments (before the full parse, so help and argument errors use it too). */
function langArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--lang') return argv[i + 1];
    if (a.startsWith('--lang=')) return a.slice('--lang='.length);
  }
  return undefined;
}

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  let lang = 'en';
  try {
    lang = resolveCliLang(langArg(argv), io.env);
    const [cmd, ...rest] = argv;
    if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      io.out(helpText(lang));
      return 0;
    }
    const handler = COMMANDS[cmd];
    if (!handler) throw new UsageError({ en: `Unknown command «${cmd}». kedit help — list of commands`, ru: `Неизвестная команда «${cmd}». kedit help — список команд` });
    const { values, positionals } = parse(rest);
    if (values.help) {
      io.out(helpText(lang));
      return 0;
    }
    return await handler(new Command(io, values, positionals, lang));
  } catch (e) {
    if (e instanceof UsageError || (e instanceof Error && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS'))) {
      io.err(`kedit: ${errorMessage(e, lang)}`);
      return 2;
    }
    io.err(`kedit: ${errorMessage(e, lang)}`);
    return 1;
  }
}
