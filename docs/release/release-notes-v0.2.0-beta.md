Tag: v0.2.0-beta
Title: Cactus v0.2.0 Beta
Attach: Cactus-0.2.0-beta-win-x64.zip (out/beta/ in the editor folder)
Tick: "Set as a pre-release"

---

**Cactus v0.2.0 Beta — publish to the Workshop, fix and clean your mod, search with conditions.**

Download `Cactus-0.2.0-beta-win-x64.zip`, unzip to a simple folder (e.g. `C:\Cactus`), run `Cactus.exe`. Nothing to install. Windows x64, needs an installed copy of Kenshi (Steam/GOG). To upgrade from 0.1, unzip into a new folder; your settings carry over (see "Upgrading from 0.1" below).

## What's new

### Ship your mod without leaving Cactus
- **Publish to the Steam Workshop:** **Mod → Publish…** uploads the open mod as a new item or updates your existing one. Title, description (BBCode), tags, visibility (new items start as *Private*), preview picture (drag it from the desktop; PNG, JPEG or GIF up to 1 MB), change note, the list of files that will go up, and checks that block or warn before anything is sent. A confirm step says in plain words what Steam will do; then progress and a result screen with links to the item.
- **Works alongside the FCS:** the item number and preview are kept in `_<mod>.info` / `_<mod>.img` in the FCS format, so the FCS and Cactus can update the same item. Backups, temporary files and Cactus companion files are left out of the upload.

### Find and fix problems before your players do
- **Diagnostics with one-click fixes:** every problem has a fix button (remove the invalid references, revert the change, remove the record, or give a record a new id), plus "Fix selected", "Fix all" per kind, an **Ignore** list kept per mod outside the mod file, and "Rescan". Fixes only touch what your mod adds or changes, never vanilla or other mods, and each one is a single undo step. The old Check window is now part of Diagnostics.
- **More FCS checks:** a record whose type changed between layers, a string id already taken by another mod, too many references in a list, a wrong target type, a reference to a deleted or missing record.
- **Mod cleanup** (Window → Mod cleanup): lists what can safely go — obsolete fields, no-op changes, records deleted by a lower layer, orphaned records, invalid references, records of an undefined type — grouped, with the rule of each group explained and a checkbox per group and per item.

### Find exactly the records you need
- **Search with conditions** in the record list: `type=WEAPON; blunt damage multiplier>=0.5`, `state=mod`, `ref=Katana`, `name?^hive`, and conditions that follow references, like `type=SQUAD_TEMPLATE; vendors.weapons:katana` (shops that sell katanas). The **?** button next to the box lists the syntax with examples; a broken condition shows a hint while the others keep filtering.

### Work with more mods and more of the world
- **FCS Extended support:** `fcs.def`, `fcs_preload.def` and `*.def.patch` files in the folder of your mod or its dependencies are applied automatically — new record types, fields and enum values show up in the editor, and **Mod info** lists what each extension adds. DLL plugins of FCS Extended are not run.
- **World view with the real game world:** with a dump from the optional [Kenshi Bridge](https://github.com/Mrgoldd11/Kenshi-Bridge) plugin, the 3D World view draws the game's actual foliage and every building; land features (`MAP_FEATURES`) and ore deposits are shown too.

### In your language
- **Chinese interface** next to English and Russian.
- **Data language is separate from the interface:** names and dialogue text can be shown in any language the game has (Settings → Data language), e.g. an English interface with Russian game texts.

## Smaller improvements and fixes
- New **Mod** menu on the toolbar: Mod info, Dependencies, Backups and Publish…; the toolbar fits on one row at 1400 px.
- **Window** menu reorganised into four sections (Data, Dialogues, World, Mod) with monochrome icons; some panels got clearer names.
- Dialogue graph of a character: a "1 of N" switcher goes through all of the character's dialogues, starting with the one the game picks when you talk to them.
- World map hides overlapping labels of small settlements; the Graphs minimap draws its cards.
- Interface-language fixes for enum labels and quotes, narrow-window layout, empty states.
- Messages from the core (edit errors, history steps, "where in game", talk, validation, merge, bulk edit and more) are translated into all three interface languages.
- Dropping a file on the main window no longer navigates away from the editor.
- Help → About states the licence correctly (free to use, closed source).
- CLI: `kedit find --query "…"` (same syntax as the search box), `kedit validate --fix`, `kedit cleanup`; English output by default, `--lang en|ru|zh` (or `KEDIT_LANG`) and `--data-locale` for game texts.
- MCP: `find` with `query`, new `fix` and `cleanup` tools (preview first, change the mod only with `apply: true`); server messages are in English.
- Public documentation is in English.

## Known limitations (Beta)
- **Workshop publishing is unofficial.** Like the FCS, Cactus talks to Steam under Kenshi's own app id (233860). Steam allows this technically, but Lo-Fi Games have not endorsed it. Steam must be running and logged in to an account that owns Kenshi. Publishing has been tested end to end against a simulated Steam; **try it first on a Private test item.** Not there yet: "update the mod's info from Steam", an ownership pre-check, and a BBCode preview of the description.
- Windows x64 only; zip, no installer; **not code-signed** — SmartScreen will warn ("More info" → "Run anyway").
- Tested mostly with Steam Kenshi 1.0.65 on one machine; GOG less tested.
- The real-world foliage and buildings in the World view need the optional Kenshi Bridge plugin and a dump made in the running game; without it, foliage is scattered approximately.
- World editing works in the editor but has not been checked in the running game yet.
- Some FCS features are still missing or weaker (configurable columns, notes, spell check, some dialogue templates, region map editor).
- AI integration (MCP) is standard stdio MCP; **verified with Claude only**.
- One-person project; some panels are rough.

## Upgrading from 0.1
- **Unzip into a new folder** (or replace the old one). Nothing is installed, so there is nothing to uninstall.
- **Your settings, autosaves and backups stay where they were:** `%APPDATA%\Cactus` (the `KEDIT_USER_DATA` variable still overrides it). The new Diagnostics ignore list is stored there too, in `validation\`.
- **`type=` in search now means the record type.** In 0.1, `--field type=…` (CLI) and `fields` with `type=…` (MCP) matched a field literally named `type`; now they filter by record type, like `type=WEAPON`. For a real field called `type`, put it in quotes: `"type"=…`.
- **Mod info, Dependencies and Backups moved into the new «Mod» menu** on the toolbar, next to Publish….
- If you connected an AI client (MCP) to 0.1 and moved the folder, copy the command again from Help → Connect AI (MCP)… — it contains the path to `Cactus.exe`.

**Back up your `.mod` files and work on copies.**

**Made a mod with Cactus?** If you like, mention "Made with Cactus" in its description — just the name is enough, no link needed. Completely optional, but it helps other modders find the tool.

Cactus is free to use but closed source (see LICENSE). Bugs, ideas and compatibility problems: [Issues](https://github.com/Mrgoldd11/Cactus/issues/new/choose).
