# Cactus screenshots

Real screenshots of Cactus, 1920×1080, in two UI languages with the same file names. 01–08 were taken on 0.1.0 Beta, 09–16 on the packaged 0.2.0 Beta build (`apps/desktop/scripts/release-shots-v02.ts`).

- `en/` — English UI (use these for the public GitHub README and posts).
- `ru/` — Russian UI.
- `zh/` — one shot of the Chinese UI (`17-chinese.png`).

Game record names and descriptions come from the game data itself, so some of them stay Russian even in the English UI. All edits were made in throwaway mods (09–15: a demo mod "Desert Arsenal" in a temporary copy of the game folder; 16–17: an unsaved mod); no game files were touched. Game paths in the window are shown as the default Steam path. `15-publish.png` was taken against a simulated Steam (nothing was uploaded); its preview picture is the "UPDATED" cover variant A.

| File | Caption |
| --- | --- |
| `01-main.png` | Main window: category tree, record list with search, and the field inspector showing a vanilla katana next to its original values. |
| `02-where.png` | "Where in game": the full chain from a record to every place it appears in the world (shops, squads, towns, coordinates). |
| `03-fields.png` | Editing a field: the changed value is highlighted, the vanilla value stays in view, one click reverts it. |
| `04-history.png` | Change history in plain words: every step can be returned to, with undo and redo. |
| `05-bulk.png` | Bulk edit: pick a type and a filter, see a before → after table, apply everything as one undoable change. |
| `06-dialogue.png` | Dialogue graph plus the conversation player: follow what a character says and how the game picks a dialogue. |
| `07-world.png` | World view: the real game map with buildings and town borders, flying to a town in one search. |
| `08-ai.png` | Claude (via MCP) proposes a change set in the editor window; you accept or roll it back. |
| `09-search.png` | Search with conditions (`type=WEAPON; blunt damage multiplier>=0.5`) and the **?** help with the syntax and examples. |
| `10-diagnostics.png` | Diagnostics: a broken reference with one-click fixes (remove the invalid references, delete the record, ignore) and "Fix all". |
| `11-cleanup.png` | Mod cleanup: no-op changes and invalid references, grouped, with the rule of each group and a checkbox per item. |
| `12-merge.png` | Merge mods: a Workshop mod against yours, a conflict on one field with "yours / source" choice. |
| `13-mod-menu.png` | The new **Mod** menu: Mod info, Dependencies, Backups, Publish… |
| `14-window-menu.png` | The **Window** menu in four sections (Data, Dialogues, World, Mod). |
| `15-publish.png` | Publish to the Steam Workshop: title, description, tags, visibility, preview, change note, files and checks. |
| `16-world.png` | World view over the Hub with the game's real foliage from a Kenshi Bridge dump. |
| `zh/17-chinese.png` | Chinese interface (data language English). |

## Order for the v0.2 update

**Steam Workshop** (item 3835566412 → *Add/edit images & videos*; keep the old 01–08 and add these, in this order, from `en/`):
1. `15-publish.png`
2. `10-diagnostics.png`
3. `09-search.png`
4. `11-cleanup.png`
5. `16-world.png`
6. `12-merge.png`
7. `13-mod-menu.png`
8. `zh/17-chinese.png`

`14-window-menu.png` is optional (least interesting).

**GitHub README** (copied to `cactus-public/docs/screenshots/`): the main shot stays `01-main.png`; the "What's new in 0.2" table uses 15, 10, 11, 09, 16, 17 in that order; the old table 02–08 stays.
