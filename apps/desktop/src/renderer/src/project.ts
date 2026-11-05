/**
 * Открытый проект в окне: контекст ядра (ModContext) из байтов, присланных main, индекс для
 * быстрого поиска по списку и дерево категорий. Компоненты подписываются на `version`,
 * которая растёт при каждой правке, отмене и сохранении.
 */
import {
  buildCategoryTree,
  decodeText,
  itemTypeName,
  matchesLayoutFilters,
  ModContext,
  OTHER_TYPES_ID,
  parseGameSchema,
  parsePo,
  readDataFile,
  withInferredFields,
  writeDataFile,
  type CategoryNode,
  type DataFile,
  type GameRecord,
  type Layer,
  type RecordStatus,
} from '@kenshi-editor/core';
import type { KeditApi, ProjectBundle, SaveResult } from '../../shared/api.ts';

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
  version = 0;
  /** Изменения перенесены из прежнего контекста (смена зависимостей) и ещё не сохранены. */
  private carriedDirty: boolean;
  private readonly index = new Map<string, IndexEntry>();
  private ids: string[] = [];
  private readonly listeners = new Set<() => void>();
  private typeCache: { version: number; map: Map<string, string[]> } | undefined;

  constructor(bundle: ProjectBundle, options: { mod?: DataFile; path?: string; carriedDirty?: boolean } = {}) {
    this.bundle = bundle;
    const vanilla: Layer[] = bundle.vanilla.map((f) => ({ name: f.name, file: readDataFile(f.bytes) }));
    const deps: Layer[] = bundle.dependencies.map((f) => ({ name: f.name, file: readDataFile(f.bytes) }));
    const mod = options.mod ?? (bundle.mod ? readDataFile(bundle.mod.bytes) : undefined);
    const schema = withInferredFields(parseGameSchema(bundle.schema), [...vanilla, ...deps].map((l) => l.file).concat(mod ? [mod] : []));
    this.ctx = new ModContext({
      layers: [...vanilla, ...deps],
      modName: bundle.modName,
      schema,
      ...(mod ? { mod } : {}),
      ...(bundle.po !== undefined ? { po: parsePo(bundle.po) } : {}),
    });
    this.path = options.path ?? bundle.mod?.path;
    this.carriedDirty = options.carriedDirty ?? false;
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
    const rec = this.record(sid);
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
    return this.carriedDirty || this.ctx.dirty;
  }

  get title(): string {
    return this.ctx.modName;
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

  /** Сохранить: в известный путь или с выбором пути (`saveAs`, новый мод). */
  async save(saveAs = false): Promise<SaveResult> {
    let path = this.path;
    if (saveAs || path === undefined) {
      const chosen = await window.kedit.chooseSavePath(path ?? this.bundle.suggestedPath);
      if (chosen === null) return { ok: false, cancelled: true };
      path = chosen;
    }
    const file = this.ctx.buildModFile();
    const result = await window.kedit.saveMod({ path, bytes: writeDataFile(file) });
    if (result.ok) {
      this.ctx.markSaved();
      this.path = result.path;
      this.carriedDirty = false;
      this.bump();
    }
    return result;
  }
}

/** Новый контекст с другими зависимостями; правки мода переносятся (история отмены — нет). */
export async function reloadWithDependencies(p: Project, dependencies: string[]): Promise<Project> {
  p.ctx.setModInfo({ dependencies });
  const mod = p.ctx.buildModFile();
  const wasDirty = p.dirty;
  const bundle = await window.kedit.openProject({ game: p.bundle.game, modName: p.ctx.modName, dependencies: [...dependencies, ...p.ctx.info.references] });
  return new Project(bundle, { mod, ...(p.path !== undefined ? { path: p.path } : {}), carriedDirty: wasDirty || p.ctx.dirty });
}
