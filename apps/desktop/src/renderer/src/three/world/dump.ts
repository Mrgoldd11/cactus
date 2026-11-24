/**
 * World dump of the running game (Kenshi Bridge plugin): the real places of foliage and the
 * buildings the game holds with all the player's mods. Read lazily, zone by zone.
 *
 * The dump grows while the game runs (and during a fly-over), so the zone list is re-read
 * every now and then; `version` changes when a zone appeared or was rewritten.
 */
import * as THREE from 'three';
import { isOutdoorDumpBuilding, parseBuildingDump, parseFoliageDump, DUMP_BUILDING, ZONE_COUNT, type DumpBuilding } from '@kenshi-editor/core';

/** Side of a foliage bucket; the same as the cell of `FoliageScatter`. */
export const DUMP_CELL = 1024;
const RELIST_MS = 20000;
const UP = new THREE.Vector3(0, 1, 0);

export interface DumpFoliageItem {
  target: string;
  matrix: THREE.Matrix4;
}

export interface DumpFoliageZone {
  count: number;
  /** Instances by cell "ix,iz" (cell side `DUMP_CELL`, world coordinates). */
  cells: Map<string, DumpFoliageItem[]>;
}

type Slot<T> = { stamp: string; data: T | 'loading' | 'bad' };

const key = (zx: number, zy: number): number => zy * ZONE_COUNT + zx;

export class WorldDump {
  /** Changes when the set of dumped zones (or a zone file) changed. */
  version = 0;
  /** Folder of the dump ('' until known). */
  dir = '';
  /** A zone finished loading or the zone list changed. */
  onChange: () => void = () => undefined;
  private foliageIndex = new Map<number, string>();
  private buildingIndex = new Map<number, string>();
  private readonly foliageZones = new Map<number, Slot<DumpFoliageZone>>();
  private readonly buildingZones = new Map<number, Slot<DumpBuilding[]>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor() {
    void this.relist();
    this.timer = setInterval(() => void this.relist(), RELIST_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }

  get foliageZoneCount(): number {
    return this.foliageIndex.size;
  }

  get buildingZoneCount(): number {
    return this.buildingIndex.size;
  }

  /** Zones that have a building file: "x,y" list for callers that walk them. */
  buildingZoneList(): [number, number][] {
    return [...this.buildingIndex.keys()].map((k) => [k % ZONE_COUNT, Math.floor(k / ZONE_COUNT)]);
  }

  /** Re-read which zones are dumped. */
  async relist(): Promise<void> {
    let index;
    try {
      index = await window.kedit.listWorldDump();
    } catch (e) {
      console.warn('world dump: list', e);
      return;
    }
    if (this.disposed) return;
    this.dir = index.dir;
    const fol = new Map(index.foliage.map((z) => [key(z.x, z.y), z.stamp]));
    const bld = new Map(index.buildings.map((z) => [key(z.x, z.y), z.stamp]));
    const same = (a: Map<number, string>, b: Map<number, string>): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
    if (same(fol, this.foliageIndex) && same(bld, this.buildingIndex)) return;
    this.foliageIndex = fol;
    this.buildingIndex = bld;
    for (const [k, s] of this.foliageZones) if (fol.get(k) !== s.stamp) this.foliageZones.delete(k);
    for (const [k, s] of this.buildingZones) if (bld.get(k) !== s.stamp) this.buildingZones.delete(k);
    this.version++;
    this.onChange();
  }

  /** Foliage of a zone: undefined — not dumped (or the file is broken), 'loading' — ask again later. */
  foliage(zx: number, zy: number): DumpFoliageZone | 'loading' | undefined {
    const k = key(zx, zy);
    const stamp = this.foliageIndex.get(k);
    if (stamp === undefined) return undefined;
    let slot = this.foliageZones.get(k);
    if (!slot) {
      slot = { stamp, data: 'loading' };
      this.foliageZones.set(k, slot);
      this.load(slot, 'foliage', zx, zy, (bytes) => bucket(bytes));
    }
    return slot.data === 'bad' ? undefined : slot.data;
  }

  /** Outdoor standing buildings of a zone as the game has them; same answers as `foliage`. */
  buildings(zx: number, zy: number): DumpBuilding[] | 'loading' | undefined {
    const k = key(zx, zy);
    const stamp = this.buildingIndex.get(k);
    if (stamp === undefined) return undefined;
    let slot = this.buildingZones.get(k);
    if (!slot) {
      slot = { stamp, data: 'loading' };
      this.buildingZones.set(k, slot);
      // Foliage buildings (ore rocks) are already in the foliage dump as instances.
      this.load(slot, 'buildings', zx, zy, (bytes) =>
        parseBuildingDump(new TextDecoder().decode(bytes)).buildings.filter((b) => isOutdoorDumpBuilding(b) && (b.flags & DUMP_BUILDING.foliage) === 0),
      );
    }
    return slot.data === 'bad' ? undefined : slot.data;
  }

  private load<T>(slot: Slot<T>, kind: 'foliage' | 'buildings', zx: number, zy: number, parse: (bytes: Uint8Array) => T): void {
    window.kedit
      .readWorldDump(kind, zx, zy)
      .then((bytes) => {
        slot.data = bytes ? parse(bytes) : 'bad';
      })
      .catch((e: unknown) => {
        console.warn(`world dump: ${kind} ${zx}.${zy}`, e);
        slot.data = 'bad';
      })
      .finally(() => {
        if (!this.disposed) this.onChange();
      });
  }
}

function bucket(bytes: Uint8Array): DumpFoliageZone {
  const d = parseFoliageDump(bytes);
  const cells = new Map<string, DumpFoliageItem[]>();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (let i = 0; i < d.count; i++) {
    const o = i * 5;
    pos.set(d.data[o]!, d.data[o + 1]!, d.data[o + 2]);
    quat.setFromAxisAngle(UP, (d.data[o + 3]! * Math.PI) / 180);
    const s = d.data[o + 4]!;
    scale.set(s, s, s);
    const item = { target: d.meshes[d.mesh[i]!]!, matrix: new THREE.Matrix4().compose(pos, quat, scale) };
    const k = `${Math.floor(pos.x / DUMP_CELL)},${Math.floor(pos.z / DUMP_CELL)}`;
    const l = cells.get(k);
    if (l) l.push(item);
    else cells.set(k, [item]);
  }
  return { count: d.count, cells };
}
