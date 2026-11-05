/**
 * Состояние сервера: пути к игре, ванильные слои (читаются один раз) и открытый мод.
 * Пока мод не открыт, команды работают по ванили (контекст нового пустого мода).
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { GameSchema, Layer, ModContext, PoFile, WorldIndex } from '@kenshi-editor/core';
import {
  gamedataPoPath,
  hasGame,
  loadGamedataPo,
  isInGameFolders,
  loadGameSchema,
  loadModContext,
  loadVanillaLayers,
  loadWorld,
  resolveModPath,
  saveModContext,
  type GamePaths,
} from '@kenshi-editor/core/node';

export class SessionError extends Error {
  override name = 'SessionError';
}

export interface OpenRequest {
  /** Путь к .mod или имя установленного мода; если файла нет — новый мод с этим путём. */
  mod?: string;
  /** Имя файла нового мода (`Мой мод.mod`), если `mod` не задан. */
  name?: string;
  dependencies?: string[];
}

export interface OpenResult {
  ctx: ModContext;
  path?: string;
  missingDependencies: string[];
  dependencyPaths: string[];
}

export class Session {
  readonly paths: GamePaths;
  readonly cwd: string;
  private vanillaCache?: Layer[];
  private schemaCache?: GameSchema;
  private poCache?: PoFile | null;
  private current?: OpenResult;
  private worldCache?: { key: string; world: WorldIndex };

  constructor(paths: GamePaths, cwd: string) {
    this.paths = paths;
    this.cwd = cwd;
  }

  private vanilla(): Layer[] {
    if (!hasGame(this.paths)) throw new SessionError(`Нет игры в ${this.paths.kenshi} (задайте KENSHI_DIR или --game)`);
    return (this.vanillaCache ??= loadVanillaLayers(this.paths));
  }

  schema(): GameSchema {
    if (!hasGame(this.paths)) throw new SessionError(`Нет игры в ${this.paths.kenshi}`);
    return (this.schemaCache ??= loadGameSchema(this.paths));
  }

  po(): PoFile | undefined {
    if (this.poCache === undefined) this.poCache = existsSync(gamedataPoPath(this.paths)) ? loadGamedataPo(this.paths) : null;
    return this.poCache ?? undefined;
  }

  get opened(): OpenResult | undefined {
    return this.current;
  }

  /** Открытый мод; если ничего не открыто — новый пустой мод поверх ванили. */
  ctx(): ModContext {
    return (this.current ??= this.load({})).ctx;
  }

  open(req: OpenRequest): OpenResult {
    return (this.current = this.load(req));
  }

  private load(req: OpenRequest): OpenResult {
    let path: string | undefined;
    if (req.mod !== undefined) path = resolveModPath(this.paths, req.mod, this.cwd) ?? resolve(this.cwd, req.mod);
    const loaded = loadModContext({
      paths: this.paths,
      vanilla: this.vanilla(),
      ...(path !== undefined ? { modPath: path } : {}),
      ...(req.name !== undefined ? { modName: req.name } : {}),
      ...(req.dependencies ? { dependencies: req.dependencies } : {}),
      // Схема и перевод одни на сессию: при повторном открытии не читаются заново.
      schema: this.schema(),
      ...(this.po() ? { po: this.po()! } : { po: false }),
    });
    return { ...loaded, ...(path !== undefined ? { path } : {}) };
  }

  /**
   * Мир (города, здания, экземпляры в зонах) ванили и папок `leveldata` зависимостей и
   * открытого мода. Читается один раз на набор модов (~1–2 с).
   */
  world(): WorldIndex {
    const cur = this.current;
    const modFiles = [...(cur?.dependencyPaths ?? []), ...(cur?.path !== undefined ? [cur.path] : [])];
    const key = modFiles.join('\n');
    if (this.worldCache?.key !== key) this.worldCache = { key, world: loadWorld(this.paths, { modFiles }).world };
    return this.worldCache.world;
  }

  /** Записать мод. Без пути — туда, откуда открыт. В папку игры — только с `force`. */
  save(path: string | undefined, force: boolean): { path: string; records: number } {
    const cur = this.current;
    if (!cur) throw new SessionError('Мод не открыт: сначала open_mod');
    const target = path !== undefined ? resolve(this.cwd, path) : cur.path;
    if (target === undefined) throw new SessionError('Мод новый: укажите path');
    if (!force && isInGameFolders(this.paths, target)) {
      throw new SessionError(`${target} — в папке игры или мастерской; запись туда только с force: true`);
    }
    const file = saveModContext(cur.ctx, target);
    cur.path ??= target;
    return { path: target, records: file.records.length };
  }
}
