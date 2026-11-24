/**
 * Open project in the window: core context (ModContext) from bytes sent by main, an index for
 * fast list search, and the category tree. Components subscribe to `version`,
 * which grows with every edit, undo and save.
 */
import {
  applyExtensionLayers,
  buildCategoryTree,
  decodeText,
  indexTranslation,
  INTERIORS,
  matchesLayoutFilters,
  MergeLedger,
  ModContext,
  ParsedFileCache,
  OTHER_TYPES_ID,
  parseMergeStore,
  parsePo,
  prepareSchemaBase,
  readDataFile,
  serializeMergeStore,
  splitModList,
  summarizeExtensions,
  withInferredFields,
  WorldEdits,
  WorldIndex,
  writeDataFile,
  type CategoryNode,
  type DataFile,
  type ExtensionLayer,
  type ExtensionSummary,
  type GameRecord,
  type GameSchema,
  type Layer,
  type RecordStatus,
  type SchemaBase,
  type TranslationIndex,
  type WorldFile,
} from '@kenshi-editor/core';
import type { CopyModResult, GameInstallInfo, KeditApi, ModProvenance, ModRef, NamedBytes, ProjectBundle, ProjectRequest, SaveResult } from '../../shared/api.ts';
import { errorText } from './i18n.ts';

export interface IndexEntry {
  sid: string;
  type: string;
  name: string;
  /** Name in the data language ('' — none). */
  localized: string;
  /** Name, Russian name and id in lower case, separated by newlines. */
  hay: string;
}

/** A schema extension applied to the project: what it adds to the schema and its DLL plugins. */
export interface AppliedExtension {
  /** Name of the mod folder the files come from. */
  name: string;
  /** What the extension adds; absent for a folder with DLL plugins alone. */
  summary?: ExtensionSummary;
  /** DLL plugins for FCS named in `FCS_extended.json`. Cactus never runs them. */
  plugins: readonly string[];
}

/** Tree pseudo-node «Mod changes». */
export const MOD_CHANGES_ID = '__mod__';

/**
 * Parsed vanilla, dependency and level files — shared by all projects of the window: a repeated
 * «Vanilla» or another mod on the same game does not parse them again. Key — path, size and
 * modification time of the file (main checks it and sends bytes only for changed files).
 */
export const parsedFiles = new ParsedFileCache();

/** Schema with inferred fields for the latest file set without a mod (vanilla ± dependencies). */
let inferredCache: { key: string; schema: GameSchema } | undefined;

function layerFile(f: NamedBytes): DataFile {
  return f.key !== undefined ? parsedFiles.take(f.key, f.bytes) : readDataFile(f.bytes);
}

/**
 * Open a project: main sends only files that are not in the window cache. If the cache
 * evicted something between the request and parsing — repeat the request without the cache.
 */
export async function openProject(req: ProjectRequest): Promise<Project> {
  await prefetching?.catch(() => undefined);
  const bundle = await window.kedit.openProject({ ...req, known: parsedFiles.keys() });
  // Let the window draw «Loading…» before parsing.
  await new Promise((r) => setTimeout(r, 0));
  try {
    return new Project(bundle);
  } catch (e) {
    if (!(e instanceof Error) || e.name !== 'CacheMissError') throw e;
    return new Project(await window.kedit.openProject({ ...req, known: [] }));
  }
}

let prefetching: Promise<void> | undefined;
let prefetchedFor: string | undefined;

/**
 * Prepare vanilla in the background while the start screen is shown: read and parse files one
 * at a time (the window stays responsive between them) and infer the schema. Then «Vanilla» opens
 * without parsing. Errors are not shown here — opening itself will show them.
 */
export function prefetchVanilla(game: GameInstallInfo): Promise<void> {
  if (prefetchedFor === game.kenshi && prefetching) return prefetching;
  prefetchedFor = game.kenshi;
  const yieldToUi = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  prefetching = (async () => {
    const bundle = await window.kedit.openProject({ game, modName: 'untitled.mod', dependencies: [], known: parsedFiles.keys() });
    for (const f of bundle.vanilla) {
      await yieldToUi();
      if (f.key !== undefined) await parsedFiles.takeSliced(f.key, f.bytes, yieldToUi);
    }
    await yieldToUi();
    inferredSchema(bundle, bundle.vanilla.map(layerFile), undefined);
  })();
  return prefetching;
}

/** The game's own schema files, parsed once: they do not depend on the mod. */
let schemaBase: SchemaBase | undefined;

/** Whether the layer has files that change the schema (a folder with DLL plugins alone does not). */
function changesSchema(layer: ExtensionLayer): boolean {
  return layer.def !== undefined || layer.preload !== undefined || (layer.patches?.length ?? 0) > 0;
}

/**
 * The schema of the game with the schema extensions of the bundle applied (FCS Extended files of
 * the mod and of its dependencies). Without extensions it is the game's schema as it always was.
 */
function gameSchema(bundle: ProjectBundle): GameSchema {
  const { fcsDef, fcsEnums, fcsLayout } = bundle.schema;
  const s = schemaBase?.sources;
  const base = schemaBase !== undefined && s?.fcsDef === fcsDef && s.fcsEnums === fcsEnums && s.fcsLayout === fcsLayout ? schemaBase : prepareSchemaBase(bundle.schema);
  schemaBase = base;
  return applyExtensionLayers(base, (bundle.extensions ?? []).filter(changesSchema));
}

function inferredSchema(bundle: ProjectBundle, files: DataFile[], mod: DataFile | undefined): GameSchema {
  const build = (): GameSchema => withInferredFields(gameSchema(bundle), mod ? [...files, mod] : files);
  const keys = [...bundle.vanilla, ...bundle.dependencies].map((f) => f.key);
  if (mod || keys.some((k) => k === undefined)) return build();
  const { fcsDef, fcsEnums = '', fcsLayout = '' } = bundle.schema;
  const key = JSON.stringify([fcsDef, fcsEnums, fcsLayout, bundle.extensions ?? [], ...keys]);
  if (inferredCache?.key !== key) inferredCache = { key, schema: build() };
  return inferredCache.schema;
}

declare global {
  interface Window {
    kedit: KeditApi;
  }
}

export class Project {
  readonly ctx: ModContext;
  readonly bundle: ProjectBundle;
  readonly tree: CategoryNode[];
  /** Mod file path (where to save); undefined — new mod, not saved yet. */
  path: string | undefined;
  /** Where the mod file comes from: the Workshop (cannot be saved — copy only) or a copy of someone else's mod. */
  provenance: ModProvenance | undefined;
  version = 0;
  /** Merge decisions (rejected records, what was merged with what and when); written to a file next to the mod. */
  ledger: MergeLedger;
  /** The merge file next to the mod could not be read (damaged): decisions started over. */
  ledgerError: string | undefined;
  /** Changes carried over from the previous context (dependency change) and not saved yet. */
  private carriedDirty: boolean;
  private readonly index = new Map<string, IndexEntry>();
  private ids: string[] = [];
  private readonly listeners = new Set<() => void>();
  private typeCache: { version: number; map: Map<string, string[]> } | undefined;
  private worldFilesPromise: Promise<WorldFile[]> | undefined;
  private editsPromise: Promise<WorldEdits> | undefined;
  private interiorsPromise: Promise<WorldEdits> | undefined;
  private edits: WorldEdits | undefined;
  /** World with the current edits: rebuilt when world edits change. */
  private worldCache: { version: number; index: Promise<WorldIndex> } | undefined;
  /** World edit number (grows with every edit, undo, save). */
  worldVersion = 0;
  /** Interior edit number (the world is not rebuilt from them). */
  interiorVersion = 0;
  private translationPromise: Promise<TranslationIndex | undefined> | undefined;
  /** Data language last asked for (the names may still be loading). */
  requestedLocale: string | undefined;
  private readonly icons = new Map<string, Promise<string | null>>();

  constructor(bundle: ProjectBundle, options: { mod?: DataFile; path?: string; carriedDirty?: boolean; provenance?: ModProvenance | undefined; ledger?: MergeLedger } = {}) {
    this.bundle = bundle;
    const vanilla: Layer[] = bundle.vanilla.map((f) => ({ name: f.name, file: layerFile(f) }));
    const deps: Layer[] = bundle.dependencies.map((f) => ({ name: f.name, file: layerFile(f) }));
    const mod = options.mod ?? (bundle.mod ? readDataFile(bundle.mod.bytes) : undefined);
    const schema = inferredSchema(bundle, [...vanilla, ...deps].map((l) => l.file), mod);
    this.ctx = new ModContext({
      layers: [...vanilla, ...deps],
      modName: bundle.modName,
      schema,
      ...(mod ? { mod } : {}),
      ...(bundle.po !== undefined ? { po: parsePo(bundle.po), ...(bundle.dataLocale !== undefined ? { dataLocale: bundle.dataLocale } : {}) } : {}),
    });
    this.requestedLocale = bundle.dataLocale;
    this.path = options.path ?? bundle.mod?.path;
    this.provenance = 'provenance' in options ? options.provenance : bundle.provenance;
    this.carriedDirty = options.carriedDirty ?? false;
    this.ledger = options.ledger ?? new MergeLedger();
    if (!options.ledger && bundle.mergeStore !== undefined) {
      try {
        this.ledger = new MergeLedger(parseMergeStore(bundle.mergeStore));
      } catch (e) {
        this.ledgerError = errorText(e);
      }
    }
    for (const sid of this.ctx.allStringIds()) this.reindex(sid);
    this.ids = [...this.index.keys()];
    this.tree = buildCategoryTree(schema, new Set([...this.index.values()].map((e) => e.type)));
    this.ctx.subscribe((e) => {
      let added = false;
      for (const sid of e.stringIds) {
        if (!this.index.has(sid)) added = true;
        this.reindex(sid);
      }
      if (added) this.ids = [...this.index.keys()];
      this.bump();
    });
  }

  private reindex(sid: string): void {
    const rec = this.ctx.headline(sid);
    if (!rec) {
      this.index.delete(sid);
      return;
    }
    const name = decodeText(rec.name);
    const localized = this.ctx.localizedName(sid) ?? '';
    this.index.set(sid, { sid, type: this.ctx.typeName(rec.type), name, localized, hay: `${name}\n${localized}\n${sid}`.toLowerCase() });
  }

  /** Data language of the loaded names (game locale code); undefined — originals only. */
  get dataLocale(): string | undefined {
    return this.ctx.dataLocale;
  }

  /**
   * Switch the data language: read `gamedata.po` of `locale` (or drop the names), rebuild the
   * search index and the text translation, redraw. Later calls win over earlier ones still running.
   */
  async setDataLocale(locale: string | undefined): Promise<void> {
    if (locale === this.requestedLocale) return;
    this.requestedLocale = locale;
    const text = locale !== undefined ? await window.kedit.readGamedataPo(this.bundle.game, locale) : null;
    if (this.requestedLocale !== locale) return;
    this.ctx.setTranslations(text !== null ? parsePo(text) : undefined, locale);
    this.translationPromise = undefined;
    for (const sid of this.ids) this.reindex(sid);
    this.bump();
  }

  entry(sid: string): IndexEntry | undefined {
    return this.index.get(sid);
  }

  /** Resulting record; for one deleted by the mod — the record of the lower layers. */
  record(sid: string): GameRecord | undefined {
    return this.ctx.get(sid) ?? this.ctx.lower(sid) ?? this.ctx.delta(sid);
  }

  /** Records by type (cached until the next edit). */
  idsByType(): Map<string, string[]> {
    if (this.typeCache?.version === this.version) return this.typeCache.map;
    const map = new Map<string, string[]>();
    for (const sid of this.ids) {
      const e = this.index.get(sid);
      if (!e) continue;
      let list = map.get(e.type);
      if (!list) map.set(e.type, (list = []));
      list.push(sid);
    }
    this.typeCache = { version: this.version, map };
    return map;
  }

  /** Records of a category tree node (or «Mod changes»). */
  idsForNode(node: CategoryNode | typeof MOD_CHANGES_ID): string[] {
    if (node === MOD_CHANGES_ID) return this.ctx.modRecords().map((r) => r.stringId);
    if (node.type === undefined) {
      if (node.id === OTHER_TYPES_ID) return node.children.flatMap((c) => this.idsForNode(c));
      return [...this.ids];
    }
    const list = this.idsByType().get(node.type) ?? [];
    if (node.filters.length === 0) return list;
    const schema = this.ctx.schema;
    return list.filter((sid) => {
      const rec = this.record(sid);
      return rec !== undefined && matchesLayoutFilters(schema, rec, node.filters);
    });
  }

  /** All records (including those deleted by the mod) in layer order. */
  allIds(): readonly string[] {
    return this.ids;
  }

  status(sid: string): RecordStatus | undefined {
    return this.ctx.status(sid);
  }

  get dirty(): boolean {
    return this.carriedDirty || this.ctx.dirty || this.ledger.hasChanges(this.ctx) || this.edits?.isDirty() === true;
  }

  get title(): string {
    return this.ctx.modName;
  }

  /** What the mod is called for autosaves and backups: the file or the new mod name. */
  get ref(): ModRef {
    return { path: this.path, modName: this.path !== undefined ? (this.path.split(/[\\/]/).pop() ?? this.ctx.modName) : this.ctx.modName };
  }

  /** Current mod state as .mod bytes (for autosave and restore point). */
  currentBytes(): Uint8Array {
    return writeDataFile(this.ctx.buildModFile());
  }

  /**
   * Schema extensions (FCS Extended files) of the mod and of its dependencies that this project
   * was built with, in load order.
   */
  get extensions(): AppliedExtension[] {
    const layers = this.bundle.extensions ?? [];
    if (layers.length === 0) return [];
    const summaries = this.ctx.schema ? summarizeExtensions(this.ctx.schema) : [];
    return layers.map((l) => {
      const summary = summaries.find((s) => s.name === l.name);
      return { name: l.name, ...(summary ? { summary } : {}), plugins: l.plugins ?? [] };
    });
  }

  /** Context mods: layered under the mod but not written in its header. */
  get contextMods(): string[] {
    return this.bundle.contextMods ?? [];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  bump(): void {
    this.version++;
    window.kedit.setDirty(this.dirty, this.title);
    for (const fn of this.listeners) fn();
  }

  /** Name of the mod layer in the world: the .mod file name (the `leveldata` folder next to it). */
  get modLayer(): string {
    return this.path !== undefined ? (this.path.split(/[\\/]/).pop() ?? this.path) : (/\.mod$/i.test(this.ctx.modName) ? this.ctx.modName : `${this.ctx.modName}.mod`);
  }

  /** Level files of vanilla, dependencies and the mod (read once, tens of megabytes). */
  private worldFiles(): Promise<WorldFile[]> {
    this.worldFilesPromise ??= this.readWorld(false);
    return this.worldFilesPromise;
  }

  private async readWorld(interiors: boolean): Promise<WorldFile[]> {
    const modPaths = [...this.bundle.dependencies.map((d) => d.path), ...(this.path !== undefined ? [this.path] : [])];
    const req = { game: this.bundle.game, modPaths, interiors };
    let files = await window.kedit.loadWorld({ ...req, known: parsedFiles.keys() });
    if (files.some((f) => f.bytes.length === 0 && !parsedFiles.has(f.key))) files = await window.kedit.loadWorld(req);
    // There are thousands of level files and the cache holds 64: parsing new ones would evict files main knows about
    // that come later in the list (their bytes were not sent) → «Not in cache». So first
    // take everything already parsed, and only then parse the rest.
    const hits = files.map((f) => (f.bytes.length === 0 ? parsedFiles.get(f.key) : undefined));
    return files.map((f, i) => ({ layer: f.layer, path: f.path, file: hits[i] ?? parsedFiles.take(f.key, f.bytes) }));
  }

  /** World edits with interiors loaded (`interiors.level` of vanilla, dependencies and the mod). */
  interiorEdits(): Promise<WorldEdits> {
    this.interiorsPromise ??= this.worldEdits()
      .then(async (edits) => {
        if (!edits.isLoaded(INTERIORS)) edits.addFiles(await this.readWorld(true));
        return edits;
      })
      .catch((e: unknown) => {
        this.interiorsPromise = undefined;
        throw e;
      });
    return this.interiorsPromise;
  }

  /** Mod world edits (move, rotate, new and deleted objects): their own undo history. */
  worldEdits(): Promise<WorldEdits> {
    this.editsPromise ??= this.worldFiles().then((files) => {
      const edits = new WorldEdits(files, this.modLayer);
      edits.onChange((changed) => {
        // Interior-only edits do not change the world (WorldIndex).
        if (changed.length > 0 && changed.every((c) => c.path.toLowerCase() === INTERIORS)) this.interiorVersion++;
        else this.worldVersion++;
        this.bump();
      });
      this.edits = edits;
      return edits;
    });
    return this.editsPromise;
  }

  /**
   * World (towns, buildings, zones) of vanilla, dependencies and the mod — for «Where in game» and the «World» panel.
   * With the mod world edits, if there were any.
   */
  world(): Promise<WorldIndex> {
    if (this.worldCache?.version !== this.worldVersion) {
      const edits = this.edits;
      const index = edits ? Promise.resolve(new WorldIndex(edits.files())) : this.worldFiles().then((files) => new WorldIndex(files));
      this.worldCache = { version: this.worldVersion, index };
    }
    return this.worldCache.index;
  }

  /**
   * Translation of the game texts (`<locale>.translation`: dialogue lines and others) of the data
   * language, read once per language; undefined — no data language or no file.
   */
  translation(): Promise<TranslationIndex | undefined> {
    const locale = this.requestedLocale;
    this.translationPromise ??=
      locale === undefined ? Promise.resolve(undefined) : window.kedit.readTranslation(this.bundle.game, locale).then((b) => (b ? indexTranslation(readDataFile(b)) : undefined));
    return this.translationPromise;
  }

  /** Item icon from the `icon` field as a data URL (or null). */
  icon(iconPath: string): Promise<string | null> {
    let p = this.icons.get(iconPath);
    if (!p) {
      p = window.kedit.readIcon(this.bundle.game, iconPath);
      this.icons.set(iconPath, p);
    }
    return p;
  }

  /** Save: to the known path or with a path choice (`saveAs`, new mod). */
  async save(saveAs = false): Promise<SaveResult> {
    let path = this.path;
    if (saveAs || path === undefined) {
      const chosen = await window.kedit.chooseSavePath(path ?? this.bundle.suggestedPath);
      if (chosen === null) return { ok: false, cancelled: true };
      path = chosen;
    }
    const file = this.ctx.buildModFile();
    const mergeStore = this.ledger.hasChanges(this.ctx) ? serializeMergeStore(this.ledger.store(this.ctx)) : undefined;
    // Level files: the changed ones; when saving elsewhere — all mod files.
    const edits = this.edits;
    const worldPaths = edits ? (path === this.path ? edits.dirtyFiles() : edits.modFiles()) : [];
    const world = worldPaths.flatMap((p) => {
      const f = edits?.buildFile(p);
      return f ? [{ path: p, bytes: writeDataFile(f) }] : [];
    });
    const result = await window.kedit.saveMod({
      path,
      bytes: writeDataFile(file),
      ...(mergeStore !== undefined ? { mergeStore } : {}),
      ...(world.length ? { world } : {}),
      modName: this.ctx.modName,
      ...(this.path !== undefined ? { previousPath: this.path } : {}),
    });
    if (result.ok) {
      edits?.markSaved();
      if (mergeStore !== undefined) this.ledger.commit(this.ctx);
      this.ctx.markSaved();
      this.path = result.path;
      this.provenance = result.provenance;
      this.carriedDirty = false;
      this.bump();
    }
    return result;
  }

  /**
   * Someone else's mod from the Workshop: copy the file to `mods/<name>/<name>.mod` (main asks) and from then on
   * save into the copy. Unsaved edits stay — the copy is byte for byte equal to the original.
   */
  async copyForEditing(): Promise<CopyModResult> {
    if (this.path === undefined) return { ok: false, cancelled: false, error: 'not saved' };
    const r = await window.kedit.copyModForEditing(this.bundle.game, this.path);
    if (r.ok) {
      this.path = r.path;
      this.provenance = r.provenance;
      this.bump();
    }
    return r;
  }
}

/**
 * New context with other dependencies or context mods; mod edits are carried over
 * (the undo history is not). Whatever is not given is taken from the previous project.
 */
/** A saved mod in `<game>/mods/` (not a Workshop download): what the game loads and what may be published. */
export function publishable(project: Project): boolean {
  if (project.path === undefined || project.provenance?.inWorkshop === true) return false;
  const norm = (x: string): string => x.replace(/\\/g, '/').toLowerCase();
  return norm(project.path).startsWith(`${norm(project.bundle.game.kenshi).replace(/\/$/, '')}/mods/`);
}

export async function reloadProject(p: Project, change: { dependencies?: string[]; contextMods?: string[] }): Promise<Project> {
  if (change.dependencies) p.ctx.setModInfo({ dependencies: change.dependencies });
  const mod = p.ctx.buildModFile();
  const wasDirty = p.dirty;
  const contextMods = change.contextMods ?? p.contextMods;
  const req: ProjectRequest = {
    game: p.bundle.game,
    modName: p.ctx.modName,
    dependencies: [...p.ctx.info.dependencies, ...p.ctx.info.references],
    ...(contextMods.length ? { contextMods } : {}),
    ...(p.path !== undefined ? { extensionsOf: p.path } : {}),
    ...(p.requestedLocale !== undefined ? { dataLocale: p.requestedLocale } : {}),
  };
  let bundle = await window.kedit.openProject({ ...req, known: parsedFiles.keys() });
  if ([...bundle.vanilla, ...bundle.dependencies].some((f) => f.key !== undefined && f.bytes.length === 0 && !parsedFiles.has(f.key))) {
    bundle = await window.kedit.openProject(req);
  }
  return new Project(bundle, { mod, ...(p.path !== undefined ? { path: p.path } : {}), carriedDirty: wasDirty || p.ctx.dirty, provenance: p.provenance, ledger: p.ledger.carry(p.ctx) });
}

/** Mod dependencies from its header (references included) — the context is built from them. */
function headerDependencies(mod: DataFile): string[] {
  const h = mod.header;
  return h ? [...splitModList(h.dependencies), ...splitModList(h.references)] : [];
}

/**
 * Open a mod with content from an autosave: the file on disk (if any) sets the path and
 * origin, while edits and dependencies come from the backup bytes. The mod is marked as changed.
 */
export async function openRecovered(req: ProjectRequest, bytes: Uint8Array): Promise<Project> {
  const mod = readDataFile(bytes);
  const deps = headerDependencies(mod);
  const full: ProjectRequest = { ...req, dependencies: deps };
  let bundle = await window.kedit.openProject({ ...full, known: parsedFiles.keys() });
  if ([...bundle.vanilla, ...bundle.dependencies].some((f) => f.key !== undefined && f.bytes.length === 0 && !parsedFiles.has(f.key))) {
    bundle = await window.kedit.openProject(full);
  }
  return new Project(bundle, { mod, carriedDirty: true });
}

/**
 * Restore an old mod version as a new edit: the current state first goes to backups
 * (restore point), then the window gets a project with the version's content. The undo history starts over.
 */
export async function restoreProject(p: Project, bytes: Uint8Array): Promise<Project> {
  await window.kedit.addRestorePoint(p.ref, p.currentBytes());
  const mod = readDataFile(bytes);
  const contextMods = p.contextMods;
  const req: ProjectRequest = {
    game: p.bundle.game,
    modName: p.ctx.modName,
    dependencies: headerDependencies(mod),
    ...(contextMods.length ? { contextMods } : {}),
    ...(p.path !== undefined ? { extensionsOf: p.path } : {}),
    ...(p.requestedLocale !== undefined ? { dataLocale: p.requestedLocale } : {}),
  };
  let bundle = await window.kedit.openProject({ ...req, known: parsedFiles.keys() });
  if ([...bundle.vanilla, ...bundle.dependencies].some((f) => f.key !== undefined && f.bytes.length === 0 && !parsedFiles.has(f.key))) {
    bundle = await window.kedit.openProject(req);
  }
  return new Project(bundle, { mod, ...(p.path !== undefined ? { path: p.path } : {}), carriedDirty: true, provenance: p.provenance, ledger: p.ledger.carry(p.ctx) });
}

/** New context with other dependencies (context mods stay). */
export function reloadWithDependencies(p: Project, dependencies: string[]): Promise<Project> {
  return reloadProject(p, { dependencies });
}
