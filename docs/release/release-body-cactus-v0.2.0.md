**Cactus v0.2.0 Beta — publish to the Workshop, fix and clean your mod, search with conditions.**

Download `Cactus-0.2.0-beta-win-x64.zip`, unzip to a simple folder (e.g. `C:\Cactus`), run `Cactus.exe`. Nothing to install. Windows x64, needs an installed copy of Kenshi (Steam/GOG). Upgrading from 0.1: unzip into a new folder, your settings stay in `%APPDATA%\Cactus`.

### What's new
- **Publish to the Steam Workshop** from **Mod → Publish…**: new item or update, tags, visibility, preview, change note, checks and a confirm step. Uses the FCS `_<mod>.info` / `_<mod>.img` format, so the FCS and Cactus can update the same item.
- **Diagnostics with one-click fixes**, "Fix all" per kind and an ignore list; new FCS checks (type changed between layers, id taken by another mod, too many references).
- **Mod cleanup**: obsolete fields, no-op changes, orphaned records, invalid references and more, grouped with checkboxes.
- **Search with conditions**: `type=WEAPON; weight kg>10`, `state=mod`, `ref=Katana`, `vendors.weapons:katana`; the **?** button lists the syntax.
- **FCS Extended** schema files (`fcs.def`, `fcs_preload.def`, `*.def.patch`) are applied automatically.
- **World view** with the game's real foliage and buildings (via the optional [Kenshi Bridge](https://github.com/Mrgoldd11/Kenshi-Bridge) plugin), land features and ore deposits.
- **Chinese interface**, and a data language separate from the interface language.

Full notes with smaller changes, known limitations and upgrade notes: [release-notes-v0.2.0-beta.md](https://github.com/Mrgoldd11/Cactus/blob/main/docs/release-notes-v0.2.0-beta.md)

### Heads-up
- **Workshop publishing is unofficial** (Kenshi's app id, like the FCS); tested against a simulated Steam — try a *Private* test item first.
- `type=` in search (and `--field type=…` in the CLI / MCP) now means the record type; quote a real field: `"type"=…`.
- Not code-signed — SmartScreen will warn ("More info" → "Run anyway").

**Back up your `.mod` files and work on copies.**

**Made a mod with Cactus?** If you like, mention "Made with Cactus" in its description — just the name is enough, no link needed. Completely optional, but it helps other modders find the tool.

SHA-256 (`Cactus-0.2.0-beta-win-x64.zip`): `37deee3b50f98e377a8d4792374efa1ed3a538dd9294c534ab0f6be33734d866`
VirusTotal: VIRUSTOTAL_LINK_PLACEHOLDER

Cactus is free to use but closed source (see LICENSE). Bugs, ideas and compatibility problems: [Issues](https://github.com/Mrgoldd11/Cactus/issues/new/choose).
