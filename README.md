# Cactus — mod editor for Kenshi

A replacement for the FCS (Forgotten Construction Set). What is in this repository:

- `packages/core` — lossless `.base`/`.mod` format, schema from `fcs*.def`, translations from
  `gamedata.po`; editing model: layers vanilla → dependencies → mod, reference index,
  commands with undo/redo, saving only the differences, search, validation;
- `packages/cli` — `kedit`: search, view, check and build mods from the command line
  (replaces the older Python tool `tools/kdata.py`);
- `packages/mcp` — an MCP server with the same operations plus mod editing, for AI assistants;
- `apps/desktop` — the editor window (Electron + React), see [Editor](#editor-appsdesktop).

The plan is in [ROADMAP.md](ROADMAP.md) (internal notes, in Russian).

## Installation

You need Node.js 22.18 or newer (tested on 24): `kedit` and the MCP server run `.ts` files
without a build step. pnpm comes through corepack:

```bash
corepack enable pnpm
```

If `corepack enable` fails with EPERM (Node is installed in Program Files), install pnpm into
the user npm folder, which is usually already on PATH:

```bash
corepack enable pnpm --install-directory "$APPDATA/npm"
```

Then, in the `editor/` folder:

```bash
pnpm install
```

## Game path

Tests on real data and the report read the files of the installed game (they are not copied
into the repository). The game folder is looked up in this order:

- the environment variables `KENSHI_DIR` and `KENSHI_WORKSHOP_DIR`;
- a `kenshi-paths.json` file in `editor/` (or in any folder above it); it is in `.gitignore`:

```json
{ "kenshi": "C:/Games/Kenshi", "workshop": "C:/Steam/steamapps/workshop/content/233860" }
```

- otherwise the Steam install is found automatically, then GOG; if nothing is found, the
  fallback is `D:/SteamLibrary/steamapps/common/Kenshi`. The workshop folder defaults to
  `<Steam library>/steamapps/workshop/content/233860`.

If the game is not found, the tests on its files are skipped and the rest still run.

## Commands

```bash
pnpm test
```

All tests: synthetic ones (format, encodings, parsers) and ones on the game files — the 4
vanilla files and all installed mods are written back byte for byte, the schema loads and
covers every record type of vanilla.

Tests on the game files are named `*.game.test.ts` and run as a separate vitest project `game`:
after the others and one file at a time (`vitest.config.ts`). Each such file holds all of
vanilla in memory; they used to run in parallel with the rest, and once the first run printed
"Test Files 9 passed (10)" with no `failed` line. Such a summary means a worker process died
in the middle of a file (vitest reports it on a separate `Errors 1 error` line above the
summary), not that a test failed: read the whole output rather than `grep failed`.

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm report
```

A report on how `fcs.def` differs from the data: which types and fields exist in the files but
are not described in the schema, and the other way round. It is written to
`reports/schema-report.md` and `.json` (both in `.gitignore`).

## Editor (`apps/desktop`)

```bash
pnpm desktop
```

Starts the editor in development mode (electron-vite: an Electron window and a dev server on
`127.0.0.1:5173`). Without the command line, double-click `Запустить редактор.cmd` ("start the
editor") in the `editor/` folder (you can put a desktop shortcut to it); it runs
`apps/desktop/scripts/launch.ts`, the same as `pnpm desktop:start`, which rebuilds first if the
sources changed. In PowerShell with script execution disabled, `pnpm` does not start — call
`pnpm.cmd desktop`. If no window appears and the output says `Electron failed to install
correctly`, pnpm did not download Electron itself — run this once in the `electron` package
folder:

```bash
cd node_modules/.pnpm/electron@*/node_modules/electron && node install.js
```

What it can do:

- the game folder is found automatically (Steam, GOG, `KENSHI_DIR`/`kenshi-paths.json`) or
  chosen by hand; the start screen offers vanilla, a new mod, opening a `.mod` and the list of
  mods from `mods/` and the workshop, with the load order from `data/mods.cfg`;
- the mod's dependencies are picked with checkboxes (the **Dependencies** button); the mod is
  reloaded when they change;
- on the left, a category tree as in the FCS (`fcs_layout.def`) plus **Changes in this mod**,
  **All** and **Other types**; the record list is virtual, search works by English or
  translated name and by id, with a status filter; status colours as in the FCS: new — green,
  changed — yellow, deleted — red and struck out, `●` — changed since the last save;
- fields follow the `fcs.def` schema: hints from its descriptions, drop-down lists for enums,
  an **inferred** mark for fields that `fcs.def` does not describe, a **Vanilla** column and
  **Reset to vanilla** for a field;
- references: add them by searching for a record of the right type, values v0–v2 labelled from
  the schema, jump to the target, a **Referenced by** tab, and a **Changes** tab with the
  per-field differences from vanilla;
- the **Where in game** tab: the chain of back-references from a record to a place in the world
  (katana ← weapon trader's list ← squad ← towns) with coordinates from the level files and the
  item icon if there is one; every step of the chain opens with a click;
- the **Graph** tab for dialogue packages, dialogues and lines: lines as nodes (speaker, texts —
  in the data language, from the game's translation file such as `ru_RU.translation`,
  conditions, actions, score and chance), player choices highlighted, menu loops dashed; on top,
  the problems: missing record, dialogue without lines, a line the game will never pick (a
  sibling without conditions at 100% chance and a higher score); clicking a problem shows the
  line on the graph; the mouse wheel scrolls the graph, Ctrl+wheel zooms;
- the **Talk** tab for characters: which dialogues the game considers for an event (player
  click and the rest as a list), where each comes from (the character itself, its package,
  squad packages, the faction package), score, conditions and actions (arrest, attack, trade,
  recruit), which one the game picks and how the conversation starts — lines with the player's
  choices. The selection rule is exact, read from the game's code (Kenshi 1.0.65): score with
  bonuses for conditions, a fair draw among the best, chances in percent; each dialogue gets a
  plain-words explanation, and the **How the game picks** button opens a window with the rules;
- the **AI changes** panel: the MCP server connects to the open window, and the AI's edits show
  up in the editor at once as a change set — what changed per field, a link to the record,
  **Accept** and **Roll back** buttons (more in the MCP server section);
- the **Mods** panel (**Window** menu): installed mods from `mods/` and the workshop in
  `data/mods.cfg` order; checkboxes pick which mods are loaded as layers under your mod;
  drag-and-drop and ▲▼ change the load order (`mods.cfg` is written only after you confirm,
  with a copy of the previous file);
- the **Conflicts** panel: which mods change the same field differently and whose value wins
  (the later one in the load order);
- someone else's workshop mod opens read-only; the **Copy for editing** button puts a copy into
  `mods/<name>/<name>.mod`, and from then on edits are saved into the copy;
- the **Translation** panel (like the FCS translation mode): choose the mod you are translating
  and it becomes a dependency of your mod; original text on the left, translation field on the
  right (Ctrl+Enter or clicking away applies it), a **Not translated** filter, search, a
  "translated N of M" total. Your mod keeps only the translated names and texts. **Export** to
  CSV (Excel), PO (Poedit) or JSON and **Import…** back as one undo step; lines whose original
  changed after the export are not applied without a separate button. **Check of the
  translation mod** shows texts beyond the original and edits that are not texts;
- other panels from the **Window** menu: **History**, **Bulk edits**, **Merge mods**,
  **Compare items**, **Faction relations**, **NPC census**, **Graphs**, **Dialogue graph**,
  **Conversation player**, **Diagnostics**, the 3D **World**, **Building interior** and
  **Model** views, and **Game** (the running game through the optional Kenshi Bridge plugin);
  autosave and **Mod backups**;
- undo and redo (Ctrl+Z / Ctrl+Y), save (Ctrl+S, Ctrl+Shift+S — "Save as…"), back and forward
  through the navigation history (Alt+← / Alt+→), search (Ctrl+F), mod validation, interface
  language English / Russian / Chinese.

Writing into the game or workshop folder happens only after a separate confirmation; **Cancel**
is the default choice. Settings (language, game folder, recent files) are kept in
`settings.json` in Electron's `userData` folder: `%APPDATA%/@kenshi-editor/desktop/` in
development mode, `%APPDATA%/Cactus/` in the packaged build (`KEDIT_USER_DATA` overrides it).

How it is built. The core (`ModContext`) runs in the window (renderer): a list of 55 thousand
records, search, undo and change subscriptions have to be synchronous, while over IPC every
action would be asynchronous and copy data. Only the main process reads and writes files: the
renderer receives the bytes of vanilla, dependencies and the mod through preload
(`window.kedit`) and hands back the bytes of the saved mod. The window is isolated:
`contextIsolation`, `sandbox`, no `nodeIntegration`, a CSP without inline scripts (except for
the dev server).

```bash
pnpm desktop:e2e
```

Build plus Playwright e2e tests on the real game (read-only): open vanilla, find the katana,
change a field, undo, save into a temporary folder; refusing to write into the game folder
writes nothing; the scenario "copy of the katana → name and damage → into the weapon trader's
stock → save to `out/KeditE2E Trader Katana.mod`"; the dialogue graph; a talk with the
barman; the live MCP link; on a temporary "game folder" — mods as layers, conflicts, load
order, copying a workshop mod and the **Translation** panel (typing a translation, CSV export,
import back, undo). Screenshots go to `out/screenshots/`.

## kedit (CLI)

```bash
node packages/cli/bin/kedit.js --help
```

```text
Commands:
  find [text] [TYPE]      records by name (English or translated) or id; TYPE — name or number
      --type TYPE  --field key=value (~ substring, != < > <= >=, key? — field is set; may repeat)
      --status new,changed,deleted,base  --anywhere text  --exact  --mod-only
  show <id|name>...       fields and references (with target names)  --layers  --max-refs N
  tree <id|name>          dialogue tree (dialogs/lines)  --full  --depth N  --max-nodes N
  mod <file.mod> [text]   records of a mod file with status; text — substring anywhere  --brief
  refs <id|name>          references from the record and to it  --from  --to
  where <id|name>         where the record is in the game: back-reference chain to towns/buildings with coordinates
      --tree  the whole back-reference tree;  --limit N — facts (default 20)
  talk <character>        which dialogues a character has for an event, from where, which one the game picks, how the talk starts
      --event N  event (default 1 — player click);  --mods  with the player's mods from mods.cfg
  diff                    what the mod (--mod) changes over the lower layers; total «new N, changed M»
      --status added,changed,removed  only records with these changes
  diff <a.mod> <b.mod>    difference of two files
  validate                broken references, fields outside the schema, wrong kind; exit code 1 on errors
  schema [TYPE]           record types / fields of a type with descriptions from fcs.def  --enum NAME
      --mod M  with the schema extensions of the mod and its dependencies (FCS Extended files), marked [extension NAME]
  bulk <TYPE> [text]      bulk edit of records of a type (text — substring of name or id), conditions --field, --mod-only
      --set|--mul|--add FIELD=VALUE  or  --replace FIELD --find TEXT --with TEXT [--regex] [--case] (FIELD name — record name)
      preview «was → will be» by default; --apply — write into --out or --mod (one edit)
  merge <source>          merge: what the source mod (name or path) changes over --mod; new / changed / deleted, conflicts
      preview by default; --apply + choice --only id,id | --type TYPE,… | --kind new,changed,deleted | --all — merge in one edit
      --recursive  with the records they reference;  --fix-refs  also add new records the accepted ones reference
      --conflicts source|mine  which side wins conflicts (default mine — your values);  --levels  level data (detected, not merged)
      --reject id,id  reject and do not show again;  --unreject id,id  restore;  --show-rejected  show rejected ones
      writes into --out or --mod, with the decisions file <mod>.kedit-merge.json next to it; never into the workshop, into the game folder with --force
  build <script.ts|plan.json> --out <file.mod> [--name Name.mod] [--mod source] [-- arguments]
  mods [list]             installed mods: mods.cfg order, where from (mods/workshop)  --full  --json
  mods move <mod>         move in mods.cfg:  --top (first) | --bottom (wins) | --after X | --before X
  mods enable|disable <mod>  enable (at the end or --top/--after X…) / disable
      without --force only shows what changes; --force — write mods.cfg (copy next to it, game closed)
  mods copy <mod|path>    someone else's mod → copy for editing in mods/<name>/<name>.mod (+ where the copy came from)  --name Name  --force
      the workshop original is not changed; without --force only shows what will happen
  touched <id|name>       which mods from mods.cfg change the record and what exactly  --all  all installed
  conflicts               mods that change one field differently, and who wins (the later one in mods.cfg)
      --mod <path|name.mod>  only conflicts of this mod;  --all  all installed, not only mods.cfg
  strings <original.mod>  mod texts for translation: original, translation, status; total «translated N of M»
      --mod <translation.mod>  statuses in this translation mod (+ check: extra texts, non-text edits)
      --todo  untranslated only;  --out texts.csv|.json|.po — export (PO — for Poedit)
      --import <file> --out <translation.mod> [--name Name.mod]  build a translation mod from a file (CSV/JSON/PO)

Common:
  --game <Kenshi folder>  otherwise KENSHI_DIR, kenshi-paths.json or the found Steam/GOG install
  --data-locale <code>    language of translated names (de_DE, ru_RU…; none — no translation); otherwise KENSHI_DATA_LOCALE or the game language (settings.cfg)
  --lang <en|ru|zh>       language of the output; otherwise KEDIT_LANG, otherwise English
  --mod <path|name.mod>   mod over vanilla (and its dependencies)
  --deps a.mod,b.mod      dependencies instead of those written in the mod ("" — none)
  --json  --offset N  --limit N (default 50, 0 — all)
```

Besides what the help line says, `validate` also reports dialogues without lines, dangling
references to records removed by dependencies, and an added dialogue that overrides a vanilla
one with arrest, attack, trade or recruit (at an equal or higher score).

Translating someone else's mod from the command line: export the texts, translate the file in
Excel or Poedit, build the translation mod (it depends on the original and keeps only texts):

```bash
node packages/cli/bin/kedit.js strings "GusokuArmorV1.0" --out gusoku.po
```

```bash
node packages/cli/bin/kedit.js strings "GusokuArmorV1.0" --import gusoku.po --out "out/Gusoku RUS.mod"
```

Compared with `tools/kdata.py`: `find`, `show`, `tree`, `mod` are the same commands (the type
can be given as a number, as there), only the data comes from layering, as in the game, rather
than from merging files.

Records can be named by name (English or translated): if several match, the command prints a
list with ids and asks you to be more specific. Enum values are shown by name
(`DR_ONCE_ONLY “once only” (5)`), including the `DIALOG_ACTION` fields that `fcs.def` lacks
(condition, who, comparison, action, `tag` per condition) and the event in
`DIALOGUE_PACKAGE.dialogs`; in `tree` conditions read as a line (`? me: DC_IN_COMBAT = 0`).
The `set` operation accepts an enum value name instead of a number.

```bash
node packages/cli/bin/kedit.js find cannibal CHARACTER --mod "Skeleton Cannibal Friend"
```

```bash
node packages/cli/bin/kedit.js show 2604-gamedata.base --layers
```

`build` writes only the differences from the lower layers and does not write into the game or
workshop folder without `--force`. A script default-exports `(env: BuildEnv) => ModContext`; a
JSON plan is `{ mod?, name?, dependencies?, info?, ops: [...] }`, with the operations `create`,
`duplicate`, `delete`, `restore`, `revert`, `rename`, `set`, `reset`, `addRef`, `removeRef`,
`setRefs`, `info`.

Stable ids for new records: `env.stableId('unique name')` gives `number-Name.mod`; the
name → number table is `ids.json` next to the script (`{ next, ids }`, as in Vanilla Talk). New
names are appended after a successful build, a number never changes and is never reused; names
that are no longer built are reported as a warning.

Dialogues in a script use `DialogBuilder` from the core (a generalisation of the Vanilla Talk
build): lines with text variants, conditions and actions without hand-written `DIALOG_ACTION`,
attaching to a character (click) or to the packages it listens to (its own package → squad
packages → faction package):

```ts
import { DialogBuilder, SPEAKER } from '@kenshi-editor/core';

const b = new DialogBuilder(ctx, env.stableIds());
const hi = b.line('My greeting', SPEAKER.ME, ['Hello.', 'Hi there.']);
const dlg = b.dialogue('My conversation', [hi], [{ cond: 7, who: 1, v: 0 }], { score: -100 });
b.attachToCharacter('1187-gamedata.base', dlg);
```

### Example: Skeleton Cannibal Friend

`packages/cli/examples/skeleton-cannibal-friend/` is a port of `tools/build_skeleton_cannibal.py`
to core commands. It builds into `editor/out/` (in `.gitignore`):

```bash
node packages/cli/bin/kedit.js build packages/cli/examples/skeleton-cannibal-friend/build.ts --out "out/Skeleton Cannibal Friend.mod"
```

By default vanilla is taken the way `kdata.py` saw it (files merged into one record), and the
result matches the installed mod byte for byte. With `-- --layered` it uses real layering; the
only difference is explained in `packages/cli/test/scf.game.test.ts`. The test compares both
builds with the installed mod (skipped without the game).

## MCP server

A stdio server `kenshi-mod-editor` on `@modelcontextprotocol/sdk`. The tool names,
descriptions and parameters are in English.

- data tools: `open_mod`, `find`, `show`, `inspect`, `tree`, `refs`, `where`, `talk`, `diff`,
  `validate`, `touched`, `conflicts`, `schema` — as in the CLI;
- editing: `edit` (a batch of operations, as in a JSON plan, as one change set, `$aliases` for
  new records; for the dialogue graph — `addLine`, `insertLine`, `link`, `unlink`, `setText`,
  `duplicateLine`, `deleteLines`, `revertLine`, `addCondition`, `addEffect`, `removeAction`;
  enum values can be given by name), `bulk` (preview "was → will be", applied only with
  `apply: true`), `merge`, `play` (a conversation step by step, like the player in the window),
  `undo`/`redo` (with `to` — up to step #N), `history` (steps in plain words, as in the window,
  with a "you are here" mark), `save`;
- live link to the window: `connect_editor` and `editor_changes` (below);
- world: `list_in_area`, `place`, `move`, `remove`, `world_history`, `world_undo`; building
  interiors: `interior`, `interior_place`, `interior_move`, `interior_remove`;
- the running game through the optional [Kenshi Bridge](https://github.com/Mrgoldd11/Kenshi-Bridge)
  plugin: `game_state`, `game_trace`, `game_towns`, `game_dump`, `game_flyover`,
  `game_command` (the last two only with `confirm: true`);
- resources: `kenshi://schema/types`, `kenshi://schema/type/{name}` (fields with descriptions
  from `fcs.def`), `kenshi://schema/enum/{name}`;
- answers are short: references with target names, long lists in pages (`offset`, `limit`).

`save` without `path` writes into the file of the open mod; into the game or workshop folder
only with `force: true`.

### Live link with the open editor

If Cactus is open, ask the AI to call `connect_editor`. From then on the MCP server works with
the mod in the editor window, not with its own copy:

- before every command it takes the fresh state of the window — the AI sees your manual edits
  too;
- `edit` does not write by itself but sends the batch of edits to the window: it is applied at
  once as one history step "AI: …" and waits for your decision in the **AI changes** panel —
  **Accept** or **Roll back** (roll back is refused if the same record was changed afterwards,
  with an explanation of what is in the way); Ctrl+Z in the window also undoes the set;
- `editor_changes` — the state of the sets: waiting for a decision, accepted, rolled back,
  undone in the window;
- `save`, `undo`, `redo`, `open_mod` are not available in this mode — the user does that in the
  window;
- `connect_editor` with `disconnect: true` — disconnect and work as before.

How it works: the window starts a WebSocket server on `127.0.0.1` only, with a random port and
token; the port and token are in the discovery file `%TEMP%/kenshi-mod-editor/live.json`
(another path — `KEDIT_LIVE_FILE`; turn the link off — `KEDIT_LIVE=0`). Connections from
browser pages (with an `Origin` header) and without the token are rejected. The file is deleted
when the editor closes.

### Setup

In Cactus, **Help → Connect AI (MCP)…** shows a ready snippet to copy. By hand, `.mcp.json`
(Claude Code and other clients):

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

Server flags: `--game <Kenshi folder>`, `--mod <path|name.mod>` (open it right away; otherwise
use `open_mod`), `--deps a.mod,b.mod`. Without `--game` the server uses `KENSHI_DIR`,
`kenshi-paths.json`, the game folder chosen in the Cactus settings, then the Steam/GOG install.

## Example: the core in code

```ts
import { readFileSync } from 'node:fs';
import { readDataFile, writeDataFile, recordName, recordTypeName } from '@kenshi-editor/core';
import { resolveGamePaths, loadGameSchema } from '@kenshi-editor/core/node';

const file = readDataFile(readFileSync('mymod.mod'));
for (const rec of file.records) console.log(recordTypeName(rec), rec.stringId, recordName(rec));
const bytes = writeDataFile(file); // the same bytes as before

const schema = loadGameSchema(resolveGamePaths());
console.log(schema.types.get('WEAPON')?.fields.get('blunt damage multiplier')?.description);
```

### The core in your own scripts: the `@kedit/core` package

Inside the workspace the core is `@kenshi-editor/core` (TypeScript sources). For scripts
outside it (your own mod in another folder) there is the `@kedit/core` package — the same code
compiled to JavaScript with type declarations, with no dependencies:

```sh
pnpm core:package                       # → out/kedit-core/  (--tgz — also an archive for npm)
cd D:/my-mod && npm install D:/Kenshiproject/editor/out/kedit-core
```

```ts
import { ModContext, encodeText } from '@kedit/core';
import { loadModContext, resolveGamePaths } from '@kedit/core/node';
```

The script runs as usual (`node build.ts`, Node ≥ 22.18). The old relative import
`../../editor/packages/core/src/index.ts` still works. The package is marked `private` and is
not published to npm.

## Layout of `packages/core`

- `src/format/` — the binary format: `read.ts`, `write.ts`, the model in `types.ts`, record type
  numbers in `item-types.ts`. String values are kept as the original bytes (`decodeText`
  handles UTF-8 and cp1251); rare file quirks (NaN bits, booleans other than 0/1, non-UTF-8
  ids, record length 0 in format 17) are remembered so that writing is byte for byte.
- `src/schema/` — parsers for `fcs*.def`, schema assembly (`parseGameSchema`), comparison with
  the data (`analyzeCoverage`), filling the schema with fields from the data
  (`withInferredFields`) and FCS Extended schema extensions (`extensions.ts`).
- `src/locale/po.ts` — gettext PO and a translation index by record string id;
  `src/locale/translation.ts` — translations of dialogue line texts from
  `<language>.translation` (`.mod` format).
- `src/model/` — editing without Node: `context.ts` (`ModContext`: layers, statuses, reference
  index, commands, undo/redo, saving the differences), `record-ops.ts` (layering and
  differences of records), `ops.ts` (JSON operations for the CLI/MCP), `search.ts`,
  `validate.ts`, `diff.ts`, `present.ts`, `dialogue.ts`, `dialogue-graph.ts` (dialogue graph
  and checks for unreachable lines), `schema-view.ts`, `enums.ts` (enum value names),
  `stable-ids.ts` (stable ids by name), `bulk.ts`, `merge.ts`, `conflicts.ts`,
  `load-order.ts`, `translate.ts`.
- `src/dialog/` — `talk.ts` (`simulateTalk`: which dialogues a character considers for an event
  and which one the game picks; `formatTalk`), `play.ts` (conversation player), `builder.ts`
  (`DialogBuilder` for build scripts).
- `src/world/` — the world from the level files (`.zone`, `.level`): `world.ts` (`WorldIndex`:
  towns, buildings with squads, record instances in zones with layering), `where.ts`
  (`whereInGame` — the back-reference chain to a place in the world, `formatWhere`).
- `src/live/` — the live link between the window and MCP: the protocol and `LiveHost` (MCP
  requests over the open mod, AI change sets: accept, roll back).
- `src/game/bridge.ts` — the protocol of the optional Kenshi Bridge game plugin.
- `src/node/` — what needs Node: game paths, loading files, `loadModContext`,
  `saveModContext`, `loadWorld`, `loadTranslation`, `startLiveServer` (the live-link
  WebSocket), backups and autosave (`backup.ts`).
