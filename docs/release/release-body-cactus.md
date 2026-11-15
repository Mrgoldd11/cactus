**First public Beta of Cactus — a free mod editor for Kenshi.**

Download `Cactus-0.1.0-beta-win-x64.zip`, unzip to a simple folder (e.g. `C:\Cactus`), run `Cactus.exe`. Nothing to install. Windows x64, needs an installed copy of Kenshi (Steam/GOG).

### Highlights
- "Where in game": follow back-references from an item to the towns, with coordinates
- Field editing with the vanilla value in view, history in plain words, autosave and safe saving
- Bulk edit with a "was → will be" preview
- Dialogue graph, conversation player and a "Talk" simulator (selection rule taken from the game executable, Kenshi 1.0.65)
- Load order and conflict view, mod merge, translation panel (CSV/PO/JSON)
- AI integration via an MCP server — standard MCP (stdio), so any MCP-capable client can connect; **verified with Claude only**, others untested
- Russian and English interface

### Known limitations (Beta)
- Windows x64 only; zip, no installer; **not code-signed** — SmartScreen will warn ("More info" → "Run anyway")
- Tested mostly with Steam Kenshi 1.0.65 on one machine; GOG less tested
- No Steam Workshop upload yet (use the FCS for that)
- Some FCS features are missing or weaker (cleanup window, configurable columns, notes, spell check, some dialogue templates, region map editor)
- World editing works in the editor but has not been checked in the running game yet
- Some panels are rough; one-person project

**Back up your `.mod` files and work on copies.**

Cactus is free to use but closed source (see LICENSE). Bugs, ideas and compatibility problems: [Issues](https://github.com/Mrgoldd11/Cactus/issues/new/choose).
