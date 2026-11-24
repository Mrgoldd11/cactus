/**
 * Model of a Kenshi data file (.base, .mod; the same record format is used in .save/.level/.zone).
 *
 * Principle: read and write = the same bytes. So string values are the original
 * bytes (`Uint8Array`), the order of all dictionaries is preserved (Map keeps insertion order),
 * and rare "non-standard" values (NaN with special bits, booleans other than 0/1, identifiers
 * not in UTF-8) are remembered in `RecordQuirks`/`DataFile.latin1Ids`.
 */

/** File type: the first int32. */
export const FileType = {
  /** Saves, .platoon, .zone etc.: no mod header. */
  Data: 15,
  /** Old-format .mod/.base. */
  Mod: 16,
  /** .mod with header length and merge data (FCS after 1.0.x). */
  MergeMod: 17,
} as const;

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export interface MergeEntry {
  key: string;
  a: number;
  b: number;
}

export interface DeleteRequest {
  key: string;
  a: number;
  value: Uint8Array;
}

/** Data that FCS writes into the format 17 header after the reference list. */
export interface MergeData {
  saveCount: number;
  lastMerge: number;
  mergeEntries: MergeEntry[];
  /** undefined: the file had no deletion block (this is not the same as an empty list). */
  deleteRequests?: DeleteRequest[];
}

export interface ModHeader {
  version: number;
  author: Uint8Array;
  description: Uint8Array;
  /** Comma-separated dependencies, as in the file. See `splitModList`. */
  dependencies: Uint8Array;
  /** Comma-separated references. */
  references: Uint8Array;
  /** Format 17 only. */
  merge?: MergeData;
  /** Format 17 only: header bytes that come after the parsed fields (usually empty). */
  extra?: Uint8Array;
}

export interface Reference {
  /** String id of the referenced record. */
  target: string;
  v0: number;
  v1: number;
  v2: number;
}

export interface Instance {
  /** String id of the placed record. */
  target: string;
  position: Vec3;
  /** Quaternion in file order (w, x, y, z). */
  rotation: Vec4;
  states: Uint8Array[];
}

/** Deviations from the "canonical" encoding of values, needed only for byte-for-byte writing. */
export interface RecordQuirks {
  /** Value path → original NaN bits. Path: `float:<key>`, `vec3:<key>:<i>`, `inst:<key>:<i>`. */
  nanBits?: Map<string, number>;
  /** Boolean field key → original byte, if it is neither 0 nor 1. */
  boolBytes?: Map<string, number>;
}

export interface GameRecord {
  /**
   * The first int32 of a record. In format 17 it is the record length in bytes (including the number itself) or 0;
   * a non-zero length is recomputed on write. In other formats it is as in the file (usually 0).
   */
  lead: number;
  /** Record type, a number (see `itemTypeName`). */
  type: number;
  id: number;
  name: Uint8Array;
  /** String id, e.g. `2604-gamedata.base`. */
  stringId: string;
  /** Change flags as in the file (uint32): new/changed/renamed and the save counter. */
  changeFlags: number;
  bools: Map<string, boolean>;
  floats: Map<string, number>;
  ints: Map<string, number>;
  vec3s: Map<string, Vec3>;
  vec4s: Map<string, Vec4>;
  strings: Map<string, Uint8Array>;
  files: Map<string, Uint8Array>;
  /** Category → references. Order and duplicates within a category are preserved. */
  refs: Map<string, Reference[]>;
  instances: Map<string, Instance>;
  quirks?: RecordQuirks;
}

export interface DataFile {
  fileType: number;
  /** Present in formats 16 and 17. */
  header?: ModHeader;
  /** Last issued numeric id (FCS takes the next one for new records). */
  lastId: number;
  records: GameRecord[];
  /** Bytes after the last record (.zone has an id list there; .mod is usually empty). */
  tail: Uint8Array;
  /** Identifiers written in the file not in UTF-8 (read as latin1). */
  latin1Ids?: Set<string>;
}

export function emptyRecord(type: number, stringId: string, name: Uint8Array = new Uint8Array()): GameRecord {
  return {
    lead: 0,
    type,
    id: 0,
    name,
    stringId,
    changeFlags: 0,
    bools: new Map(),
    floats: new Map(),
    ints: new Map(),
    vec3s: new Map(),
    vec4s: new Map(),
    strings: new Map(),
    files: new Map(),
    refs: new Map(),
    instances: new Map(),
  };
}
