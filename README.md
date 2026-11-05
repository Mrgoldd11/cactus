# Редактор модов Kenshi

Замена FCS (Forgotten Construction Set). Сейчас готово:

- `packages/core` — формат `.base`/`.mod` без потерь, схема из `fcs*.def`, перевод из
  `gamedata.po`; модель редактирования: слои ваниль → зависимости → мод, индекс ссылок,
  команды с undo/redo, сохранение только отличий, поиск, валидация;
- `packages/cli` — `kedit`: поиск, просмотр, проверка и сборка модов из командной строки
  (замена `tools/kdata.py`);
- `packages/mcp` — MCP-сервер с теми же операциями и правкой мода для ИИ-ассистентов.

План — в [ROADMAP.md](ROADMAP.md).

## Установка

Нужен Node.js 22.18 или новее (проверено на 24): `kedit` и MCP-сервер запускают `.ts` без
сборки. pnpm подключается через corepack:

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

## kedit (CLI)

```bash
node packages/cli/bin/kedit.js --help
```

```text
find [текст] [ТИП]      записи по имени (англ. или рус.) или id; ТИП — имя или номер
    --type ТИП  --field ключ=знач (~ подстрока, != < > <= >=, ключ? — поле есть)
    --status new,changed,deleted,base  --anywhere текст  --exact  --mod-only
show <id|имя>...        поля и ссылки (с именами целей)  --layers  --max-refs N
tree <id|имя>           дерево диалога (dialogs/lines)  --full  --depth N  --max-nodes N
mod <файл.mod> [текст]  записи файла мода со статусом  --brief
refs <id|имя>           ссылки из записи и на неё  --from  --to
diff                    что мод (--mod) меняет относительно нижних слоёв; итог «новых N, изменённых M»
    --status added,changed,removed  только записи с такими изменениями
diff <a.mod> <b.mod>    разница двух файлов
validate                битые ссылки, поля вне схемы, не тот вид, диалоги без реплик,
                        висячие ссылки на записи, удалённые зависимостями; код 1 при ошибках
schema [ТИП]            типы записей / поля типа с описаниями из fcs.def  --enum ИМЯ
build <скрипт.ts|план.json> --out <файл.mod> [--name Имя.mod] [--mod исходный] [-- аргументы]
```

Общие флаги: `--game`, `--mod <путь|имя.mod>` (мод поверх ванили и его зависимостей),
`--deps a.mod,b.mod`, `--json`, `--offset`, `--limit`. Соответствие `tools/kdata.py`:
`find`, `show`, `tree`, `mod` — те же команды (тип можно номером, как там), только данные
берутся наложением слоёв, как в игре, а не слиянием файлов.

Записи можно называть именем (англ. или рус.): если подходит несколько, команда выводит
список с id и просит уточнить. Значения enum показываются именами (`DR_ONCE_ONLY «один раз» (5)`),
в том числе поля `DIALOG_ACTION`, которых нет в `fcs.def` (условие, кто, сравнение, действие,
`tag` по условию), и событие в `DIALOGUE_PACKAGE.dialogs`; в `tree` условия читаются строкой
(`? собеседник: DC_RELATIONS < 20`). Операция `set` принимает имя значения enum вместо числа.

```bash
node packages/cli/bin/kedit.js find людоед CHARACTER --mod "Skeleton Cannibal Friend"
```

```bash
node packages/cli/bin/kedit.js show 2604-gamedata.base --layers
```

`build` пишет только отличия от нижних слоёв и не пишет в папку игры или мастерской без
`--force`. Скрипт экспортирует по умолчанию `(env: BuildEnv) => ModContext`; JSON-план —
`{ mod?, name?, dependencies?, info?, ops: [...] }`, операции: `create`, `duplicate`, `delete`,
`restore`, `revert`, `rename`, `set`, `reset`, `addRef`, `removeRef`, `setRefs`, `info`.

Постоянные id новых записей: `env.stableId('уникальное имя')` даёт `номер-Имя.mod`; таблица
имя → номер — `ids.json` рядом со скриптом (`{ next, ids }`, как у Vanilla Talk). Новые имена
дописываются после удачной сборки, номер не меняется и не переиспользуется; имена, которые
больше не собираются, выводятся предупреждением.

### Пример: Skeleton Cannibal Friend

`packages/cli/examples/skeleton-cannibal-friend/` — перенос `tools/build_skeleton_cannibal.py`
на команды ядра. Сборка в `editor/out/` (в `.gitignore`):

```bash
node packages/cli/bin/kedit.js build packages/cli/examples/skeleton-cannibal-friend/build.ts --out "out/Skeleton Cannibal Friend.mod"
```

По умолчанию ваниль берётся так, как её видел `kdata.py` (файлы слиты в одну запись), и
результат совпадает с установленным модом байт в байт. С `-- --layered` — настоящим
наложением слоёв; единственное отличие разобрано в `packages/cli/test/scf.test.ts`. Тест
сравнивает обе сборки с установленным модом (без игры пропускается).

## MCP-сервер

stdio-сервер `kenshi-mod-editor` на `@modelcontextprotocol/sdk`:

- инструменты: `open_mod`, `find`, `show`, `tree`, `refs`, `diff`, `validate`, `schema` —
  как в CLI; `edit` (пачка операций, как в JSON-плане, одним набором изменений, `$псевдонимы`
  для новых записей), `undo`, `redo`, `history`, `save`;
- ресурсы: `kenshi://schema/types`, `kenshi://schema/type/{ТИП}` (поля с описаниями из
  `fcs.def`), `kenshi://schema/enum/{ИМЯ}`;
- ответы короткие: ссылки с именами целей, длинные списки — страницами (`offset`, `limit`).

`save` без `path` пишет в файл открытого мода; в папку игры или мастерской — только с
`force: true`.

`.mcp.json` (Claude Code и другие клиенты):

```json
{
  "mcpServers": {
    "kenshi": {
      "command": "node",
      "args": ["D:/Kenshiproject/editor/packages/mcp/bin/kenshi-mcp.js", "--mod", "Skeleton Cannibal Friend"],
      "env": { "KENSHI_DIR": "D:/SteamLibrary/steamapps/common/Kenshi" }
    }
  }
}
```

Флаги сервера: `--game <папка Kenshi>`, `--mod <путь|имя.mod>` (открыть сразу; иначе —
`open_mod`), `--deps a.mod,b.mod`.

## Пример: ядро в коде

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
- `src/model/` — редактирование без Node: `context.ts` (`ModContext`: слои, статусы,
  индекс ссылок, команды, undo/redo, сохранение отличий), `record-ops.ts` (наложение и
  разность записей), `ops.ts` (операции JSON для CLI/MCP), `search.ts`, `validate.ts`,
  `diff.ts`, `present.ts`, `dialogue.ts`, `schema-view.ts`, `enums.ts` (имена значений enum),
  `stable-ids.ts` (постоянные id по имени).
- `src/node/` — то, что требует Node: пути к игре, загрузка файлов, `loadModContext`,
  `saveModContext`.
