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
  /** Номер предмета мастерской (папка), если мод оттуда. */
  workshopId?: string;
  /** Есть в `mods.cfg`. */
  enabled?: boolean;
  /** Такой же файл есть в `mods/`, игра возьмёт его, а не этот. */
  shadowedBy?: string;
  /** Копия чужого мода (`.kedit-origin.json`): номер мастерской оригинала или путь к нему. */
  copyOf?: string;
  error?: string;
}

export interface ProjectRequest {
  game: GameInstallInfo;
  /** Существующий .mod; если не задан — новый мод `modName`. */
  modPath?: string;
  modName?: string;
  /** Зависимости (имена .mod); по умолчанию — из заголовка мода. */
  dependencies?: string[];
  /** Другие моды слоями под модом (по порядку `mods.cfg`), без записи в его заголовок. */
  contextMods?: string[];
  /** Ключи файлов, уже разобранных в окне (`ParsedFileCache`): их байты не присылаются. */
  known?: string[];
}

export interface NamedBytes {
  name: string;
  path: string;
  /** Пусто, если файл есть в кэше окна под ключом `key`. */
  bytes: Uint8Array;
  /** Ключ кэша (путь, размер, время изменения) — у ванили и зависимостей. */
  key?: string;
}

/** Откуда файл мода: из мастерской (только чтение) или копия чужого мода. */
export interface ModProvenance {
  /** Файл в мастерской Steam: сохранить в него нельзя, только в копию в `mods/`. */
  inWorkshop?: boolean;
  workshopId?: string;
  /** Копия чужого мода (файл `<имя>.kedit-origin.json` рядом). */
  copyOf?: {
    source: string;
    workshopId?: string;
    author?: string;
    copiedAt: string;
    /** Оригинал изменился после копирования (автор обновил мод). */
    changed?: boolean;
    /** Оригинала больше нет. */
    gone?: boolean;
  };
}

/** Копия чужого мода для правки (после подтверждения в диалоге main). */
export type CopyModResult = { ok: true; path: string; provenance?: ModProvenance } | { ok: false; cancelled: boolean; error?: string };

/** Всё, что нужно окну, чтобы собрать контекст редактирования. */
export interface ProjectBundle {
  game: GameInstallInfo;
  modName: string;
  /** Файл мода, если он уже есть на диске. */
  mod?: NamedBytes;
  vanilla: NamedBytes[];
  dependencies: NamedBytes[];
  missingDependencies: string[];
  /** Какие из `dependencies` — моды контекста (не записаны в заголовке мода). */
  contextMods?: string[];
  schema: { fcsDef: string; fcsEnums?: string; fcsLayout?: string };
  /** Русский перевод `locale/ru_RU/gamedata.po`. */
  po?: string;
  /** Путь сохранения по умолчанию для нового мода. */
  suggestedPath: string;
  /** Откуда открытый мод (мастерская, копия). */
  provenance?: ModProvenance;
  /** Файл слияния `<имя>.kedit-merge.json` рядом с модом (текст), если он есть. */
  mergeStore?: string;
}

export interface SaveRequest {
  path: string;
  bytes: Uint8Array;
  /** Решения слияния: main пишет их рядом с модом в `<имя>.kedit-merge.json` (не в .mod). */
  mergeStore?: string;
  /**
   * Файлы уровня мода (`zone.X.Y.zone`, `leveldata.level`, `interiors.level`): main пишет их в
   * `leveldata` рядом с модом — только имя файла, без папок.
   */
  world?: { path: string; bytes: Uint8Array }[];
  /** Имя мода и прежний путь — чтобы после сохранения убрать автосохранения этого мода. */
  modName?: string;
  previousPath?: string;
}

/** Мод-источник слияния: байты файла и данные уровня рядом с ним. */
export interface MergeSourceBytes {
  name: string;
  path: string;
  bytes: Uint8Array;
  /** Файлы `leveldata/*.zone|*.level` рядом с источником (слияние их не трогает, только сообщает). */
  levelData?: { dir: string; files: string[] };
}

export type MergeSourceResult = ({ ok: true } & MergeSourceBytes) | { ok: false; error: string };

/** Запись `mods.cfg`: `stale` — файл изменился на диске, пока окно показывало старый порядок. */
export type ModOrderResult =
  | { ok: true; path: string; changed: boolean; backup?: string }
  | { ok: false; cancelled: boolean; error?: string; stale?: boolean };

export type SaveResult =
  | { ok: true; path: string; provenance?: ModProvenance; backupError?: string }
  | { ok: false; cancelled: boolean; error?: string; workshop?: boolean };

export type Lang = 'en' | 'ru';

export interface Settings {
  lang: Lang;
  /** Последняя выбранная папка игры. */
  gameDir?: string;
  /** Недавно открытые моды. */
  recent: string[];
  /** Раскладка рабочего пространства (панели и их места). */
  workspace?: WorkspaceSettings;
  /** Автосохранение раз в столько минут (0 — выключено; по умолчанию 5). */
  autosaveMinutes: number;
  /** Сколько прежних версий мода хранить при сохранении (0 — не хранить; по умолчанию 5). */
  backupCount: number;
}

/** Мод для автосохранения и копий: файл на диске или новый мод по имени. */
export interface ModRef {
  path?: string | undefined;
  modName: string;
}

/** Автосохранение новее мода: предложить восстановить. */
export interface RecoveryInfo {
  /** Когда записано автосохранение (мс). */
  savedAt: number;
  size: number;
  /** Файл мода на диске есть; его время и размер. */
  modExists: boolean;
  modTime?: number;
  modSize?: number;
}

export type AutosaveResult = { ok: true; savedAt: number; size: number } | { ok: false; error: string };

/** Версия мода из резервных копий. */
export interface BackupItem {
  /** `autosave` или имя файла копии. */
  id: string;
  kind: 'backup' | 'autosave' | 'restore-point';
  /** Мс с 1970: когда создана копия (для `backup` — когда её заменили новой версией). */
  time: number;
  size: number;
}

export type ExportBackupResult = { ok: true; path: string } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: string };

export interface WorkspaceSettings {
  /** Снимок раскладки dockview (`toJSON`). */
  layout?: unknown;
  /** Последняя выбранная готовая раскладка: её ставит «Сбросить раскладку». */
  preset?: string;
}

export interface WorldFileBytes {
  /** Слой (имя .mod), из которого файл. */
  layer: string;
  /** Имя файла в папке `leveldata` (`zone.42.22.zone`). */
  path: string;
  /** Пусто, если файл есть в кэше окна под ключом `key`. */
  bytes: Uint8Array;
  key: string;
}

export interface WorldRequest {
  game: GameInstallInfo;
  /** Файлы .mod (зависимости по порядку, затем сам мод), чьи папки `leveldata` наложить. */
  modPaths: string[];
  /** Ключи файлов, уже разобранных в окне. */
  known?: string[];
  /** Только интерьеры (`interiors.level`): они большие, их читают по запросу панели «Внутри». */
  interiors?: boolean;
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

/** Текстовый файл (выгрузка перевода): CSV, JSON или PO. */
export type TextFileKind = 'csv' | 'json' | 'po';

export type SaveTextResult = { ok: true; path: string } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: string };

/** Связь с игрой через плагин Kenshi Bridge (RE_Kenshi). */
export interface GameLinkStatus {
  /** Плагин отвечает. */
  connected: boolean;
  /** Игра в мире (не в меню и не на загрузке). */
  inGame: boolean;
  version?: string;
}

export type GameReply = { ok: true; result: unknown } | { ok: false; code: string; message: string };

/** Команды плагина, которые окно может отправить (через main). */
export const GAME_COMMANDS = ['state', 'camera', 'teleport', 'speed', 'pause', 'trace', 'trace_get'] as const;
export type GameCommand = (typeof GAME_COMMANDS)[number];

export interface KeditApi {
  detectGames(): Promise<GameInstallInfo[]>;
  /** Диалог выбора папки игры; null — отменено или в папке нет игры. */
  chooseGameDir(): Promise<GameInstallInfo | { error: string } | null>;
  listMods(game: GameInstallInfo): Promise<ModEntry[]>;
  /** Порядок `data/mods.cfg` как есть. */
  readModOrder(game: GameInstallInfo): Promise<string[]>;
  /**
   * Записать новый порядок `mods.cfg` — только после подтверждения в диалоге main; копия рядом,
   * игра и лаунчер должны быть закрыты. `expected` — порядок, от которого шли правки.
   */
  writeModOrder(game: GameInstallInfo, names: string[], expected: string[]): Promise<ModOrderResult>;
  /** Диалог выбора файла .mod. */
  chooseModFile(game: GameInstallInfo): Promise<string | null>;
  openProject(req: ProjectRequest): Promise<ProjectBundle>;
  /** Диалог «Сохранить как». */
  chooseSavePath(defaultPath: string): Promise<string | null>;
  /** Записать мод. В папку игры — только после подтверждения в диалоге main; в мастерскую — никогда. */
  saveMod(req: SaveRequest): Promise<SaveResult>;
  /** Прочитать мод-источник слияния (.mod / .base по пути): байты и данные уровня рядом. Только чтение. */
  readMergeSource(path: string): Promise<MergeSourceResult>;
  /** Скопировать чужой мод в `mods/<имя>/<имя>.mod` для правки (main спросит подтверждение). */
  copyModForEditing(game: GameInstallInfo, path: string): Promise<CopyModResult>;
  /** Байты файлов уровня (города, здания, зоны) ванили и модов — для «Где в игре». */
  loadWorld(req: WorldRequest): Promise<WorldFileBytes[]>;
  /**
   * Байты файла модели или текстуры (`.mesh`, `.dds`, `.png`, `.material`) по пути из записи
   * (`.\data\items\a.mesh`, относительно папки игры). Только чтение и только внутри папки игры
   * или мастерской; иначе null.
   */
  readGameAsset(game: GameInstallInfo, relPath: string): Promise<Uint8Array | null>;
  /**
   * Тайл рельефа (квадродерево карты высот `fullmap.tif`): 129×129 значений карты высот.
   * null — нет карты высот в папке игры.
   */
  readTerrainTile(game: GameInstallInfo, level: number, tx: number, ty: number): Promise<Uint16Array | null>;
  /** Диалог «Сохранить» и запись картинки PNG (иконка). В папку игры и мастерской не пишет — `game-folder`. */
  savePngFile(defaultName: string, png: Uint8Array): Promise<SaveTextResult>;
  /** Иконка предмета (поле `icon`, путь относительно папки игры) как data URL; null — нет файла. */
  readIcon(game: GameInstallInfo, iconPath: string): Promise<string | null>;
  /**
   * Диалог «Сохранить» и запись текста (UTF-8). В папку игры и мастерской не пишет — ошибка
   * `game-folder` (выгрузка перевода — рабочий файл, ему там не место).
   */
  saveTextFile(defaultName: string, kind: TextFileKind, text: string): Promise<SaveTextResult>;
  /** Диалог «Открыть» для CSV/JSON/PO и текст файла; null — отменено. */
  openTextFile(): Promise<{ path: string; text: string } | { error: string } | null>;
  /** Байты перевода текстов записей `locale/ru_RU/ru_RU.translation` (реплики); null — нет файла. */
  readTranslation(game: GameInstallInfo): Promise<Uint8Array | null>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /**
   * Записать автосохранение мода в папку данных приложения (не в мод, не в игру, не в мастерскую).
   * Окно зовёт только когда есть несохранённые правки.
   */
  autosave(ref: ModRef, bytes: Uint8Array): Promise<AutosaveResult>;
  /** Убрать автосохранение (правок больше нет или от них отказались). */
  autosaveClear(ref: ModRef): Promise<void>;
  /** Есть ли автосохранение новее мода (или мода на диске нет): предложить восстановить. */
  findRecovery(ref: ModRef): Promise<RecoveryInfo | null>;
  /** Байты автосохранения для восстановления. */
  readAutosave(ref: ModRef): Promise<Uint8Array | null>;
  /** «Открыть как есть»: автосохранение уходит в список резервных копий мода. */
  keepAutosave(ref: ModRef): Promise<void>;
  /** Автосохранение и резервные копии мода, новые сверху. */
  listBackups(ref: ModRef): Promise<BackupItem[]>;
  readBackup(ref: ModRef, id: string): Promise<Uint8Array | null>;
  /** Точка возврата: текущее состояние уходит в копии перед восстановлением старой версии. */
  addRestorePoint(ref: ModRef, bytes: Uint8Array): Promise<void>;
  /** Диалог «Сохранить» и запись копии как отдельного файла (в игре — с подтверждением, в мастерской — никогда). */
  exportBackup(ref: ModRef, id: string): Promise<ExportBackupResult>;
  /** Есть ли несохранённые изменения (main спросит при закрытии окна). */
  setDirty(dirty: boolean, title: string): void;
  /** Обработчик запросов ИИ к открытому проекту (один на окно; новый заменяет прежний). */
  onLiveRequest(handler: (req: LiveRequestBody) => LiveReply): void;
  getLiveStatus(): Promise<LiveStatus>;
  /** Подписка на состояние живой связи; вернёт отписку. */
  onLiveStatus(cb: (s: LiveStatus) => void): () => void;
  getGameStatus(): Promise<GameLinkStatus>;
  /** Подписка на связь с игрой; вернёт отписку. */
  onGameStatus(cb: (s: GameLinkStatus) => void): () => void;
  /** Команда плагину игры (main пропускает только `GAME_COMMANDS`). */
  gameRequest(cmd: GameCommand, args?: object): Promise<GameReply>;
}

export const IPC = {
  detectGames: 'kedit:detect-games',
  chooseGameDir: 'kedit:choose-game-dir',
  listMods: 'kedit:list-mods',
  readModOrder: 'kedit:read-mod-order',
  writeModOrder: 'kedit:write-mod-order',
  chooseModFile: 'kedit:choose-mod-file',
  openProject: 'kedit:open-project',
  chooseSavePath: 'kedit:choose-save-path',
  saveMod: 'kedit:save-mod',
  copyModForEditing: 'kedit:copy-mod-for-editing',
  readMergeSource: 'kedit:read-merge-source',
  loadWorld: 'kedit:load-world',
  readIcon: 'kedit:read-icon',
  readGameAsset: 'kedit:read-game-asset',
  readTerrainTile: 'kedit:read-terrain-tile',
  savePngFile: 'kedit:save-png-file',
  readTranslation: 'kedit:read-translation',
  saveTextFile: 'kedit:save-text-file',
  openTextFile: 'kedit:open-text-file',
  getSettings: 'kedit:get-settings',
  setSettings: 'kedit:set-settings',
  setDirty: 'kedit:set-dirty',
  autosave: 'kedit:autosave',
  autosaveClear: 'kedit:autosave-clear',
  findRecovery: 'kedit:find-recovery',
  readAutosave: 'kedit:read-autosave',
  keepAutosave: 'kedit:keep-autosave',
  listBackups: 'kedit:list-backups',
  readBackup: 'kedit:read-backup',
  addRestorePoint: 'kedit:add-restore-point',
  exportBackup: 'kedit:export-backup',
  liveRequest: 'kedit:live-request',
  liveResponse: 'kedit:live-response',
  liveStatus: 'kedit:live-status',
  getLiveStatus: 'kedit:get-live-status',
  gameStatus: 'kedit:game-status',
  getGameStatus: 'kedit:get-game-status',
  gameRequest: 'kedit:game-request',
} as const;
