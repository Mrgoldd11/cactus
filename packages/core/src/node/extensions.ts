/**
 * Schema extensions on disk: finds the mod folders that carry FCS Extended files and reads them
 * into layers for `schema/extensions.ts`.
 *
 * A folder is an extension when it holds at least one of `fcs.def`, `fcs_preload.def`,
 * `<name>.def.patch`, `FCS_extended.json`. File names are matched without regard to letter
 * case (FCS Extended runs on Windows, where `FCS.def` and `fcs.def` are the same file).
 *
 * Finding costs one directory listing per folder and one `stat` per extension file. No `.mod`
 * file is opened, and of the extension files only the small `FCS_extended.json` is read. The
 * texts of the def files are read later, and only when the schema cache has no schema for them
 * (`loadGameSchema`).
 *
 * Which extensions apply to a mod (`extensionsFor`): by default those of the opened mod and of
 * the mods loaded under it, not every installed one as in FCS Extended. The order is the one
 * FCS Extended uses: folders of `mods/` by name, then folders of the workshop by name.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { FileStamp } from '../format/file-cache.ts';
import type { ExtensionFile, ExtensionLayer } from '../schema/extensions.ts';
import type { GamePaths } from './paths.ts';

/** Where the folder of an extension lies: in `mods/` of the game, in the workshop, or elsewhere. */
export type ExtensionSource = 'mods' | 'workshop' | 'folder';

/** A mod folder with FCS Extended files, as found on disk. */
export interface FoundExtension {
  /**
   * Key of the extension for settings: `mods/<folder>`, `workshop/<folder>`, or the full path
   * of the folder for a mod kept elsewhere.
   */
  id: string;
  /**
   * Name for the user, also written into the schema (`extension` of types, fields, warnings):
   * the name of the folder; for a workshop folder (its name is a number) the name of its
   * `.mod` file without the suffix, when there is one.
   */
  name: string;
  source: ExtensionSource;
  /** Full path of the folder. */
  dir: string;
  /** `fcs.def` of the folder, with the letter case it has on disk. */
  def?: string;
  /** `fcs_preload.def` of the folder. */
  preload?: string;
  /** `<target>.patch` files; the target keeps the letter case of the file name. */
  patches: { path: string; target: string }[];
  /** `FCS_extended.json` of the folder. */
  config?: string;
  /** DLL plugins named in `FCS_extended.json`. Cactus never loads them. */
  plugins: string[];
  /** Why `FCS_extended.json` could not be read, if it could not. */
  configError?: string;
  /** Names of the `.mod` files in the folder (the files are not opened). */
  mods: string[];
  /** Size and time of every extension file: the key of the schema cache. */
  stamps: FileStamp[];
}

const DEF_NAME = 'fcs.def';
const PRELOAD_NAME = 'fcs_preload.def';
const CONFIG_NAME = 'fcs_extended.json';
const PATCH_SUFFIX = '.def.patch';
/** A plugin list is a few lines; a bigger file is not read. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Order of folders, as Windows lists them and FCS Extended walks them: by name without regard
 * to letter case. Names equal in everything but case keep a fixed order too.
 */
export function compareFolderNames(a: string, b: string): number {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stampOf(path: string): FileStamp | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? { path, size: st.size, mtimeMs: st.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function readPlugins(path: string, size: number): { plugins: string[]; error?: string } {
  if (size > MAX_CONFIG_BYTES) return { plugins: [], error: 'FCS_extended.json is too big to be a plugin list; it is not read' };
  try {
    const json: unknown = JSON.parse(stripBom(readFileSync(path, 'utf8')));
    const list = typeof json === 'object' && json !== null ? (json as Record<string, unknown>)['FCS_Plugins'] : undefined;
    if (list === undefined) return { plugins: [] };
    if (!Array.isArray(list)) return { plugins: [], error: 'FCS_Plugins in FCS_extended.json is not a list' };
    return { plugins: list.filter((p): p is string => typeof p === 'string' && p.length > 0) };
  } catch (e) {
    return { plugins: [], error: `FCS_extended.json cannot be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Where a folder lies relative to the game: directly in `mods/`, directly in the workshop, or elsewhere. */
export function extensionSourceOf(paths: GamePaths, dir: string): ExtensionSource {
  const parent = dirname(resolve(dir));
  if (samePath(parent, join(paths.kenshi, 'mods'))) return 'mods';
  if (samePath(parent, paths.workshop)) return 'workshop';
  return 'folder';
}

/** The extension files of one folder; undefined when the folder has none (or cannot be listed). */
export function readExtensionDir(dir: string, source: ExtensionSource = 'folder'): FoundExtension | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  // Cheap test first: most folders are plain mods, and they stop here.
  let any = false;
  for (const n of names) {
    const lower = n.toLowerCase();
    if (lower === DEF_NAME || lower === PRELOAD_NAME || lower === CONFIG_NAME || lower.endsWith(PATCH_SUFFIX)) {
      any = true;
      break;
    }
  }
  if (!any) return undefined;

  const full = resolve(dir);
  const folder = basename(full);
  const stamps: FileStamp[] = [];
  const patches: { path: string; target: string }[] = [];
  const mods: string[] = [];
  let def: string | undefined;
  let preload: string | undefined;
  let config: FileStamp | undefined;
  // Sorted, so that on a file system that tells `FCS.def` from `fcs.def` the choice is fixed.
  for (const n of [...names].sort()) {
    const lower = n.toLowerCase();
    if (lower.endsWith('.mod')) {
      mods.push(n);
      continue;
    }
    const isPatch = lower.endsWith(PATCH_SUFFIX);
    if (!isPatch && lower !== DEF_NAME && lower !== PRELOAD_NAME && lower !== CONFIG_NAME) continue;
    const path = join(full, n);
    const stamp = stampOf(path);
    if (!stamp) continue;
    if (isPatch) {
      patches.push({ path, target: n.slice(0, n.length - '.patch'.length) });
    } else if (lower === DEF_NAME) {
      if (def !== undefined) continue;
      def = path;
    } else if (lower === PRELOAD_NAME) {
      if (preload !== undefined) continue;
      preload = path;
    } else {
      if (config) continue;
      config = stamp;
    }
    stamps.push(stamp);
  }
  if (def === undefined && preload === undefined && !config && patches.length === 0) return undefined;

  const read = config ? readPlugins(config.path, config.size) : { plugins: [] };
  const modName = mods[0]?.slice(0, -'.mod'.length);
  return {
    id: source === 'folder' ? full : `${source}/${folder}`,
    name: source === 'workshop' && modName !== undefined ? modName : folder,
    source,
    dir: full,
    ...(def !== undefined && { def }),
    ...(preload !== undefined && { preload }),
    patches,
    ...(config && { config: config.path }),
    plugins: read.plugins,
    ...(read.error !== undefined && { configError: read.error }),
    mods,
    stamps,
  };
}

/** Whether the extension has files that change the schema (a folder with DLL plugins alone does not). */
export function changesSchema(ext: FoundExtension): boolean {
  return ext.def !== undefined || ext.preload !== undefined || ext.patches.length > 0;
}

const SOURCE_ORDER: Record<ExtensionSource, number> = { mods: 0, workshop: 1, folder: 2 };

/**
 * Load order of extensions, as in FCS Extended: folders of `mods/` by name, then folders of the
 * workshop by name. Folders from elsewhere (FCS Extended never sees them) go last, by path.
 */
export function sortExtensions(list: readonly FoundExtension[]): FoundExtension[] {
  return [...list].sort(
    (a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || compareFolderNames(basename(a.dir), basename(b.dir)) || compareFolderNames(a.dir, b.dir),
  );
}

/**
 * Every extension installed: one pass over `mods/` of the game and over the workshop, in load
 * order. For the list in the editor window; opening a mod does not need it (`extensionsFor`).
 */
export function findExtensions(paths: GamePaths): FoundExtension[] {
  const out: FoundExtension[] = [];
  const scan = (root: string, source: ExtensionSource): void => {
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name);
    } catch {
      return;
    }
    for (const d of dirs.sort(compareFolderNames)) {
      const ext = readExtensionDir(join(root, d), source);
      if (ext) out.push(ext);
    }
  };
  scan(join(paths.kenshi, 'mods'), 'mods');
  scan(paths.workshop, 'workshop');
  return out;
}

/** Which extensions to apply; kept in the settings of the editor. */
export interface ExtensionChoice {
  /** Apply the extensions of the opened mod and of the mods loaded under it. Default: yes. */
  auto?: boolean;
  /** Ids (`FoundExtension.id`) of extensions to apply besides those. */
  enable?: readonly string[];
  /** Ids of extensions never to apply. */
  disable?: readonly string[];
}

/** A choice read from a settings file: anything of a wrong shape is dropped. */
export function normalizeExtensionChoice(value: unknown): ExtensionChoice {
  if (typeof value !== 'object' || value === null) return {};
  const v = value as Record<string, unknown>;
  const ids = (x: unknown): string[] | undefined => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.length > 0) : undefined);
  const enable = ids(v['enable']);
  const disable = ids(v['disable']);
  return {
    ...(typeof v['auto'] === 'boolean' && { auto: v['auto'] }),
    ...(enable && enable.length > 0 && { enable }),
    ...(disable && disable.length > 0 && { disable }),
  };
}

/** Folder of an extension by its id; undefined for an id that is not a folder name or a path. */
export function extensionDirOf(paths: GamePaths, id: string): string | undefined {
  const slash = id.indexOf('/');
  const head = slash < 0 ? '' : id.slice(0, slash);
  if (head === 'mods' || head === 'workshop') {
    const folder = id.slice(slash + 1);
    if (folder.length === 0 || folder === '.' || folder === '..' || /[/\\]/.test(folder)) return undefined;
    return join(head === 'mods' ? join(paths.kenshi, 'mods') : paths.workshop, folder);
  }
  return id.length > 0 ? resolve(id) : undefined;
}

/**
 * The extensions to apply to a mod, in load order.
 *
 * `modFiles` are the `.mod` files loaded into the context: the opened mod (the file may not
 * exist yet) and its dependencies. The folder of each is looked at; with `choice.auto: false`
 * none of them is. `choice.enable` adds extensions by id, `choice.disable` removes them.
 */
export function extensionsFor(paths: GamePaths, modFiles: readonly string[], choice: ExtensionChoice = {}): FoundExtension[] {
  const dirs = new Map<string, string>();
  const add = (dir: string): void => {
    const full = resolve(dir);
    // The game's own folder holds the game's fcs.def: it is the base, not an extension.
    if (samePath(full, paths.kenshi)) return;
    const key = full.toLowerCase();
    if (!dirs.has(key)) dirs.set(key, full);
  };
  if (choice.auto !== false) for (const f of modFiles) add(dirname(resolve(f)));
  for (const id of choice.enable ?? []) {
    const dir = extensionDirOf(paths, id);
    if (dir !== undefined) add(dir);
  }
  const disabled = new Set((choice.disable ?? []).map((id) => id.toLowerCase()));
  const out: FoundExtension[] = [];
  for (const dir of dirs.values()) {
    const ext = readExtensionDir(dir, extensionSourceOf(paths, dir));
    if (ext && !disabled.has(ext.id.toLowerCase())) out.push(ext);
  }
  return sortExtensions(out);
}

function readText(path: string): ExtensionFile {
  return { path, text: stripBom(readFileSync(path, 'utf8')) };
}

/** Read the texts of the found extensions into schema layers (for `applyExtensionLayers`). */
export function readExtensionLayers(found: readonly FoundExtension[]): ExtensionLayer[] {
  return found.map((e) => ({
    name: e.name,
    dir: e.dir,
    ...(e.def !== undefined && { def: readText(e.def) }),
    ...(e.preload !== undefined && { preload: readText(e.preload) }),
    ...(e.patches.length > 0 && { patches: e.patches.map((p) => ({ ...readText(p.path), target: p.target })) }),
    ...(e.plugins.length > 0 && { plugins: e.plugins }),
  }));
}

/** Key of the schema cache for a set of extensions: ids in load order with the state of their files. */
export function extensionsCacheKey(found: readonly FoundExtension[]): string {
  return found.map((e) => `${e.id}*${e.name}*${e.stamps.map((s) => `${s.path}|${s.size}|${s.mtimeMs}`).join(';')}`).join('\n');
}
