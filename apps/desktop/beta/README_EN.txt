Cactus {VERSION} - quick start
==============================

Cactus is a mod editor for Kenshi (a replacement for FCS) with a dialogue graph, a
world view and AI assistant integration (MCP). This is a beta: keep a copy of your
.mod files before editing them.

RUN
1. Unzip to a simple folder, for example C:\Cactus (do not run from inside the archive).
2. Run Cactus.exe. Nothing to install.
   If Windows says "protected your PC": More info -> Run anyway (the app is not signed yet).
3. The game (Steam/GOG) is found automatically. If not, click "Choose folder..." and pick
   your Kenshi folder (the one with kenshi_x64.exe and data).

THINGS TO TRY
- "Browse vanilla" -> Ctrl+F "katana" -> "Where in game" tab: who sells it.
- "Window" -> "Layouts" -> "Dialogues", find "Beep": dialogue graph and player.
  Right-click a line for the menu, double-click to edit text, Delete to remove.
- Undo/redo (Ctrl+Z / Ctrl+Y); the arrow next to them lists the steps.
- Your own mod: type a name on the start screen -> "New mod" -> edit -> Ctrl+S.
  It is saved to <game folder>\mods\<Name>\; tick it in the Kenshi launcher.

NEW IN 0.2
- Search with conditions: type "type=WEAPON; weight kg>10" in the record list search;
  the "?" button next to it shows examples.
- "Diagnostics" (toolbar) lists problems of your mod with fix buttons;
  "Window" -> "Mod cleanup" removes leftovers (obsolete fields, no-op changes, dead references).
- "Mod" menu (toolbar): mod info, dependencies, backups and "Publish..." to the Steam
  Workshop (Steam must be running). Publishing is unofficial, like the FCS: try it first with
  a Private test item.
- Chinese interface; the language of game texts is set separately (Settings -> Data language).

AI (any MCP client: Claude Desktop, Claude Code and others)
1. In Cactus: "Help" -> "Connect AI (MCP)..." -> "Copy".
2. Claude Desktop: Settings -> Developer -> Edit Config, paste into claude_desktop_config.json,
   save and fully restart Claude (tray -> Quit). Claude Code: paste the copied command
   into PowerShell.
3. Ask: "Find the katana and show where it is sold in the game".
Cactus speaks standard MCP (stdio), so any AI client that supports MCP can connect;
for other clients use the same command that "Copy" puts on the clipboard. Tested with
Claude only so far; reports about other clients are welcome.

PROBLEMS
Open an issue: https://github.com/Mrgoldd11/Cactus/issues - attach the version
(Help -> About), the log file (Help -> Open log folder), steps and a screenshot.
