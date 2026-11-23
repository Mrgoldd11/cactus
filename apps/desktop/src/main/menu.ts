/**
 * Window menu in the UI language. Edit shortcuts (Ctrl+Z, Ctrl+S etc.) are handled by the
 * window itself — by physical key, on any keyboard layout (`renderer/src/keys.ts`); the «Edit» items
 * here are standard roles for input fields. There is no window reload in the menu: it loses
 * unsaved changes.
 */
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import type { Lang } from '../shared/api.ts';
import { logDir, logFile } from './log.ts';
import { pick } from './tr.ts';

export const APP_TITLE = 'Cactus';

function about(lang: Lang): void {
  const v = process.versions;
  const options = {
    type: 'info' as const,
    title: pick(lang, { en: 'About', ru: 'О программе', zh: '关于' }),
    message: `${APP_TITLE} ${app.getVersion()}`,
    detail: [
      pick(lang, { en: 'Kenshi mod editor.', ru: 'Редактор модов Kenshi.', zh: 'Kenshi Mod 编辑器。' }),
      pick(lang, { en: 'Free to use, closed source: see LICENSE.txt next to Cactus.exe.', ru: 'Бесплатная программа с закрытым кодом: условия в LICENSE.txt рядом с Cactus.exe.', zh: '免费软件，闭源：条款见 Cactus.exe 旁的 LICENSE.txt。' }),
      '',
      `Electron ${v.electron}, Chromium ${v.chrome}, Node ${v.node}`,
      `${pick(lang, { en: 'Log', ru: 'Журнал', zh: '日志' })}: ${logFile() ?? '—'}`,
    ].join('\n'),
    buttons: ['OK'],
  };
  const win = BrowserWindow.getFocusedWindow();
  void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
}

/**
 * How to start the MCP server of this program copy. In the packaged build — the same exe in Node mode
 * (`ELECTRON_RUN_AS_NODE=1`) and `resources/mcp/kenshi-mcp.mjs`: no separate Node needed.
 * In dev mode — `node packages/mcp/bin/kenshi-mcp.js`.
 */
export function mcpLaunch(): { command: string; args: string[]; env?: Record<string, string> } {
  if (app.isPackaged) return { command: process.execPath, args: [join(process.resourcesPath, 'mcp', 'kenshi-mcp.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { command: 'node', args: [join(app.getAppPath(), '..', '..', 'packages', 'mcp', 'bin', 'kenshi-mcp.js')] };
}

const quoteArg = (s: string): string => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function connectAi(lang: Lang): void {
  const m = mcpLaunch();
  const desktopJson = JSON.stringify({ mcpServers: { kenshi: m } }, null, 2);
  const env = Object.entries(m.env ?? {}).map(([k, v]) => `-e ${k}=${v} `).join('');
  const codeCmd = `claude mcp add kenshi --scope user ${env}-- ${[m.command, ...m.args].map(quoteArg).join(' ')}`;
  const options = {
    type: 'info' as const,
    title: pick(lang, { en: 'Connect AI (MCP)', ru: 'Подключить ИИ (MCP)', zh: '连接 AI (MCP)' }),
    message: pick(lang, { en: 'MCP server setup for Claude', ru: 'Настройка MCP-сервера для Claude', zh: '为 Claude 配置 MCP 服务器' }),
    detail: pick(lang, { en: [
        'Claude Desktop: Settings → Developer → Edit Config, paste into claude_desktop_config.json (if mcpServers already exists, add only the "kenshi" block):',
        desktopJson,
        'Claude Code (in a terminal):',
        codeCmd,
        'Then restart Claude.',
      ], ru: [
        'Claude Desktop: Настройки → Developer → Edit Config, вставьте в claude_desktop_config.json (если там уже есть mcpServers — добавьте только блок "kenshi"):',
        desktopJson,
        'Claude Code (в терминале):',
        codeCmd,
        'Потом перезапустите Claude.',
      ], zh: [
        'Claude Desktop：设置 → Developer → Edit Config，粘贴到 claude_desktop_config.json 中（如果其中已有 mcpServers，只需添加 "kenshi" 这一块）：',
        desktopJson,
        'Claude Code（在终端中）：',
        codeCmd,
        '然后重启 Claude。',
      ] }).join('\n\n'),
    buttons: pick(lang, { en: ['Copy for Claude Desktop', 'Copy for Claude Code', 'Close'], ru: ['Копировать для Claude Desktop', 'Копировать для Claude Code', 'Закрыть'], zh: ['复制给 Claude Desktop', '复制给 Claude Code', '关闭'] }),
    defaultId: 0,
    cancelId: 2,
  };
  const win = BrowserWindow.getFocusedWindow();
  void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then((r) => {
    if (r.response === 0) void clipboard.writeText(desktopJson);
    else if (r.response === 1) void clipboard.writeText(codeCmd);
  });
}

/** Menu labels; a new interface language adds one more dictionary to MENU. */
const menuEn = {
  file: 'File',
  quit: 'Exit',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  view: 'View',
  resetZoom: 'Actual size',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fullScreen: 'Full screen',
  devTools: 'Developer tools',
  help: 'Help',
  logFolder: 'Open log folder',
  connectAi: 'Connect AI (MCP)…',
  about: 'About',
};
type MenuStrings = typeof menuEn;
const menuRu: MenuStrings = {
  file: 'Файл',
  quit: 'Выход',
  edit: 'Правка',
  undo: 'Отменить',
  redo: 'Повторить',
  cut: 'Вырезать',
  copy: 'Копировать',
  paste: 'Вставить',
  selectAll: 'Выделить всё',
  view: 'Вид',
  resetZoom: 'Обычный масштаб',
  zoomIn: 'Крупнее',
  zoomOut: 'Мельче',
  fullScreen: 'Во весь экран',
  devTools: 'Инструменты разработчика',
  help: 'Справка',
  logFolder: 'Открыть папку логов',
  connectAi: 'Подключить ИИ (MCP)…',
  about: 'О программе',
};
const menuZh: MenuStrings = {
  file: '文件',
  quit: '退出',
  edit: '编辑',
  undo: '撤销',
  redo: '重做',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  view: '视图',
  resetZoom: '实际大小',
  zoomIn: '放大',
  zoomOut: '缩小',
  fullScreen: '全屏',
  devTools: '开发者工具',
  help: '帮助',
  logFolder: '打开日志文件夹',
  connectAi: '连接 AI (MCP)…',
  about: '关于',
};
const MENU: Readonly<Record<Lang, MenuStrings>> = { en: menuEn, ru: menuRu, zh: menuZh };

export function buildMenu(lang: Lang): void {
  const m = MENU[lang];
  const template: MenuItemConstructorOptions[] = [
    {
      label: m.file,
      submenu: [{ role: 'quit', label: m.quit }],
    },
    {
      label: m.edit,
      submenu: [
        { role: 'undo', label: m.undo },
        { role: 'redo', label: m.redo },
        { type: 'separator' },
        { role: 'cut', label: m.cut },
        { role: 'copy', label: m.copy },
        { role: 'paste', label: m.paste },
        { role: 'selectAll', label: m.selectAll },
      ],
    },
    {
      label: m.view,
      submenu: [
        { role: 'resetZoom', label: m.resetZoom },
        { role: 'zoomIn', label: m.zoomIn },
        { role: 'zoomOut', label: m.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: m.fullScreen },
        { role: 'toggleDevTools', label: m.devTools },
      ],
    },
    {
      label: m.help,
      submenu: [
        {
          label: m.logFolder,
          click: () => {
            const dir = logDir();
            if (dir) void shell.openPath(dir);
          },
        },
        {
          label: m.connectAi,
          click: () => {
            connectAi(lang);
          },
        },
        { type: 'separator' },
        {
          label: m.about,
          click: () => {
            about(lang);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
