/**
 * Map features: huge scenery the game places by hand (robot arms, bridges, wrecks, canyon
 * bluffs). They are not in the zone files but in `data/newland/land/features.dat`:
 *
 *   "MF01", u32 zone count (4096 = 64×64), then per zone (index = y·64 + x) u32 offset + u32 size;
 *   a zone block is u32 count, then per feature: u8 length + string id of a MAP_FEATURES record,
 *   position xyz (world, absolute height), scale xyz, rotation wxyz — ten float32.
 *
 * A feature is listed in every zone it reaches into, so duplicates are dropped here.
 * Layout decoded from the file itself (all blocks end exactly at offset + size).
 */
export const MAP_FEATURES_PATH = 'data/newland/land/features.dat';

export interface MapFeature {
  /** String id of the MAP_FEATURES record. */
  target: string;
  position: [number, number, number];
  scale: [number, number, number];
  /** w, x, y, z — as in the zone files. */
  rotation: [number, number, number, number];
}

export function parseMapFeatures(bytes: Uint8Array): MapFeature[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'MF01') throw new Error('features.dat: not an MF01 file');
  const zones = v.getUint32(4, true);
  if (8 + zones * 8 > bytes.length) throw new Error('features.dat: zone table is cut off');
  const out: MapFeature[] = [];
  const seen = new Set<string>();
  for (let z = 0; z < zones; z++) {
    let o = v.getUint32(8 + z * 8, true);
    const size = v.getUint32(12 + z * 8, true);
    if (size < 4 || o + size > bytes.length) continue;
    const end = o + size;
    const count = v.getUint32(o, true);
    o += 4;
    for (let i = 0; i < count; i++) {
      const len = bytes[o]!;
      if (o + 1 + len + 40 > end) break;
      const target = String.fromCharCode(...bytes.subarray(o + 1, o + 1 + len));
      o += 1 + len;
      const f: number[] = [];
      for (let k = 0; k < 10; k++) f.push(v.getFloat32(o + k * 4, true));
      o += 40;
      const key = `${target}|${f.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ target, position: [f[0]!, f[1]!, f[2]!], scale: [f[3]!, f[4]!, f[5]!], rotation: [f[6]!, f[7]!, f[8]!, f[9]!] });
    }
  }
  return out;
}
