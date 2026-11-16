/**
 * Main process: window, file calls for the window (IPC), confirmation of writes into the game folder,
 * the unsaved-changes question on close, settings in `userData/settings.json`.
 *
 * The core (ModContext) runs in the window: it needs synchronous access to records for a list of
 * tens of thousands of rows, undo and change subscriptions. Main only reads and writes files.
 *
 * Live AI link: main runs a WebSocket server on 127.0.0.1 (discovery file `live.json`
 * in the temp folder, `KEDIT_LIVE_FILE`; `KEDIT_LIVE=0` turns it off) and forwards MCP
 * requests to the window — `LiveHost` executes them on the open project.
 *
 * Window menu — `menu.ts`, error log file — `log.ts`, game bridge (Kenshi Bridge plugin) — `game.ts`.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { describeOrderChange, errorMessage, uiText, type LiveRequestBody } from '@kenshi-editor/core';
import {
  addBackup,
  clearAutosave,
  DEFAULT_AUTOSAVE_MINUTES,
  DEFAULT_BACKUP_COUNT,
  findRecovery,
  keepAutosaveAsBackup,
  listBackups,
  listGameDump,
  loadIgnoreList,
  saveIgnoreList,
  MAX_BACKUP_COUNT,
  readAutosave,
  readBackup,
  readGameDumpFile,
  startLiveServer,
  writeAutosave,
  writeFileAtomic,
  type LiveServer,
  type ModRef,
} from '@kenshi-editor/core/node';
import { initLog, log, watchWindow } from './log.ts';
import { startGameLink, stopGameLink } from './game.ts';
import { APP_TITLE, buildMenu } from './menu.ts';
import { pick } from './tr.ts';
import {
  IPC,
  isLang,
  DATA_LOCALE_AUTO,
  DATA_LOCALE_NONE,
  type GameInstallInfo,
  type LiveReply,
  type AutosaveResult,
  type BackupItem,
  type ExportBackupResult,
  type LiveStatus,
  type RecoveryInfo,
  type CopyModResult,
  type ModOrderResult,
  type ProjectRequest,
  type SaveRequest,
  type SaveResult,
  type SaveTextResult,
  type TextFileKind,
  type Settings,
  type WorldRequest,
} from '../shared/api.ts';
import {
  copyMod,
  detectGames,
  gameFromDir,
  listMods,
  loadProject,
  loadWorldBytes,
  modInstallPath,
  isWorkshopPath,
  needsConfirmation,
  planCopy,
  provenanceOf,
  readGameAsset,
  readIconDataUrl,
  readTerrainTile,
  readMergeSourceBytes,
  readModOrder,
  readTranslationBytes,
  readGamedataPoText,
  listLocales,
  saveDialogDefaultPath,
  writeMod,
  writeModOrder,
} from './service.ts';

// Separate data folder (e2e starts the app with clean settings).
if (process.env['KEDIT_USER_DATA']) app.setPath('userData', process.env['KEDIT_USER_DATA']);

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS: Settings = { lang: 'ru', recent: [], autosaveMinutes: DEFAULT_AUTOSAVE_MINUTES, backupCount: DEFAULT_BACKUP_COUNT };

/** A locale folder name from the window: no path separators or dots. */
function isLocaleCode(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/.test(v);
}

/** Autosave and backup settings are clamped to valid values (the file may have been edited by hand). */
function sanitizeSettings(s: Settings): Settings {
  const minutes = Number.isFinite(s.autosaveMinutes) && s.autosaveMinutes >= 0 ? Math.min(s.autosaveMinutes, 1440) : DEFAULT_AUTOSAVE_MINUTES;
  const count = Number.isFinite(s.backupCount) && s.backupCount >= 0 ? Math.min(Math.floor(s.backupCount), MAX_BACKUP_COUNT) : DEFAULT_BACKUP_COUNT;
  const dataLocale = s.dataLocale === DATA_LOCALE_AUTO || s.dataLocale === DATA_LOCALE_NONE || isLocaleCode(s.dataLocale) ? s.dataLocale : DATA_LOCALE_AUTO;
  return { ...s, lang: isLang(s.lang) ? s.lang : DEFAULT_SETTINGS.lang, dataLocale, autosaveMinutes: minutes, backupCount: count };
}

function loadSettings(): Settings {
  try {
    if (existsSync(settingsPath())) return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>) });
  } catch {
    // Corrupt settings file — start from defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

let settings = loadSettings();

initLog(
  join(app.getPath('userData'), 'logs'),
  `start ${APP_TITLE} ${app.getVersion()}; Electron ${process.versions.electron}; ${process.platform} ${process.arch}; ${app.isPackaged ? 'packaged' : 'dev'}`,
);
let knownGames: GameInstallInfo[] = [];
let currentGame: GameInstallInfo | undefined;
const dirtyWindows = new Map<number, string>();

function windowOf(e: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(e.sender) ?? undefined;
}

function games(): GameInstallInfo[] {
  return [...knownGames, ...(currentGame ? [currentGame] : [])];
}

function isGamePath(path: string): boolean {
  return games().some((g) => needsConfirmation(g, path));
}

const TEXT_FILTERS: Record<TextFileKind, { name: string; extensions: string[] }> = {
  csv: { name: 'CSV (Excel, LibreOffice)', extensions: ['csv'] },
  json: { name: 'JSON', extensions: ['json'] },
  po: { name: 'gettext PO (Poedit)', extensions: ['po'] },
};

/** Translation export: dialog and write; the game folder and the Workshop are refused. */
async function saveTextFile(e: IpcMainInvokeEvent, defaultName: string, kind: TextFileKind, text: string): Promise<SaveTextResult> {
  const win = windowOf(e);
  const opts = { defaultPath: join(app.getPath('documents'), defaultName), filters: [TEXT_FILTERS[kind]] };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  const path = r.filePath;
  if (isGamePath(path) || isWorkshopPath(games(), path)) return { ok: false, cancelled: false, error: 'game-folder' };
  try {
    writeFileSync(path, text, 'utf8');
    return { ok: true, path };
  } catch (err) {
    log('error', 'saveTextFile', path, err);
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function savePngFile(e: IpcMainInvokeEvent, defaultName: string, png: Uint8Array): Promise<SaveTextResult> {
  const win = windowOf(e);
  const opts = { defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: 'PNG', extensions: ['png'] }] };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  const path = r.filePath;
  if (isGamePath(path) || isWorkshopPath(games(), path)) return { ok: false, cancelled: false, error: 'game-folder' };
  try {
    writeFileSync(path, png);
    return { ok: true, path };
  } catch (err) {
    log('error', 'savePngFile', path, err);
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A translation file larger than this is not export text (guard against a wrong pick). */
const MAX_TEXT_FILE = 64 * 1024 * 1024;

async function openTextFile(e: IpcMainInvokeEvent): Promise<{ path: string; text: string } | { error: string } | null> {
  const win = windowOf(e);
  const opts = { properties: ['openFile' as const], defaultPath: app.getPath('documents'), filters: [{ name: 'CSV, JSON, PO', extensions: ['csv', 'json', 'po', 'txt'] }] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const path = r.canceled ? undefined : r.filePaths[0];
  if (path === undefined) return null;
  try {
    if (statSync(path).size > MAX_TEXT_FILE) return { error: 'too-big' };
    return { path, text: readFileSync(path, 'utf8') };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function saveMod(e: IpcMainInvokeEvent, request: SaveRequest): Promise<SaveResult> {
  if (!request.path.toLowerCase().endsWith('.mod')) return { ok: false, cancelled: false, error: 'not a .mod path' };
  const req = { ...request, path: modInstallPath(games(), request.path) };
  // The Workshop holds other people's files (Steam overwrites them on update): only a copy in mods/.
  if (isWorkshopPath(games(), req.path)) return { ok: false, cancelled: false, workshop: true, error: req.path };
  const win = windowOf(e);
  if (isGamePath(req.path)) {
    const lg = settings.lang;
    const options = {
      type: 'warning' as const,
      buttons: pick(lg, { en: ['Write', 'Cancel'], ru: ['Записать', 'Отмена'], zh: ['写入', '取消'] }),
      defaultId: 1,
      cancelId: 1,
      title: pick(lg, { en: 'Writing to the game folder', ru: 'Запись в папку игры', zh: '写入游戏文件夹' }),
      message: pick(lg, { en: 'The file will be written into the game or workshop folder:', ru: 'Файл будет записан в папку игры или мастерской:', zh: '文件将被写入游戏或创意工坊文件夹：' }),
      detail: req.world?.length ? [req.path, ...req.world.map((f) => `leveldata/${f.path}`)].join('\n') : req.path,
    };
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (r.response !== 0) return { ok: false, cancelled: true };
  }
  try {
    const saved = writeMod(req.path, req.bytes, req.mergeStore, req.world ?? [], { dataDir, keep: settings.backupCount });
    // Edits are saved into the mod itself — this mod's autosaves are no longer needed.
    const done: ModRef[] = [{ path: req.path, modName: basename(req.path) }];
    if (request.path !== req.path) done.push({ path: request.path, modName: basename(request.path) });
    if (req.previousPath !== undefined) done.push({ path: req.previousPath, modName: basename(req.previousPath) });
    if (req.modName !== undefined) done.push({ modName: req.modName });
    for (const ref of done) {
      try {
        clearAutosave(dataDir, ref);
      } catch (err) {
        log('error', 'clearAutosave', ref.path ?? ref.modName, err);
      }
    }
    if (win) autosaveRefs.delete(win.id);
    settings.recent = [req.path, ...settings.recent.filter((p) => p !== req.path)].slice(0, 10);
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    const game = games().find((g) => needsConfirmation(g, req.path)) ?? currentGame;
    const provenance = game ? provenanceOf(game, req.path) : undefined;
    return { ok: true, path: req.path, ...(provenance ? { provenance } : {}), ...(saved.backupError !== undefined ? { backupError: saved.backupError } : {}) };
  } catch (err) {
    log('error', 'saveMod', req.path, err);
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Copy of someone else's mod for editing: `mods/<name>/<name>.mod` + origin file. This writes into the game
 * folder — always with confirmation; the original is only read.
 */
async function copyModForEditing(e: IpcMainInvokeEvent, game: GameInstallInfo, path: string): Promise<CopyModResult> {
  const known = games().some((g) => resolve(g.kenshi).toLowerCase() === resolve(game.kenshi).toLowerCase());
  if (!known) return { ok: false, cancelled: false, error: 'unknown game folder' };
  const lg = settings.lang;
  let plan;
  try {
    plan = planCopy(game, path);
  } catch (err) {
    return { ok: false, cancelled: false, error: errorMessage(err, lg) };
  }
  if (plan.error !== undefined) return { ok: false, cancelled: false, error: plan.errorText ? uiText(plan.errorText, lg) : plan.error };
  const options = {
    type: 'warning' as const,
    buttons: pick(lg, { en: ['Copy', 'Cancel'], ru: ['Скопировать', 'Отмена'], zh: ['复制', '取消'] }),
    defaultId: 1,
    cancelId: 1,
    title: pick(lg, { en: 'Copy the mod for editing', ru: 'Копия мода для правки', zh: '复制 Mod 以便编辑' }),
    message: pick(lg, { en: 'Workshop mods are never changed: Steam overwrites them on update. Copy the mod into the game folder and edit the copy?', ru: 'Мод из мастерской не меняем: Steam перезапишет его при обновлении. Скопировать мод в папку игры и править копию?', zh: '创意工坊的 Mod 不会被修改：Steam 在更新时会覆盖它。要把 Mod 复制到游戏文件夹并编辑副本吗？' }),
    detail: [`${pick(lg, { en: 'From', ru: 'Откуда', zh: '来源' })}: ${plan.source}`, `${pick(lg, { en: 'To', ru: 'Куда', zh: '目标' })}: ${plan.dest}`, '', ...plan.warningTexts.map((w) => uiText(w, lg))].join('\n'),
  };
  const win = windowOf(e);
  const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (r.response !== 0) return { ok: false, cancelled: true };
  try {
    return { ok: true, ...copyMod(game, path) };
  } catch (err) {
    log('error', 'copyModForEditing', path, err);
    return { ok: false, cancelled: false, error: errorMessage(err, lg) };
  }
}

/** New `mods.cfg` order: it is a game file — always with confirmation, the game must be closed. */
async function saveModOrder(e: IpcMainInvokeEvent, game: GameInstallInfo, names: string[], expected: string[]): Promise<ModOrderResult> {
  const known = [...knownGames, ...(currentGame ? [currentGame] : [])].some((g) => resolve(g.kenshi).toLowerCase() === resolve(game.kenshi).toLowerCase());
  if (!known) return { ok: false, cancelled: false, error: 'unknown game folder' };
  const lg = settings.lang;
  const changes = describeOrderChange(expected, names, lg);
  if (changes.length === 0) return { ok: true, path: join(game.kenshi, 'data', 'mods.cfg'), changed: false };
  const options = {
    type: 'warning' as const,
    buttons: pick(lg, { en: ['Write', 'Cancel'], ru: ['Записать', 'Отмена'], zh: ['写入', '取消'] }),
    defaultId: 1,
    cancelId: 1,
    title: pick(lg, { en: 'Mod load order', ru: 'Порядок загрузки модов', zh: 'Mod 加载顺序' }),
    message: pick(lg, { en: 'Write the new order into the game file mods.cfg? The game and launcher must be closed; a copy of the old file is kept next to it.', ru: 'Записать новый порядок в файл игры mods.cfg? Игра и лаунчер должны быть закрыты; рядом останется копия прежнего файла.', zh: '要把新的顺序写入游戏文件 mods.cfg 吗？游戏和启动器必须处于关闭状态；旧文件的副本会保留在旁边。' }),
    detail: [join(game.kenshi, 'data', 'mods.cfg'), '', ...changes.slice(0, 30), ...(changes.length > 30 ? [`… +${changes.length - 30}`] : [])].join('\n'),
  };
  const win = windowOf(e);
  const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (r.response !== 0) return { ok: false, cancelled: true };
  try {
    return writeModOrder(game, names, expected);
  } catch (err) {
    log('error', 'writeModOrder', game.kenshi, err);
    return { ok: false, cancelled: false, error: errorMessage(err, lg) };
  }
}

let liveServer: LiveServer | undefined;
let liveStatus: LiveStatus = { clients: [] };
const liveWaits = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let liveRid = 1;

/** AI request — to the project window; the answer comes via `liveResponse`. */
function forwardLive(req: LiveRequestBody): Promise<unknown> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return Promise.reject(new Error('The editor window is closed'));
  const rid = liveRid++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      liveWaits.delete(rid);
      reject(new Error('The editor window did not answer'));
    }, 25_000);
    liveWaits.set(rid, { resolve, reject, timer });
    win.webContents.send(IPC.liveRequest, { rid, req });
  });
}

function pushLiveStatus(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.liveStatus, liveStatus);
}

async function startLive(): Promise<void> {
  if (process.env['KEDIT_LIVE'] === '0') return;
  try {
    liveServer = await startLiveServer({
      handle: forwardLive,
      onClients: (clients) => {
        liveStatus = { ...liveStatus, clients };
        pushLiveStatus();
      },
      app: `Cactus ${app.getVersion()}`,
    });
    liveStatus = { port: liveServer.port, clients: [] };
  } catch (err) {
    liveStatus = { clients: [], error: err instanceof Error ? err.message : String(err) };
  }
  pushLiveStatus();
}

const dataDir = app.getPath('userData');
/** The window's latest autosave (to set it aside in backups if the user discarded the edits). */
const autosaveRefs = new Map<number, ModRef>();

/** Folders autosaves and backups must not be written to: the game and the Workshop. */
function forbiddenDirs(): string[] {
  return games().flatMap((g) => [g.kenshi, g.workshop]);
}

function autosaveNow(e: IpcMainInvokeEvent, ref: ModRef, bytes: Uint8Array): AutosaveResult {
  try {
    const r = writeAutosave(dataDir, ref, bytes, { forbidden: forbiddenDirs() });
    const win = windowOf(e);
    if (win) autosaveRefs.set(win.id, ref);
    return { ok: true, savedAt: r.savedAt, size: r.size };
  } catch (err) {
    log('error', 'autosave', ref.path ?? ref.modName, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function recoveryOf(ref: ModRef): RecoveryInfo | null {
  try {
    return findRecovery(dataDir, ref) ?? null;
  } catch (err) {
    log('error', 'findRecovery', ref.path ?? ref.modName, err);
    return null;
  }
}

/** Copy of a mod from backups as a separate file («Save» dialog). */
async function exportBackup(e: IpcMainInvokeEvent, ref: ModRef, id: string): Promise<ExportBackupResult> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = readBackup(dataDir, ref, id);
  } catch (err) {
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!bytes) return { ok: false, cancelled: false, error: 'no such backup' };
  const win = windowOf(e);
  const name = basename(ref.path ?? ref.modName).replace(/\.mod$/i, '');
  const opts = { defaultPath: join(app.getPath('documents'), `${name} (copy).mod`), filters: [{ name: 'Kenshi mod', extensions: ['mod'] }] };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  const path = r.filePath;
  if (!path.toLowerCase().endsWith('.mod')) return { ok: false, cancelled: false, error: 'not a .mod path' };
  if (isWorkshopPath(games(), path)) return { ok: false, cancelled: false, error: 'game-folder' };
  if (isGamePath(path)) {
    const lg = settings.lang;
    const options = {
      type: 'warning' as const,
      buttons: pick(lg, { en: ['Write', 'Cancel'], ru: ['Записать', 'Отмена'], zh: ['写入', '取消'] }),
      defaultId: 1,
      cancelId: 1,
      title: pick(lg, { en: 'Writing to the game folder', ru: 'Запись в папку игры', zh: '写入游戏文件夹' }),
      message: pick(lg, { en: 'The file will be written into the game folder:', ru: 'Файл будет записан в папку игры:', zh: '文件将被写入游戏文件夹：' }),
      detail: path,
    };
    const c = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (c.response !== 0) return { ok: false, cancelled: true };
  }
  try {
    writeFileAtomic(path, bytes);
    return { ok: true, path };
  } catch (err) {
    log('error', 'exportBackup', path, err);
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.autosave, autosaveNow);
  ipcMain.handle(IPC.autosaveClear, (e, ref: ModRef) => {
    clearAutosave(dataDir, ref);
    const win = windowOf(e);
    if (win) autosaveRefs.delete(win.id);
  });
  ipcMain.handle(IPC.findRecovery, (_e, ref: ModRef) => recoveryOf(ref));
  ipcMain.handle(IPC.readAutosave, (_e, ref: ModRef) => readAutosave(dataDir, ref) ?? null);
  ipcMain.handle(IPC.keepAutosave, (e, ref: ModRef) => {
    keepAutosaveAsBackup(dataDir, ref, settings.backupCount);
    const win = windowOf(e);
    if (win) autosaveRefs.delete(win.id);
  });
  ipcMain.handle(IPC.listBackups, (_e, ref: ModRef): BackupItem[] => listBackups(dataDir, ref));
  ipcMain.handle(IPC.readBackup, (_e, ref: ModRef, id: string) => readBackup(dataDir, ref, id) ?? null);
  ipcMain.handle(IPC.readIgnoreList, (_e, ref: ModRef): string[] => loadIgnoreList(dataDir, ref).ignored);
  ipcMain.handle(IPC.writeIgnoreList, (_e, ref: ModRef, keys: unknown) => {
    const ignored = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
    saveIgnoreList(dataDir, ref, { version: 1, ignored });
  });
  ipcMain.handle(IPC.addRestorePoint, (_e, ref: ModRef, bytes: Uint8Array) => {
    addBackup(dataDir, ref, bytes, 'restore-point', settings.backupCount);
  });
  ipcMain.handle(IPC.exportBackup, exportBackup);
  ipcMain.on(IPC.liveResponse, (_e, msg: { rid: number; reply: LiveReply }) => {
    const w = liveWaits.get(msg.rid);
    if (!w) return;
    liveWaits.delete(msg.rid);
    clearTimeout(w.timer);
    if (msg.reply.ok) w.resolve(msg.reply.result);
    else w.reject(new Error(msg.reply.error));
  });
  ipcMain.handle(IPC.getLiveStatus, () => liveStatus);
  ipcMain.handle(IPC.detectGames, () => {
    knownGames = detectGames();
    return knownGames;
  });
  ipcMain.handle(IPC.chooseGameDir, async (e) => {
    const win = windowOf(e);
    const opts = { properties: ['openDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const dir = r.filePaths[0];
    if (r.canceled || dir === undefined) return null;
    const g = gameFromDir(dir);
    if (!g) return { error: dir };
    knownGames.push(g);
    return g;
  });
  ipcMain.handle(IPC.listMods, (_e, game: GameInstallInfo) => listMods(game));
  ipcMain.handle(IPC.readModOrder, (_e, game: GameInstallInfo) => readModOrder(game));
  ipcMain.handle(IPC.writeModOrder, saveModOrder);
  ipcMain.handle(IPC.chooseModFile, async (e, game: GameInstallInfo) => {
    const win = windowOf(e);
    const opts = { properties: ['openFile' as const], defaultPath: join(game.kenshi, 'mods'), filters: [{ name: 'Kenshi mod', extensions: ['mod'] }] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.openProject, (_e, req: ProjectRequest) => {
    currentGame = req.game;
    try {
      return loadProject(req);
    } catch (err) {
      log('error', 'openProject', req.modPath ?? req.modName ?? '', err);
      throw err;
    }
  });
  ipcMain.handle(IPC.chooseSavePath, async (e, defaultPath: string) => {
    const win = windowOf(e);
    const opts = { defaultPath: saveDialogDefaultPath(defaultPath), filters: [{ name: 'Kenshi mod', extensions: ['mod'] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    return r.canceled ? null : (r.filePath || null);
  });
  ipcMain.handle(IPC.saveMod, saveMod);
  ipcMain.handle(IPC.readMergeSource, (_e, path: string) => readMergeSourceBytes(path));
  ipcMain.handle(IPC.copyModForEditing, copyModForEditing);
  ipcMain.handle(IPC.loadWorld, (_e, req: WorldRequest) => loadWorldBytes(req));
  ipcMain.handle(IPC.readIcon, (_e, game: GameInstallInfo, iconPath: string) => readIconDataUrl(game, iconPath));
  ipcMain.handle(IPC.readGameAsset, (_e, game: GameInstallInfo, relPath: string) => readGameAsset(game, relPath));
  ipcMain.handle(IPC.listWorldDump, () => listGameDump());
  ipcMain.handle(IPC.readWorldDump, (_e, kind: unknown, x: unknown, y: unknown) =>
    (kind === 'foliage' || kind === 'buildings') && typeof x === 'number' && typeof y === 'number' ? readGameDumpFile(kind, x, y) : null,
  );
  ipcMain.handle(IPC.readTerrainTile, (_e, game: GameInstallInfo, level: number, tx: number, ty: number) => readTerrainTile(game, level, tx, ty));
  ipcMain.handle(IPC.savePngFile, savePngFile);
  ipcMain.handle(IPC.readTranslation, (_e, game: GameInstallInfo, locale: unknown) => (isLocaleCode(locale) ? readTranslationBytes(game, locale) : null));
  ipcMain.handle(IPC.readGamedataPo, (_e, game: GameInstallInfo, locale: unknown) => (isLocaleCode(locale) ? readGamedataPoText(game, locale) : null));
  ipcMain.handle(IPC.listGameLocales, (_e, game: GameInstallInfo) => listLocales(game));
  ipcMain.handle(IPC.saveTextFile, saveTextFile);
  ipcMain.handle(IPC.openTextFile, openTextFile);
  ipcMain.handle(IPC.getSettings, () => settings);
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<Settings>) => {
    const langChanged = patch.lang !== undefined && patch.lang !== settings.lang;
    settings = sanitizeSettings({ ...settings, ...patch });
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    if (langChanged) buildMenu(settings.lang);
    return settings;
  });
  ipcMain.on(IPC.setDirty, (e, dirty: boolean, title: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (dirty) dirtyWindows.set(win.id, title);
    else dirtyWindows.delete(win.id);
    win.setTitle(windowTitle(title, dirty));
  });
}

/** Window title: mod and program version (`● ` — there are unsaved changes). */
function windowTitle(title = '', dirty = false): string {
  const base = `${APP_TITLE} ${app.getVersion()}`;
  if (!title || title === APP_TITLE) return base;
  return `${dirty ? '● ' : ''}${title} — ${base}`;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: windowTitle(),
    backgroundColor: '#1e1f22',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  watchWindow(win.webContents);
  // The title is set by main (with the version), not by the page <title>.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('close', (e) => {
    const title = dirtyWindows.get(win.id);
    if (title === undefined) return;
    const lg = settings.lang;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'Cactus',
      buttons: pick(lg, { en: ['Close without saving', 'Cancel'], ru: ['Закрыть без сохранения', 'Отмена'], zh: ['不保存并关闭', '取消'] }),
      defaultId: 1,
      cancelId: 1,
      message: pick(lg, { en: `“${title}” has unsaved changes.`, ru: `В «${title}» есть несохранённые изменения.`, zh: `“${title}”有未保存的更改。` }),
    });
    if (choice !== 0) e.preventDefault();
    else {
      dirtyWindows.delete(win.id);
      // Edits discarded: the autosave is not deleted but set aside in backups (no reminder on open).
      const ref = autosaveRefs.get(win.id);
      autosaveRefs.delete(win.id);
      if (ref) {
        try {
          keepAutosaveAsBackup(dataDir, ref, settings.backupCount);
        } catch (err) {
          log('error', 'keepAutosave', ref.path ?? ref.modName, err);
        }
      }
    }
  });
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

void app.whenReady().then(() => {
  buildMenu(settings.lang);
  registerIpc();
  startGameLink();
  createWindow();
  void startLive();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  // The discovery file is removed at once (synchronously), connections are closed after it.
  void liveServer?.close();
  liveServer = undefined;
  stopGameLink();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
