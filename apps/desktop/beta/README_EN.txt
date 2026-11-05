Kenshi Mod Editor {VERSION} — step-by-step guide
================================================

A mod editor for Kenshi: all game data, dialogue graph, conversation player and help from an
AI (Claude). No programming needed.

This is a beta for testing. Keep a copy of your .mod file before editing your own mods.

Pictures for this guide are in the screenshots folder next to this file:
  screenshots\1-start.png         — start screen
  screenshots\2-katana-where.png  — katana and the "Where in game" tab
  screenshots\3-dialogues.png     — "Dialogues" layout: graph, menu, player
(The pictures show the Russian interface; switch with EN / RU in the top right corner.)


STEP 1. UNZIP
-------------
1. Do not run the program from inside the zip — it will not work that way.
2. Right-click the zip → "Extract All…".
3. Pick a simple folder, best C:\KenshiModEditor
   (not "Program Files" or "Downloads" — Windows sometimes blocks writing there).
4. Click "Extract". The folder will contain KenshiModEditor.exe, this guide, the folders
   locales, resources, screenshots and support files. Delete nothing: everything is needed.

No Node.js, Python or anything else to install. The program installs nothing into the system:
to remove it, delete the folder.


STEP 2. FIRST RUN
-----------------
1. Double-click KenshiModEditor.exe.
2. Windows may show a blue "Windows protected your PC" window.
   That is because the program is not signed (signing costs money; the beta has none).
   Click "More info" → "Run anyway". Needed only once.
3. If an antivirus asks about the program — allow it. If it deleted a file, restore it from
   quarantine or unzip again.
4. The start screen opens (picture screenshots\1-start.png). At the top, in "Game folder",
   you should see the Kenshi folder marked Steam or GOG.

Desktop shortcut: right-click KenshiModEditor.exe → "Send to" → "Desktop (create shortcut)".


STEP 3. IF THE GAME WAS NOT FOUND
---------------------------------
The program looks for Kenshi in Steam and GOG by itself. If you see "Kenshi was not found
automatically", or the folder is wrong:

1. Click "Choose folder…".
2. Pick the game folder — the one with kenshi_x64.exe and the data folder.
   Common places:
     Steam: C:\Program Files (x86)\Steam\steamapps\common\Kenshi
            D:\SteamLibrary\steamapps\common\Kenshi   (Steam library on another drive)
     GOG:   C:\GOG Games\Kenshi
            C:\Program Files (x86)\GOG Galaxy\Games\Kenshi
3. To find it exactly:
     Steam — in the library right-click Kenshi → "Manage" → "Browse local files".
             The right folder opens: copy the path from Explorer's address bar.
     GOG Galaxy — open Kenshi → settings icon next to "Play" → "Manage installation" →
             "Show folder".
4. "No data/gamedata.base in the folder" means a wrong folder (for example data or mods).
   You need the folder one level up.

The program remembers your choice. It only reads the game; it writes into the game folder
only when you save a mod, and only after you confirm.


STEP 4. FIRST STEPS IN THE EDITOR
---------------------------------
EN / RU in the top right corner switches the language.

4.1. Look at the game
  1. On the start screen click "Browse vanilla" — all game data without mods. Opens in a
     second or two.
  2. Left: "Categories" (weapons, characters, factions…), middle: "Records", right:
     "Inspector" with the fields of the selected record.

4.2. Find the katana and where it is in the game (picture screenshots\2-katana-where.png)
  1. Press Ctrl+F (or click the search box above the records) and type "katana".
     English and Russian names both work.
  2. Click "Katana" in the list.
  3. In the inspector open the "Where in game" tab: which traders sell it, in which towns,
     with coordinates. The first time it takes a few seconds — it reads the world map.
     Underlined names are links: a click opens that record.
  4. The ← → buttons on the toolbar go back and forward through opened records.

4.3. Dialogues (picture screenshots\3-dialogues.png)
  1. Menu "Window" (top) → under "Layouts" choose "Dialogues".
     Panels rearrange: records list, dialogue graph, "Line", conversation player.
  2. Search for "Beep" and click the character Beep.
  3. The "Conversation player" at the bottom shows which dialogue the game picks, what Beep
     says and which answers the player sees. Click answers to continue the conversation.
  4. Click the underlined line "Beep!" — the dialogue opens in the graph.
  5. In the graph:
       - right-click a line — menu: edit text, add player answer, add NPC line, link,
         duplicate, delete;
       - right-click an arrow — delete the link or insert a line in between;
       - double-click a line or F2 — edit the text right in the node
         (Enter — save, Esc — cancel);
       - ＋ on a line — new answer; drag from a node's right edge to another — new link;
       - Delete — delete selection, Ctrl+D — duplicate, mouse wheel — zoom;
       - key hints are in the line at the bottom of the graph.
  6. The "Line" panel on the right shows everything about the selected line: speaker, text,
     conditions, effects, what comes next.
  7. Back to the usual view: "Window" → "Layouts" → "Data".

4.4. Undo and history
  - The round ↶ ↷ buttons on the toolbar (or Ctrl+Z / Ctrl+Y) — undo and redo.
    Works on any keyboard layout.
  - The small ▾ next to ↶ — the last steps in plain words ("Added player answer "…"").
    Click a step to go back to it.
  - Full history — "Window" → "Panels" → "History".

4.5. Your own mod: create and save
  1. Go back to the start screen (the ⌂ button top left).
  2. In "New mod file name" type a name in Latin letters, e.g. MyFirstMod, and click
     "New mod".
  3. Change what you want. For example: find the katana → "Duplicate" → change the copy's
     name and damage. Changed fields are highlighted, and "Changes in this mod" in the categories
     shows everything you changed.
  4. Save: Ctrl+S (or the "Save" button). The program suggests:
        <game folder>\mods\MyFirstMod\MyFirstMod.mod
     That is the right place — the game launcher sees mods there. Click "Save".
  5. The program asks "Writing to the game folder" → "Write".
  6. Start Kenshi through its launcher and tick MyFirstMod on the mods tab.
  Other ways:
     - "Browse vanilla" can be edited too: on the first save the program asks where to save
       the new mod;
     - "Save as…" (Ctrl+Shift+S) — save a copy into another file;
     - open an existing mod: start screen → "Installed mods" → "Open", or "Open .mod file…".
  The "Validation" button finds errors in the mod (broken links, empty dialogues) before you play.


STEP 5. CONNECT THE AI (Claude)
-------------------------------
Claude can search the game data, walk through conversations and edit the mod by itself —
you watch and accept or roll back its changes. You need Claude Desktop or Claude Code
(with a Claude account). The editor connects to them as an "MCP server".

5.1. The easiest way
  1. In the editor: menu "Help" → "Connect AI (MCP)…".
  2. The window shows a ready config with your program path already in it.
     Click "Copy for Claude Desktop" or "Copy for Claude Code".
  3. Then follow 5.2 or 5.3, pasting what you copied.

5.2. Claude Desktop
  1. In Claude Desktop: Settings → Developer → Edit Config.
     A folder opens with claude_desktop_config.json
     (usually %APPDATA%\Claude\claude_desktop_config.json). Open it in Notepad.
  2. If the file is empty or only has {} — replace everything with:

{
  "mcpServers": {
    "kenshi": {
      "command": "C:\\KenshiModEditor\\KenshiModEditor.exe",
      "args": ["C:\\KenshiModEditor\\resources\\mcp\\kenshi-mcp.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}

  3. If you unzipped somewhere else than C:\KenshiModEditor — fix the path in two places.
     Inside the quotes every backslash is written TWICE. Example for D:\Games\KenshiModEditor:
        "command": "D:\\Games\\KenshiModEditor\\KenshiModEditor.exe",
        "args": ["D:\\Games\\KenshiModEditor\\resources\\mcp\\kenshi-mcp.mjs"],
  4. If the file already has "mcpServers" with other servers — add only the "kenshi": { … }
     block inside it, with a comma between blocks.
  5. Save the file and restart Claude Desktop COMPLETELY: close the window, then right-click
     the Claude icon in the tray near the clock → Quit, and start it again.
  6. Check: Settings → Developer — kenshi should say running. In a chat, the tools menu
     (the sliders or "+" button) lists kenshi.

5.3. Claude Code
  1. Open a terminal (PowerShell) and run one line (with your path):

  claude mcp add kenshi --scope user -e ELECTRON_RUN_AS_NODE=1 -- "C:\KenshiModEditor\KenshiModEditor.exe" "C:\KenshiModEditor\resources\mcp\kenshi-mcp.mjs"

     Single backslashes here — this is not JSON.
  2. Check: claude mcp list — kenshi should be Connected (✓). Restart Claude Code if it was
     open. Inside Claude Code, /mcp lists kenshi too.

5.4. What to ask the AI (plain text in the chat)
  - "Find the katana and show where it is in the game."
  - "What does Beep say when you talk to him? Walk through the whole conversation."
  - "Which dialogues does the game pick for the bartender, and why?"
  - "Open my mod MyFirstMod and check it for errors."
  - For the AI to edit what is open in your editor window, first say:
    "connect to the open editor". Its changes then arrive in the window as a change set
    ("AI changes" panel, ✦ in the history) — you accept or roll them back.
    You save yourself, Ctrl+S.
  The AI uses the game folder chosen in the editor.


STEP 6. TROUBLESHOOTING
-----------------------
The program does not start or closes at once
  - You run it from inside the zip — unzip first (step 1).
  - An antivirus deleted or blocked a file — restore it from quarantine, add the folder to
    exclusions, or unzip again.
The game is not found — step 3, "Choose folder…".
The mod is not visible in the game
  - The file must be at <game folder>\mods\ModName\ModName.mod.
  - Tick it on the mods tab of the Kenshi launcher.
Claude does not see kenshi
  - Restart Claude completely (Quit from the tray, not just closing the window).
  - Check the path in the config: double \\ in JSON, the folder where you unzipped.
  - Keep "env": { "ELECTRON_RUN_AS_NODE": "1" } — without it the editor window opens instead
    of the server.
  - Claude Desktop logs MCP errors to %APPDATA%\Claude\logs\mcp-server-kenshi.log.
Empty window, freeze or an error
  - Send the log: "Help" → "Open log folder" → file kenshi-mod-editor.log
    (folder %APPDATA%\Kenshi Mod Editor\logs).

What to send with a bug report:
  1. the version — "Help" → "About" (now {VERSION});
  2. the file kenshi-mod-editor.log;
  3. what you did before the error, step by step, and a screenshot (Win+Shift+S);
  4. if the problem is in a mod — the .mod file itself.


KNOWN BETA LIMITATIONS
----------------------
- Windows 10/11 64-bit only.
- The program is not signed — hence the Windows warning.
- Task Manager shows the process as "Electron", the icon is the default one.
- Scene editing (placing things in the world) comes later; the "Scene" layout is empty for now.
- No installer: the program lives in the folder where you unzipped it.

License: MIT (preliminary), see LICENSE.txt.
