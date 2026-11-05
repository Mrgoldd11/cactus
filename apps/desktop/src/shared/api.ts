/**
 * Договор между окном (renderer) и главным процессом (main). Окно не трогает файлы само:
 * всё чтение и запись — через эти вызовы, main выполняет их и спрашивает подтверждение,
 * если запись идёт в папку игры или мастерской.
 */
import type { LiveRequestBody } from '@kenshi-editor/core';

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

export interface WorldFileBytes {
  /** Слой (имя .mod), из которого файл. */
  layer: string;
  /** Имя файла в папке `leveldata` (`zone.42.22.zone`). */
  path: string;
  bytes: Uint8Array;
}

export interface WorldRequest {
  game: GameInstallInfo;
  /** Файлы .mod (зависимости по порядку, затем сам мод), чьи папки `leveldata` наложить. */
  modPaths: string[];
}

/** Живая связь с ИИ (MCP): сервер в main, запросы выполняет окно. */
export interface LiveStatus {
  /** Порт на 127.0.0.1; нет — сервер не запущен (см. error). */
  port?: number;
  /** Подключённые клиенты (MCP-серверы ИИ). */
  clients: { id: number; name: string; since: number }[];
  error?: string;
}

export type LiveReply = { ok: true; result: unknown } | { ok: false; error: string };

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
  /** Байты файлов уровня (города, здания, зоны) ванили и модов — для «Где в игре». */
  loadWorld(req: WorldRequest): Promise<WorldFileBytes[]>;
  /** Иконка предмета (поле `icon`, путь относительно папки игры) как data URL; null — нет файла. */
  readIcon(game: GameInstallInfo, iconPath: string): Promise<string | null>;
  /** Байты перевода текстов записей `locale/ru_RU/ru_RU.translation` (реплики); null — нет файла. */
  readTranslation(game: GameInstallInfo): Promise<Uint8Array | null>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Есть ли несохранённые изменения (main спросит при закрытии окна). */
  setDirty(dirty: boolean, title: string): void;
  /** Обработчик запросов ИИ к открытому проекту (один на окно; новый заменяет прежний). */
  onLiveRequest(handler: (req: LiveRequestBody) => LiveReply): void;
  getLiveStatus(): Promise<LiveStatus>;
  /** Подписка на состояние живой связи; вернёт отписку. */
  onLiveStatus(cb: (s: LiveStatus) => void): () => void;
}

export const IPC = {
  detectGames: 'kedit:detect-games',
  chooseGameDir: 'kedit:choose-game-dir',
  listMods: 'kedit:list-mods',
  chooseModFile: 'kedit:choose-mod-file',
  openProject: 'kedit:open-project',
  chooseSavePath: 'kedit:choose-save-path',
  saveMod: 'kedit:save-mod',
  loadWorld: 'kedit:load-world',
  readIcon: 'kedit:read-icon',
  readTranslation: 'kedit:read-translation',
  getSettings: 'kedit:get-settings',
  setSettings: 'kedit:set-settings',
  setDirty: 'kedit:set-dirty',
  liveRequest: 'kedit:live-request',
  liveResponse: 'kedit:live-response',
  liveStatus: 'kedit:live-status',
  getLiveStatus: 'kedit:get-live-status',
} as const;
