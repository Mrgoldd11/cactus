/** Мост для окна: только перечисленные вызовы `KeditApi`, без доступа к Node. */
import { contextBridge, ipcRenderer } from 'electron';
import type { LiveRequestBody } from '@kenshi-editor/core';
import { IPC, type GameLinkStatus, type KeditApi, type LiveReply, type LiveStatus } from '../shared/api.ts';

const api: KeditApi = {
  detectGames: () => ipcRenderer.invoke(IPC.detectGames),
  chooseGameDir: () => ipcRenderer.invoke(IPC.chooseGameDir),
  listMods: (game) => ipcRenderer.invoke(IPC.listMods, game),
  readModOrder: (game) => ipcRenderer.invoke(IPC.readModOrder, game),
  writeModOrder: (game, names, expected) => ipcRenderer.invoke(IPC.writeModOrder, game, names, expected),
  copyModForEditing: (game, path) => ipcRenderer.invoke(IPC.copyModForEditing, game, path),
  readMergeSource: (path) => ipcRenderer.invoke(IPC.readMergeSource, path),
  chooseModFile: (game) => ipcRenderer.invoke(IPC.chooseModFile, game),
  openProject: (req) => ipcRenderer.invoke(IPC.openProject, req),
  chooseSavePath: (defaultPath) => ipcRenderer.invoke(IPC.chooseSavePath, defaultPath),
  saveMod: (req) => ipcRenderer.invoke(IPC.saveMod, req),
  loadWorld: (req) => ipcRenderer.invoke(IPC.loadWorld, req),
  readIcon: (game, iconPath) => ipcRenderer.invoke(IPC.readIcon, game, iconPath),
  readGameAsset: (game, relPath) => ipcRenderer.invoke(IPC.readGameAsset, game, relPath),
  listWorldDump: () => ipcRenderer.invoke(IPC.listWorldDump),
  readWorldDump: (kind, x, y) => ipcRenderer.invoke(IPC.readWorldDump, kind, x, y),
  readTerrainTile: (game, level, tx, ty) => ipcRenderer.invoke(IPC.readTerrainTile, game, level, tx, ty),
  savePngFile: (defaultName, png) => ipcRenderer.invoke(IPC.savePngFile, defaultName, png),
  readTranslation: (game) => ipcRenderer.invoke(IPC.readTranslation, game),
  saveTextFile: (defaultName, kind, text) => ipcRenderer.invoke(IPC.saveTextFile, defaultName, kind, text),
  openTextFile: () => ipcRenderer.invoke(IPC.openTextFile),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  autosave: (ref, bytes) => ipcRenderer.invoke(IPC.autosave, ref, bytes),
  autosaveClear: (ref) => ipcRenderer.invoke(IPC.autosaveClear, ref),
  findRecovery: (ref) => ipcRenderer.invoke(IPC.findRecovery, ref),
  readAutosave: (ref) => ipcRenderer.invoke(IPC.readAutosave, ref),
  keepAutosave: (ref) => ipcRenderer.invoke(IPC.keepAutosave, ref),
  listBackups: (ref) => ipcRenderer.invoke(IPC.listBackups, ref),
  readBackup: (ref, id) => ipcRenderer.invoke(IPC.readBackup, ref, id),
  addRestorePoint: (ref, bytes) => ipcRenderer.invoke(IPC.addRestorePoint, ref, bytes),
  exportBackup: (ref, id) => ipcRenderer.invoke(IPC.exportBackup, ref, id),
  setDirty: (dirty, title) => {
    ipcRenderer.send(IPC.setDirty, dirty, title);
  },
  onLiveRequest: (handler) => {
    ipcRenderer.removeAllListeners(IPC.liveRequest);
    ipcRenderer.on(IPC.liveRequest, (_e, msg: { rid: number; req: LiveRequestBody }) => {
      let reply: LiveReply;
      try {
        reply = handler(msg.req);
      } catch (err) {
        reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      ipcRenderer.send(IPC.liveResponse, { rid: msg.rid, reply });
    });
  },
  getLiveStatus: () => ipcRenderer.invoke(IPC.getLiveStatus),
  onLiveStatus: (cb) => {
    const listener = (_e: unknown, s: LiveStatus): void => {
      cb(s);
    };
    ipcRenderer.on(IPC.liveStatus, listener);
    return () => {
      ipcRenderer.removeListener(IPC.liveStatus, listener);
    };
  },
  getGameStatus: () => ipcRenderer.invoke(IPC.getGameStatus),
  onGameStatus: (cb) => {
    const listener = (_e: unknown, s: GameLinkStatus): void => {
      cb(s);
    };
    ipcRenderer.on(IPC.gameStatus, listener);
    return () => {
      ipcRenderer.removeListener(IPC.gameStatus, listener);
    };
  },
  gameRequest: (cmd, args) => ipcRenderer.invoke(IPC.gameRequest, cmd, args ?? {}),
};

contextBridge.exposeInMainWorld('kedit', api);
