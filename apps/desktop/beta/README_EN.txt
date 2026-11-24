Cactus {VERSION} - quick start
==============================

Cactus is a mod editor for Kenshi (a replacement for FCS) with a dialogue graph, a
world view and AI assistant integration (MCP). Keep a copy of your .mod files before
editing them.

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

NEW IN 1.0
- Dialogue editor: a tree like the FCS (Window -> Tree), the package and events on the
  left, the line panel on the right with conditions in plain words; "Play" under the
  graph shows how the game would pick a line.
- "Create -> Own creature...": a new race and animal out of the game's own files (mesh,
  skeleton, texture), clip and ragdoll check, sale and start, all in one undo step.
- Inside buildings: Window -> Inside building - walls, floors, a cutaway, click a prop in 3D.
- Model panel: Ogre skeletons, skin weights and animation clips; "Add animations..."
  copies your own clips from Blender into a race.
- Record list: multi-select (Ctrl/Shift) and bulk edit of the selection.
- The game through Kenshi Bridge: spawn a character and take a screenshot of the game
  window from the Game panel and from MCP.

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
