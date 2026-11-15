/**
 * Маленькая «папка игры» во временном каталоге: четыре ванильных файла, fcs.def,
 * fcs_enums.def, русский gamedata.po и один установленный мод.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyRecord, encodeText, FileType, itemTypeId, joinModList, removedRef, type DataFile, type GameRecord } from '@kenshi-editor/core';
import { writeDataFileSync } from '@kenshi-editor/core/node';
import type { Io } from '../src/main.ts';

const b = encodeText;
export const CHAR = itemTypeId('CHARACTER')!;
export const ITEM = itemTypeId('ITEM')!;
export const DIALOGUE = itemTypeId('DIALOGUE')!;
export const LINE = itemTypeId('DIALOGUE_LINE')!;

export function rec(type: number, sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(type, sid, b(name));
  fill(r);
  return r;
}

export function dataFile(records: GameRecord[], deps: string[] = [], lastId = 0): DataFile {
  return {
    fileType: FileType.Mod,
    header: { version: 1, author: b('test'), description: b(''), dependencies: joinModList(deps), references: b('') },
    lastId,
    records,
    tail: new Uint8Array(),
  };
}

export interface Fixture {
  game: string;
  modPath: string;
  io: Io & { lines: string[]; errors: string[] };
}

export function makeFixture(): Fixture {
  const game = mkdtempSync(join(tmpdir(), 'kedit-'));
  mkdirSync(join(game, 'data'));
  writeDataFileSync(
    join(game, 'data', 'gamedata.base'),
    dataFile([
      rec(CHAR, 'A', 'Bandit', (r) => {
        r.ints.set('money', 10);
        r.refs.set('vendors', [{ target: 'X', v0: 1, v1: 0, v2: 0 }]);
      }),
      rec(ITEM, 'X', 'Sword', (r) => r.floats.set('weight', 2)),
      rec(ITEM, 'Y', 'Shield'),
    ]),
  );
  writeDataFileSync(join(game, 'data', 'Newwworld.mod'), dataFile([]));
  writeDataFileSync(
    join(game, 'data', 'Dialogue.mod'),
    dataFile([
      rec(DIALOGUE, 'D1', 'greet', (r) => r.refs.set('lines', [{ target: 'L1', v0: 0, v1: 0, v2: 0 }])),
      rec(LINE, 'L1', 'DIALOGUE_LINE', (r) => {
        r.strings.set('text0', b('Hello there'));
        r.refs.set('lines', [{ target: 'L2', v0: 0, v1: 0, v2: 0 }]);
      }),
      rec(LINE, 'L2', 'DIALOGUE_LINE', (r) => {
        r.strings.set('text0', b('Bye'));
        r.refs.set('lines', [{ target: 'L1', v0: 0, v1: 0, v2: 0 }]);
      }),
    ]),
  );
  writeDataFileSync(join(game, 'data', 'rebirth.mod'), dataFile([rec(CHAR, 'A', 'Bandit', (r) => r.ints.set('money', 15))]));
  writeFileSync(
    join(game, 'fcs.def'),
    ['[CHARACTER]', 'general:', 'money: 0 "how much money"', 'vendors: ITEM (1,0,0)', '', '[ITEM]', 'weight: 1.0', 'kind: Kind.TOOL', ''].join('\n'),
  );
  writeFileSync(join(game, 'fcs_enums.def'), 'enum Kind { TOOL, FOOD }\n');
  // The data language of the CLI and MCP follows the game's own language.
  writeFileSync(join(game, 'settings.cfg'), 'language=ru_RU\n');
  mkdirSync(join(game, 'locale', 'ru_RU'), { recursive: true });
  writeFileSync(
    join(game, 'locale', 'ru_RU', 'gamedata.po'),
    ['#: A', 'msgid "Bandit"', 'msgstr "Разбойник"', '', '#: X', 'msgid "Sword"', 'msgstr "Меч"', ''].join('\n'),
  );
  mkdirSync(join(game, 'mods', 'My'), { recursive: true });
  const modPath = join(game, 'mods', 'My', 'My.mod');
  writeDataFileSync(
    modPath,
    dataFile(
      [
        rec(CHAR, 'A', 'Bandit', (r) => {
          r.ints.set('money', 99);
          r.refs.set('vendors', [removedRef('X'), { target: '1-My.mod', v0: 3, v1: 0, v2: 0 }]);
        }),
        rec(ITEM, '1-My.mod', 'Magic hat', (r) => r.floats.set('weight', 0.5)),
      ],
      [],
      1,
    ),
  );
  const lines: string[] = [];
  const errors: string[] = [];
  const io = {
    lines,
    errors,
    out: (l: string) => lines.push(...l.split('\n')),
    err: (l: string) => errors.push(l),
    cwd: game,
    env: {},
  };
  return { game, modPath, io };
}
