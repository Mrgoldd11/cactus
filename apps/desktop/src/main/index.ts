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
 * Меню окна — `menu.ts`, журнал ошибок в файл — `log.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { LiveRequestBody } from '@kenshi-editor/core';
import { startLiveServer, type LiveServer } from '@kenshi-editor/core/node';
import { initLog, log, watchWindow } from './log.ts';
import { APP_TITLE, buildMenu } from './menu.ts';
import {
  IPC,
  type GameInstallInfo,
  type LiveReply,
  type LiveStatus,
  type ProjectRequest,
  type SaveRequest,
  type SaveResult,
  type Settings,
  type WorldRequest,
} from '../shared/api.ts';
import {
  detectGames,
  gameFromDir,
  listMods,
  loadProject,
  loadWorldBytes,
  modInstallPath,
  needsConfirmation,
  readIconDataUrl,
  readTranslationBytes,
  saveDialogDefaultPath,
  writeMod,
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

function isGamePath(path: string): boolean {
  return [...knownGames, ...(currentGame ? [currentGame] : [])].some((g) => needsConfirmation(g, path));
}

async function saveMod(e: IpcMainInvokeEvent, request: SaveRequest): Promise<SaveResult> {
  if (!request.path.toLowerCase().endsWith('.mod')) return { ok: false, cancelled: false, error: 'not a .mod path' };
  const req = { ...request, path: modInstallPath([...knownGames, ...(currentGame ? [currentGame] : [])], request.path) };
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
      detail: req.path,
    };
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (r.response !== 0) return { ok: false, cancelled: true };
  }
  try {
    writeMod(req.path, req.bytes);
    settings.recent = [req.path, ...settings.recent.filter((p) => p !== req.path)].slice(0, 10);
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    return { ok: true, path: req.path };
  } catch (err) {
    log('error', 'saveMod', req.path, err);
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
  ipcMain.handle(IPC.loadWorld, (_e, req: WorldRequest) => loadWorldBytes(req));
  ipcMain.handle(IPC.readIcon, (_e, game: GameInstallInfo, iconPath: string) => readIconDataUrl(game, iconPath));
  ipcMain.handle(IPC.readTranslation, (_e, game: GameInstallInfo) => readTranslationBytes(game));
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
