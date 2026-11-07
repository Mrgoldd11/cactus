/**
 * Меню окна на языке интерфейса. Сочетания правки (Ctrl+Z, Ctrl+S и т. п.) обрабатывает само
 * окно — по физической клавише, на любой раскладке (`renderer/src/keys.ts`); пункты «Правка»
 * здесь — стандартные роли для полей ввода. Перезагрузки окна в меню нет: она теряет
 * несохранённые изменения.
 */
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import type { Lang } from '../shared/api.ts';
import { logDir, logFile } from './log.ts';

export const APP_TITLE = 'Cactus';

function about(lang: Lang): void {
  const ru = lang === 'ru';
  const v = process.versions;
  const options = {
    type: 'info' as const,
    title: ru ? 'О программе' : 'About',
    message: `${APP_TITLE} ${app.getVersion()}`,
    detail: [
      ru ? 'Редактор модов Kenshi. Бета-версия для проверки.' : 'Kenshi mod editor. Beta for testing.',
      ru ? 'Лицензия: MIT (предварительно).' : 'License: MIT (preliminary).',
      '',
      `Electron ${v.electron}, Chromium ${v.chrome}, Node ${v.node}`,
      `${ru ? 'Журнал' : 'Log'}: ${logFile() ?? '—'}`,
    ].join('\n'),
    buttons: ['OK'],
  };
  const win = BrowserWindow.getFocusedWindow();
  void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
}

/**
 * Как запустить MCP-сервер этой копии программы. В собранной версии — тот же exe в режиме Node
 * (`ELECTRON_RUN_AS_NODE=1`) и `resources/mcp/kenshi-mcp.mjs`: отдельный Node не нужен.
 * В режиме разработки — `node packages/mcp/bin/kenshi-mcp.js`.
 */
export function mcpLaunch(): { command: string; args: string[]; env?: Record<string, string> } {
  if (app.isPackaged) return { command: process.execPath, args: [join(process.resourcesPath, 'mcp', 'kenshi-mcp.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { command: 'node', args: [join(app.getAppPath(), '..', '..', 'packages', 'mcp', 'bin', 'kenshi-mcp.js')] };
}

const quoteArg = (s: string): string => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function connectAi(lang: Lang): void {
  const ru = lang === 'ru';
  const m = mcpLaunch();
  const desktopJson = JSON.stringify({ mcpServers: { kenshi: m } }, null, 2);
  const env = Object.entries(m.env ?? {}).map(([k, v]) => `-e ${k}=${v} `).join('');
  const codeCmd = `claude mcp add kenshi --scope user ${env}-- ${[m.command, ...m.args].map(quoteArg).join(' ')}`;
  const options = {
    type: 'info' as const,
    title: ru ? 'Подключить ИИ (MCP)' : 'Connect AI (MCP)',
    message: ru ? 'Настройка MCP-сервера для Claude' : 'MCP server setup for Claude',
    detail: (ru
      ? [
          'Claude Desktop: Настройки → Developer → Edit Config, вставьте в claude_desktop_config.json (если там уже есть mcpServers — добавьте только блок "kenshi"):',
          desktopJson,
          'Claude Code (в терминале):',
          codeCmd,
          'Потом перезапустите Claude.',
        ]
      : [
          'Claude Desktop: Settings → Developer → Edit Config, paste into claude_desktop_config.json (if mcpServers already exists, add only the "kenshi" block):',
          desktopJson,
          'Claude Code (in a terminal):',
          codeCmd,
          'Then restart Claude.',
        ]
    ).join('\n\n'),
    buttons: ru ? ['Копировать для Claude Desktop', 'Копировать для Claude Code', 'Закрыть'] : ['Copy for Claude Desktop', 'Copy for Claude Code', 'Close'],
    defaultId: 0,
    cancelId: 2,
  };
  const win = BrowserWindow.getFocusedWindow();
  void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then((r) => {
    if (r.response === 0) void clipboard.writeText(desktopJson);
    else if (r.response === 1) void clipboard.writeText(codeCmd);
  });
}

export function buildMenu(lang: Lang): void {
  const ru = lang === 'ru';
  const template: MenuItemConstructorOptions[] = [
    {
      label: ru ? 'Файл' : 'File',
      submenu: [{ role: 'quit', label: ru ? 'Выход' : 'Exit' }],
    },
    {
      label: ru ? 'Правка' : 'Edit',
      submenu: [
        { role: 'undo', label: ru ? 'Отменить' : 'Undo' },
        { role: 'redo', label: ru ? 'Повторить' : 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: ru ? 'Вырезать' : 'Cut' },
        { role: 'copy', label: ru ? 'Копировать' : 'Copy' },
        { role: 'paste', label: ru ? 'Вставить' : 'Paste' },
        { role: 'selectAll', label: ru ? 'Выделить всё' : 'Select all' },
      ],
    },
    {
      label: ru ? 'Вид' : 'View',
      submenu: [
        { role: 'resetZoom', label: ru ? 'Обычный масштаб' : 'Actual size' },
        { role: 'zoomIn', label: ru ? 'Крупнее' : 'Zoom in' },
        { role: 'zoomOut', label: ru ? 'Мельче' : 'Zoom out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: ru ? 'Во весь экран' : 'Full screen' },
        { role: 'toggleDevTools', label: ru ? 'Инструменты разработчика' : 'Developer tools' },
      ],
    },
    {
      label: ru ? 'Справка' : 'Help',
      submenu: [
        {
          label: ru ? 'Открыть папку логов' : 'Open log folder',
          click: () => {
            const dir = logDir();
            if (dir) void shell.openPath(dir);
          },
        },
        {
          label: ru ? 'Подключить ИИ (MCP)…' : 'Connect AI (MCP)…',
          click: () => {
            connectAi(lang);
          },
        },
        { type: 'separator' },
        {
          label: ru ? 'О программе' : 'About',
          click: () => {
            about(lang);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
