/**
 * What all commands need: game paths, vanilla layers (read once), the mod context.
 */
import { basename } from 'node:path';
import { ModContext, UiTextError, uiText, type Layer, type UiText } from '@kenshi-editor/core';
import {
  defaultWorkshopDir,
  hasGame,
  loadModContext,
  loadVanillaLayers,
  readDataFileSync,
  resolveGamePaths,
  resolveDataLocale,
  resolveModPath,
  type GamePaths,
  type LoadedContext,
} from '@kenshi-editor/core/node';

export class UsageError extends UiTextError {
  override name = 'UsageError';
}

/** A usage error from any error, keeping its texts in every language. */
export function usageFrom(e: unknown): UsageError {
  return new UsageError(e instanceof UiTextError ? e.texts : e instanceof Error ? e.message : String(e));
}

/** Interface languages of the CLI output; the first one is the default. */
export const CLI_LANGS = ['en', 'ru', 'zh'] as const;

/** CLI language: `--lang`, otherwise KEDIT_LANG, otherwise English. */
export function resolveCliLang(option: string | undefined, env: NodeJS.ProcessEnv): string {
  const v = (option ?? env['KEDIT_LANG'] ?? 'en').trim().toLowerCase();
  if (!(CLI_LANGS as readonly string[]).includes(v)) throw new UsageError({ en: `--lang: ${CLI_LANGS.join(', ')}, not “${v}”`, ru: `--lang: ${CLI_LANGS.join(', ')}, а не «${v}»` });
  return v;
}

export interface WorkspaceOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Game folder instead of the one found via KENSHI_DIR / kenshi-paths.json. */
  game?: string;
  /** Data language (locale code or `none`) instead of KENSHI_DATA_LOCALE / the game's settings.cfg. */
  dataLocale?: string;
  /** Interface language of the output (default English). */
  lang?: string;
}

export interface OpenOptions {
  /** Path to a .mod or an installed mod name. */
  mod?: string;
  /** Name of a new mod if `mod` is not given or the file does not exist yet. */
  name?: string;
  /** Dependencies instead of those written in the mod header. */
  dependencies?: string[];
  schema?: boolean;
  po?: boolean;
  /** The mod must exist. */
  mustExist?: boolean;
}

export class Workspace {
  readonly paths: GamePaths;
  readonly cwd: string;
  /** Locale of translated names and texts; undefined — originals only. */
  readonly dataLocale: string | undefined;
  /** Interface language of the output. */
  readonly lang: string;
  private vanillaCache?: Layer[];

  constructor(options: WorkspaceOptions) {
    this.cwd = options.cwd;
    this.lang = options.lang ?? 'en';
    const found = resolveGamePaths(options.cwd, options.env);
    this.paths = options.game ? { kenshi: options.game, workshop: defaultWorkshopDir(options.game) } : found;
    this.dataLocale = resolveDataLocale(this.paths, options.dataLocale ?? options.env['KENSHI_DATA_LOCALE']);
  }

  /** A text in the output language (English when it has no entry for it). */
  t(text: UiText): string {
    return uiText(text, this.lang);
  }

  get hasGame(): boolean {
    return hasGame(this.paths);
  }

  requireGame(): void {
    if (!this.hasGame) throw new UsageError({ en: `No game in ${this.paths.kenshi}: pass --game <Kenshi folder> or KENSHI_DIR`, ru: `Нет игры в ${this.paths.kenshi}: укажите --game <папка Kenshi> или KENSHI_DIR` });
  }

  vanilla(): Layer[] {
    this.requireGame();
    return (this.vanillaCache ??= loadVanillaLayers(this.paths));
  }

  /** Mod path: a file or an installed mod by name. */
  modPath(spec: string, mustExist = true): string {
    const p = resolveModPath(this.paths, spec, this.cwd);
    if (p) return p;
    if (mustExist) throw new UsageError({ en: `Mod not found: ${spec}`, ru: `Мод не найден: ${spec}` });
    return spec;
  }

  /** Context: vanilla → dependencies → mod. */
  open(options: OpenOptions = {}): LoadedContext {
    const modPath = options.mod !== undefined ? this.modPath(options.mod, options.mustExist ?? true) : undefined;
    return loadModContext({
      paths: this.paths,
      vanilla: this.vanilla(),
      ...(modPath !== undefined ? { modPath } : {}),
      ...(options.name !== undefined ? { modName: options.name } : {}),
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.po !== undefined ? { po: options.po } : {}),
      dataLocale: this.dataLocale ?? 'none',
    });
  }

  /** A mod file without the game: all records are new, reference target names are unknown. */
  openStandalone(path: string): ModContext {
    return new ModContext({ layers: [], mod: readDataFileSync(path), modName: basename(path) });
  }
}
