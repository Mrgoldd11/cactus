/**
 * Publish to the Steam Workshop: main-process side. Gathers what the publish window shows,
 * starts the uploader child process (`out/main/uploader.js`, Electron's binary run as Node),
 * forwards its protocol messages to the window and keeps a plain-text log of each run in
 * `<userData>/logs/steam-upload.log`.
 *
 * Nothing here talks to Steam; only the child does, and only when `KEDIT_FAKE_STEAM` is unset.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  encodeMessage,
  isPublishedId,
  LineSplitter,
  parseUploaderLine,
  STEAM_APP_ID_KENSHI,
  WORKSHOP_AGREEMENT_URL,
  workshopUrls,
  type PublishRequest,
  type PublishStage,
  type UploaderMessage,
} from '@kenshi-editor/core';
import { fakeScenarioFromEnv, isSteamProcessRunning, listUploadFiles, previewInfo, readModOrigin, readWorkshopInfo, workshopPaths } from '@kenshi-editor/core/node';
import { IPC, type GameInstallInfo, type PublishPrep, type PublishPreview, type PublishStartRequest, type PublishStartResult } from '../shared/api.ts';
import { log, logDir } from './log.ts';
import { pick } from './tr.ts';
import type { Lang } from '../shared/api.ts';

export interface PublishDeps {
  games: () => GameInstallInfo[];
  lang: () => Lang;
  dataDir: string;
}

const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** Where a `.mod` lives: only `mods/<name>/<name>.mod` of a known game may be published. */
function locate(games: readonly GameInstallInfo[], modPath: string): PublishPrep['location'] {
  const dir = dirname(resolve(modPath));
  for (const g of games) if (same(dirname(dir), g.workshop)) return 'workshop';
  const stem = basename(modPath).replace(/\.mod$/i, '');
  for (const g of games) if (same(dirname(dir), join(g.kenshi, 'mods')) && basename(dir).toLowerCase() === stem.toLowerCase()) return 'mods';
  return 'other';
}

const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' } as const;
/** Pictures larger than this are not shown as a thumbnail (they are refused anyway). */
const THUMB_MAX = 8 * 1024 * 1024;

function preview(path: string): PublishPreview | null {
  const p = previewInfo(path);
  if (!p) return null;
  const dataUrl = p.format && p.size <= THUMB_MAX ? `data:${MIME[p.format]};base64,${readFileSync(path).toString('base64')}` : undefined;
  return { path, size: p.size, format: p.format ?? null, ...(dataUrl ? { dataUrl } : {}) };
}

function uploadLogPath(): string {
  return join(logDir() ?? '.', 'steam-upload.log');
}

function uploadLog(line: string): void {
  try {
    const dir = dirname(uploadLogPath());
    mkdirSync(dir, { recursive: true });
    appendFileSync(uploadLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never break the upload
  }
}

interface Active {
  child: ChildProcessWithoutNullStreams;
  win: BrowserWindow;
  stage: PublishStage | 'start';
  finished: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
}
let active: Active | undefined;

export function publishRunning(): boolean {
  return active !== undefined;
}

function prepare(deps: PublishDeps, modPath: string): PublishPrep {
  const games = deps.games();
  const location = locate(games, modPath);
  const paths = workshopPaths(modPath);
  const info = readWorkshopInfo(modPath);
  const scenario = fakeScenarioFromEnv(process.env['KEDIT_FAKE_STEAM']);
  const list = location === 'mods' && existsSync(paths.dir) ? listUploadFiles(paths.dir) : { files: [], excluded: [], totalSize: 0 };
  const origin = readModOrigin(modPath);
  return {
    location,
    modName: paths.mod,
    info: info.state === 'ok' ? info.file.info : null,
    infoState: info.state,
    ...(info.state === 'unreadable' ? { infoError: info.error } : {}),
    preview: existsSync(paths.img) ? preview(paths.img) : null,
    imgPath: paths.img,
    files: list.files,
    excluded: list.excluded,
    totalSize: list.totalSize,
    ...(origin ? { copyOf: { ...(origin.workshopId !== undefined ? { workshopId: origin.workshopId } : {}) } } : {}),
    fake: scenario ?? null,
    steamRunning: scenario !== undefined ? scenario !== 'not-running' : (isSteamProcessRunning() ?? null),
    appId: STEAM_APP_ID_KENSHI,
    logPath: uploadLogPath(),
  };
}

function send(a: Active, m: UploaderMessage): void {
  if (!a.win.isDestroyed()) a.win.webContents.send(IPC.publishEvent, m);
}

function start(deps: PublishDeps, e: IpcMainInvokeEvent, r: PublishStartRequest): PublishStartResult {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return { ok: false, reason: 'no-window' };
  if (active) return { ok: false, reason: 'busy' };
  if (locate(deps.games(), r.modPath) !== 'mods') return { ok: false, reason: 'not-in-mods' };
  if (r.expectedId !== '0' && !isPublishedId(r.expectedId)) return { ok: false, reason: 'bad-request' };
  const stem = workshopPaths(r.modPath).mod.replace(/[^\w.-]+/g, '_');
  const request: PublishRequest = { ...r, stagingDir: join(deps.dataDir, 'workshop-staging', stem) };
  const entry = join(import.meta.dirname, 'uploader.js');
  if (!existsSync(entry)) return { ok: false, reason: 'no-uploader' };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(process.execPath, [entry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    log('error', 'publish: spawn', err);
    return { ok: false, reason: 'spawn-failed' };
  }
  const a: Active = { child, win, stage: 'start', finished: false };
  active = a;
  const fake = fakeScenarioFromEnv(process.env['KEDIT_FAKE_STEAM']);
  uploadLog(`--- start ${fake ? `FAKE(${fake})` : 'REAL'} mod=${r.modPath} expectedId=${r.expectedId} visibility=${String(r.visibility)} tags=${r.tags.join('|')} preview=${r.previewPath}`);
  log('info', 'publish: start', r.modPath, fake ? `fake ${fake}` : 'real');
  const split = new LineSplitter();
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const line of split.push(chunk)) {
      const m = parseUploaderLine(line);
      if (!m) {
        uploadLog(`stdout: ${line}`);
        continue;
      }
      if (m.type !== 'progress') uploadLog(`<- ${line}`);
      if (m.type === 'stage') a.stage = m.stage;
      if (m.type === 'done' || m.type === 'error' || m.type === 'cancelled') a.finished = true;
      send(a, m);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
    uploadLog(`stderr: ${chunk.trimEnd()}`);
  });
  child.on('error', (err) => {
    uploadLog(`process error: ${String(err)}`);
  });
  child.on('exit', (code, signal) => {
    uploadLog(`--- exit code=${String(code)} signal=${String(signal)}`);
    if (a.killTimer) clearTimeout(a.killTimer);
    if (!a.finished) {
      a.finished = true;
      send(a, { type: 'error', code: 'crashed', detail: `exit ${String(code ?? signal)}${stderr ? `\n${stderr.trim()}` : ''}` });
    }
    if (active === a) active = undefined;
  });
  child.stdin.on('error', () => {
    // the child may already be gone
  });
  child.stdin.write(encodeMessage({ type: 'publish', request }));
  return { ok: true };
}

/**
 * Stop the run. Before Steam is asked anything, and during the upload, the child stops at once.
 * While Steam creates the item the child is left to finish writing the new id into `_<mod>.info`
 * (killing it there could leave an item nobody knows about).
 */
function cancel(): void {
  const a = active;
  if (!a || a.finished) return;
  uploadLog('-> cancel');
  try {
    a.child.stdin.write(encodeMessage({ type: 'cancel' }));
  } catch {
    // ignore
  }
  if (a.stage === 'creating' || a.stage === 'writing-info') return;
  a.killTimer = setTimeout(() => {
    if (!a.finished || a.child.exitCode === null) {
      uploadLog('kill after cancel');
      a.child.kill();
    }
  }, 3000);
}

async function choosePreview(deps: PublishDeps, e: IpcMainInvokeEvent): Promise<PublishPreview | null> {
  const win = BrowserWindow.fromWebContents(e.sender);
  const lg = deps.lang();
  const opts = {
    title: pick(lg, { en: 'Preview picture', ru: 'Картинка предпросмотра', zh: '预览图片' }),
    properties: ['openFile' as const],
    filters: [{ name: pick(lg, { en: 'Pictures (PNG, JPEG, GIF)', ru: 'Картинки (PNG, JPEG, GIF)', zh: '图片（PNG、JPEG、GIF）' }), extensions: ['png', 'jpg', 'jpeg', 'gif'] }],
  };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const path = r.filePaths[0];
  if (r.canceled || path === undefined) return null;
  return preview(path);
}

async function openPage(id: string): Promise<boolean> {
  if (!isPublishedId(id)) return false;
  const u = workshopUrls(id);
  try {
    await shell.openExternal(u.steam);
    return true;
  } catch {
    // No Steam client to take steam:// links — use the web page.
    await shell.openExternal(u.web);
    return true;
  }
}

export function registerPublishIpc(deps: PublishDeps): void {
  ipcMain.handle(IPC.publishPrepare, (_e, modPath: string) => prepare(deps, modPath));
  ipcMain.handle(IPC.publishChoosePreview, (e) => choosePreview(deps, e));
  ipcMain.handle(IPC.publishStart, (e, r: PublishStartRequest) => start(deps, e, r));
  ipcMain.handle(IPC.publishCancel, () => {
    cancel();
  });
  ipcMain.handle(IPC.publishOpenPage, (_e, id: string) => openPage(id));
  ipcMain.handle(IPC.publishWebPage, async (_e, id: string) => {
    if (!isPublishedId(id)) return false;
    await shell.openExternal(workshopUrls(id).web);
    return true;
  });
  ipcMain.handle(IPC.publishCopyLink, (_e, id: string) => {
    if (!isPublishedId(id)) return false;
    void clipboard.writeText(workshopUrls(id).web);
    return true;
  });
  ipcMain.handle(IPC.publishOpenAgreement, () => shell.openExternal(WORKSHOP_AGREEMENT_URL));
  ipcMain.handle(IPC.publishShowLog, () => {
    if (existsSync(uploadLogPath())) shell.showItemInFolder(uploadLogPath());
    else void shell.openPath(dirname(uploadLogPath()));
  });
}
