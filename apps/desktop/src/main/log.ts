/**
 * Журнал ошибок в файл: `<данные приложения>/logs/kenshi-mod-editor.log` (Windows:
 * `%APPDATA%\Cactus\logs`). Пишутся ошибки и предупреждения главного процесса и окна
 * (консоль окна, падение окна, ошибки загрузки). Файл больше 1 МБ при запуске переносится в
 * `kenshi-mod-editor.old.log`, так что журнал не растёт без конца.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import type { WebContents } from 'electron';

const MAX_BYTES = 1024 * 1024;
let file: string | undefined;

export function logDir(): string | undefined {
  return file ? join(file, '..') : undefined;
}

export function logFile(): string | undefined {
  return file;
}

export function log(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  if (!file) return;
  const text = parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : format('%o', p))).join(' ');
  try {
    appendFileSync(file, `${new Date().toISOString()} [${level}] ${text}\n`);
  } catch {
    // Журнал не должен ронять приложение.
  }
}

/** Открыть журнал в папке `dir`, записать строку запуска и перехватить ошибки главного процесса. */
export function initLog(dir: string, startLine: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'kenshi-mod-editor.log');
    if (existsSync(f) && statSync(f).size > MAX_BYTES) {
      const old = join(dir, 'kenshi-mod-editor.old.log');
      rmSync(old, { force: true });
      renameSync(f, old);
    }
    file = f;
  } catch {
    file = undefined;
    return;
  }
  log('info', startLine);
  process.on('uncaughtException', (err) => {
    log('error', 'main: uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    log('error', 'main: unhandledRejection', reason);
  });
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      log(level, 'main:', ...args);
      orig(...args);
    };
  }
}

/** Ошибки и предупреждения окна — в журнал. */
export function watchWindow(wc: WebContents): void {
  wc.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log(e.level === 'error' ? 'error' : 'warn', `window: ${e.message} (${e.sourceId}:${String(e.lineNumber)})`);
  });
  wc.on('render-process-gone', (_e, d) => {
    log('error', `window: process gone (${d.reason}, code ${String(d.exitCode)})`);
  });
  wc.on('preload-error', (_e, path, err) => {
    log('error', `window: preload error in ${path}`, err);
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    log('error', `window: load failed ${String(code)} ${desc} ${url}`);
  });
  wc.on('unresponsive', () => {
    log('warn', 'window: not responding');
  });
}
