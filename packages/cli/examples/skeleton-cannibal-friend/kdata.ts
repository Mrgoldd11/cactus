/**
 * Vanilla as tools/kdata.py saw it (`base()`): records of the four files are merged into one
 * instead of being overlaid as layers. Needed to build the mod byte for byte like the Python builder.
 *
 * Differences from a real layer overlay (ModContext):
 * - name and type come from the first file where the record appears (renames below are not seen);
 * - bool/float/int/str — `dict.update` in file order (new keys at the end);
 * - references are appended to the end of the category, with repeats and deletion markers as is;
 * - vec3/vec4/file and instances — only from the first file;
 * - the record deletion marker (REMOVED) is just another bool field.
 */
import { cloneRecord, FileType, type GameRecord, type Layer } from '@kenshi-editor/core';

export function kdataMerge(layers: readonly Layer[]): Map<string, GameRecord> {
  const all = new Map<string, GameRecord>();
  for (const layer of layers) {
    for (const r of layer.file.records) {
      const o = all.get(r.stringId);
      if (!o) {
        all.set(r.stringId, cloneRecord(r));
        continue;
      }
      for (const [k, v] of r.bools) o.bools.set(k, v);
      for (const [k, v] of r.floats) o.floats.set(k, v);
      for (const [k, v] of r.ints) o.ints.set(k, v);
      for (const [k, v] of r.strings) o.strings.set(k, v);
      for (const [c, l] of r.refs) {
        let into = o.refs.get(c);
        if (!into) {
          into = [];
          o.refs.set(c, into);
        }
        into.push(...l.map((x) => ({ ...x })));
      }
    }
  }
  return all;
}

/** Merged vanilla as one layer (on top of it the mod gets a diff against exactly what kdata.py saw). */
export function kdataLayer(merged: ReadonlyMap<string, GameRecord>): Layer {
  return { name: 'vanilla (kdata.py)', file: { fileType: FileType.Mod, lastId: 0, records: [...merged.values()], tail: new Uint8Array() } };
}
