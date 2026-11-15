**Kenshi Bridge 0.1.0** — an optional, open-source (GPLv3) plugin for [RE_Kenshi](https://github.com/BFrizzleFoShizzle/RE_Kenshi) that lets [Cactus](https://github.com/Mrgoldd11/Cactus) (and its AI tools) see the running game: the selected character and position, which dialogue the game chose and why, the town list with border radii, and (with your confirmation) teleport, camera, speed and pause.

Cactus works fine without it.

### Install
1. Install RE_Kenshi and start the game through it at least once.
2. Download `KenshiBridge-0.1.0-win-x64.zip` below and copy the `KenshiBridge` folder into `<Kenshi>\mods\`.
3. Enable **KenshiBridge** in the game launcher's Mods tab and start Kenshi through RE_Kenshi. Details are in the README.

### Status (Beta)
Built for Kenshi 1.0.65, RE_Kenshi 0.3.5, KenshiLib 0.5.0. Checked in the running game: ping, state, teleport, camera, speed, pause, dialogue trace, town list. **Not yet checked with the real game:** the Cactus window and its AI tools talking to the Bridge (tested against a stand-in server only).

The plugin listens on `127.0.0.1` only. It does not change game data (its `.mod` is empty).
