/**
 * Договор между окном (renderer) и главным процессом (main). Окно не трогает файлы само:
 * всё чтение и запись — через эти вызовы, main выполняет их и спрашивает подтверждение,
 * если запись идёт в папку игры или мастерской.
 */

export type GameSource = 'config' | 'steam' | 'gog' | 'manual';

export interface GameInstallInfo {
  kenshi: string;
  workshop: string;
  source: GameSource;
}

export interface ModEntry {
  /** Имя файла (`Мой мод.mod`). */
  fileName: string;
  path: string;
  source: 'mods' | 'workshop' | 'other';
  author?: string;
  description?: string;
  dependencies?: string[];
  references?: string[];
  recordCount?: number;
  /** Место в `data/mods.cfg` (с 0), если мод включён. */
  loadIndex?: number;
  error?: string;
}

export interface ProjectRequest {
  game: GameInstallInfo;
  /** Существующий .mod; если не задан — новый мод `modName`. */
  modPath?: string;
  modName?: string;
  /** Зависимости (имена .mod); по умолчанию — из заголовка мода. */
  dependencies?: string[];
}

export interface NamedBytes {
  name: string;
  path: string;
  bytes: Uint8Array;
}

/** Всё, что нужно окну, чтобы собрать контекст редактирования. */
export interface ProjectBundle {
  game: GameInstallInfo;
  modName: string;
  /** Файл мода, если он уже есть на диске. */
  mod?: NamedBytes;
  vanilla: NamedBytes[];
  dependencies: NamedBytes[];
  missingDependencies: string[];
  schema: { fcsDef: string; fcsEnums?: string; fcsLayout?: string };
  /** Русский перевод `locale/ru_RU/gamedata.po`. */
  po?: string;
  /** Путь сохранения по умолчанию для нового мода. */
  suggestedPath: string;
}

export interface SaveRequest {
  path: string;
  bytes: Uint8Array;
}

export type SaveResult = { ok: true; path: string } | { ok: false; cancelled: boolean; error?: string };

export type Lang = 'en' | 'ru';

export interface Settings {
  lang: Lang;
  /** Последняя выбранная папка игры. */
  gameDir?: string;
  /** Недавно открытые моды. */
  recent: string[];
}

export interface KeditApi {
  detectGames(): Promise<GameInstallInfo[]>;
  /** Диалог выбора папки игры; null — отменено или в папке нет игры. */
  chooseGameDir(): Promise<GameInstallInfo | { error: string } | null>;
  listMods(game: GameInstallInfo): Promise<ModEntry[]>;
  /** Диалог выбора файла .mod. */
  chooseModFile(game: GameInstallInfo): Promise<string | null>;
  openProject(req: ProjectRequest): Promise<ProjectBundle>;
  /** Диалог «Сохранить как». */
  chooseSavePath(defaultPath: string): Promise<string | null>;
  /** Записать мод. В папку игры/мастерской — только после подтверждения в диалоге main. */
  saveMod(req: SaveRequest): Promise<SaveResult>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Есть ли несохранённые изменения (main спросит при закрытии окна). */
  setDirty(dirty: boolean, title: string): void;
}

export const IPC = {
  detectGames: 'kedit:detect-games',
  chooseGameDir: 'kedit:choose-game-dir',
  listMods: 'kedit:list-mods',
  chooseModFile: 'kedit:choose-mod-file',
  openProject: 'kedit:open-project',
  chooseSavePath: 'kedit:choose-save-path',
  saveMod: 'kedit:save-mod',
  getSettings: 'kedit:get-settings',
  setSettings: 'kedit:set-settings',
  setDirty: 'kedit:set-dirty',
} as const;
