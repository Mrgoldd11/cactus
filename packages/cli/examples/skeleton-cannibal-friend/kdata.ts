/**
 * Ваниль так, как её видел tools/kdata.py (`base()`): записи четырёх файлов сливаются в одну,
 * а не накладываются слоями. Нужна, чтобы собрать мод байт в байт как Python-сборщик.
 *
 * Отличия от настоящего наложения слоёв (ModContext):
 * - имя и тип — из первого файла, где запись встретилась (переименования ниже не видны);
 * - bool/float/int/str — `dict.update` по порядку файлов (новые ключи в конец);
 * - ссылки — дописываются в конец категории, с повторами и маркерами удаления как есть;
 * - vec3/vec4/file и объекты — только из первого файла;
 * - маркер удаления записи (REMOVED) — просто ещё одно bool-поле.
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

/** Слитая ваниль одним слоем (под ним мод получает разницу ровно с тем, что видел kdata.py). */
export function kdataLayer(merged: ReadonlyMap<string, GameRecord>): Layer {
  return { name: 'vanilla (kdata.py)', file: { fileType: FileType.Mod, lastId: 0, records: [...merged.values()], tail: new Uint8Array() } };
}
