/** Мост для окна: только перечисленные вызовы `KeditApi`, без доступа к Node. */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type KeditApi } from '../shared/api.ts';

const api: KeditApi = {
  detectGames: () => ipcRenderer.invoke(IPC.detectGames),
  chooseGameDir: () => ipcRenderer.invoke(IPC.chooseGameDir),
  listMods: (game) => ipcRenderer.invoke(IPC.listMods, game),
  chooseModFile: (game) => ipcRenderer.invoke(IPC.chooseModFile, game),
  openProject: (req) => ipcRenderer.invoke(IPC.openProject, req),
  chooseSavePath: (defaultPath) => ipcRenderer.invoke(IPC.chooseSavePath, defaultPath),
  saveMod: (req) => ipcRenderer.invoke(IPC.saveMod, req),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  setDirty: (dirty, title) => {
    ipcRenderer.send(IPC.setDirty, dirty, title);
  },
};

contextBridge.exposeInMainWorld('kedit', api);
