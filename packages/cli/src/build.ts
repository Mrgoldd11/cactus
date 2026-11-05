/**
 * `kedit build`: собрать мод скриптом или JSON-планом правок и записать (только изменения).
 *
 * Скрипт (.ts/.js) экспортирует по умолчанию функцию `(env: BuildEnv) => ModContext`.
 * План (.json) — `{ mod?, name?, dependencies?, info?, ops: EditOp[] }` или просто массив операций.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyOps, parseStableIds, StableIds, type EditOp, type Layer, type ModContext, type ModInfo } from '@kenshi-editor/core';
import { isInGameFolders, saveModContext, type GamePaths, type LoadedContext } from '@kenshi-editor/core/node';
import { UsageError, type OpenOptions, type Workspace } from './workspace.ts';

export interface BuildEnv {
  paths: GamePaths;
  /** Куда будет записан мод. */
  outPath: string;
  /** Имя файла мода (из `--name` или имени выходного файла). */
  modName: string;
  /** Аргументы после пути к скрипту. */
  args: string[];
  /** Ванильные слои (читаются один раз). */
  vanilla(): Layer[];
  /** Контекст поверх ванили и зависимостей. */
  open(options?: OpenOptions): LoadedContext;
  log(line: string): void;
  /**
   * Постоянный строковый id новой записи по её уникальному имени (`номер-Имя.mod`). Таблица
   * имя → номер — `ids.json` рядом со скриптом; новые имена дописываются туда после удачной
   * сборки, имена, которые больше не собираются, выводятся предупреждением.
   */
  stableId(name: string): string;
  /** Таблица постоянных id (номер `next` — для `lastId` в ModInfo). */
  stableIds(): StableIds;
}

export type BuildScript = (env: BuildEnv) => ModContext | Promise<ModContext>;

export interface BuildPlan {
  /** Мод, с которого начать (путь или имя установленного). */
  mod?: string;
  name?: string;
  dependencies?: string[];
  info?: Partial<Omit<ModInfo, 'fileName'>>;
  ops: EditOp[];
}

export interface BuildRequest {
  source: string;
  out: string;
  name?: string;
  /** Мод, с которого начать (для JSON-плана). */
  mod?: string;
  args: string[];
  /** Разрешить запись в папку игры / мастерской. */
  force: boolean;
}

export interface BuildResult {
  ctx: ModContext;
  outPath: string;
  bytes: number;
}

export async function runBuild(ws: Workspace, req: BuildRequest, log: (line: string) => void): Promise<BuildResult> {
  const source = resolve(ws.cwd, req.source);
  const outPath = resolve(ws.cwd, req.out);
  if (!req.force && isInGameFolders(ws.paths, outPath)) {
    throw new UsageError(`${outPath} — в папке игры или мастерской; запись туда только с --force`);
  }
  const modName = req.name ?? basename(outPath);
  let ctx: ModContext;
  const idsPath = join(dirname(source), 'ids.json');
  let ids: StableIds | undefined;
  if (source.toLowerCase().endsWith('.json')) {
    const raw = JSON.parse(readFileSync(source, 'utf8')) as BuildPlan | EditOp[];
    const plan: BuildPlan = Array.isArray(raw) ? { ops: raw } : raw;
    const base = req.mod ?? (plan.mod !== undefined ? resolve(dirname(source), plan.mod) : undefined);
    ({ ctx } = ws.open({
      ...(base !== undefined ? { mod: base } : {}),
      name: plan.name ?? modName,
      ...(plan.dependencies ? { dependencies: plan.dependencies } : {}),
    }));
    const ops: EditOp[] = plan.info ? [{ op: 'info', ...plan.info }, ...plan.ops] : plan.ops;
    applyOps(ctx, ops, basename(source));
  } else {
    const mod = (await import(pathToFileURL(source).href)) as { default?: unknown };
    if (typeof mod.default !== 'function') throw new UsageError(`${req.source}: нет функции по умолчанию (export default)`);
    const table = (): StableIds =>
      (ids ??= new StableIds(modName, existsSync(idsPath) ? parseStableIds(readFileSync(idsPath, 'utf8')) : undefined));
    const env: BuildEnv = {
      paths: ws.paths,
      outPath,
      modName,
      args: req.args,
      vanilla: () => ws.vanilla(),
      open: (o) => ws.open(o),
      log,
      stableId: (name) => table().id(name),
      stableIds: table,
    };
    ctx = await (mod.default as BuildScript)(env);
  }
  saveModContext(ctx, outPath);
  // Таблица дописывается только после удачной записи мода.
  if (ids) finishStableIds(ids, idsPath, log);
  return { ctx, outPath, bytes: statSync(outPath).size };
}

/** Дописать новые имена в ids.json и предупредить об именах, которые больше не собираются. */
function finishStableIds(ids: StableIds, idsPath: string, log: (line: string) => void): void {
  if (ids.added.length) {
    writeFileSync(idsPath, JSON.stringify(ids.data, null, 1) + '\n');
    log(`ids.json: добавлено ${ids.added.length} id (next=${ids.data.next})`);
  }
  const orphan = ids.orphans();
  if (orphan.length) {
    const sample = orphan.slice(0, 3).map((n) => `«${n}»`).join(', ');
    log(`предупреждение: в ids.json ${orphan.length} имён больше не собираются (номера не переиспользуются): ${sample}${orphan.length > 3 ? '…' : ''}`);
  }
}
