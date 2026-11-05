/** Мост для окна: только перечисленные вызовы `KeditApi`, без доступа к Node. */
import { contextBridge, ipcRenderer } from 'electron';
import type { LiveRequestBody } from '@kenshi-editor/core';
import { IPC, type KeditApi, type LiveReply, type LiveStatus } from '../shared/api.ts';

const api: KeditApi = {
  detectGames: () => ipcRenderer.invoke(IPC.detectGames),
  chooseGameDir: () => ipcRenderer.invoke(IPC.chooseGameDir),
  listMods: (game) => ipcRenderer.invoke(IPC.listMods, game),
  readModOrder: (game) => ipcRenderer.invoke(IPC.readModOrder, game),
  writeModOrder: (game, names, expected) => ipcRenderer.invoke(IPC.writeModOrder, game, names, expected),
  copyModForEditing: (game, path) => ipcRenderer.invoke(IPC.copyModForEditing, game, path),
  chooseModFile: (game) => ipcRenderer.invoke(IPC.chooseModFile, game),
  openProject: (req) => ipcRenderer.invoke(IPC.openProject, req),
  chooseSavePath: (defaultPath) => ipcRenderer.invoke(IPC.chooseSavePath, defaultPath),
  saveMod: (req) => ipcRenderer.invoke(IPC.saveMod, req),
  loadWorld: (req) => ipcRenderer.invoke(IPC.loadWorld, req),
  readIcon: (game, iconPath) => ipcRenderer.invoke(IPC.readIcon, game, iconPath),
  readTranslation: (game) => ipcRenderer.invoke(IPC.readTranslation, game),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
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
};

contextBridge.exposeInMainWorld('kedit', api);
