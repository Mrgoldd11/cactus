/**
 * Мир игры: файлы уровня (`leveldata.level`) и зон (`zone.X.Y.zone`) по слоям — ваниль
 * (`data/newland/leveldata` и подпапки Newwworld / Dialogue / rebirth), затем моды
 * (`<папка мода>/leveldata`). Файлы с одним и тем же относительным именем сливаются по слоям
 * так же, как записи .mod (`applyLayer`): id записей вроде `0-buildinglist` повторяются в
 * каждой зоне, поэтому сливать можно только внутри одного файла.
 *
 * Общая модель — размещённые экземпляры (`Placement`): что стоит, где (vec3) и как повёрнуто
 * (кватернион w, x, y, z), в каком файле и зоне. Поверх неё — города (список городов в
 * `leveldata.level`) и здания (`0-buildinglist` в зонах с состоянием GAMESTATE_BUILDING).
 * Модуль без доступа к диску; чтение — в `node/world.ts`.
 */
import { decodeText } from '../text.ts';
import { itemTypeName } from '../format/item-types.ts';
import type { DataFile, GameRecord, Vec3, Vec4 } from '../format/types.ts';
import { applyLayer } from '../model/record-ops.ts';

export interface WorldFile {
  /** Слой (имя .mod), из которого файл. */
  layer: string;
  /** Путь внутри папки `leveldata` через `/`, например `zone.42.22.zone`. */
  path: string;
  file: DataFile;
}

export interface ZoneCoord {
  x: number;
  y: number;
}

export interface Placement {
  /** Ключ экземпляра в записи-владельце. */
  key: string;
  /** Что размещено (строковый id записи из .mod). */
  target: string;
  position: Vec3;
  /** Кватернион в порядке файла (w, x, y, z). */
  rotation: Vec4;
  /** Строковые id состояний экземпляра (GAMESTATE_*), если есть. */
  states: string[];
  /** Запись файла уровня, в которой лежит экземпляр (например `0-buildinglist`). */
  holder: string;
  holderType: string;
  /** Файл (относительный путь) и последний слой, менявший запись-владельца. */
  file: string;
  layer: string;
  zone?: ZoneCoord;
}

export interface TownPlacement extends Placement {
  /** Зоны, которые занимает город (из GAMESTATE_TOWN). */
  zones: ZoneCoord[];
}

export interface BuildingPlacement extends Placement {
  /** Поля состояния здания (GAMESTATE_BUILDING). */
  name?: string;
  squadTemplate?: string;
  residentsTemplate?: string;
  interior?: string;
  exterior?: string;
  faction?: string;
  /** Город (TOWN), к которому привязано здание, если нашёлся. */
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

/** Дальше этого (по горизонтали) здание к городу «по соседству» не привязываем. */
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
  /** Относительный путь (в нижнем регистре) → слитые записи файла. */
  private readonly merged = new Map<string, { path: string; records: Map<string, MergedRecord> }>();
  private readonly byTarget = new Map<string, Placement[]>();
  private readonly townsById = new Map<string, TownPlacement[]>();
  private readonly buildingsBySquad = new Map<string, BuildingPlacement[]>();
  private readonly townsByZone = new Map<string, TownPlacement[]>();
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

  /** Пустой мир (нет файлов уровня). */
  static empty(): WorldIndex {
    return new WorldIndex([]);
  }

  private build(): void {
    // Состояния (GAMESTATE_TOWN / GAMESTATE_BUILDING) ищем в том же файле, что и экземпляр:
    // их id (`133-Newwworld-INGAME-S23`) повторяются в разных зонах.
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
            buildings.push({ b, townHandle: handleKey(state, 'town') });
          }
        }
      }
    }
    // Ручка города у здания бывает устаревшей (осталась от слоя Newwworld), тогда берём
    // ближайший город, в зонах которого лежит здание.
    for (const list of this.townsById.values()) for (const t of list) for (const z of t.zones) push(this.townsByZone, `${z.x}.${z.y}`, t);
    for (const { b, townHandle } of buildings) {
      const town = (townHandle ? townByHandle.get(townHandle) : undefined) ?? this.townNear(b)?.target;
      if (town) b.town = town;
      this.buildingCount++;
      for (const squad of new Set([b.squadTemplate, b.residentsTemplate]))
        if (squad) push(this.buildingsBySquad, squad, b);
    }
  }

  /** Все экземпляры, размещающие запись `target` (здания, предметы, города…). */
  instancesOf(target: string): readonly Placement[] {
    return this.byTarget.get(target) ?? [];
  }

  /** Где стоит город (TOWN): по списку городов `leveldata.level`. */
  towns(townId: string): readonly TownPlacement[] {
    return this.townsById.get(townId) ?? [];
  }

  /** Здания, в которых живёт / работает отряд (`squad template` или `residents template`). */
  buildingsWithSquad(squadId: string): readonly BuildingPlacement[] {
    return this.buildingsBySquad.get(squadId) ?? [];
  }

  /** Ближайший город, в зонах которого лежит точка (не дальше `NEAREST_TOWN_MAX` по горизонтали). */
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

  /** Слитая запись файла уровня. */
  record(path: string, stringId: string): GameRecord | undefined {
    return this.merged.get(path.toLowerCase())?.records.get(stringId)?.rec;
  }

  /** Относительные пути слитых файлов. */
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

/** Координаты для людей: `x z` (y — высота), с зоной, если известна. */
export function formatPosition(position: Vec3, zone?: ZoneCoord): string {
  const r = (n: number): string => String(Math.round(n));
  return `${r(position[0])} ${r(position[2])}${zone ? ` (зона ${zone.x}.${zone.y})` : ''}`;
}
