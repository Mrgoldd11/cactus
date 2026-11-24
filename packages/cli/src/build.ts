/**
 * `kedit build`: build a mod with a script or a JSON edit plan and write it (changes only).
 *
 * A script (.ts/.js) default-exports a function `(env: BuildEnv) => ModContext`.
 * A plan (.json) is `{ mod?, name?, dependencies?, info?, ops: EditOp[] }` or just an array of operations.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyOps, parseStableIds, StableIds, type EditOp, type Layer, type ModContext, type ModInfo, type UiText } from '@kenshi-editor/core';
import { isInGameFolders, isInWorkshop, saveModContext, type GamePaths, type LoadedContext } from '@kenshi-editor/core/node';
import { UsageError, type OpenOptions, type Workspace } from './workspace.ts';

export interface BuildEnv {
  paths: GamePaths;
  /** Where the mod will be written. */
  outPath: string;
  /** Mod file name (from `--name` or the output file name). */
  modName: string;
  /** Arguments after the script path. */
  args: string[];
  /** Vanilla layers (read once). */
  vanilla(): Layer[];
  /** Context on top of vanilla and dependencies. */
  open(options?: OpenOptions): LoadedContext;
  log(line: string): void;
  /**
   * Stable string id of a new record by its unique name (`number-Name.mod`). The name → number
   * table is `ids.json` next to the script; new names are appended to it after a successful
   * build, names no longer built are reported as a warning.
   */
  stableId(name: string): string;
  /** Stable id table (number `next` — for `lastId` in ModInfo). */
  stableIds(): StableIds;
}

export type BuildScript = (env: BuildEnv) => ModContext | Promise<ModContext>;

export interface BuildPlan {
  /** Mod to start from (path or installed mod name). */
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
  /** Mod to start from (for a JSON plan). */
  mod?: string;
  args: string[];
  /** Allow writing into the game / Workshop folder. */
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
  if (isInWorkshop(ws.paths, outPath)) {
    throw new UsageError({ en: `${outPath} is in the Steam workshop; the editor never writes there. Make a copy: kedit mods copy <mod>`, ru: `${outPath} — в мастерской Steam; туда не пишем никогда. Сделайте копию: kedit mods copy <мод>` });
  }
  if (!req.force && isInGameFolders(ws.paths, outPath)) {
    throw new UsageError({ en: `${outPath} is in the game or workshop folder; writing there needs --force`, ru: `${outPath} — в папке игры или мастерской; запись туда только с --force` });
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
    if (typeof mod.default !== 'function') throw new UsageError({ en: `${req.source}: no default function (export default)`, ru: `${req.source}: нет функции по умолчанию (export default)` });
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
  // The table is appended only after the mod was written successfully.
  if (ids) finishStableIds(ids, idsPath, (t) => { log(ws.t(t)); });
  return { ctx, outPath, bytes: statSync(outPath).size };
}

/** Append new names to ids.json and warn about names that are no longer built. */
function finishStableIds(ids: StableIds, idsPath: string, log: (text: UiText) => void): void {
  if (ids.added.length) {
    writeFileSync(idsPath, JSON.stringify(ids.data, null, 1) + '\n');
    log({ en: `ids.json: added ${ids.added.length} id (next=${ids.data.next})`, ru: `ids.json: добавлено ${ids.added.length} id (next=${ids.data.next})` });
  }
  const orphan = ids.orphans();
  if (orphan.length) {
    const sample = orphan.slice(0, 3).map((n) => `«${n}»`).join(', ') + (orphan.length > 3 ? '…' : '');
    log({
      en: `warning: ${orphan.length} names in ids.json are no longer built (numbers are not reused): ${sample}`,
      ru: `предупреждение: в ids.json ${orphan.length} имён больше не собираются (номера не переиспользуются): ${sample}`,
    });
  }
}
