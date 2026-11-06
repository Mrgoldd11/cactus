/**
 * Открытый проект в окне: контекст ядра (ModContext) из байтов, присланных main, индекс для
 * быстрого поиска по списку и дерево категорий. Компоненты подписываются на `version`,
 * которая растёт при каждой правке, отмене и сохранении.
 */
import {
  buildCategoryTree,
  decodeText,
  indexTranslation,
  itemTypeName,
  matchesLayoutFilters,
  MergeLedger,
  ModContext,
  ParsedFileCache,
  OTHER_TYPES_ID,
  parseGameSchema,
  parseMergeStore,
  parsePo,
  readDataFile,
  serializeMergeStore,
  withInferredFields,
  WorldEdits,
  WorldIndex,
  writeDataFile,
  type CategoryNode,
  type DataFile,
  type GameRecord,
  type GameSchema,
  type Layer,
  type RecordStatus,
  type TranslationIndex,
  type WorldFile,
} from '@kenshi-editor/core';
import type { CopyModResult, GameInstallInfo, KeditApi, ModProvenance, NamedBytes, ProjectBundle, ProjectRequest, SaveResult } from '../../shared/api.ts';

export interface IndexEntry {
  sid: string;
  type: string;
  name: string;
  ru: string;
  /** Имя, русское имя и id в нижнем регистре через перевод строки. */
  hay: string;
}

/** Псевдо-узел дерева «Изменения мода». */
export const MOD_CHANGES_ID = '__mod__';

/**
 * Разобранные файлы ванили, зависимостей и уровня — общие для всех проектов окна: повторное
 * «Ваниль» или другой мод на той же игре не разбирает их заново. Ключ — путь, размер и время
 * изменения файла (main сверяет его и присылает байты только изменившихся файлов).
 */
export const parsedFiles = new ParsedFileCache();

/** Схема с выведенными полями для последнего набора файлов без мода (ваниль ± зависимости). */
let inferredCache: { key: string; schema: GameSchema } | undefined;

function layerFile(f: NamedBytes): DataFile {
  return f.key !== undefined ? parsedFiles.take(f.key, f.bytes) : readDataFile(f.bytes);
}

/**
 * Открыть проект: main присылает только файлы, которых нет в кэше окна. Если кэш успел
 * что-то вытеснить между запросом и разбором — повторить запрос без кэша.
 */
export async function openProject(req: ProjectRequest): Promise<Project> {
  await prefetching?.catch(() => undefined);
  const bundle = await window.kedit.openProject({ ...req, known: parsedFiles.keys() });
  // Дать окну нарисовать «Загрузка…» до разбора.
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
 * Подготовить ваниль в фоне, пока виден стартовый экран: прочитать и разобрать файлы по
 * одному (между ними окно успевает отвечать) и вывести схему. Потом «Ваниль» открывается
 * без разбора. Ошибки здесь не показываются — их покажет само открытие.
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

function inferredSchema(bundle: ProjectBundle, files: DataFile[], mod: DataFile | undefined): GameSchema {
  const build = (): GameSchema => withInferredFields(parseGameSchema(bundle.schema), mod ? [...files, mod] : files);
  const keys = [...bundle.vanilla, ...bundle.dependencies].map((f) => f.key);
  if (mod || keys.some((k) => k === undefined)) return build();
  const { fcsDef, fcsEnums = '', fcsLayout = '' } = bundle.schema;
  const key = JSON.stringify([fcsDef, fcsEnums, fcsLayout, ...keys]);
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
  /** Путь файла мода (куда сохранять); undefined — новый мод, ещё не сохранён. */
  path: string | undefined;
  /** Откуда файл мода: мастерская (сохранять нельзя — только копия) или копия чужого мода. */
  provenance: ModProvenance | undefined;
  version = 0;
  /** Решения слияния (отклонённые записи, с чем и когда слито); пишутся в файл рядом с модом. */
  ledger: MergeLedger;
  /** Файл слияния рядом с модом не прочитался (повреждён): решения начаты заново. */
  ledgerError: string | undefined;
  /** Изменения перенесены из прежнего контекста (смена зависимостей) и ещё не сохранены. */
  private carriedDirty: boolean;
  private readonly index = new Map<string, IndexEntry>();
  private ids: string[] = [];
  private readonly listeners = new Set<() => void>();
  private typeCache: { version: number; map: Map<string, string[]> } | undefined;
  private worldFilesPromise: Promise<WorldFile[]> | undefined;
  private editsPromise: Promise<WorldEdits> | undefined;
  private edits: WorldEdits | undefined;
  /** Мир по текущим правкам: пересобирается, когда правки мира меняются. */
  private worldCache: { version: number; index: Promise<WorldIndex> } | undefined;
  /** Номер правки мира (растёт при каждой правке, отмене, сохранении). */
  worldVersion = 0;
  private translationPromise: Promise<TranslationIndex | undefined> | undefined;
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
      ...(bundle.po !== undefined ? { po: parsePo(bundle.po) } : {}),
    });
    this.path = options.path ?? bundle.mod?.path;
    this.provenance = 'provenance' in options ? options.provenance : bundle.provenance;
    this.carriedDirty = options.carriedDirty ?? false;
    this.ledger = options.ledger ?? new MergeLedger();
    if (!options.ledger && bundle.mergeStore !== undefined) {
      try {
        this.ledger = new MergeLedger(parseMergeStore(bundle.mergeStore));
      } catch (e) {
        this.ledgerError = e instanceof Error ? e.message : String(e);
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
    const ru = this.ctx.localizedName(sid) ?? '';
    this.index.set(sid, { sid, type: itemTypeName(rec.type), name, ru, hay: `${name}\n${ru}\n${sid}`.toLowerCase() });
  }

  entry(sid: string): IndexEntry | undefined {
    return this.index.get(sid);
  }

  /** Итоговая запись; для удалённой модом — запись нижних слоёв. */
  record(sid: string): GameRecord | undefined {
    return this.ctx.get(sid) ?? this.ctx.lower(sid) ?? this.ctx.delta(sid);
  }

  /** Записи по типам (кэш до следующей правки). */
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

  /** Записи узла дерева категорий (или «Изменения мода»). */
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

  /** Все записи (в том числе удалённые модом) в порядке слоёв. */
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

  /** Моды контекста: лежат слоями под модом, но не записаны в его заголовке. */
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

  /** Имя слоя мода в мире: имя файла .mod (папка `leveldata` рядом с ним). */
  get modLayer(): string {
    return this.path !== undefined ? (this.path.split(/[\\/]/).pop() ?? this.path) : (/\.mod$/i.test(this.ctx.modName) ? this.ctx.modName : `${this.ctx.modName}.mod`);
  }

  /** Файлы уровня ванили, зависимостей и мода (читаются один раз, десятки мегабайт). */
  private worldFiles(): Promise<WorldFile[]> {
    this.worldFilesPromise ??= (async () => {
      const modPaths = [...this.bundle.dependencies.map((d) => d.path), ...(this.path !== undefined ? [this.path] : [])];
      const req = { game: this.bundle.game, modPaths };
      let files = await window.kedit.loadWorld({ ...req, known: parsedFiles.keys() });
      if (files.some((f) => f.bytes.length === 0 && !parsedFiles.has(f.key))) files = await window.kedit.loadWorld(req);
      return files.map((f) => ({ layer: f.layer, path: f.path, file: parsedFiles.take(f.key, f.bytes) }));
    })();
    return this.worldFilesPromise;
  }

  /** Правки мира мода (сдвиг, поворот, новые и удалённые объекты): своя история отмены. */
  worldEdits(): Promise<WorldEdits> {
    this.editsPromise ??= this.worldFiles().then((files) => {
      const edits = new WorldEdits(files, this.modLayer);
      edits.onChange(() => {
        this.worldVersion++;
        this.bump();
      });
      this.edits = edits;
      return edits;
    });
    return this.editsPromise;
  }

  /**
   * Мир (города, здания, зоны) ванили, зависимостей и мода — для «Где в игре» и панели «Мир».
   * С правками мира мода, если они были.
   */
  world(): Promise<WorldIndex> {
    if (this.worldCache?.version !== this.worldVersion) {
      const edits = this.edits;
      const index = edits ? Promise.resolve(new WorldIndex(edits.files())) : this.worldFiles().then((files) => new WorldIndex(files));
      this.worldCache = { version: this.worldVersion, index };
    }
    return this.worldCache.index;
  }

  /** Перевод реплик игры (`ru_RU.translation`), читается один раз; undefined — нет файла. */
  translation(): Promise<TranslationIndex | undefined> {
    this.translationPromise ??= window.kedit.readTranslation(this.bundle.game).then((b) => (b ? indexTranslation(readDataFile(b)) : undefined));
    return this.translationPromise;
  }

  /** Иконка предмета по полю `icon` как data URL (или null). */
  icon(iconPath: string): Promise<string | null> {
    let p = this.icons.get(iconPath);
    if (!p) {
      p = window.kedit.readIcon(this.bundle.game, iconPath);
      this.icons.set(iconPath, p);
    }
    return p;
  }

  /** Сохранить: в известный путь или с выбором пути (`saveAs`, новый мод). */
  async save(saveAs = false): Promise<SaveResult> {
    let path = this.path;
    if (saveAs || path === undefined) {
      const chosen = await window.kedit.chooseSavePath(path ?? this.bundle.suggestedPath);
      if (chosen === null) return { ok: false, cancelled: true };
      path = chosen;
    }
    const file = this.ctx.buildModFile();
    const mergeStore = this.ledger.hasChanges(this.ctx) ? serializeMergeStore(this.ledger.store(this.ctx)) : undefined;
    // Файлы уровня: изменённые; при сохранении в другое место — все файлы мода.
    const edits = this.edits;
    const worldPaths = edits ? (path === this.path ? edits.dirtyFiles() : edits.modFiles()) : [];
    const world = worldPaths.flatMap((p) => {
      const f = edits?.buildFile(p);
      return f ? [{ path: p, bytes: writeDataFile(f) }] : [];
    });
    const result = await window.kedit.saveMod({ path, bytes: writeDataFile(file), ...(mergeStore !== undefined ? { mergeStore } : {}), ...(world.length ? { world } : {}) });
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
   * Чужой мод из мастерской: скопировать файл в `mods/<имя>/<имя>.mod` (main спросит) и дальше
   * сохранять в копию. Несохранённые правки остаются — копия байт в байт равна оригиналу.
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
 * Новый контекст с другими зависимостями или модами контекста; правки мода переносятся
 * (история отмены — нет). Не заданное берётся из прежнего проекта.
 */
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
  };
  let bundle = await window.kedit.openProject({ ...req, known: parsedFiles.keys() });
  if ([...bundle.vanilla, ...bundle.dependencies].some((f) => f.key !== undefined && f.bytes.length === 0 && !parsedFiles.has(f.key))) {
    bundle = await window.kedit.openProject(req);
  }
  return new Project(bundle, { mod, ...(p.path !== undefined ? { path: p.path } : {}), carriedDirty: wasDirty || p.ctx.dirty, provenance: p.provenance, ledger: p.ledger.carry(p.ctx) });
}

/** Новый контекст с другими зависимостями (моды контекста остаются). */
export function reloadWithDependencies(p: Project, dependencies: string[]): Promise<Project> {
  return reloadProject(p, { dependencies });
}
