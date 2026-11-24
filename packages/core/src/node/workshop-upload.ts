/**
 * The Workshop upload itself, as run inside the uploader child process. Steam is reached only
 * through `SteamWorkshopApi`: the desktop app passes a steamworks.js adapter, tests and
 * `KEDIT_FAKE_STEAM=1` runs pass `fakeSteam()`, which never touches Steam.
 *
 * Order (create or update is decided by the id in `_<mod>.info`):
 *  1. init Steam (an init failure is told apart by the local process list: not running / refused);
 *  2. check the account owns Kenshi; re-read `_<mod>.info` and refuse if its id changed;
 *  3. no id yet → create the item, then at once write `_<mod>.info` with the new id, so a later
 *     failure never leaves an item Cactus forgets about;
 *     with an id → write `_<mod>.info` with the new title / tags / visibility / date;
 *  4. copy the preview to `_<mod>.img`, stage the upload files into a temp folder;
 *  5. submit the update (content + preview + texts) and report progress;
 *  6. remove the temp folder.
 */
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { dotNetDate, isPublishedId, newWorkshopInfo, type WorkshopInfo } from '../workshop/info.ts';
import {
  classifySteamError,
  encodeMessage,
  STEAM_APP_ID_KENSHI,
  LineSplitter,
  UPLOADER_PROTOCOL,
  type ParentMessage,
  type PublishErrorCode,
  type PublishRequest,
  type PublishStage,
  type UploaderMessage,
  type UploadPhase,
} from '../workshop/protocol.ts';
import { isSteamProcessRunning, listUploadFiles, readWorkshopInfo, removeStaging, stageUploadFiles, workshopPaths, writeWorkshopInfo } from './workshop.ts';

export interface SteamItemDetails {
  title: string;
  description: string;
  changeNote: string;
  previewPath: string;
  contentPath: string;
  tags: string[];
  visibility: number;
}

/** The part of Steam the uploader needs. Errors are thrown as `Error` with Steam's text. */
export interface SteamWorkshopApi {
  /** Connect to the running Steam client for the app; throws when Steam refuses. */
  init(appId: number): void;
  /** The logged-in account owns the app. */
  ownsApp(appId: number): boolean;
  createItem(appId: number): Promise<{ itemId: string; needsToAcceptAgreement: boolean }>;
  updateItem(itemId: string, details: SteamItemDetails, appId: number, onProgress: (phase: UploadPhase, done: number, total: number) => void): Promise<{ needsToAcceptAgreement: boolean }>;
  /** Local check whether a Steam client runs (defaults to the process list). */
  steamRunning?(): boolean | undefined;
}

/** Thrown inside the session to end it with a typed error. */
class PublishFailure extends Error {
  readonly code: PublishErrorCode;
  readonly detail: string | undefined;
  constructor(code: PublishErrorCode, detail?: string) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail;
  }
}

export interface PublishSessionOptions {
  /** Polled between steps; `true` stops the session. */
  cancelled?: () => boolean;
  now?: () => Date;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Run one publish. Emits protocol messages and returns the final one (`done`, `error` or
 * `cancelled`), which is also emitted.
 */
export async function runPublish(req: PublishRequest, steam: SteamWorkshopApi, emit: (m: UploaderMessage) => void, opts: PublishSessionOptions = {}): Promise<UploaderMessage> {
  let stage: PublishStage | 'start' = 'start';
  let itemId: string | undefined;
  let staged: string | undefined;
  const step = (s: PublishStage): void => {
    if (opts.cancelled?.()) throw new CancelSignal();
    stage = s;
    emit({ type: 'stage', stage: s });
  };
  const finish = (m: UploaderMessage): UploaderMessage => {
    emit(m);
    return m;
  };
  try {
    const paths = workshopPaths(req.modPath);
    step('init');
    try {
      steam.init(STEAM_APP_ID_KENSHI);
    } catch (e) {
      const running = (steam.steamRunning ?? isSteamProcessRunning)();
      const code = classifySteamError(errText(e));
      throw new PublishFailure(running === false ? 'steam-not-running' : code === 'unknown' ? 'steam-init-failed' : code, errText(e));
    }

    step('checking');
    if (!steam.ownsApp(STEAM_APP_ID_KENSHI)) throw new PublishFailure('no-license');
    if (!existsSync(req.modPath)) throw new PublishFailure('files', `mod file not found: ${req.modPath}`);
    if (!existsSync(req.previewPath)) throw new PublishFailure('files', `preview not found: ${req.previewPath}`);
    const onDisk = readWorkshopInfo(req.modPath);
    const diskId = onDisk.state === 'ok' && isPublishedId(onDisk.file.info.id) ? onDisk.file.info.id : '0';
    const expected = isPublishedId(req.expectedId) ? req.expectedId : '0';
    if (diskId !== expected) throw new PublishFailure('info-changed', `window had ${expected}, file has ${diskId}`);
    const base = onDisk.state === 'ok' ? onDisk.file : undefined;
    const now = (opts.now ?? (() => new Date()))();
    const info: WorkshopInfo = {
      ...(base?.info ?? newWorkshopInfo(paths.mod)),
      mod: paths.mod,
      title: req.title,
      tags: [...req.tags],
      visibility: req.visibility,
      lastUpdate: dotNetDate(now),
    };

    let created = false;
    let needsAgreement = false;
    if (diskId === '0') {
      step('creating');
      try {
        const r = await steam.createItem(STEAM_APP_ID_KENSHI);
        itemId = r.itemId;
        needsAgreement = r.needsToAcceptAgreement;
      } catch (e) {
        throw new PublishFailure(classifySteamError(errText(e)), errText(e));
      }
      if (!isPublishedId(itemId)) throw new PublishFailure('unknown', `Steam returned item id ${String(itemId)}`);
      created = true;
      emit({ type: 'created', id: itemId, needsAgreement });
    } else itemId = diskId;
    info.id = itemId;

    // Not cancellable between create and this write: the new id must land in the file.
    stage = 'writing-info';
    emit({ type: 'stage', stage });
    try {
      writeWorkshopInfo(req.modPath, info, base);
    } catch (e) {
      throw new PublishFailure('files', `could not write ${paths.info}: ${errText(e)}`);
    }

    step('staging');
    try {
      if (resolve(req.previewPath).toLowerCase() !== resolve(paths.img).toLowerCase()) copyFileSync(req.previewPath, paths.img);
      const list = listUploadFiles(paths.dir);
      staged = req.stagingDir;
      const s = stageUploadFiles(paths.dir, list.files, staged);
      emit({ type: 'log', text: `staged ${String(list.files.length)} files (${String(list.totalSize)} bytes; ${String(s.linked)} linked, ${String(s.copied)} copied), excluded ${String(list.excluded.length)}` });
    } catch (e) {
      throw new PublishFailure('files', errText(e));
    }

    step('uploading');
    try {
      const r = await steam.updateItem(
        itemId,
        {
          title: req.title,
          description: req.description,
          changeNote: req.changeNote,
          previewPath: resolve(paths.img),
          contentPath: resolve(staged),
          tags: [...req.tags],
          visibility: req.visibility,
        },
        STEAM_APP_ID_KENSHI,
        (phase, done, total) => {
          emit({ type: 'progress', phase, done, total });
        },
      );
      needsAgreement ||= r.needsToAcceptAgreement;
    } catch (e) {
      throw new PublishFailure(classifySteamError(errText(e)), errText(e));
    }
    removeStaging(staged);
    staged = undefined;
    return finish({ type: 'done', id: itemId, created, needsAgreement });
  } catch (e) {
    // During the upload Steam may still read the staged files: leave them (the next run clears them).
    if (staged !== undefined && (stage as PublishStage | 'start') !== 'uploading') removeStaging(staged);
    if (e instanceof CancelSignal) return finish({ type: 'cancelled', stage, ...(itemId !== undefined ? { id: itemId } : {}) });
    if (e instanceof PublishFailure) return finish({ type: 'error', code: e.code, ...(e.detail !== undefined ? { detail: e.detail } : {}), ...(itemId !== undefined ? { id: itemId } : {}) });
    return finish({ type: 'error', code: 'crashed', detail: e instanceof Error ? (e.stack ?? e.message) : String(e), ...(itemId !== undefined ? { id: itemId } : {}) });
  }
}

class CancelSignal extends Error {}

// ---------------------------------------------------------------------------------------------
// Fake Steam

export type FakeSteamScenario =
  | 'success'
  | 'agreement'
  | 'slow'
  | 'not-running'
  | 'init-failed'
  | 'no-license'
  | 'not-logged-in'
  | 'access-denied'
  | 'item-deleted'
  | 'rate-limit'
  | 'timeout'
  | 'no-connection'
  | 'banned'
  | 'unknown-error'
  | 'crash';

export const FAKE_STEAM_SCENARIOS: readonly FakeSteamScenario[] = [
  'success', 'agreement', 'slow', 'not-running', 'init-failed', 'no-license', 'not-logged-in', 'access-denied',
  'item-deleted', 'rate-limit', 'timeout', 'no-connection', 'banned', 'unknown-error', 'crash',
];

/** Item id the fake gives a new item. */
export const FAKE_ITEM_ID = '4000000001';

/** Steam texts the fake throws (the real steamworks.js 0.4.0 texts). */
const FAKE_ERRORS: Partial<Record<FakeSteamScenario, string>> = {
  'not-logged-in': 'user not logged on',
  'access-denied': 'access denied',
  'item-deleted': 'item deleted',
  'rate-limit': 'temporary rate limit exceeded',
  timeout: 'operation timed out',
  'no-connection': "there isn't a network connection to steam, or the steam servers are down",
  banned: 'VAC2 banned',
  'unknown-error': 'a generic failure from the steamworks API',
};

export interface FakeSteamOptions {
  /** Delay between progress steps, ms (`slow` multiplies it by 10). */
  tickMs?: number;
  /** Where to append a JSON line per call (what would have been sent to Steam). */
  logPath?: string;
  /** Called instead of exiting for the `crash` scenario (tests). */
  onCrash?: () => never;
  appendLog?: (line: string) => void;
}

/** Scenario from `KEDIT_FAKE_STEAM` (`1` / `true` → success); `undefined` — use real Steam. */
export function fakeScenarioFromEnv(value: string | undefined): FakeSteamScenario | undefined {
  if (value === undefined || value === '' || value === '0' || value.toLowerCase() === 'false') return undefined;
  if (value === '1' || value.toLowerCase() === 'true') return 'success';
  return (FAKE_STEAM_SCENARIOS as readonly string[]).includes(value) ? (value as FakeSteamScenario) : 'success';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(`${relative(dir, full).split(sep).join('/')}:${String(statSync(full).size)}`);
    }
  };
  walk(dir);
  return out.sort();
}

/** A Steam that only pretends: no network, no Steam client, nothing leaves the machine. */
export function fakeSteam(scenario: FakeSteamScenario = 'success', opts: FakeSteamOptions = {}): SteamWorkshopApi {
  const tick = (opts.tickMs ?? 60) * (scenario === 'slow' ? 10 : 1);
  const record = (call: string, data: Record<string, unknown>): void => {
    const line = JSON.stringify({ call, ...data });
    opts.appendLog?.(line);
  };
  const fail = (): void => {
    const text = FAKE_ERRORS[scenario];
    if (text !== undefined) throw new Error(text);
  };
  return {
    init(appId) {
      record('init', { appId });
      if (scenario === 'not-running' || scenario === 'init-failed') throw new Error('failed to init the steamworks API');
    },
    ownsApp(appId) {
      record('ownsApp', { appId });
      return scenario !== 'no-license';
    },
    steamRunning() {
      return scenario !== 'not-running';
    },
    async createItem(appId) {
      record('createItem', { appId });
      await sleep(tick);
      if (scenario === 'not-logged-in' || scenario === 'rate-limit' || scenario === 'banned') fail();
      return { itemId: FAKE_ITEM_ID, needsToAcceptAgreement: scenario === 'agreement' };
    },
    async updateItem(itemId, details, appId, onProgress) {
      record('updateItem', { itemId, appId, ...details, files: listTree(details.contentPath) });
      const total = 1000;
      const phases: UploadPhase[] = ['preparing-config', 'preparing-content', 'uploading-content', 'uploading-content', 'uploading-content', 'uploading-preview', 'committing'];
      for (let i = 0; i < phases.length; i++) {
        await sleep(tick);
        onProgress(phases[i]!, phases[i] === 'uploading-content' ? Math.round((total * (i - 1)) / 3) : 0, phases[i] === 'uploading-content' ? total : 0);
        if (scenario === 'crash' && i === 3) {
          if (opts.onCrash) opts.onCrash();
          process.exit(70);
        }
        if (i === 2) fail();
      }
      return { needsToAcceptAgreement: scenario === 'agreement' };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Child process main

export interface UploaderMainOptions {
  /** Loads the real Steam adapter (only called when no fake is asked for). */
  loadReal: () => SteamWorkshopApi;
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  write?: (line: string) => void;
  exit?: (code: number) => void;
  appendFakeLog?: (path: string, line: string) => void;
}

/**
 * Entry of the uploader process: reads the request from stdin, runs it, prints protocol lines
 * to stdout and exits (steamworks.js keeps a callback timer alive forever, so exiting is the
 * only way to end the process).
 */
export function uploaderMain(o: UploaderMainOptions): void {
  const env = o.env ?? process.env;
  const write = o.write ?? ((l: string) => process.stdout.write(l));
  const exit =
    o.exit ??
    ((code: number) => {
      process.stdout.write('', () => process.exit(code));
    });
  const stdin: Readable = o.stdin ?? process.stdin;
  let finished = false;
  let stage: PublishStage | 'start' = 'start';
  let itemId: string | undefined;
  const emit = (m: UploaderMessage): void => {
    if (finished) return;
    if (m.type === 'stage') stage = m.stage;
    if (m.type === 'created') itemId = m.id;
    if (m.type === 'done' || m.type === 'error' || m.type === 'cancelled') finished = true;
    write(encodeMessage(m));
  };
  const scenario = fakeScenarioFromEnv(env['KEDIT_FAKE_STEAM']);
  emit({ type: 'hello', protocol: UPLOADER_PROTOCOL, fake: scenario !== undefined });

  let cancelled = false;
  let started = false;
  const splitter = new LineSplitter();
  stdin.setEncoding('utf8');
  const start = (req: PublishRequest): void => {
    started = true;
    let steam: SteamWorkshopApi;
    try {
      if (scenario !== undefined) {
        const logPath = env['KEDIT_FAKE_STEAM_LOG'];
        const tick = Number(env['KEDIT_FAKE_STEAM_TICK_MS']);
        steam = fakeSteam(scenario, {
          ...(Number.isFinite(tick) && tick >= 0 ? { tickMs: tick } : {}),
          ...(logPath && o.appendFakeLog ? { appendLog: (line: string) => { o.appendFakeLog!(logPath, line); } } : {}),
        });
      } else steam = o.loadReal();
    } catch (e) {
      emit({ type: 'error', code: 'library-missing', detail: e instanceof Error ? (e.stack ?? e.message) : String(e) });
      exit(2);
      return;
    }
    void runPublish(req, steam, emit, { cancelled: () => cancelled }).then(
      (m) => {
        if (m.type === 'cancelled' && finished && stage === 'uploading') return;
        exit(m.type === 'done' ? 0 : m.type === 'cancelled' ? 3 : 1);
      },
      (e: unknown) => {
        emit({ type: 'error', code: 'crashed', detail: String(e) });
        exit(1);
      },
    );
  };
  stdin.on('data', (chunk: string | Buffer) => {
    for (const line of splitter.push(String(chunk))) {
      let m: ParentMessage;
      try {
        m = JSON.parse(line) as ParentMessage;
      } catch {
        continue;
      }
      if (m.type === 'cancel') {
        cancelled = true;
        if (!started) {
          emit({ type: 'cancelled', stage: 'start' });
          exit(3);
        } else if (stage === 'uploading' && !finished) {
          // steamworks.js cannot abort a submitted update: leave now; Steam drops or finishes it.
          emit({ type: 'cancelled', stage, ...(itemId !== undefined ? { id: itemId } : {}) });
          exit(3);
        }
        // Other stages stop at the next safe point (creating waits for the id to be written).
      } else if (!started) start(m.request);
    }
  });
  stdin.on('end', () => {
    // Parent went away: stop at the next safe point.
    cancelled = true;
    if (!started) exit(3);
  });
}
