/**
 * Contract between the window (renderer) and the main process (main). The window does not touch files itself:
 * all reading and writing goes through these calls, main executes them and asks for confirmation
 * if the write goes into the game or Workshop folder.
 */
import type { ExtensionLayer, LiveRequestBody, UploaderMessage, WorkshopInfo } from '@kenshi-editor/core';

export type GameSource = 'config' | 'steam' | 'gog' | 'manual';

export interface GameInstallInfo {
  kenshi: string;
  workshop: string;
  source: GameSource;
}

/** Zone of the world dump; `stamp` changes when the plugin rewrites the file. */
export interface WorldDumpZone {
  x: number;
  y: number;
  stamp: string;
}

/** What the Kenshi Bridge plugin has dumped of the game world (same shape as core's GameDumpIndex). */
export interface WorldDumpIndex {
  dir: string;
  foliage: WorldDumpZone[];
  buildings: WorldDumpZone[];
}

export interface ModEntry {
  /** File name (`My mod.mod`). */
  fileName: string;
  path: string;
  source: 'mods' | 'workshop' | 'other';
  author?: string;
  description?: string;
  dependencies?: string[];
  references?: string[];
  recordCount?: number;
  /** Place in `data/mods.cfg` (from 0), if the mod is enabled. */
  loadIndex?: number;
  /** Workshop item number (folder), if the mod comes from there. */
  workshopId?: string;
  /** Present in `mods.cfg`. */
  enabled?: boolean;
  /** The same file exists in `mods/`; the game takes that one, not this. */
  shadowedBy?: string;
  /** Copy of someone else's mod (`.kedit-origin.json`): the original's Workshop number or its path. */
  copyOf?: string;
  error?: string;
}

export interface ProjectRequest {
  game: GameInstallInfo;
  /** Existing .mod; if not set — a new mod `modName`. */
  modPath?: string;
  modName?: string;
  /** Dependencies (.mod names); by default — from the mod header. */
  dependencies?: string[];
  /** Other mods layered under the mod (in `mods.cfg` order), not written into its header. */
  contextMods?: string[];
  /**
   * Path of the mod file when the window keeps the mod itself and sends no `modPath` (other
   * dependencies, a restored version): its folder is still searched for schema extensions.
   */
  extensionsOf?: string;
  /** Keys of files already parsed in the window (`ParsedFileCache`): their bytes are not sent. */
  known?: string[];
  /** Data language: `gamedata.po` of this game locale comes in the bundle. */
  dataLocale?: string;
}

export interface NamedBytes {
  name: string;
  path: string;
  /** Empty if the file is in the window cache under key `key`. */
  bytes: Uint8Array;
  /** Cache key (path, size, modification time) — for vanilla and dependencies. */
  key?: string;
}

/** Where the mod file comes from: the Workshop (read only) or a copy of someone else's mod. */
export interface ModProvenance {
  /** File in the Steam Workshop: it cannot be saved to, only to a copy in `mods/`. */
  inWorkshop?: boolean;
  workshopId?: string;
  /** Copy of someone else's mod (file `<name>.kedit-origin.json` next to it). */
  copyOf?: {
    source: string;
    workshopId?: string;
    author?: string;
    copiedAt: string;
    /** The original changed after copying (the author updated the mod). */
    changed?: boolean;
    /** The original no longer exists. */
    gone?: boolean;
  };
}

/** Copy of someone else's mod for editing (after confirmation in the main dialog). */
export type CopyModResult = { ok: true; path: string; provenance?: ModProvenance } | { ok: false; cancelled: boolean; error?: string };

/** Everything the window needs to build the editing context. */
export interface ProjectBundle {
  game: GameInstallInfo;
  modName: string;
  /** Mod file, if it already exists on disk. */
  mod?: NamedBytes;
  vanilla: NamedBytes[];
  dependencies: NamedBytes[];
  missingDependencies: string[];
  /** Which of `dependencies` are context mods (not written in the mod header). */
  contextMods?: string[];
  schema: { fcsDef: string; fcsEnums?: string; fcsLayout?: string };
  /**
   * Schema extensions (FCS Extended files: `fcs.def`, `fcs_preload.def`, `*.def.patch`) of the
   * mod folder and of the folders of its dependencies, in load order, with the texts of their
   * files. The window applies them on top of `schema`. Absent when there are none.
   */
  extensions?: ExtensionLayer[];
  /** `locale/<dataLocale>/gamedata.po` (translated record names), if requested and present. */
  po?: string;
  /** Locale of `po`. */
  dataLocale?: string;
  /** Default save path for a new mod. */
  suggestedPath: string;
  /** Where the open mod comes from (Workshop, copy). */
  provenance?: ModProvenance;
  /** Merge file `<name>.kedit-merge.json` next to the mod (text), if present. */
  mergeStore?: string;
}

export interface SaveRequest {
  path: string;
  bytes: Uint8Array;
  /** Merge decisions: main writes them next to the mod in `<name>.kedit-merge.json` (not into the .mod). */
  mergeStore?: string;
  /**
   * Mod level files (`zone.X.Y.zone`, `leveldata.level`, `interiors.level`): main writes them into
   * `leveldata` next to the mod — file name only, no folders.
   */
  world?: { path: string; bytes: Uint8Array }[];
  /** Mod name and previous path — to remove this mod's autosaves after saving. */
  modName?: string;
  previousPath?: string;
}

/** Merge source mod: file bytes and the level data next to it. */
export interface MergeSourceBytes {
  name: string;
  path: string;
  bytes: Uint8Array;
  /** `leveldata/*.zone|*.level` files next to the source (the merge does not touch them, only reports them). */
  levelData?: { dir: string; files: string[] };
}

export type MergeSourceResult = ({ ok: true } & MergeSourceBytes) | { ok: false; error: string };

/** `mods.cfg` write: `stale` — the file changed on disk while the window showed the old order. */
export type ModOrderResult =
  | { ok: true; path: string; changed: boolean; backup?: string }
  | { ok: false; cancelled: boolean; error?: string; stale?: boolean };

export type SaveResult =
  | { ok: true; path: string; provenance?: ModProvenance; backupError?: string }
  | { ok: false; cancelled: boolean; error?: string; workshop?: boolean };

/**
 * Interface languages: code, name in the language itself (for the dropdown), locale for dates
 * and numbers, and the game's translation folder (`locale/<gameLocale>`) whose record names
 * follow this language by default. A new language needs one entry here plus its dictionary.
 */
export interface LangInfo {
  code: string;
  name: string;
  locale: string;
  gameLocale?: string;
}

export const LANGS = [
  { code: 'en', name: 'English', locale: 'en-GB' },
  { code: 'ru', name: 'Русский', locale: 'ru-RU', gameLocale: 'ru_RU' },
  { code: 'zh', name: '简体中文', locale: 'zh-CN', gameLocale: 'zh_CN' },
] as const satisfies readonly LangInfo[];

export type Lang = (typeof LANGS)[number]['code'];

export const isLang = (v: unknown): v is Lang => LANGS.some((l) => l.code === v);
/** Locale for formatting dates and numbers in the UI language. */
export const LOCALE = Object.fromEntries(LANGS.map((l) => [l.code, l.locale])) as Record<Lang, string>;

/** `Settings.dataLocale`: follow the interface language. */
export const DATA_LOCALE_AUTO = 'auto';
/** `Settings.dataLocale`: no translation, English originals only. */
export const DATA_LOCALE_NONE = 'none';

/**
 * Data language: the game locale (`de_DE`) whose record names and texts are shown next to the
 * originals; undefined — none. `choice` is `Settings.dataLocale`.
 */
export function dataLocaleFor(lang: Lang, choice: string | undefined): string | undefined {
  if (choice === DATA_LOCALE_NONE) return undefined;
  if (choice !== undefined && choice !== '' && choice !== DATA_LOCALE_AUTO) return choice;
  const list: readonly LangInfo[] = LANGS;
  return list.find((x) => x.code === lang)?.gameLocale;
}

/** A translation folder of the game (`locale/<code>`). */
export interface GameLocaleInfo {
  code: string;
  /** `gamedata.po` exists (record names). */
  names: boolean;
  /** `<code>.translation` exists (dialogue lines and other texts). */
  texts: boolean;
}

export interface Settings {
  lang: Lang;
  /**
   * Language of game data (record names, texts): `auto` (default) — follows `lang`, `none` —
   * originals only, or a locale folder of the game (`de_DE`).
   */
  dataLocale?: string;
  /** Last chosen game folder. */
  gameDir?: string;
  /** Recently opened mods. */
  recent: string[];
  /** Workspace layout (panels and their places). */
  workspace?: WorkspaceSettings;
  /** Autosave every this many minutes (0 — off; default 5). */
  autosaveMinutes: number;
  /** How many previous mod versions to keep on save (0 — none; default 5). */
  backupCount: number;
}

/** Mod for autosaves and backups: a file on disk or a new mod by name. */
export interface ModRef {
  path?: string | undefined;
  modName: string;
}

/** Autosave newer than the mod: offer to restore. */
export interface RecoveryInfo {
  /** When the autosave was written (ms). */
  savedAt: number;
  size: number;
  /** The mod file exists on disk; its time and size. */
  modExists: boolean;
  modTime?: number;
  modSize?: number;
}

export type AutosaveResult = { ok: true; savedAt: number; size: number } | { ok: false; error: string };

/** Mod version from backups. */
export interface BackupItem {
  /** `autosave` or the backup file name. */
  id: string;
  kind: 'backup' | 'autosave' | 'restore-point';
  /** Ms since 1970: when the backup was created (for `backup` — when it was replaced by a newer version). */
  time: number;
  size: number;
}

export type ExportBackupResult = { ok: true; path: string } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: string };

export interface WorkspaceSettings {
  /** dockview layout snapshot (`toJSON`). */
  layout?: unknown;
  /** Last chosen preset layout: «Reset layout» applies it. */
  preset?: string;
}

export interface WorldFileBytes {
  /** Layer (.mod name) the file comes from. */
  layer: string;
  /** File name in the `leveldata` folder (`zone.42.22.zone`). */
  path: string;
  /** Empty if the file is in the window cache under key `key`. */
  bytes: Uint8Array;
  key: string;
}

export interface WorldRequest {
  game: GameInstallInfo;
  /** .mod files (dependencies in order, then the mod itself) whose `leveldata` folders to overlay. */
  modPaths: string[];
  /** Keys of files already parsed in the window. */
  known?: string[];
  /** Interiors only (`interiors.level`): they are big and read on request of the «Inside» panel. */
  interiors?: boolean;
}

/** Live AI link (MCP): server in main, the window executes requests. */
export interface LiveStatus {
  /** Port on 127.0.0.1; absent — the server is not running (see error). */
  port?: number;
  /** Connected clients (AI MCP servers). */
  clients: { id: number; name: string; since: number }[];
  error?: string;
}

export type LiveReply = { ok: true; result: unknown } | { ok: false; error: string };

/** Text file (translation export): CSV, JSON or PO. */
export type TextFileKind = 'csv' | 'json' | 'po';

export type SaveTextResult = { ok: true; path: string } | { ok: false; cancelled: true } | { ok: false; cancelled: false; error: string };

/** Game link via the Kenshi Bridge plugin (RE_Kenshi). */
export interface GameLinkStatus {
  /** The plugin answers. */
  connected: boolean;
  /** The game is in the world (not in the menu and not loading). */
  inGame: boolean;
  version?: string;
}

export type GameReply = { ok: true; result: unknown } | { ok: false; code: string; message: string };

/** Plugin commands the window may send (via main). */
export const GAME_COMMANDS = ['state', 'camera', 'teleport', 'spawn', 'speed', 'pause', 'towns', 'trace', 'trace_get'] as const;
export type GameCommand = (typeof GAME_COMMANDS)[number];

/** Preview picture of a Workshop item. */
export interface PublishPreview {
  path: string;
  size: number;
  format: 'png' | 'jpeg' | 'gif' | null;
  /** Thumbnail to show (absent for huge or non-picture files). */
  dataUrl?: string;
}

/** What the publish window needs from disk (read-only; nothing reaches Steam). */
export interface PublishPrep {
  location: 'mods' | 'workshop' | 'other';
  modName: string;
  /** `_<mod>.info`, if it exists and reads. */
  info: WorkshopInfo | null;
  infoState: 'missing' | 'ok' | 'unreadable';
  infoError?: string;
  /** Existing `_<mod>.img`. */
  preview: PublishPreview | null;
  imgPath: string;
  files: { rel: string; size: number }[];
  excluded: { rel: string; size: number; reason: 'cactus' | 'backup' | 'temp' | 'system' | 'vcs' }[];
  totalSize: number;
  copyOf?: { workshopId?: string };
  /** Fake Steam scenario (`KEDIT_FAKE_STEAM`), `null` — the real Steam would be used. */
  fake: string | null;
  /** A Steam process runs on this computer (`null` — could not tell). */
  steamRunning: boolean | null;
  appId: number;
  logPath: string;
}

export interface PublishStartRequest {
  modPath: string;
  title: string;
  description: string;
  changeNote: string;
  tags: string[];
  visibility: number;
  previewPath: string;
  expectedId: string;
}

export type PublishStartResult = { ok: true } | { ok: false; reason: 'no-window' | 'busy' | 'not-in-mods' | 'bad-request' | 'no-uploader' | 'spawn-failed' };

/** Kinds of files a mod brings from Blender. */
export type ModAssetKind = 'skeleton' | 'mesh' | 'texture';

/** A file the user picked in the «Open» dialog. */
export interface PickedModAsset {
  path: string;
  name: string;
  bytes: Uint8Array;
  /**
   * For a `.mesh`: files found next to it — the `.skeleton` it links by name, `<stem>.dds`/`.png` and
   * `<stem>_n.dds` (normal map). They count as picked too (can be copied into the mod).
   */
  linked?: { skeleton?: PickedModAsset; texture?: PickedModAsset; normalMap?: PickedModAsset };
}

export interface ImportModAssetRequest {
  game: GameInstallInfo;
  /** The mod file (saved or the suggested path of a new mod). */
  modPath: string;
  /** Folder inside the mod folder: `animations`. */
  sub: string;
  /** Path returned by `chooseModAsset`. */
  source: string;
  /** A different file of the same name is already there: ask (→ `conflict`), replace it or copy as `name_2`. */
  onConflict: 'ask' | 'replace' | 'rename';
}

export type ImportModAssetResult =
  | { ok: true; status: 'copied' | 'same' | 'replaced'; fileName: string; recordPath: string }
  | { ok: false; error: 'conflict' | 'not-in-mods' | 'bad-file' | 'io'; existing?: string; message?: string };

export interface KeditApi {
  detectGames(): Promise<GameInstallInfo[]>;
  /** Game folder picker dialog; null — cancelled or there is no game in the folder. */
  chooseGameDir(): Promise<GameInstallInfo | { error: string } | null>;
  listMods(game: GameInstallInfo): Promise<ModEntry[]>;
  /** `data/mods.cfg` order as is. */
  readModOrder(game: GameInstallInfo): Promise<string[]>;
  /**
   * Write a new `mods.cfg` order — only after confirmation in the main dialog; a copy is kept next to it,
   * the game and the launcher must be closed. `expected` — the order the edits started from.
   */
  writeModOrder(game: GameInstallInfo, names: string[], expected: string[]): Promise<ModOrderResult>;
  /** .mod file picker dialog. */
  chooseModFile(game: GameInstallInfo): Promise<string | null>;
  openProject(req: ProjectRequest): Promise<ProjectBundle>;
  /** «Save as» dialog. */
  chooseSavePath(defaultPath: string): Promise<string | null>;
  /** Write the mod. Into the game folder — only after confirmation in the main dialog; into the Workshop — never. */
  saveMod(req: SaveRequest): Promise<SaveResult>;
  /** Read the merge source mod (.mod / .base by path): bytes and the level data next to it. Read only. */
  readMergeSource(path: string): Promise<MergeSourceResult>;
  /** Copy someone else's mod to `mods/<name>/<name>.mod` for editing (main asks for confirmation). */
  copyModForEditing(game: GameInstallInfo, path: string): Promise<CopyModResult>;
  /** Bytes of level files (towns, buildings, zones) of vanilla and mods — for «Where in game». */
  loadWorld(req: WorldRequest): Promise<WorldFileBytes[]>;
  /**
   * Bytes of a model or texture file (`.mesh`, `.dds`, `.png`, `.material`) by the path from a record
   * (`.\data\items\a.mesh`, relative to the game folder). Read only and only inside the game folder
   * or the Workshop; otherwise null.
   */
  readGameAsset(game: GameInstallInfo, relPath: string): Promise<Uint8Array | null>;
  /** Zones of the world dump made by the Kenshi Bridge plugin in the running game (foliage, buildings). */
  listWorldDump(): Promise<WorldDumpIndex>;
  /** One zone file of that dump, or null. */
  readWorldDump(kind: 'foliage' | 'buildings', x: number, y: number): Promise<Uint8Array | null>;
  /**
   * Terrain tile (quadtree of the `fullmap.tif` heightmap): 129×129 heightmap values.
   * null — no heightmap in the game folder.
   */
  readTerrainTile(game: GameInstallInfo, level: number, tx: number, ty: number): Promise<Uint16Array | null>;
  /**
   * «Open» dialog for a file exported from Blender (skeleton, model, texture) and its bytes; null — cancelled.
   * Only a file picked here can then be copied into the mod (`importModAsset`).
   */
  chooseModAsset(kind: ModAssetKind): Promise<PickedModAsset | { error: string } | null>;
  /** Copy a picked file into `<game>/mods/<mod folder>/<sub>/`; never overwrites without `onConflict: 'replace'`. */
  importModAsset(req: ImportModAssetRequest): Promise<ImportModAssetResult>;
  /** Skeleton link of each model file (by record path); null — no file or no skeleton. */
  meshSkeletonNames(game: GameInstallInfo, paths: string[]): Promise<(string | null)[]>;
  /** «Save» dialog and writing a PNG image (icon). Does not write into the game or Workshop folder — `game-folder`. */
  savePngFile(defaultName: string, png: Uint8Array): Promise<SaveTextResult>;
  /** Item icon (field `icon`, path relative to the game folder) as a data URL; null — no file. */
  readIcon(game: GameInstallInfo, iconPath: string): Promise<string | null>;
  /**
   * «Save» dialog and writing text (UTF-8). Does not write into the game or Workshop folder — error
   * `game-folder` (a translation export is a work file, it does not belong there).
   */
  saveTextFile(defaultName: string, kind: TextFileKind, text: string): Promise<SaveTextResult>;
  /** «Open» dialog for CSV/JSON/PO and the file text; null — cancelled. */
  openTextFile(): Promise<{ path: string; text: string } | { error: string } | null>;
  /** Bytes of `locale/<locale>/<locale>.translation` (dialogue lines and other texts); null — no file. */
  readTranslation(game: GameInstallInfo, locale: string): Promise<Uint8Array | null>;
  /** Text of `locale/<locale>/gamedata.po`; null — no file. */
  readGamedataPo(game: GameInstallInfo, locale: string): Promise<string | null>;
  /** Translation folders of the game. */
  listGameLocales(game: GameInstallInfo): Promise<GameLocaleInfo[]>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /**
   * Write a mod autosave into the app data folder (not into the mod, the game or the Workshop).
   * The window calls it only when there are unsaved edits.
   */
  autosave(ref: ModRef, bytes: Uint8Array): Promise<AutosaveResult>;
  /** Remove the autosave (no edits left, or they were discarded). */
  autosaveClear(ref: ModRef): Promise<void>;
  /** Whether there is an autosave newer than the mod (or no mod on disk): offer to restore. */
  findRecovery(ref: ModRef): Promise<RecoveryInfo | null>;
  /** Autosave bytes for restoring. */
  readAutosave(ref: ModRef): Promise<Uint8Array | null>;
  /** «Open as is»: the autosave goes to the mod backup list. */
  keepAutosave(ref: ModRef): Promise<void>;
  /** Mod autosave and backups, newest first. */
  listBackups(ref: ModRef): Promise<BackupItem[]>;
  readBackup(ref: ModRef, id: string): Promise<Uint8Array | null>;
  /** Restore point: the current state goes to backups before restoring an old version. */
  addRestorePoint(ref: ModRef, bytes: Uint8Array): Promise<void>;
  /** «Save» dialog and writing a backup as a separate file (into the game — with confirmation, into the Workshop — never). */
  exportBackup(ref: ModRef, id: string): Promise<ExportBackupResult>;
  /** Ignored validation problems of the mod (`issueKey` values), kept in the editor's data folder. */
  readIgnoreList(ref: ModRef): Promise<string[]>;
  writeIgnoreList(ref: ModRef, keys: string[]): Promise<void>;
  /** Whether there are unsaved changes (main asks when the window closes). */
  setDirty(dirty: boolean, title: string): void;
  /** Handler of AI requests to the open project (one per window; a new one replaces the previous). */
  onLiveRequest(handler: (req: LiveRequestBody) => LiveReply): void;
  getLiveStatus(): Promise<LiveStatus>;
  /** Subscribe to the live link state; returns the unsubscribe function. */
  onLiveStatus(cb: (s: LiveStatus) => void): () => void;
  getGameStatus(): Promise<GameLinkStatus>;
  /** Subscribe to the game link; returns the unsubscribe function. */
  onGameStatus(cb: (s: GameLinkStatus) => void): () => void;
  /** Command to the game plugin (main lets through only `GAME_COMMANDS`). */
  gameRequest(cmd: GameCommand, args?: object): Promise<GameReply>;
  /** Publish window: read `_<mod>.info`, preview, upload file list, Steam presence. */
  publishPrepare(modPath: string): Promise<PublishPrep>;
  publishChoosePreview(): Promise<PublishPreview | null>;
  /** Preview from a picture dropped on the window; null when it is not a PNG/JPEG/GIF file. */
  publishPreviewFromPath(path: string): Promise<PublishPreview | null>;
  /** Disk path of a dropped file ('' for files that do not come from disk). */
  pathForFile(file: File): string;
  /** Start the uploader process; its messages come through `onPublishEvent`. */
  publishStart(req: PublishStartRequest): Promise<PublishStartResult>;
  publishCancel(): Promise<void>;
  onPublishEvent(cb: (m: UploaderMessage) => void): () => void;
  /** Workshop page in the Steam client (web page if Steam cannot open it). */
  publishOpenPage(id: string): Promise<boolean>;
  publishWebPage(id: string): Promise<boolean>;
  publishCopyLink(id: string): Promise<boolean>;
  publishOpenAgreement(): Promise<void>;
  publishShowLog(): Promise<void>;
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
  listWorldDump: 'kedit:list-world-dump',
  readWorldDump: 'kedit:read-world-dump',
  readTerrainTile: 'kedit:read-terrain-tile',
  savePngFile: 'kedit:save-png-file',
  chooseModAsset: 'kedit:choose-mod-asset',
  importModAsset: 'kedit:import-mod-asset',
  meshSkeletonNames: 'kedit:mesh-skeleton-names',
  readTranslation: 'kedit:read-translation',
  readGamedataPo: 'kedit:read-gamedata-po',
  listGameLocales: 'kedit:list-game-locales',
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
  readIgnoreList: 'kedit:read-ignore-list',
  writeIgnoreList: 'kedit:write-ignore-list',
  liveRequest: 'kedit:live-request',
  liveResponse: 'kedit:live-response',
  liveStatus: 'kedit:live-status',
  getLiveStatus: 'kedit:get-live-status',
  gameStatus: 'kedit:game-status',
  getGameStatus: 'kedit:get-game-status',
  gameRequest: 'kedit:game-request',
  publishPrepare: 'kedit:publish-prepare',
  publishChoosePreview: 'kedit:publish-choose-preview',
  publishPreviewFromPath: 'kedit:publish-preview-from-path',
  publishStart: 'kedit:publish-start',
  publishCancel: 'kedit:publish-cancel',
  publishEvent: 'kedit:publish-event',
  publishOpenPage: 'kedit:publish-open-page',
  publishWebPage: 'kedit:publish-web-page',
  publishCopyLink: 'kedit:publish-copy-link',
  publishOpenAgreement: 'kedit:publish-open-agreement',
  publishShowLog: 'kedit:publish-show-log',
} as const;
