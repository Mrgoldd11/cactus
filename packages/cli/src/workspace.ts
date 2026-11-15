/**
 * Что нужно всем командам: пути к игре, ванильные слои (читаются один раз), контекст мода.
 */
import { basename } from 'node:path';
import { ModContext, type Layer } from '@kenshi-editor/core';
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

export class UsageError extends Error {
  override name = 'UsageError';
}

export interface WorkspaceOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Папка игры вместо найденной по KENSHI_DIR / kenshi-paths.json. */
  game?: string;
  /** Data language (locale code or `none`) instead of KENSHI_DATA_LOCALE / the game's settings.cfg. */
  dataLocale?: string;
}

export interface OpenOptions {
  /** Путь к .mod или имя установленного мода. */
  mod?: string;
  /** Имя нового мода, если `mod` не задан или файла ещё нет. */
  name?: string;
  /** Зависимости вместо записанных в заголовке мода. */
  dependencies?: string[];
  schema?: boolean;
  po?: boolean;
  /** Мод должен существовать. */
  mustExist?: boolean;
}

export class Workspace {
  readonly paths: GamePaths;
  readonly cwd: string;
  /** Locale of translated names and texts; undefined — originals only. */
  readonly dataLocale: string | undefined;
  private vanillaCache?: Layer[];

  constructor(options: WorkspaceOptions) {
    this.cwd = options.cwd;
    const found = resolveGamePaths(options.cwd, options.env);
    this.paths = options.game ? { kenshi: options.game, workshop: defaultWorkshopDir(options.game) } : found;
    this.dataLocale = resolveDataLocale(this.paths, options.dataLocale ?? options.env['KENSHI_DATA_LOCALE']);
  }

  get hasGame(): boolean {
    return hasGame(this.paths);
  }

  requireGame(): void {
    if (!this.hasGame) throw new UsageError(`Нет игры в ${this.paths.kenshi}: укажите --game <папка Kenshi> или KENSHI_DIR`);
  }

  vanilla(): Layer[] {
    this.requireGame();
    return (this.vanillaCache ??= loadVanillaLayers(this.paths));
  }

  /** Путь к моду: файл или установленный мод по имени. */
  modPath(spec: string, mustExist = true): string {
    const p = resolveModPath(this.paths, spec, this.cwd);
    if (p) return p;
    if (mustExist) throw new UsageError(`Мод не найден: ${spec}`);
    return spec;
  }

  /** Контекст: ваниль → зависимости → мод. */
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

  /** Файл мода без игры: все записи — новые, имена целей ссылок неизвестны. */
  openStandalone(path: string): ModContext {
    return new ModContext({ layers: [], mod: readDataFileSync(path), modName: basename(path) });
  }
}
