/**
 * Фоновый поток окна «Мир»: вся тяжёлая работа — не в потоке интерфейса.
 *  - `terrain`: значения карты высот тайла → вершины, нормали, UV (с «юбкой» по краю, чтобы
 *    между тайлами разных уровней не было щелей);
 *  - `mesh`: байты `.mesh` → массивы подмоделей (`parseOgreMesh` из ядра);
 *  - `dds`: байты `.dds` → RGBA (`decodeDds`);
 *  - `png`: байты PNG → уменьшенная картинка RGBA для цвета земли. Свой разбор, а не
 *    `createImageBitmap`: в альфе `colour.I.J` лежит не прозрачность, и браузер затемнил бы цвет.
 * Ответы передаются без копирования (transferable).
 */
import { HEIGHT_SCALE, TILE_CELLS, TILE_SAMPLES, decodeDds, parseOgreMesh, triangleIndices } from '@kenshi-editor/core';
import type { WorkerReply, WorkerRequest, SubmeshArrays } from './protocol.ts';

interface Scope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerReply, transfer?: Transferable[]): void;
}
const scope = self as unknown as Scope;

function terrain(heights: Uint16Array, size: number, uv: readonly [number, number, number, number]) {
  const n = TILE_SAMPLES;
  const cell = size / TILE_CELLS;
  // Сетка n×n и юбка по периметру (4·(n−1) вершин, опущенных вниз).
  const ring = 4 * (n - 1);
  const count = n * n + ring;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const h = (c: number, r: number): number => heights[Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, c))]! * HEIGHT_SCALE;
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const y = h(c, r);
      if (y < min) min = y;
      if (y > max) max = y;
      pos[i * 3] = c * cell;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = r * cell;
      // Нормаль по разностям соседей (на краю — односторонние).
      const dx = (h(c + 1, r) - h(c - 1, r)) / ((Math.min(n - 1, c + 1) - Math.max(0, c - 1)) * cell);
      const dz = (h(c, r + 1) - h(c, r - 1)) / ((Math.min(n - 1, r + 1) - Math.max(0, r - 1)) * cell);
      const len = Math.hypot(dx, 1, dz);
      nor[i * 3] = -dx / len;
      nor[i * 3 + 1] = 1 / len;
      nor[i * 3 + 2] = -dz / len;
      uvs[i * 2] = uv[0] + (c / TILE_CELLS) * uv[2];
      uvs[i * 2 + 1] = uv[1] + (r / TILE_CELLS) * uv[3];
    }
  // Периметр по кругу: верх (r=0), правый край, низ, левый край.
  const perim: number[] = [];
  for (let c = 0; c < n - 1; c++) perim.push(c);
  for (let r = 0; r < n - 1; r++) perim.push(r * n + n - 1);
  for (let c = n - 1; c > 0; c--) perim.push((n - 1) * n + c);
  for (let r = n - 1; r > 0; r--) perim.push(r * n);
  const drop = Math.max(cell * 2, 20);
  perim.forEach((src, k) => {
    const d = n * n + k;
    pos[d * 3] = pos[src * 3]!;
    pos[d * 3 + 1] = pos[src * 3 + 1]! - drop;
    pos[d * 3 + 2] = pos[src * 3 + 2]!;
    nor.copyWithin(d * 3, src * 3, src * 3 + 3);
    uvs.copyWithin(d * 2, src * 2, src * 2 + 2);
  });
  return { pos, nor, uvs, min: min - drop, max };
}

/** PNG (8 бит, RGB / RGBA, без чересстрочности) → RGBA size×size, альфа = 255. */
async function png(bytes: Uint8Array, size: number): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let w = 0;
  let h = 0;
  let colourType = 0;
  const idat: Uint8Array[] = [];
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = dv.getUint32(p + 8);
      h = dv.getUint32(p + 12);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG: нужен 8 бит без чересстрочности');
      colourType = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  if (!bpp || !w || !h) throw new Error('PNG: нужен RGB или RGBA');
  const stream = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  // Снятие фильтров строк.
  const stride = w * bpp;
  const img = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? img[row + x - bpp]! : 0;
      const b = y > 0 ? img[up + x]! : 0;
      let v = raw[src + x]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const c = y > 0 && x >= bpp ? img[up + x - bpp]! : 0;
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      img[row + x] = v & 255;
    }
  }
  // Уменьшение усреднением (размер — делитель исходного) или как есть.
  const k = Math.max(1, Math.floor(w / size));
  const ow = Math.floor(w / k);
  const oh = Math.floor(h / k);
  const out = new Uint8Array(ow * oh * 4);
  const n = k * k;
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let dy = 0; dy < k; dy++) {
        let s = ((y * k + dy) * w + x * k) * bpp;
        for (let dx = 0; dx < k; dx++, s += bpp) {
          r += img[s]!;
          g += img[s + 1]!;
          bl += img[s + 2]!;
        }
      }
      const o = (y * ow + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = bl / n;
      out[o + 3] = 255;
    }
  return { width: ow, height: oh, rgba: out };
}

scope.onmessage = (e) => {
  const req = e.data;
  try {
    if (req.type === 'terrain') {
      const t = terrain(req.heights, req.size, req.uv);
      scope.postMessage({ id: req.id, type: 'terrain', ...t }, [t.pos.buffer, t.nor.buffer, t.uvs.buffer]);
    } else if (req.type === 'mesh') {
      const mesh = parseOgreMesh(req.bytes);
      const subs: SubmeshArrays[] = [];
      const transfer: Transferable[] = [];
      for (const sub of mesh.submeshes) {
        const index = triangleIndices(sub);
        if (index.length === 0) continue;
        const g = sub.geometry;
        // Буферы подмоделей могут делить общий ArrayBuffer — копируем, чтобы передать.
        const s: SubmeshArrays = { index: index.slice(), positions: g.positions.slice() };
        if (g.normals) s.normals = g.normals.slice();
        if (g.uvs) s.uvs = g.uvs.slice();
        if (g.colors) s.colors = g.colors.slice();
        for (const a of [s.index, s.positions, s.normals, s.uvs, s.colors]) if (a) transfer.push(a.buffer);
        subs.push(s);
      }
      scope.postMessage({ id: req.id, type: 'mesh', submeshes: subs }, transfer);
    } else if (req.type === 'dds') {
      const img = decodeDds(req.bytes, { maxSize: req.maxSize });
      const rgba = img.rgba.slice();
      scope.postMessage({ id: req.id, type: 'dds', width: img.width, height: img.height, rgba }, [rgba.buffer]);
    } else {
      const id = req.id;
      png(req.bytes, req.size).then(
        (img) => {
          scope.postMessage({ id, type: 'png', ...img }, [img.rgba.buffer]);
        },
        (err: unknown) => {
          scope.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
        },
      );
    }
  } catch (err) {
    scope.postMessage({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
