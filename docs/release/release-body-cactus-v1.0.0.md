**Cactus v1.0.0 — out of beta. The dialogue editor is rebuilt, own creatures and animals, inside view of buildings.**

Download `Cactus-1.0.0-win-x64.zip`, unzip to a simple folder (e.g. `C:\Cactus`), run `Cactus.exe`. Nothing to install. Windows x64, needs an installed copy of Kenshi (Steam/GOG). Upgrading from 0.2: unzip into a new folder, your settings stay in `%APPDATA%\Cactus`.

### What's new
- **The dialogue editor is rebuilt**: a tree like the FCS (Window → Tree), the graph reads left to right (event → who → dialogue), a line panel with conditions and effects in plain words and the field's description, and **▶ Play** under the graph showing the game's candidates in its own order and why the picked line won.
- **Create → Own creature…**: a new race and animal out of the game's own files (mesh, skeleton, texture), clip and ragdoll check with a playing preview, then race, animal, sale and start in the mod — one undo step. Plus the **Race compatibility** and **Add animations** wizards.
- **Inside view of buildings**: the shell, floors with a cutaway, click a prop in 3D. Plus the **Model panel** (Ogre skeletons, skin weights, clips with playback).
- **Every record says whether it is in the game**; the record list multi-selects (Ctrl/Shift) and bulk-edits the selection; **+ New** knows the category you are in.
- **The game through [Kenshi Bridge](https://github.com/Mrgoldd11/Kenshi-Bridge)**: spawn a character and screenshot the game window from the Game panel and from MCP (`game_spawn`, `game_screenshot`).
- Saving the mod, `mods.cfg` and the settings is atomic: a crash or a full disk never leaves a half-written file.

Full notes with smaller changes, known limitations and upgrade notes: [release-notes-v1.0.0.md](https://github.com/Mrgoldd11/Cactus/blob/main/docs/release-notes-v1.0.0.md)

### Heads-up
- Not code-signed — SmartScreen will warn ("More info" → "Run anyway").
- Workshop publishing: Steam must be running; **before your first real upload, try a Private test item**.

**Back up your `.mod` files and work on copies.**

**Made a mod with Cactus?** If you like, mention "Made with Cactus" in its description — just the name is enough, no link needed. Completely optional, but it helps other modders find the tool.

SHA-256 (`Cactus-1.0.0-win-x64.zip`): `cf2f5815adaf87e4e478bf6c1678b04a1c76e2a6aa36bce781e4e99cfeacd62c`

Cactus is free and open source under the GNU GPLv3 (see LICENSE). Bugs, ideas and compatibility problems: [Issues](https://github.com/Mrgoldd11/Cactus/issues/new/choose).
