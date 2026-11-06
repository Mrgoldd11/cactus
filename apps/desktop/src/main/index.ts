/**
 * Главный процесс: окно, файловые вызовы для окна (IPC), подтверждение записи в папку игры,
 * вопрос о несохранённых изменениях при закрытии, настройки в `userData/settings.json`.
 *
 * Ядро (ModContext) работает в окне: ему нужен синхронный доступ к записям для списка на
 * десятки тысяч строк, отмены и подписки на изменения. Main только читает и пишет файлы.
 *
 * Живая связь с ИИ: main держит WebSocket-сервер на 127.0.0.1 (файл обнаружения `live.json`
 * во временной папке, `KEDIT_LIVE_FILE`; `KEDIT_LIVE=0` — выключить) и передаёт запросы
 * MCP окну — их выполняет `LiveHost` над открытым проектом.
 *
 * Меню окна — `menu.ts`, журнал ошибок в файл — `log.ts`, мост к игре (плагин Kenshi Bridge) — `game.ts`.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { describeOrderChange, type LiveRequestBody } from '@kenshi-editor/core';
import { startLiveServer, type LiveServer } from '@kenshi-editor/core/node';
import { initLog, log, watchWindow } from './log.ts';
import { startGameLink, stopGameLink } from './game.ts';
import { APP_TITLE, buildMenu } from './menu.ts';
import {
  IPC,
  type GameInstallInfo,
  type LiveReply,
  type LiveStatus,
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
  saveDialogDefaultPath,
  writeMod,
  writeModOrder,
} from './service.ts';

// Отдельная папка данных (e2e запускает приложение с чистыми настройками).
if (process.env['KEDIT_USER_DATA']) app.setPath('userData', process.env['KEDIT_USER_DATA']);

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS: Settings = { lang: 'ru', recent: [] };

function loadSettings(): Settings {
  try {
    if (existsSync(settingsPath())) return { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>) };
  } catch {
    // Испорченный файл настроек — начинаем с умолчаний.
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

/** Выгрузка перевода: диалог и запись; папка игры и мастерская — отказ. */
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

/** Файл перевода больше этого — не текст выгрузки (защита от случайного выбора). */
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
  // Мастерская — чужие файлы (Steam перезапишет их при обновлении): только копия в mods/.
  if (isWorkshopPath(games(), req.path)) return { ok: false, cancelled: false, workshop: true, error: req.path };
  const win = windowOf(e);
  if (isGamePath(req.path)) {
    const ru = settings.lang === 'ru';
    const options = {
      type: 'warning' as const,
      buttons: ru ? ['Записать', 'Отмена'] : ['Write', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: ru ? 'Запись в папку игры' : 'Writing to the game folder',
      message: ru ? 'Файл будет записан в папку игры или мастерской:' : 'The file will be written into the game or workshop folder:',
      detail: req.world?.length ? [req.path, ...req.world.map((f) => `leveldata/${f.path}`)].join('\n') : req.path,
    };
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (r.response !== 0) return { ok: false, cancelled: true };
  }
  try {
    writeMod(req.path, req.bytes, req.mergeStore, req.world);
    settings.recent = [req.path, ...settings.recent.filter((p) => p !== req.path)].slice(0, 10);
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    const game = games().find((g) => needsConfirmation(g, req.path)) ?? currentGame;
    const provenance = game ? provenanceOf(game, req.path) : undefined;
    return { ok: true, path: req.path, ...(provenance ? { provenance } : {}) };
  } catch (err) {
    log('error', 'saveMod', req.path, err);
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Копия чужого мода для правки: `mods/<имя>/<имя>.mod` + файл происхождения. Это запись в папку
 * игры — всегда с подтверждением; оригинал только читается.
 */
async function copyModForEditing(e: IpcMainInvokeEvent, game: GameInstallInfo, path: string): Promise<CopyModResult> {
  const known = games().some((g) => resolve(g.kenshi).toLowerCase() === resolve(game.kenshi).toLowerCase());
  if (!known) return { ok: false, cancelled: false, error: 'unknown game folder' };
  const ru = settings.lang === 'ru';
  let plan;
  try {
    plan = planCopy(game, path);
  } catch (err) {
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (plan.error !== undefined) return { ok: false, cancelled: false, error: plan.error };
  const enWarnings = [
    ...(plan.shadowsOriginal ? ['The copy has the same name and hides the original: the game and the editor will use the file from mods/. Delete the copy folder to get the original back.'] : []),
    ...(plan.origin.workshopId !== undefined ? ["The author may update the mod; the copy stays as it is. Do not upload the copy to the workshop without the author's permission."] : []),
  ];
  const options = {
    type: 'warning' as const,
    buttons: ru ? ['Скопировать', 'Отмена'] : ['Copy', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: ru ? 'Копия мода для правки' : 'Copy the mod for editing',
    message: ru
      ? 'Мод из мастерской не меняем: Steam перезапишет его при обновлении. Скопировать мод в папку игры и править копию?'
      : 'Workshop mods are never changed: Steam overwrites them on update. Copy the mod into the game folder and edit the copy?',
    detail: [`${ru ? 'Откуда' : 'From'}: ${plan.source}`, `${ru ? 'Куда' : 'To'}: ${plan.dest}`, '', ...(ru ? plan.warnings : enWarnings)].join('\n'),
  };
  const win = windowOf(e);
  const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (r.response !== 0) return { ok: false, cancelled: true };
  try {
    return { ok: true, ...copyMod(game, path) };
  } catch (err) {
    log('error', 'copyModForEditing', path, err);
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Новый порядок `mods.cfg`: это файл игры — всегда с подтверждением, игра должна быть закрыта. */
async function saveModOrder(e: IpcMainInvokeEvent, game: GameInstallInfo, names: string[], expected: string[]): Promise<ModOrderResult> {
  const known = [...knownGames, ...(currentGame ? [currentGame] : [])].some((g) => resolve(g.kenshi).toLowerCase() === resolve(game.kenshi).toLowerCase());
  if (!known) return { ok: false, cancelled: false, error: 'unknown game folder' };
  const changes = describeOrderChange(expected, names);
  if (changes.length === 0) return { ok: true, path: join(game.kenshi, 'data', 'mods.cfg'), changed: false };
  const ru = settings.lang === 'ru';
  const options = {
    type: 'warning' as const,
    buttons: ru ? ['Записать', 'Отмена'] : ['Write', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: ru ? 'Порядок загрузки модов' : 'Mod load order',
    message: ru
      ? 'Записать новый порядок в файл игры mods.cfg? Игра и лаунчер должны быть закрыты; рядом останется копия прежнего файла.'
      : 'Write the new order into the game file mods.cfg? The game and launcher must be closed; a copy of the old file is kept next to it.',
    detail: [join(game.kenshi, 'data', 'mods.cfg'), '', ...changes.slice(0, 30), ...(changes.length > 30 ? [`… +${changes.length - 30}`] : [])].join('\n'),
  };
  const win = windowOf(e);
  const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (r.response !== 0) return { ok: false, cancelled: true };
  try {
    return writeModOrder(game, names, expected);
  } catch (err) {
    log('error', 'writeModOrder', game.kenshi, err);
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

let liveServer: LiveServer | undefined;
let liveStatus: LiveStatus = { clients: [] };
const liveWaits = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let liveRid = 1;

/** Запрос ИИ — окну проекта; ответ придёт по `liveResponse`. */
function forwardLive(req: LiveRequestBody): Promise<unknown> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return Promise.reject(new Error('Окно редактора закрыто'));
  const rid = liveRid++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      liveWaits.delete(rid);
      reject(new Error('Окно редактора не ответило'));
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
      app: `Kenshi Mod Editor ${app.getVersion()}`,
    });
    liveStatus = { port: liveServer.port, clients: [] };
  } catch (err) {
    liveStatus = { clients: [], error: err instanceof Error ? err.message : String(err) };
  }
  pushLiveStatus();
}

function registerIpc(): void {
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
  ipcMain.handle(IPC.readTerrainTile, (_e, game: GameInstallInfo, level: number, tx: number, ty: number) => readTerrainTile(game, level, tx, ty));
  ipcMain.handle(IPC.savePngFile, savePngFile);
  ipcMain.handle(IPC.readTranslation, (_e, game: GameInstallInfo) => readTranslationBytes(game));
  ipcMain.handle(IPC.saveTextFile, saveTextFile);
  ipcMain.handle(IPC.openTextFile, openTextFile);
  ipcMain.handle(IPC.getSettings, () => settings);
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<Settings>) => {
    const langChanged = patch.lang !== undefined && patch.lang !== settings.lang;
    settings = { ...settings, ...patch };
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

/** Заголовок окна: мод и версия программы (`● ` — есть несохранённые изменения). */
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
  // Заголовок задаёт main (с версией), а не <title> страницы.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('close', (e) => {
    const title = dirtyWindows.get(win.id);
    if (title === undefined) return;
    const ru = settings.lang === 'ru';
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'Kenshi Mod Editor',
      buttons: ru ? ['Закрыть без сохранения', 'Отмена'] : ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: ru ? `В «${title}» есть несохранённые изменения.` : `“${title}” has unsaved changes.`,
    });
    if (choice !== 0) e.preventDefault();
    else dirtyWindows.delete(win.id);
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
  // Файл обнаружения убирается сразу (синхронно), соединения закрываются следом.
  void liveServer?.close();
  liveServer = undefined;
  stopGameLink();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
