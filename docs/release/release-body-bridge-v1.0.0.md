**Kenshi Bridge 1.0.0** — an optional, open-source (GPLv3) plugin for [RE_Kenshi](https://github.com/BFrizzleFoShizzle/RE_Kenshi) that lets [Cactus](https://github.com/Mrgoldd11/Cactus) (and its AI tools) see the running game: the selected character and position, which dialogue the game chose and why, the town list with border radii, a dump of the real foliage and buildings for the World view, and (with your confirmation) teleport, camera, speed and pause.

New in this release: **spawn** a character or animal from a record and **screenshot** the game window to PNG — from Cactus's Game panel or from the AI (`game_spawn`, `game_screenshot`), plus coordinates you can copy in Cactus and paste into the Game panel. Checked in the running game with Cactus 1.0.

Cactus works fine without it.

### Install
1. Install RE_Kenshi and start the game through it at least once.
2. Download `KenshiBridge-1.0.0-win-x64.zip` below and copy the `KenshiBridge` folder into `<Kenshi>\mods\`.
3. Enable **KenshiBridge** in the game launcher's Mods tab and start Kenshi through RE_Kenshi. Details are in the README.

### Status
Built for Kenshi 1.0.65, RE_Kenshi 0.3.5, KenshiLib 0.5.0. Checked in the running game: ping, state, teleport, camera, speed, pause, dialogue trace, town list, spawn, screenshot, the Cactus window and its AI tools talking to the Bridge.

The plugin listens on `127.0.0.1` only. It does not change game data (its `.mod` is empty).

SHA-256 (`KenshiBridge-1.0.0-win-x64.zip`): `fcf2269fe27792496887653908b850b9c08969b917602e2010f57a9b8ec3ae5e`
VirusTotal: 0 / 65 detections — https://www.virustotal.com/gui/file/fcf2269fe27792496887653908b850b9c08969b917602e2010f57a9b8ec3ae5e
