/**
 * World dump of the Kenshi Bridge plugin: where the running game really put foliage (trees, rocks,
 * bushes) and buildings, one small file per zone. The game scatters foliage itself when a zone
 * loads, so these places exist nowhere in the game files; the plugin records them.
 *
 *  - `foliage.X.Y.bin`: "KBF1", u32 zoneX, u32 zoneY, u32 meshCount, meshCount × (u16 length,
 *    FOLIAGE_MESH string id), u32 count, count × 24 bytes (f32 x, y, z, yaw in degrees, scale;
 *    u16 mesh index; u16 flags). Little endian.
 *  - `buildings.X.Y.json`: `{ v: 1, zone: [x, y], buildings: [{ id, name, p, q, f, town?, faction? }] }`.
 *
 * X is the zone column (from world x), Y the row (from world z), as in `zone.X.Y.zone`.
 */

export const FOLIAGE_DUMP_MAGIC = 'KBF1';
const INSTANCE_BYTES = 24;

/** Foliage instance carries a building (ore rocks). */
export const DUMP_FOLIAGE_BUILDING = 1;

/** Flags of a dumped building. */
export const DUMP_BUILDING = {
  interior: 1,
  foliage: 2,
  destroyed: 4,
  unfinished: 8,
  door: 16,
  furniture: 32,
  outsideFurniture: 64,
} as const;

export interface FoliageDump {
  zone: [number, number];
  /** FOLIAGE_MESH string ids. */
  meshes: string[];
  count: number;
  /** Five numbers per instance: x, y, z, yaw (degrees, around the up axis), uniform scale. */
  data: Float32Array;
  /** Index into `meshes` per instance. */
  mesh: Uint16Array;
  flags: Uint16Array;
}

export interface DumpBuilding {
  /** BUILDING string id. */
  id: string;
  name: string;
  position: [number, number, number];
  /** w, x, y, z. */
  rotation: [number, number, number, number];
  flags: number;
  town?: string;
  faction?: string;
}

export interface BuildingDump {
  zone: [number, number];
  buildings: DumpBuilding[];
}

/** File name of one zone of the dump. */
export function dumpFileName(kind: 'foliage' | 'buildings', x: number, y: number): string {
  return kind === 'foliage' ? `foliage.${x}.${y}.bin` : `buildings.${x}.${y}.json`;
}

/** Zone of a dump file name, or undefined when it is some other file. */
export function parseDumpFileName(name: string): { kind: 'foliage' | 'buildings'; x: number; y: number } | undefined {
  const m = /^(foliage|buildings)\.(\d{1,2})\.(\d{1,2})\.(bin|json)$/.exec(name);
  if (!m) return undefined;
  const kind = m[1] as 'foliage' | 'buildings';
  if ((kind === 'foliage') !== (m[4] === 'bin')) return undefined;
  const x = Number(m[2]);
  const y = Number(m[3]);
  return x < 64 && y < 64 ? { kind, x, y } : undefined;
}

/** Parses `foliage.X.Y.bin`. Throws on a broken file. */
export function parseFoliageDump(bytes: Uint8Array): FoliageDump {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number): void => {
    if (at + n > bytes.byteLength) throw new Error('foliage dump: file is cut short');
  };
  need(16);
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== FOLIAGE_DUMP_MAGIC) throw new Error('foliage dump: not a KBF1 file');
  const zone: [number, number] = [view.getUint32(4, true), view.getUint32(8, true)];
  const meshCount = view.getUint32(12, true);
  at = 16;
  const text = new TextDecoder();
  const meshes: string[] = [];
  for (let k = 0; k < meshCount; k++) {
    need(2);
    const len = view.getUint16(at, true);
    at += 2;
    need(len);
    meshes.push(text.decode(bytes.subarray(at, at + len)));
    at += len;
  }
  need(4);
  const count = view.getUint32(at, true);
  at += 4;
  need(count * INSTANCE_BYTES);
  const data = new Float32Array(count * 5);
  const mesh = new Uint16Array(count);
  const flags = new Uint16Array(count);
  for (let k = 0; k < count; k++) {
    const o = at + k * INSTANCE_BYTES;
    for (let j = 0; j < 5; j++) data[k * 5 + j] = view.getFloat32(o + j * 4, true);
    const m = view.getUint16(o + 20, true);
    if (m >= meshes.length) throw new Error('foliage dump: mesh index out of range');
    mesh[k] = m;
    flags[k] = view.getUint16(o + 22, true);
  }
  return { zone, meshes, count, data, mesh, flags };
}

/** Writes `foliage.X.Y.bin` (tests and tools; the plugin has its own writer). */
export function writeFoliageDump(d: Pick<FoliageDump, 'zone' | 'meshes' | 'data' | 'mesh' | 'flags'>): Uint8Array {
  const enc = new TextEncoder();
  const names = d.meshes.map((m) => enc.encode(m));
  const count = d.mesh.length;
  const size = 16 + names.reduce((n, b) => n + 2 + b.length, 0) + 4 + count * INSTANCE_BYTES;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(enc.encode(FOLIAGE_DUMP_MAGIC), 0);
  view.setUint32(4, d.zone[0], true);
  view.setUint32(8, d.zone[1], true);
  view.setUint32(12, names.length, true);
  let at = 16;
  for (const b of names) {
    view.setUint16(at, b.length, true);
    out.set(b, at + 2);
    at += 2 + b.length;
  }
  view.setUint32(at, count, true);
  at += 4;
  for (let k = 0; k < count; k++) {
    const o = at + k * INSTANCE_BYTES;
    for (let j = 0; j < 5; j++) view.setFloat32(o + j * 4, d.data[k * 5 + j]!, true);
    view.setUint16(o + 20, d.mesh[k]!, true);
    view.setUint16(o + 22, d.flags[k]!, true);
  }
  return out;
}

const isNumbers = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Parses `buildings.X.Y.json`. Throws on a broken file; entries without id or position are dropped. */
export function parseBuildingDump(text: string): BuildingDump {
  const raw = JSON.parse(text) as { v?: unknown; zone?: unknown; buildings?: unknown };
  if (raw.v !== 1 || !isNumbers(raw.zone, 2) || !Array.isArray(raw.buildings)) throw new Error('building dump: unknown format');
  const buildings: DumpBuilding[] = [];
  for (const b of raw.buildings as Record<string, unknown>[]) {
    if (typeof b['id'] !== 'string' || !isNumbers(b['p'], 3) || !isNumbers(b['q'], 4)) continue;
    const out: DumpBuilding = {
      id: b['id'],
      name: typeof b['name'] === 'string' ? b['name'] : '',
      position: b['p'] as [number, number, number],
      rotation: b['q'] as [number, number, number, number],
      flags: typeof b['f'] === 'number' ? b['f'] : 0,
    };
    if (typeof b['town'] === 'string') out.town = b['town'];
    if (typeof b['faction'] === 'string') out.faction = b['faction'];
    buildings.push(out);
  }
  return { zone: [raw.zone[0]!, raw.zone[1]!], buildings };
}

/** Is a dumped building drawn on the map: outdoor, standing, not a door leaf of another building. */
export function isOutdoorDumpBuilding(b: DumpBuilding): boolean {
  return (b.flags & (DUMP_BUILDING.interior | DUMP_BUILDING.destroyed | DUMP_BUILDING.door)) === 0;
}
