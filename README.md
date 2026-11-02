# Редактор модов Kenshi

Замена FCS (Forgotten Construction Set). Сейчас готово ядро формата — `packages/core`:
чтение и запись `.base`/`.mod` без потерь, разбор `fcs.def`, `fcs_enums.def`,
`fcs_layout.def` и `gamedata.po`. План — в [ROADMAP.md](ROADMAP.md).

## Установка

Нужен Node.js 20 или новее (проверено на 24). pnpm подключается через corepack:

```bash
corepack enable pnpm
```

Если `corepack enable` падает с EPERM (Node стоит в Program Files), поставьте pnpm в
пользовательскую папку npm, она обычно уже есть в PATH:

```bash
corepack enable pnpm --install-directory "$APPDATA/npm"
```

Потом в папке `editor/`:

```bash
pnpm install
```

## Путь к игре

Тесты на реальных данных и отчёт читают файлы установленной игры (в репозиторий они не
копируются). По умолчанию — `D:/SteamLibrary/steamapps/common/Kenshi`, мастерская —
`<библиотека Steam>/steamapps/workshop/content/233860`. Другой путь можно задать так:

- переменные окружения `KENSHI_DIR` и `KENSHI_WORKSHOP_DIR`;
- или файл `kenshi-paths.json` в `editor/` (или в любой папке выше), он в `.gitignore`:

```json
{ "kenshi": "C:/Games/Kenshi", "workshop": "C:/Steam/steamapps/workshop/content/233860" }
```

Если игра не найдена, тесты на её файлах пропускаются, остальные выполняются.

## Команды

```bash
pnpm test
```

Все тесты: синтетические (формат, кодировки, парсеры) и на файлах игры — 4 ванильных файла
и все установленные моды пишутся обратно байт в байт, схема загружается и покрывает все
типы записей ванили.

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm report
```

Отчёт о расхождениях `fcs.def` с данными: какие типы и поля есть в файлах, но не описаны
в схеме, и наоборот. Пишется в `reports/schema-report.md` и `.json` (в `.gitignore`).

## Пример

```ts
import { readFileSync } from 'node:fs';
import { readDataFile, writeDataFile, recordName, recordTypeName } from '@kenshi-editor/core';
import { resolveGamePaths, loadGameSchema } from '@kenshi-editor/core/node';

const file = readDataFile(readFileSync('mymod.mod'));
for (const rec of file.records) console.log(recordTypeName(rec), rec.stringId, recordName(rec));
const bytes = writeDataFile(file); // те же байты, что были

const schema = loadGameSchema(resolveGamePaths());
console.log(schema.types.get('WEAPON')?.fields.get('blunt damage multiplier')?.description);
```

## Устройство `packages/core`

- `src/format/` — бинарный формат: `read.ts`, `write.ts`, модель в `types.ts`, номера типов
  записей в `item-types.ts`. Строковые значения хранятся как исходные байты
  (`decodeText` умеет UTF-8 и cp1251), редкие особенности файла (биты NaN, булевы не 0/1,
  идентификаторы не в UTF-8, длина записи 0 в формате 17) запоминаются, чтобы запись
  была байт в байт.
- `src/schema/` — парсеры `fcs*.def`, сборка схемы (`parseGameSchema`), сверка с данными
  (`analyzeCoverage`) и дополнение схемы полями из данных (`withInferredFields`).
- `src/locale/po.ts` — gettext PO и индекс переводов по строковым id записей.
- `src/node/` — то, что требует Node: пути к игре, загрузка файлов.
