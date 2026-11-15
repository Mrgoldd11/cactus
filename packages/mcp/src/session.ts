/**
 * Состояние сервера: пути к игре, ванильные слои (читаются один раз) и открытый мод.
 * Пока мод не открыт, команды работают по ванили (контекст нового пустого мода).
 */
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { LiveClient } from './live-client.ts';
import { readFileSync, statSync } from 'node:fs';
import { base64ToBytes, type DataFile, MergeLedger, type MergeSource, type LevelDataInfo, ModContext, readDataFile, type GameSchema, type Layer, type LiveSnapshot, type LiveState, type PoFile, type ProposeResult, type TranslationIndex, type AiChangeset, type EditOp, WorldEdits, WorldIndex, writeDataFile } from '@kenshi-editor/core';
import {
  detectLevelData,
  extensionsFor,
  type FoundExtension,
  gamedataPoPath,
  loadMergeLedger,
  readMergeSource,
  saveMergeLedger,
  hasGame,
  loadGamedataPo,
  isInGameFolders,
  isInWorkshop,
  loadGameSchema,
  loadModContext,
  loadVanillaLayers,
  loadWorld,
  Heightmap,
  heightmapPath,
  readWorldFiles,
  worldDirs,
  loadTranslation,
  liveDiscoveryPath,
  loadModLayers,
  type ModLayers,
  readLiveDiscovery,
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
  /** Schema extensions (FCS Extended files of the mod and of its dependencies) applied to the schema. */
  extensions: FoundExtension[];
}

/** Файлы .mod, чьи `leveldata` накладываются на ваниль: зависимости, затем сам мод. */
function worldModFiles(cur: OpenResult | undefined): string[] {
  return [...(cur?.dependencyPaths ?? []), ...(cur?.path !== undefined ? [cur.path] : [])];
}

export class Session {
  readonly paths: GamePaths;
  readonly cwd: string;
  private vanillaCache?: Layer[];
  private poCache?: PoFile | null;
  private translationCache?: TranslationIndex | null;
  private current?: OpenResult;
  private worldCache?: { key: string; world: WorldIndex };
  /** Правки мира открытого мода (сдвиг, поворот, новые и удалённые объекты) и мир с ними. */
  private editsCache?: { owner: OpenResult; edits: WorldEdits; version: number; index?: { version: number; world: WorldIndex } };
  private heightmap?: Promise<Heightmap>;
  private live?: { client: LiveClient; state: LiveState; synced?: { session: number; version: number } };
  /** Решения слияния открытого мода (читаются из файла-спутника при первом обращении). */
  private ledgerCache?: { owner: OpenResult; ledger: MergeLedger };
  private readonly depCache = new Map<string, Layer>();
  /** Разобранные моды игрока для конфликтов: путь → размер/время и файл. */
  private readonly modFileCache = new Map<string, { stamp: string; file: DataFile }>();

  constructor(paths: GamePaths, cwd: string) {
    this.paths = paths;
    this.cwd = cwd;
  }

  private vanilla(): Layer[] {
    if (!hasGame(this.paths)) throw new SessionError(`No game in ${this.paths.kenshi} (set KENSHI_DIR or --game)`);
    return (this.vanillaCache ??= loadVanillaLayers(this.paths));
  }

  /**
   * Schema of the opened mod: the game's schema with the schema extensions of the mod and of
   * its dependencies. Without a mod, the game's schema alone. Core keeps parsed schemas in
   * memory by the state of their files, so nothing is cached here.
   */
  schema(): GameSchema {
    if (!hasGame(this.paths)) throw new SessionError(`No game in ${this.paths.kenshi}`);
    return this.current?.ctx.schema ?? loadGameSchema(this.paths);
  }

  /** Русский перевод текстов игры (`ru_RU.translation`), если есть. */
  translation(): TranslationIndex | undefined {
    if (this.translationCache === undefined) this.translationCache = hasGame(this.paths) ? (loadTranslation(this.paths) ?? null) : null;
    return this.translationCache ?? undefined;
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
    if (this.live) throw new SessionError('Connected to the editor: the mod is opened in the editor window (or connect_editor with disconnect: true)');
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
      // The schema depends on the mod (its schema extensions); core reads it from disk once
      // per state of the files. The translation is one for the session.
      schema: true,
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
    const e = this.editsCache;
    if (e && cur && e.owner === cur) {
      if (e.index?.version !== e.version) e.index = { version: e.version, world: new WorldIndex(e.edits.files()) };
      return e.index.world;
    }
    const modFiles = worldModFiles(cur);
    const key = modFiles.join('\n');
    if (this.worldCache?.key !== key) this.worldCache = { key, world: loadWorld(this.paths, { modFiles }).world };
    return this.worldCache.world;
  }

  /**
   * Правки мира открытого мода: свои шаги отмены (не путаются с правками записей). Файлы уровня
   * читаются при первом обращении. С подключённым редактором мир правят в его окне.
   */
  worldEdits(): WorldEdits {
    if (this.live) throw new SessionError('Connected to the editor: world objects are moved in the editor window (the World panel). connect_editor with disconnect: true edits the mod file directly');
    this.ctx();
    const cur = this.current!;
    if (this.editsCache?.owner !== cur) {
      const { files } = readWorldFiles(worldDirs(this.paths, worldModFiles(cur)));
      const name = cur.ctx.modName;
      const layer = cur.path !== undefined ? basename(cur.path) : /\.mod$/i.test(name) ? name : `${name}.mod`;
      const entry: NonNullable<Session['editsCache']> = { owner: cur, edits: new WorldEdits(files, layer), version: 0 };
      entry.edits.onChange(() => {
        entry.version++;
      });
      this.editsCache = entry;
    }
    return this.editsCache.edits;
  }

  /**
   * Правки мира с дочитанными интерьерами (`interiors.level` ванили, зависимостей и мода): тот
   * же объект и та же история отмены, что у `worldEdits`.
   */
  interiorEdits(): WorldEdits {
    const edits = this.worldEdits();
    if (!edits.isLoaded('interiors.level')) {
      const { files } = readWorldFiles(worldDirs(this.paths, worldModFiles(this.current)), { interiors: true });
      edits.addFiles(files.filter((f) => f.path.toLowerCase() === 'interiors.level'));
    }
    return edits;
  }

  /** Есть ли несохранённые правки мира открытого мода. */
  worldDirty(): boolean {
    const e = this.editsCache;
    return e !== undefined && e.owner === this.current && e.edits.isDirty();
  }

  /** Высота земли в точках мира (карта высот игры); undefined — карты нет. */
  async groundAt(points: readonly { x: number; z: number }[]): Promise<number[] | undefined> {
    const path = heightmapPath(this.paths.kenshi);
    if (!existsSync(path)) return undefined;
    this.heightmap ??= Heightmap.open(path);
    return (await this.heightmap).heightsAt(points);
  }

  /**
   * Слои для конфликтов: ваниль, моды из `mods.cfg` (с `all` — все установленные) и открытый
   * мод (его записи как есть сейчас, с несохранёнными правками) на его месте или последним.
   * Файлы модов читаются один раз, пока не изменились. Только чтение.
   */
  modLayers(all: boolean): ModLayers & { opened?: string } {
    const read = (path: string): DataFile => {
      const st = statSync(path);
      const stamp = `${st.size}:${st.mtimeMs}`;
      const hit = this.modFileCache.get(path);
      if (hit?.stamp === stamp) return hit.file;
      const file = readDataFile(readFileSync(path));
      this.modFileCache.set(path, { stamp, file });
      return file;
    };
    const cur = this.current;
    const opened = cur && cur.ctx.modRecords().length > 0 ? cur.ctx.modName : undefined;
    const r = loadModLayers(this.paths, this.vanilla(), {
      all,
      read,
      ...(cur && opened !== undefined ? { extra: { name: opened, records: cur.ctx.modRecords() } } : {}),
    });
    return { ...r, ...(opened !== undefined ? { opened } : {}) };
  }

  /** Решения слияния открытого мода; записываются в файл-спутник вместе с сохранением мода. */
  mergeLedger(): MergeLedger {
    this.ctx();
    const cur = this.current!;
    if (this.ledgerCache?.owner !== cur) this.ledgerCache = { owner: cur, ledger: loadMergeLedger(cur.path) };
    return this.ledgerCache.ledger;
  }

  /** Мод-источник слияния по имени установленного мода или пути. */
  mergeSource(spec: string, levels: boolean): { source: MergeSource; path: string; levelData?: LevelDataInfo } {
    const path = resolveModPath(this.paths, spec, this.cwd);
    if (!path) throw new SessionError(`Source mod not found: ${spec}`);
    const levelData = levels ? detectLevelData(path) : undefined;
    return { source: readMergeSource(path), path, ...(levelData ? { levelData } : {}) };
  }

  /** Записать мод. Без пути — туда, откуда открыт. В папку игры — только с `force`. */
  save(path: string | undefined, force: boolean): { path: string; records: number; mergeStore?: string; world?: string[] } {
    if (this.live) throw new SessionError('Connected to the editor: the user saves in the window (Ctrl+S)');
    const cur = this.current;
    if (!cur) throw new SessionError('No mod is open: open_mod first');
    const target = path !== undefined ? resolve(this.cwd, path) : cur.path;
    if (target === undefined) throw new SessionError('The mod is new: give a path');
    if (isInWorkshop(this.paths, target)) {
      throw new SessionError(`${target} is in the Steam Workshop; we never write there, even with force. To edit someone else's mod, use a copy in mods/ (kedit mods copy or the button in the editor)`);
    }
    if (!force && isInGameFolders(this.paths, target)) {
      throw new SessionError(`${target} is in the game or Workshop folder; writing there needs force: true`);
    }
    const file = saveModContext(cur.ctx, target);
    const world = this.saveWorld(cur, target);
    cur.path ??= target;
    // Слияние: «слито» и «отклонено» становятся постоянными, файл-спутник рядом с модом.
    const mergeStore = this.ledgerCache?.owner === cur ? saveMergeLedger(cur.ctx, this.ledgerCache.ledger, target) : undefined;
    return { path: target, records: file.records.length, ...(mergeStore !== undefined ? { mergeStore } : {}), ...(world.length ? { world } : {}) };
  }

  /**
   * Файлы уровня мода — в `leveldata` рядом с .mod: изменённые; при записи в другое место — все
   * файлы мода. Возвращает записанные имена.
   */
  private saveWorld(cur: OpenResult, target: string): string[] {
    const e = this.editsCache?.owner === cur ? this.editsCache.edits : undefined;
    if (!e) return [];
    const paths = cur.path !== undefined && resolve(cur.path) === resolve(target) ? e.dirtyFiles() : e.modFiles();
    const out: string[] = [];
    const dir = join(dirname(target), 'leveldata');
    for (const p of paths) {
      const f = e.buildFile(p);
      if (!f) continue;
      mkdirSync(dir, { recursive: true });
      // Сначала во временный файл, потом на место: игра не увидит половину файла.
      const full = join(dir, p);
      writeFileSync(`${full}.tmp`, writeDataFile(f));
      renameSync(`${full}.tmp`, full);
      out.push(p);
    }
    e.markSaved();
    return out;
  }

  // ------------------------------------------------------------ живая связь с редактором

  /** Подключён ли открытый редактор (и что в нём открыто на момент последней синхронизации). */
  get editor(): LiveState | undefined {
    return this.live && !this.live.client.closed ? this.live.state : undefined;
  }

  /** Подключиться к открытому редактору по файлу обнаружения и взять его мод. */
  async connectEditor(discoveryPath = liveDiscoveryPath()): Promise<LiveState> {
    const d = readLiveDiscovery(discoveryPath);
    if (!d) throw new SessionError(`The editor is not running (no ${discoveryPath}): open Cactus`);
    this.disconnectEditor();
    const client = await LiveClient.connect(d);
    try {
      const state = await client.request<LiveState>({ method: 'state' });
      this.live = { client, state };
      await this.sync();
      return this.live.state;
    } catch (e) {
      client.close();
      this.live = undefined;
      throw e;
    }
  }

  disconnectEditor(): void {
    if (!this.live) return;
    this.live.client.close();
    this.live = undefined;
    this.current = undefined;
  }

  /**
   * Перед каждой командой: если подключены к редактору и в окне что-то изменилось — взять
   * свежий снимок мода. Связь оборвалась — ошибка, дальше работа без редактора (по ванили).
   */
  async sync(): Promise<void> {
    const live = this.live;
    if (!live) return;
    try {
      const state = await live.client.request<LiveState>({ method: 'state' });
      live.state = state;
      if (live.synced?.session === state.session && live.synced.version === state.version && this.current) return;
      const snap = await live.client.request<LiveSnapshot>({ method: 'snapshot' });
      this.current = this.fromSnapshot(snap);
      live.state = snap;
      live.synced = { session: snap.session, version: snap.version };
    } catch (e) {
      this.live = undefined;
      this.current = undefined;
      throw new SessionError(`${e instanceof Error ? e.message : String(e)}. Continuing without the editor; connect_editor to connect again`);
    }
  }

  private fromSnapshot(snap: LiveSnapshot): OpenResult {
    const deps = snap.dependencies.map((d) => {
      let layer = this.depCache.get(d.path);
      if (!layer) this.depCache.set(d.path, (layer = { name: d.name, file: readDataFile(readFileSync(d.path)) }));
      return layer;
    });
    const po = this.po();
    const dependencyPaths = snap.dependencies.map((d) => d.path);
    const extensions = extensionsFor(this.paths, [...(snap.modPath !== undefined ? [snap.modPath] : []), ...dependencyPaths]);
    const ctx = new ModContext({
      layers: [...this.vanilla(), ...deps],
      modName: snap.modName,
      mod: readDataFile(base64ToBytes(snap.mod)),
      schema: loadGameSchema(this.paths, { extensions }),
      ...(po ? { po } : {}),
    });
    return { ctx, ...(snap.modPath !== undefined ? { path: snap.modPath } : {}), missingDependencies: [], dependencyPaths, extensions };
  }

  /** Отправить правки в окно редактора набором изменений ИИ. */
  async propose(title: string, ops: EditOp[]): Promise<ProposeResult> {
    const live = this.live;
    if (!live) throw new SessionError('The editor is not connected');
    const r = await live.client.request<ProposeResult>({ method: 'propose', title, ops });
    await this.sync();
    return r;
  }

  async editorChangesets(): Promise<AiChangeset[]> {
    const live = this.live;
    if (!live) throw new SessionError('The editor is not connected');
    return live.client.request<AiChangeset[]>({ method: 'changesets' });
  }
}
