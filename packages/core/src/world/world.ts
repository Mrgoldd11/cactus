/**
 * The game world: level files (`leveldata.level`) and zone files (`zone.X.Y.zone`) by layer — vanilla
 * (`data/newland/leveldata` and the subfolders Newwworld / Dialogue / rebirth), then mods
 * (`<mod folder>/leveldata`). Files with the same relative name are merged by layer
 * the same way as .mod records (`applyLayer`): record ids like `0-buildinglist` repeat in
 * every zone, so merging is only possible within one file.
 *
 * The common model is placed instances (`Placement`): what stands, where (vec3) and how it is rotated
 * (quaternion w, x, y, z), in which file and zone. On top of it — towns (the town list in
 * `leveldata.level`) and buildings (`0-buildinglist` in zones with GAMESTATE_BUILDING state).
 * The module has no disk access; reading is in `node/world.ts`.
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { DataFile, GameRecord, Vec3, Vec4 } from '../format/types.ts';
import { applyLayer } from '../model/record-ops.ts';

export interface WorldFile {
  /** The layer (.mod name) the file comes from. */
  layer: string;
  /** Path inside the `leveldata` folder with `/`, e.g. `zone.42.22.zone`. */
  path: string;
  file: DataFile;
}

export interface ZoneCoord {
  x: number;
  y: number;
}

export interface Placement {
  /** Instance key in the owner record. */
  key: string;
  /** What is placed (record string id from the .mod). */
  target: string;
  position: Vec3;
  /** Quaternion in file order (w, x, y, z). */
  rotation: Vec4;
  /** String ids of the instance's states (GAMESTATE_*), if any. */
  states: string[];
  /** The level-file record that holds the instance (e.g. `0-buildinglist`). */
  holder: string;
  holderType: string;
  /** File (relative path) and the last layer that changed the owner record. */
  file: string;
  layer: string;
  zone?: ZoneCoord;
}

export interface TownPlacement extends Placement {
  /** Zones the town occupies (from GAMESTATE_TOWN). */
  zones: ZoneCoord[];
}

export interface BuildingPlacement extends Placement {
  /** Building state fields (GAMESTATE_BUILDING). */
  name?: string;
  squadTemplate?: string;
  residentsTemplate?: string;
  interior?: string;
  exterior?: string;
  faction?: string;
  /**
   * World height of the building (`world Y pos` of the state). A building instance's y is height ABOVE GROUND:
   * for ≈ 76 % of buildings `world Y pos` = terrain + y (the rest stand on something — platforms, tiers).
   */
  worldY?: number;
  /** The town (TOWN) the building belongs to, if found. */
  town?: string;
}

export interface WorldStats {
  files: number;
  records: number;
  placements: number;
  towns: number;
  buildings: number;
}

interface MergedRecord {
  rec: GameRecord;
  layer: string;
}

/** Beyond this (horizontally) a building is not attached to a "neighbouring" town. */
const NEAREST_TOWN_MAX = 6000;

const ZONE_RE = /(?:^|\/)zone\.(-?\d+)\.(-?\d+)\.zone$/i;

export function zoneOfPath(path: string): ZoneCoord | undefined {
  const m = ZONE_RE.exec(path);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
}

function str(rec: GameRecord, key: string): string | undefined {
  const v = rec.strings.get(key);
  if (!v) return undefined;
  const s = decodeText(v);
  return s === '' ? undefined : s;
}

function handleKey(rec: GameRecord, prefix: string): string | undefined {
  const c = rec.ints.get(`${prefix}C`);
  const cs = rec.ints.get(`${prefix}CS`);
  return c === undefined || cs === undefined ? undefined : `${c}:${cs}`;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export class WorldIndex {
  /** Relative path (lowercase) → merged file records. */
  private readonly merged = new Map<string, { path: string; records: Map<string, MergedRecord> }>();
  private readonly byTarget = new Map<string, Placement[]>();
  private readonly townsById = new Map<string, TownPlacement[]>();
  private readonly buildingsBySquad = new Map<string, BuildingPlacement[]>();
  private readonly townsByZone = new Map<string, TownPlacement[]>();
  private readonly buildingList: BuildingPlacement[] = [];
  private placementCount = 0;
  private buildingCount = 0;

  constructor(files: readonly WorldFile[]) {
    for (const wf of files) {
      const k = wf.path.toLowerCase();
      let entry = this.merged.get(k);
      if (!entry) {
        entry = { path: wf.path, records: new Map() };
        this.merged.set(k, entry);
      }
      for (const rec of wf.file.records) {
        const next = applyLayer(entry.records.get(rec.stringId)?.rec, rec);
        if (next) entry.records.set(rec.stringId, { rec: next, layer: wf.layer });
        else entry.records.delete(rec.stringId);
      }
    }
    this.build();
  }

  /** Empty world (no level files). */
  static empty(): WorldIndex {
    return new WorldIndex([]);
  }

  private build(): void {
    // States (GAMESTATE_TOWN / GAMESTATE_BUILDING) are looked up in the same file as the instance:
    // their ids (`133-Newwworld-INGAME-S23`) repeat across zones.
    const townByHandle = new Map<string, string>();
    const buildings: { b: BuildingPlacement; townHandle: string | undefined }[] = [];

    for (const { path, records } of this.merged.values()) {
      const zone = zoneOfPath(path);
      const townStates = new Map<string, GameRecord>();
      const buildingStates = new Map<string, GameRecord>();
      for (const { rec } of records.values()) {
        const t = itemTypeName(rec.type);
        if (t === 'GAMESTATE_TOWN') townStates.set(rec.stringId, rec);
        else if (t === 'GAMESTATE_BUILDING') buildingStates.set(rec.stringId, rec);
      }
      for (const { rec, layer } of records.values()) {
        if (rec.instances.size === 0) continue;
        const holderType = itemTypeName(rec.type);
        for (const [key, inst] of rec.instances) {
          const p: Placement = {
            key,
            target: inst.target,
            position: inst.position,
            rotation: inst.rotation,
            states: inst.states.map((s) => decodeText(s)).filter((s) => s !== ''),
            holder: rec.stringId,
            holderType,
            file: path,
            layer,
            ...(zone ? { zone } : {}),
          };
          this.placementCount++;
          push(this.byTarget, p.target, p);
          if (holderType === 'GAMESTATE_TOWN_INSTANCE_LIST') {
            const state = p.states.map((s) => townStates.get(s)).find((s) => s !== undefined);
            const zones: ZoneCoord[] = [];
            if (state) {
              const n = state.ints.get('zones_count') ?? 0;
              for (let i = 0; i < n; i++) {
                const x = state.ints.get(`zone_x_${i}`);
                const y = state.ints.get(`zone_y_${i}`);
                if (x !== undefined && y !== undefined) zones.push({ x, y });
              }
              const h = handleKey(state, 'hand');
              if (h) townByHandle.set(h, p.target);
            }
            push(this.townsById, p.target, { ...p, zones });
          } else {
            const state = p.states.map((s) => buildingStates.get(s)).find((s) => s !== undefined);
            if (!state) continue;
            const b: BuildingPlacement = { ...p };
            const fields = [
              ['name', 'name'],
              ['squadTemplate', 'squad template'],
              ['residentsTemplate', 'residents template'],
              ['interior', 'interior layout name'],
              ['exterior', 'exterior layout name'],
              ['faction', 'owner faction ID'],
            ] as const;
            for (const [field, key] of fields) {
              const v = str(state, key);
              if (v !== undefined) b[field] = v;
            }
            const wy = state.floats.get('world Y pos');
            if (wy !== undefined) b.worldY = wy;
            buildings.push({ b, townHandle: handleKey(state, 'town') });
          }
        }
      }
    }
    // A building's town handle may be stale (left from the Newwworld layer); then we take
    // the nearest town whose zones contain the building.
    for (const list of this.townsById.values()) for (const t of list) for (const z of t.zones) push(this.townsByZone, `${z.x}.${z.y}`, t);
    for (const { b, townHandle } of buildings) {
      const town = (townHandle ? townByHandle.get(townHandle) : undefined) ?? this.townNear(b)?.target;
      if (town) b.town = town;
      this.buildingCount++;
      this.buildingList.push(b);
      for (const squad of new Set([b.squadTemplate, b.residentsTemplate]))
        if (squad) push(this.buildingsBySquad, squad, b);
    }
  }

  /** All instances placing record `target` (buildings, items, towns…). */
  instancesOf(target: string): readonly Placement[] {
    return this.byTarget.get(target) ?? [];
  }

  /** All world instances (except empty ones — that is how a later layer removes an instance). */
  *placements(): Iterable<Placement> {
    for (const [target, list] of this.byTarget) if (target !== '') yield* list;
  }

  /** All buildings with a state (GAMESTATE_BUILDING) — with name, faction, squads, town. */
  buildings(): readonly BuildingPlacement[] {
    return this.buildingList;
  }

  /** All placed towns (the town list in `leveldata.level`). */
  allTowns(): TownPlacement[] {
    return [...this.townsById.values()].flat();
  }

  /** Where a town (TOWN) stands: from the town list in `leveldata.level`. */
  towns(townId: string): readonly TownPlacement[] {
    return this.townsById.get(townId) ?? [];
  }

  /** Buildings where a squad lives / works (`squad template` or `residents template`). */
  buildingsWithSquad(squadId: string): readonly BuildingPlacement[] {
    return this.buildingsBySquad.get(squadId) ?? [];
  }

  /** Nearest town whose zones contain the point (no farther than `NEAREST_TOWN_MAX` horizontally). */
  townNear(p: { position: Vec3; zone?: ZoneCoord }): TownPlacement | undefined {
    if (!p.zone) return undefined;
    let best: TownPlacement | undefined;
    let bestD = NEAREST_TOWN_MAX ** 2;
    for (const t of this.townsByZone.get(`${p.zone.x}.${p.zone.y}`) ?? []) {
      const d = (t.position[0] - p.position[0]) ** 2 + (t.position[2] - p.position[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  /** Merged level-file record. */
  record(path: string, stringId: string): GameRecord | undefined {
    return this.merged.get(path.toLowerCase())?.records.get(stringId)?.rec;
  }

  /** Relative paths of merged files. */
  files(): string[] {
    return [...this.merged.values()].map((e) => e.path);
  }

  stats(): WorldStats {
    let records = 0;
    for (const e of this.merged.values()) records += e.records.size;
    return {
      files: this.merged.size,
      records,
      placements: this.placementCount,
      towns: this.townsById.size,
      buildings: this.buildingCount,
    };
  }
}

/** Coordinates for humans: `x z` (y is height), with the zone if known. */
export function formatPosition(position: Vec3, zone?: ZoneCoord): string {
  const r = (n: number): string => String(Math.round(n));
  return `${r(position[0])} ${r(position[2])}${zone ? ` (зона ${zone.x}.${zone.y})` : ''}`;
}
