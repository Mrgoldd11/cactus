/**
 * Parser of binary Ogre models (`.mesh`): this is how all Kenshi models are stored: weapons, armour,
 * buildings, furniture, characters. Three serializer versions occur in the game:
 * `MeshSerializer_v1.100` (Ogre 1.10+), `MeshSerializer_v1.8` and `MeshSerializer_v1.41`.
 *
 * The file is nested chunks "id (uint16) + length (uint32) + data". Old Ogre versions compute chunk
 * lengths wrongly (a submesh's length is smaller than its own geometry), so we read
 * sequentially, like Ogre itself: chunk after chunk, never skipping by length. Only what is
 * drawn is needed: geometry (positions, normals, UV, vertex colour), indices and the material name of each
 * submesh. LOD, shadow edges, poses and animations come after the submeshes; reading
 * stops at them.
 *
 * The module has no disk access and no three.js: bytes in, arrays out.
 */

const M_HEADER = 0x1000;
const M_MESH = 0x3000;
const M_SUBMESH = 0x4000;
const M_SUBMESH_OPERATION = 0x4010;
const M_SUBMESH_BONE_ASSIGNMENT = 0x4100;
const M_SUBMESH_TEXTURE_ALIAS = 0x4200;
const M_GEOMETRY = 0x5000;
const M_GEOMETRY_VERTEX_DECLARATION = 0x5100;
const M_GEOMETRY_VERTEX_ELEMENT = 0x5110;
const M_GEOMETRY_VERTEX_BUFFER = 0x5200;
const M_GEOMETRY_VERTEX_BUFFER_DATA = 0x5210;
const M_MESH_SKELETON_LINK = 0x6000;
const M_MESH_BONE_ASSIGNMENT = 0x7000;

/** Meaning of a vertex element (Ogre `VertexElementSemantic`). */
const SEM_POSITION = 1;
const SEM_NORMAL = 4;
const SEM_DIFFUSE = 5;
const SEM_TEXCOORD = 7;

/** Primitive kind (Ogre `RenderOperation::OperationType`). */
export const OP_TRIANGLE_LIST = 4;
export const OP_TRIANGLE_STRIP = 5;
export const OP_TRIANGLE_FAN = 6;

export interface MeshGeometry {
  vertexCount: number;
  /** x, y, z per vertex. */
  positions: Float32Array;
  normals?: Float32Array;
  /** First UV set: u, v per vertex. */
  uvs?: Float32Array;
  /** Vertex colour r, g, b, a (0…1), if present. */
  colors?: Float32Array;
}

export interface MeshSubmesh {
  /** Ogre material name (`Material#84`). In Kenshi the texture is usually set by the record, not by it. */
  material: string;
  operation: number;
  /** Shared model geometry or its own. */
  geometry: MeshGeometry;
  indices: Uint16Array | Uint32Array;
}

export interface OgreMesh {
  /** Version string from the header: `[MeshSerializer_v1.8]`. */
  version: string;
  submeshes: MeshSubmesh[];
  /** Skeleton name, if the model is animated. */
  skeleton?: string;
  /** Bounding box over all vertices (computed, not from the file). */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export class MeshFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeshFormatError';
  }
}

interface Element {
  source: number;
  type: number;
  semantic: number;
  offset: number;
  index: number;
}

/** Number of float components of an element type; undefined for a type we do not read. */
function floatCount(type: number): number | undefined {
  // VET_FLOAT1..VET_FLOAT4
  return type >= 0 && type <= 3 ? type + 1 : undefined;
}

/** Vertex colour in one uint32: COLOUR (4), COLOUR_ARGB (10), COLOUR_ABGR (11), UBYTE4 (9). */
function isPackedColour(type: number): boolean {
  return type === 4 || type === 9 || type === 10 || type === 11;
}

class Reader {
  private readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get left(): number {
    return this.bytes.length - this.pos;
  }

  need(n: number): void {
    if (n > this.left) throw new MeshFormatError(`файл обрывается (нужно ${n} байт на ${this.pos}, осталось ${this.left})`);
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** String up to `\n` (this is how Ogre writes strings). */
  line(): string {
    const end = this.bytes.indexOf(10, this.pos);
    if (end < 0) throw new MeshFormatError(`строка без конца на ${this.pos}`);
    let s = '';
    for (let i = this.pos; i < end; i++) s += String.fromCharCode(this.bytes[i]!);
    this.pos = end + 1;
    return s;
  }

  slice(n: number): Uint8Array {
    this.need(n);
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  /** id of the next chunk without moving the position; undefined at end of file. */
  peekChunk(): number | undefined {
    return this.left >= 6 ? this.view.getUint16(this.pos, true) : undefined;
  }

  /** Chunk header: id and length (the length of old versions cannot be trusted). */
  chunk(): { id: number; length: number } {
    const id = this.u16();
    const length = this.u32();
    return { id, length };
  }
}

function readGeometry(r: Reader): MeshGeometry {
  const vertexCount = r.u32();
  const elements: Element[] = [];
  const buffers = new Map<number, { size: number; data: Uint8Array }>();
  for (;;) {
    const id = r.peekChunk();
    if (id === M_GEOMETRY_VERTEX_DECLARATION) {
      r.chunk();
      while (r.peekChunk() === M_GEOMETRY_VERTEX_ELEMENT) {
        r.chunk();
        elements.push({ source: r.u16(), type: r.u16(), semantic: r.u16(), offset: r.u16(), index: r.u16() });
      }
    } else if (id === M_GEOMETRY_VERTEX_BUFFER) {
      r.chunk();
      const bind = r.u16();
      const size = r.u16();
      const data = r.chunk();
      if (data.id !== M_GEOMETRY_VERTEX_BUFFER_DATA) throw new MeshFormatError(`ждали данные вершин, а блок 0x${data.id.toString(16)}`);
      buffers.set(bind, { size, data: r.slice(size * vertexCount) });
    } else break;
  }
  return decodeVertices(vertexCount, elements, buffers);
}

function decodeVertices(vertexCount: number, elements: readonly Element[], buffers: ReadonlyMap<number, { size: number; data: Uint8Array }>): MeshGeometry {
  const geo: MeshGeometry = { vertexCount, positions: new Float32Array(vertexCount * 3) };
  let havePos = false;
  for (const el of elements) {
    const buf = buffers.get(el.source);
    if (!buf) continue;
    const view = new DataView(buf.data.buffer, buf.data.byteOffset, buf.data.byteLength);
    const n = floatCount(el.type);
    const readFloats = (comps: number, out: Float32Array): void => {
      const take = Math.min(comps, n ?? 0);
      for (let v = 0; v < vertexCount; v++) {
        const base = v * buf.size + el.offset;
        for (let c = 0; c < take; c++) out[v * comps + c] = view.getFloat32(base + c * 4, true);
      }
    };
    if (el.semantic === SEM_POSITION && n !== undefined && n >= 3 && !havePos) {
      readFloats(3, geo.positions);
      havePos = true;
    } else if (el.semantic === SEM_NORMAL && n !== undefined && n >= 3 && !geo.normals) {
      geo.normals = new Float32Array(vertexCount * 3);
      readFloats(3, geo.normals);
    } else if (el.semantic === SEM_TEXCOORD && el.index === 0 && n !== undefined && n >= 2 && !geo.uvs) {
      geo.uvs = new Float32Array(vertexCount * 2);
      readFloats(2, geo.uvs);
    } else if (el.semantic === SEM_DIFFUSE && isPackedColour(el.type) && !geo.colors) {
      const out = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) {
        const base = v * buf.size + el.offset;
        const b0 = buf.data[base]!, b1 = buf.data[base + 1]!, b2 = buf.data[base + 2]!, b3 = buf.data[base + 3]!;
        // In memory (little-endian): ARGB → B G R A, ABGR → R G B A. COLOUR (4) in D3D builds is ARGB.
        const [r, g, b, a] = el.type === 11 || el.type === 9 ? [b0, b1, b2, b3] : [b2, b1, b0, b3];
        out.set([r / 255, g / 255, b / 255, a / 255], v * 4);
      }
      geo.colors = out;
    }
  }
  if (!havePos && vertexCount > 0) throw new MeshFormatError('у геометрии нет позиций вершин float3');
  return geo;
}

function readSubmesh(r: Reader, shared: MeshGeometry | undefined): MeshSubmesh {
  const material = r.line();
  const useShared = r.bool();
  const indexCount = r.u32();
  const idx32 = r.bool();
  let indices: Uint16Array | Uint32Array;
  if (idx32) {
    const raw = r.slice(indexCount * 4);
    indices = new Uint32Array(indexCount);
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < indexCount; i++) indices[i] = v.getUint32(i * 4, true);
  } else {
    const raw = r.slice(indexCount * 2);
    indices = new Uint16Array(indexCount);
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < indexCount; i++) indices[i] = v.getUint16(i * 2, true);
  }
  let geometry: MeshGeometry;
  if (useShared) {
    if (!shared) throw new MeshFormatError(`подмодель «${material}» берёт общую геометрию, а её нет`);
    geometry = shared;
  } else {
    const c = r.chunk();
    if (c.id !== M_GEOMETRY) throw new MeshFormatError(`у подмодели «${material}» нет геометрии (блок 0x${c.id.toString(16)})`);
    geometry = readGeometry(r);
  }
  let operation = OP_TRIANGLE_LIST;
  for (;;) {
    const id = r.peekChunk();
    if (id === M_SUBMESH_OPERATION) {
      r.chunk();
      operation = r.u16();
    } else if (id === M_SUBMESH_BONE_ASSIGNMENT) {
      r.chunk();
      r.slice(10);
    } else if (id === M_SUBMESH_TEXTURE_ALIAS) {
      r.chunk();
      r.line();
      r.line();
    } else break;
  }
  for (const i of indices)
    if (i >= geometry.vertexCount) throw new MeshFormatError(`индекс ${i} за пределами вершин (${geometry.vertexCount}) у «${material}»`);
  return { material, operation, geometry, indices };
}

/** Parse a `.mesh`. Throws `MeshFormatError` if the file is not an Ogre model or is corrupt. */
export function parseOgreMesh(bytes: Uint8Array): OgreMesh {
  const r = new Reader(bytes);
  const head = r.u16();
  if (head !== M_HEADER) throw new MeshFormatError(head === 0x0010 ? 'модель big-endian не поддерживается' : 'это не модель Ogre (.mesh)');
  const version = r.line();
  if (!version.startsWith('[MeshSerializer_v')) throw new MeshFormatError(`неизвестная версия «${version}»`);
  const mesh: OgreMesh = { version, submeshes: [], bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  const top = r.chunk();
  if (top.id !== M_MESH) throw new MeshFormatError(`ждали блок модели, а 0x${top.id.toString(16)}`);
  r.bool(); // skeletallyAnimated
  let shared: MeshGeometry | undefined;
  for (;;) {
    const id = r.peekChunk();
    if (id === M_GEOMETRY) {
      r.chunk();
      shared = readGeometry(r);
    } else if (id === M_SUBMESH) {
      r.chunk();
      mesh.submeshes.push(readSubmesh(r, shared));
    } else if (id === M_MESH_SKELETON_LINK) {
      r.chunk();
      mesh.skeleton = r.line();
    } else if (id === M_MESH_BONE_ASSIGNMENT) {
      r.chunk();
      r.slice(10);
    } else break;
  }
  mesh.bounds = boundsOf(mesh.submeshes);
  return mesh;
}

function boundsOf(subs: readonly MeshSubmesh[]): OgreMesh['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const s of subs)
    for (const i of s.indices)
      for (let c = 0; c < 3; c++) {
        const v = s.geometry.positions[i * 3 + c]!;
        if (v < min[c]!) min[c] = v;
        if (v > max[c]!) max[c] = v;
      }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** Indices as a triangle list (strips and fans are unrolled). */
export function triangleIndices(sub: MeshSubmesh): Uint32Array {
  const ix = sub.indices;
  if (sub.operation === OP_TRIANGLE_LIST) return Uint32Array.from(ix);
  const out: number[] = [];
  if (sub.operation === OP_TRIANGLE_STRIP) {
    for (let i = 2; i < ix.length; i++) {
      const a = ix[i - 2]!, b = ix[i - 1]!, c = ix[i]!;
      if (a === b || b === c || a === c) continue;
      if (i % 2 === 0) out.push(a, b, c);
      else out.push(b, a, c);
    }
  } else if (sub.operation === OP_TRIANGLE_FAN) {
    for (let i = 2; i < ix.length; i++) out.push(ix[0]!, ix[i - 1]!, ix[i]!);
  }
  return Uint32Array.from(out);
}
