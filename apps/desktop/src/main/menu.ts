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
import { pick } from './tr.ts';

export const APP_TITLE = 'Cactus';

function about(lang: Lang): void {
  const v = process.versions;
  const options = {
    type: 'info' as const,
    title: pick(lang, { en: 'About', ru: 'О программе', zh: '关于' }),
    message: `${APP_TITLE} ${app.getVersion()}`,
    detail: [
      pick(lang, { en: 'Kenshi mod editor. Beta for testing.', ru: 'Редактор модов Kenshi. Бета-версия для проверки.', zh: 'Kenshi Mod 编辑器。测试版。' }),
      pick(lang, { en: 'License: MIT (preliminary).', ru: 'Лицензия: MIT (предварительно).', zh: '许可证：MIT（暂定）。' }),
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

export function buildMenu(lang: Lang): void {
  const t = (ru: string, en: string, zh: string): string => pick(lang, { en: en, ru: ru, zh: zh });
  const template: MenuItemConstructorOptions[] = [
    {
      label: t('Файл', 'File', '文件'),
      submenu: [{ role: 'quit', label: t('Выход', 'Exit', '退出') }],
    },
    {
      label: t('Правка', 'Edit', '编辑'),
      submenu: [
        { role: 'undo', label: t('Отменить', 'Undo', '撤销') },
        { role: 'redo', label: t('Повторить', 'Redo', '重做') },
        { type: 'separator' },
        { role: 'cut', label: t('Вырезать', 'Cut', '剪切') },
        { role: 'copy', label: t('Копировать', 'Copy', '复制') },
        { role: 'paste', label: t('Вставить', 'Paste', '粘贴') },
        { role: 'selectAll', label: t('Выделить всё', 'Select all', '全选') },
      ],
    },
    {
      label: t('Вид', 'View', '视图'),
      submenu: [
        { role: 'resetZoom', label: t('Обычный масштаб', 'Actual size', '实际大小') },
        { role: 'zoomIn', label: t('Крупнее', 'Zoom in', '放大') },
        { role: 'zoomOut', label: t('Мельче', 'Zoom out', '缩小') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('Во весь экран', 'Full screen', '全屏') },
        { role: 'toggleDevTools', label: t('Инструменты разработчика', 'Developer tools', '开发者工具') },
      ],
    },
    {
      label: t('Справка', 'Help', '帮助'),
      submenu: [
        {
          label: t('Открыть папку логов', 'Open log folder', '打开日志文件夹'),
          click: () => {
            const dir = logDir();
            if (dir) void shell.openPath(dir);
          },
        },
        {
          label: t('Подключить ИИ (MCP)…', 'Connect AI (MCP)…', '连接 AI (MCP)…'),
          click: () => {
            connectAi(lang);
          },
        },
        { type: 'separator' },
        {
          label: t('О программе', 'About', '关于'),
          click: () => {
            about(lang);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
