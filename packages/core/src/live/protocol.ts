/**
 * Живая связь ИИ с открытым редактором: MCP-сервер подключается по WebSocket (только
 * 127.0.0.1, токен из файла обнаружения) и шлёт запросы JSON. Ответы — от окна редактора.
 *
 * Запросы: `hello` (токен), `state` (версия и что открыто), `snapshot` (то же + файл мода),
 * `propose` (правки — в окне появляются набором изменений ИИ), `changesets` (их состояние).
 */
import type { EditOp } from '../model/ops.ts';

export const LIVE_PROTOCOL = 1;

/** Файл обнаружения, который пишет редактор (`live.json`). */
export interface LiveDiscovery {
  protocol: number;
  port: number;
  token: string;
  pid: number;
  /** Версия редактора. */
  app?: string;
}

export type LiveRequestBody =
  | { method: 'hello'; token: string; client?: string }
  | { method: 'state' }
  | { method: 'snapshot' }
  | { method: 'propose'; title: string; ops: EditOp[] }
  | { method: 'changesets' };

export type LiveRequest = LiveRequestBody & { id: number };

export type LiveResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export interface LiveState {
  /** Растёт при каждой правке в окне; другой `session` — открыт другой мод. */
  version: number;
  session: number;
  modName: string;
  /** Путь файла мода; нет — новый мод, ещё не сохранён. */
  modPath?: string;
  /** Папка игры, открытой в редакторе. */
  game?: string;
  /** Зависимости — нижние слои поверх ванили, по порядку. */
  dependencies: { name: string; path: string }[];
  dirty: boolean;
}

export interface LiveSnapshot extends LiveState {
  /** Текущий мод (только изменения), как его записало бы «Сохранить», в base64. */
  mod: string;
}

/**
 * pending — ждёт решения; accepted — принят; rolled-back — откачен кнопкой;
 * undone — отменён в окне (Ctrl+Z).
 */
export type AiChangeStatus = 'pending' | 'accepted' | 'rolled-back' | 'undone';

export interface AiChangeset {
  /** Id правки в истории отмены редактора. */
  id: number;
  title: string;
  status: AiChangeStatus;
  /** Затронутые записи и созданные (по порядку). */
  touched: string[];
  created: string[];
  /** Разница по записям, текстом (как в `diff`). */
  summary: string[];
  at: number;
}

export interface ProposeResult {
  changeset: AiChangeset;
  aliases: Record<string, string>;
}

const CHUNK = 0x8000;

/** base64 без Buffer — работает и в окне, и в Node. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function base64ToBytes(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
