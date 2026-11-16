/**
 * Правки мира в моде (`WorldEdits`): сдвиг с состоянием здания, новый и удалённый экземпляр,
 * отмена/повтор, файл уровня мода — разница поверх нижних слоёв, не тронутое — те же байты.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  readDataFile,
  WorldEdits,
  WorldIndex,
  writeDataFile,
  type DataFile,
  type GameRecord,
  type WorldFile,
} from '../src/index.ts';

const b = (s: string): Uint8Array => encodeText(s);

function rec(type: string, sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, b(name));
  fill(r);
  return r;
}

function level(records: GameRecord[], lastId = 0, tail = new Uint8Array()): DataFile {
  return { fileType: FileType.Data, lastId, records, tail };
}

const ZONE = 'zone.32.32.zone';

function vanilla(): WorldFile {
  return {
    layer: 'gamedata.base',
    path: ZONE,
    file: level(
      [
        rec('INSTANCE_COLLECTION', '0-buildinglist', '0', (r) => {
          r.instances.set('1-base', { target: 'HOUSE', position: [100, 2, 200], rotation: [1, 0, 0, 0], states: [b('1-base-S23')] });
          r.instances.set('2-base', { target: 'WALL', position: [150, 0, 250], rotation: [1, 0, 0, 0], states: [] });
        }),
        rec('GAMESTATE_BUILDING', '1-base-S23', 'House', (r) => {
          r.floats.set('world Y pos', 502);
          r.strings.set('name', b('House'));
        }),
      ],
      2,
    ),
  };
}

function modZone(): WorldFile {
  // Мод уже двигал стену и имеет хвост — его надо сохранить.
  const tail = new Uint8Array([1, 0, 0, 0, 7, 0, 0, 0]);
  return {
    layer: 'My Mod.mod',
    path: ZONE,
    file: level(
      [
        rec('INSTANCE_COLLECTION', '0-buildinglist', '0', (r) => {
          r.instances.set('2-base', { target: 'WALL', position: [160, 0, 250], rotation: [1, 0, 0, 0], states: [] });
        }),
      ],
      5,
      tail,
    ),
  };
}

describe('правки мира в моде', () => {
  it('сдвиг здания: экземпляр и полная копия состояния с новой высотой; отмена — те же байты', () => {
    const mod = modZone();
    const bytes = writeDataFile(mod.file);
    const ed = new WorldEdits([vanilla(), mod], 'My Mod.mod');
    expect(ed.dirtyFiles()).toEqual([]);
    ed.move(ZONE, '0-buildinglist', '1-base', [120, 2, 210], [0.7071, 0, 0.7071, 0], { worldY: 510 });
    expect(ed.undoLabel()).toBe('Сдвиг объекта');
    expect(ed.dirtyFiles()).toEqual([ZONE]);
    const out = ed.buildFile(ZONE)!;
    expect(out.fileType).toBe(FileType.Data);
    expect(out.header).toBeUndefined();
    expect([...out.tail]).toEqual([1, 0, 0, 0, 7, 0, 0, 0]);
    const holder = out.records[0]!;
    expect([...holder.instances.keys()]).toEqual(['2-base', '1-base']);
    expect(holder.instances.get('1-base')!.position).toEqual([120, 2, 210]);
    const state = out.records.find((r) => r.stringId === '1-base-S23')!;
    expect(state.floats.get('world Y pos')).toBe(510);
    expect(state.strings.has('name')).toBe(true);
    // Через WorldIndex видно новое место и высоту.
    const w = new WorldIndex(ed.files());
    expect(w.buildings()[0]).toMatchObject({ key: '1-base', position: [120, 2, 210], worldY: 510 });

    ed.undo();
    expect(ed.dirtyFiles()).toEqual([]);
    expect(writeDataFile(ed.buildFile(ZONE)!)).toEqual(bytes);
    ed.redo();
    expect(ed.buildFile(ZONE)!.records.length).toBe(2);
  });

  it('вернуть объект на место — правка мода исчезает', () => {
    const ed = new WorldEdits([vanilla()], 'My Mod.mod');
    ed.move(ZONE, '0-buildinglist', '1-base', [0, 2, 0], [1, 0, 0, 0], { worldY: 1 });
    ed.move(ZONE, '0-buildinglist', '1-base', [100, 2, 200], [1, 0, 0, 0], { worldY: 502 });
    expect(ed.buildFile(ZONE)).toBeUndefined();
    expect(ed.dirtyFiles()).toEqual([]);
  });

  it('новый объект: ключ мода, lastId; удаление своего — стирает, чужого — пишет пустую цель', () => {
    const ed = new WorldEdits([vanilla(), modZone()], 'My Mod.mod');
    const key = ed.place(ZONE, '0-buildinglist', 'BED', [1, 2, 3], [1, 0, 0, 0]);
    expect(key).toBe('6-My Mod-INGAME');
    expect(ed.buildFile(ZONE)!.lastId).toBe(6);
    expect(ed.instance(ZONE, '0-buildinglist', key)).toMatchObject({ target: 'BED', states: [] });
    ed.remove(ZONE, '0-buildinglist', key);
    expect(ed.instance(ZONE, '0-buildinglist', key)).toBeUndefined();
    expect(ed.buildFile(ZONE)!.records[0]!.instances.has(key)).toBe(false);
    ed.remove(ZONE, '0-buildinglist', '1-base');
    expect(ed.buildFile(ZONE)!.records[0]!.instances.get('1-base')).toEqual({ target: '', position: [0, 0, 0], rotation: [1, 0, 0, 0], states: [] });
    expect(new WorldIndex(ed.files()).buildings()).toHaveLength(0);
    expect(ed.history().undo).toEqual(['Новый объект', 'Удаление объекта', 'Удаление объекта']);
    ed.undo();
    ed.undo();
    ed.undo();
    expect(ed.buildFile(ZONE)!.lastId).toBe(5);
    expect(ed.dirtyFiles()).toEqual([]);
  });

  it('новый файл зоны мода: тип 15, пустой хвост, владелец с типом и именем ванили; запись читается обратно', () => {
    const ed = new WorldEdits([vanilla()], 'My Mod.mod');
    ed.transaction('Две правки', () => {
      ed.place(ZONE, '0-buildinglist', 'BED', [1, 2, 3], [1, 0, 0, 0]);
      ed.move(ZONE, '0-buildinglist', '2-base', [0, 0, 0], [1, 0, 0, 0]);
    });
    expect(ed.history().undo).toEqual(['Две правки']);
    const f = ed.buildFile(ZONE)!;
    expect(f.tail.length).toBe(0);
    expect(f.records[0]!.changeFlags).toBe(0);
    const back = readDataFile(writeDataFile(f));
    expect(back.records[0]!.instances.size).toBe(2);
    ed.markSaved();
    expect(ed.isDirty()).toBe(false);
    ed.undo();
    expect(ed.dirtyFiles()).toEqual([ZONE]);
  });

  it('объект не выносится из своей зоны; подписчики узнают, какие записи менялись', () => {
    const ed = new WorldEdits([vanilla()], 'My Mod.mod');
    const seen: string[][] = [];
    ed.onChange((c) => {
      seen.push(c.map((x) => x.sid));
    });
    expect(() => {
      ed.move(ZONE, '0-buildinglist', '2-base', [5000, 0, 0], [1, 0, 0, 0]);
    }).toThrow(/zone 33\.32/);
    ed.move(ZONE, '0-buildinglist', '1-base', [10, 2, 10], [1, 0, 0, 0], { worldY: 7 });
    ed.undo();
    expect(seen).toEqual([
      ['0-buildinglist', '1-base-S23'],
      ['0-buildinglist', '1-base-S23'],
    ]);
  });

  it('ошибка в транзакции откатывает её правки', () => {
    const ed = new WorldEdits([vanilla()], 'My Mod.mod');
    expect(() => {
      ed.transaction('x', () => {
        ed.move(ZONE, '0-buildinglist', '2-base', [9, 9, 9], [1, 0, 0, 0]);
        ed.move(ZONE, '0-buildinglist', 'nope', [9, 9, 9], [1, 0, 0, 0]);
      });
    }).toThrow();
    expect(ed.instance(ZONE, '0-buildinglist', '2-base')!.position).toEqual([150, 0, 250]);
    expect(ed.canUndo()).toBe(false);
  });
});
