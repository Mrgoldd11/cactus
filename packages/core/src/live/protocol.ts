/**
 * Live link of the AI with the open editor: the MCP server connects over WebSocket (only
 * 127.0.0.1, token from the discovery file) and sends JSON requests. Replies come from the editor window.
 *
 * Requests: `hello` (token), `state` (version and what is open), `snapshot` (the same + the mod file),
 * `propose` (edits; they show up in the window as an AI change set), `changesets` (their state).
 */
import type { EditOp } from '../model/ops.ts';

export const LIVE_PROTOCOL = 1;

/** Discovery file written by the editor (`live.json`). */
export interface LiveDiscovery {
  protocol: number;
  port: number;
  token: string;
  pid: number;
  /** Editor version. */
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
  /** Grows on every edit in the window; a different `session` means another mod was opened. */
  version: number;
  session: number;
  modName: string;
  /** Path of the mod file; absent for a new mod not saved yet. */
  modPath?: string;
  /** Game folder opened in the editor. */
  game?: string;
  /** Dependencies: lower layers over vanilla, in order. */
  dependencies: { name: string; path: string }[];
  dirty: boolean;
}

export interface LiveSnapshot extends LiveState {
  /** The current mod (changes only), as "Save" would write it, in base64. */
  mod: string;
}

/**
 * pending: awaiting a decision; accepted: accepted; rolled-back: rolled back with the button;
 * undone: undone in the window (Ctrl+Z).
 */
export type AiChangeStatus = 'pending' | 'accepted' | 'rolled-back' | 'undone';

export interface AiChangeset {
  /** Edit id in the editor's undo history. */
  id: number;
  title: string;
  status: AiChangeStatus;
  /** Affected records and created ones (in order). */
  touched: string[];
  created: string[];
  /** Per-record difference, as text (as in `diff`). */
  summary: string[];
  at: number;
}

export interface ProposeResult {
  changeset: AiChangeset;
  aliases: Record<string, string>;
}

const CHUNK = 0x8000;

/** base64 without Buffer: works both in the window and in Node. */
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
