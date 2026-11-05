Kenshi Mod Editor {VERSION} — beta for testing
===============================================

A mod editor for Kenshi: game data, dialogue graph, conversation player, AI link (Claude).
This is a beta: keep copies of your mods.


1. RUNNING
----------
- Unzip into a simple folder, e.g. C:\KenshiModEditor (not "Program Files").
- Run KenshiModEditor.exe. No Node.js or anything else to install.
- Windows may say "Windows protected your PC": the app is not signed.
  Click "More info" → "Run anyway". An antivirus may ask too — allow it.
- The game (Steam or GOG) is found automatically. If not, click "Choose folder…" on the start
  screen and pick the game folder (the one with kenshi_x64.exe and the data folder).
- The app writes into the game folder only after you confirm.


2. WHAT TO TRY
--------------
- "Browse vanilla" — all game data without a mod.
- Search for "Katana" (Ctrl+F), open the record, panel "Where in game" — where the item
  appears (traders, squads, towns).
- Window → layout "Dialogues", open a dialogue: the line graph.
  Right-click a line for the menu (add answer, insert, copy, delete).
  Double-click or F2 — edit text.
- ↶ ↷ on the toolbar (Ctrl+Z / Ctrl+Y, any keyboard layout) — undo and redo.
  The button next to them shows the full step history.
- "Conversation player" — pick a character: what they say and which answers the player sees.
- Save — Ctrl+S. Better save a new mod into a separate file (Ctrl+Shift+S).


3. AI VIA MCP (Claude)
----------------------
Easiest: in the app, menu "Help" → "Connect AI (MCP)…" — a ready config with the right path
and a "Copy" button.

By hand. Claude Desktop: Settings → Developer → Edit Config, file claude_desktop_config.json:

{
  "mcpServers": {
    "kenshi": {
      "command": "C:\\KenshiModEditor\\KenshiModEditor.exe",
      "args": ["C:\\KenshiModEditor\\resources\\mcp\\kenshi-mcp.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}

  Replace C:\\KenshiModEditor with your folder (two places, with double \\).
  If the file already has "mcpServers", add only the "kenshi" block inside it.

Claude Code (one line in a terminal, use your path):

  claude mcp add kenshi --scope user -e ELECTRON_RUN_AS_NODE=1 -- "C:\KenshiModEditor\KenshiModEditor.exe" "C:\KenshiModEditor\resources\mcp\kenshi-mcp.mjs"

RESTART Claude after setup — a new MCP server is picked up only at startup.

Things to ask the AI:
- "Find the katana and show where it is in the game."
- "What does Beep say when you talk to him? Walk through the conversation."
- "Add a player answer to the dialogue …" — if the editor is open, first ask it to
  "connect to the editor" (connect_editor): changes arrive in the window, you accept or roll back.


4. IF SOMETHING BREAKS
----------------------
- Error log: menu "Help" → "Open log folder"
  (that is %APPDATA%\Kenshi Mod Editor\logs). Send the file kenshi-mod-editor.log.
- Say what you did before the error and attach a screenshot.
- MCP errors are logged by Claude Desktop itself: %APPDATA%\Claude\logs\mcp-server-kenshi.log.


5. KNOWN BETA LIMITATIONS
-------------------------
- Windows 10/11 64-bit only. The app is not signed (Windows warning — see above).
- Task Manager shows the process as "Electron", the icon is the default one.
- Scene editing (placement in the world) comes later.
- Copy your .mod file before editing your own mods.

License: MIT (preliminary), see LICENSE.txt.
