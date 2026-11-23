**Cactus v1.0.0 — the dialogue editor is rebuilt, own creatures and animals, inside view of buildings.**

Download `Cactus-1.0.0-win-x64.zip`, unzip to a simple folder (e.g. `C:\Cactus`), run `Cactus.exe`. Nothing to install. Windows x64, needs an installed copy of Kenshi (Steam/GOG). To upgrade from 0.2, unzip into a new folder; your settings carry over (see "Upgrading from 0.2" below).

This is the first release outside beta.

## What's new

### A dialogue editor you can actually read
- **A tree like the FCS** (Window → Tree): packages, dialogues and lines in one list, next to the graph.
- **The graph reads left to right**: event → who speaks → dialogue; a line is one node, clicking a node opens its panel.
- **The line panel** on the right: texts, who speaks, score and chance, conditions and effects in plain words with the field's description, "when it may play" switches, "How the game picks" and "Like it…" / "Hang on another event…".
- **▶ Play under the graph**: the game's candidates in its own order, the picked line lit step by step, and a draft of a line "like this one".
- **New dialogue on event** with the score line, **transitions between dialogues** as portals in the graph, and dialogues the game starts without a package (biome arrival, campaign, contract end…).
- Conditions and effects of a package are read from v0, v1 and v2 of `DIALOGUE_PACKAGE.dialogs` — the whole event list, not just the first one.

### Create a creature, not just a record
- **Create → Own creature…**: pick mesh, skeleton and texture from the game's own files, check the clips and the ragdoll bones with a playing preview, then the race, the animal, its sale and its start in the mod — one undo step.
- **Race compatibility wizard**: a new race works like a sample race — armour and clothing, weapons, dialogue conditions, race groups, start scenarios, animation files. **New race based on a sample…** copies the sample under a required name first.
- **Add animations…**: your own clips from Blender into a race, with the clips the game actually asks for.

### See the mod, not just the data
- **Inside view of buildings** (Window → Inside building): the building shell, floors with a cutaway, framing, click a prop in 3D.
- **Model panel**: Ogre skeletons, skin weights and animation clips with playback.
- **Every record says whether it is in the game**: the "In the game: …" line, the ways a record gets into the game, and "like the sample".
- **The record list multi-selects** (Ctrl/Shift/Ctrl+A) and bulk-edits the selection.

### The game, when you have the Bridge
- **Spawn** a character or animal from a record and **screenshot** the game window from the Game panel and from MCP (`game_spawn`, `game_screenshot`); coordinates can be pasted into the panel and copied back out.

## Smaller improvements and fixes
- Saving the mod, `mods.cfg` and the settings is atomic: a crash or a full disk never leaves a half-written file.
- The inspector lists references among the fields, shows field names in the interface language, and explains an "empty" value.
- **+ New** knows the category you are in: it offers the category's condition, a sample to copy or an empty record.
- Translated names lose the game's gender markup (`Трактирщи/кца1/` → `Трактирщик`).
- Popup menus close on a click outside or Esc (language switch, window menu).
- MCP: `game_spawn`, `game_screenshot`; the setup snippet from Help → Connect AI (MCP) also works for spawn and screenshot.

## Known limitations
- Windows x64 only; zip, no installer; **not code-signed** — SmartScreen will warn ("More info" → "Run anyway").
- Tested mostly with Steam Kenshi 1.0.65 on one machine; GOG less tested.
- Workshop publishing: Steam must be running and logged in to an account that owns Kenshi. **Before your first real upload, try a Private test item.**
- The real-world foliage and buildings in the World view need the optional Kenshi Bridge plugin and a dump made in the running game; without it, foliage is scattered approximately.
- World editing works in the editor but has not been checked in the running game yet.
- Some FCS features are still missing or weaker (configurable columns, notes, spell check, some dialogue templates, region map editor).
- AI integration (MCP) is standard stdio MCP; **verified with Claude only**.
- One-person project; some panels are rough.

## Upgrading from 0.2
- **Unzip into a new folder** (or replace the old one). Nothing is installed, so there is nothing to uninstall.
- **Your settings, autosaves and backups stay where they were:** `%APPDATA%\Cactus` (the `KEDIT_USER_DATA` variable still overrides it).
- If you connected an AI client (MCP) to 0.2 and moved the folder, copy the command again from Help → Connect AI (MCP)… — it contains the path to `Cactus.exe`.

**Back up your `.mod` files and work on copies.**

**Made a mod with Cactus?** If you like, mention "Made with Cactus" in its description — just the name is enough, no link needed. Completely optional, but it helps other modders find the tool.

Cactus is free and open source under the GNU GPLv3 (see LICENSE). Bugs, ideas and compatibility problems: [Issues](https://github.com/Mrgoldd11/Cactus/issues/new/choose).
