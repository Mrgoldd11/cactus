# Cactus: a free mod editor for Kenshi (v0.1.0 Beta, looking for testers)

> Links: GitHub (download, screenshots, bug reports): {GITHUB_URL} (default https://github.com/Mrgoldd11/Cactus, TODO-verify) · Video walkthrough: {YOUTUBE_URL}

I've been modding Kenshi for a while, and at some point I started building my own editor for it.
It is called **Cactus**, it is free (freeware: closed source, binaries only), and today I'm
releasing the first public Beta. This post explains what it is, why I made it, what it can and
cannot do yet, and how you can help by breaking it.

## What Cactus is

Cactus is a desktop editor for Kenshi `.mod` files. It reads the same data the game and the FCS
read (`gamedata.base`, your mods, the load order from `mods.cfg`) and writes standard `.mod`
files back. It does **not** replace the game or touch your saves, and it does not need RE_Kenshi
or any game plugin to work.

It is one core with two ways in: a desktop window (Electron + React) and an MCP server for AI
assistants. Everything you can do by hand can also be done by an AI, and all of it goes through
the same undo/redo. (TODO-verify: a command line tool `kedit` exists internally, but I'm not sure it ships in the Beta zip, so it is not advertised.)

## Why I made it

I wanted three things the FCS doesn't give me:

1. **To see what a record is connected to.** In the FCS I kept asking "where does this actually
   appear in the game?" and "why does this NPC say that?". Answering means clicking through
   references by hand.
2. **Dialogue editing I can follow.** Kenshi dialogue is a graph of lines, conditions and
   priorities, and the rule the game uses to pick one is not obvious. I wanted to see it.
3. **A way to let an AI help without trusting it blindly.** I use Claude a lot, and I wanted its
   edits to appear in my editor as a reviewable change set, not as a mystery file.

The format layer is also strict: reading and writing a file gives back the same bytes. I check
this against the vanilla files and every mod installed on my machine (106 of them at the time of
writing), so a plain open/save does not silently change your mod.

## How it differs from the FCS

Cactus is not "FCS but prettier". The FCS is a complete tool with features Cactus still lacks (see
limitations below). Where Cactus goes further:

- **"Where in the game" tab.** Pick an item and follow the chain of back-references: a katana ←
  a weapon trader's list ← a squad ← the towns that spawn it, with level coordinates. Each step
  is one click. The FCS shows references one level at a time.
- **Dialogue graph.** Lines as nodes, with speaker, text, conditions, actions, priority and
  chance. The graph points out problems (a dialogue with no lines, a line the game can never
  pick). There is a conversation player that walks through a dialogue step by step.
- **"Talk" simulator.** For a character, Cactus lists the dialogues the game considers on a
  click, where each comes from (the character, its package, the squad, the faction), their
  scores, and which one wins and with what probability. The selection rule is taken from the game
  executable (Kenshi 1.0.65) rather than guessed.
- **Conflict view and load order.** See which mods change the same field differently and which
  wins, and reorder `mods.cfg` with a confirmation and a backup copy.
- **Mod merge.** Merge two mods with per-field conflict resolution and a "fix references" step.
  (TODO-verify: decide how strongly to word this; it has had less real-world testing than the rest.)
- **Translation panel.** Translate someone else's mod into your language: the original and your
  text side by side, export to CSV/PO/JSON and back, with changed originals flagged. The
  translation mod only stores the translated strings.
- **History in plain words.** Every step is described and you can jump back to any one.
- **Autosave and backups.** Autosave goes to Cactus's own data folder, never into your mod or
  the game folder, and saving uses a temp file + verification before replacing.
- **Bulk edit with preview.** See "was → will be" before applying a mass change; it is undone in one step.
- **Russian and English** names and UI throughout (I play in Russian, so this was personal).

Opening a mod from the Steam Workshop is read-only; "Copy for editing" makes a copy in `mods/`
and continues there. Writing into the game or Workshop folder always asks first.

## AI integration

Cactus ships an MCP server (stdio, 18+ tools: search, show, tree, references, "where", talk,
play, diff, validate, schema, edit, undo/redo, history, save). You can use it from Claude
Desktop or Claude Code. More interesting is the **live connection**: if Cactus is open, the AI
works on the mod in your window, sees your manual changes, and its edits arrive as a **change
set** in an "AI changes" panel with "Accept" and "Revert" buttons. One Ctrl+Z also undoes it.
Saving stays with you.

Honest status: the server is plain standard MCP over stdio, so any MCP-capable client can
connect (Claude Desktop, Claude Code, and in principle ChatGPT-based tools, Qwen and other
models). I have verified it only with **Claude**; other clients are untested, and I would love
reports. The ready-made setup snippets in the app are Claude-specific for now.

## Status: Beta

This is v0.1.0 Beta. It is stable enough for me to build real mods with it, but it has had one
tester (me) and a few friends. **Back up your `.mod` files, and work on a copy.** Verified on
Kenshi 1.0.65 (Steam) on Windows. Please report anything weird.

## Known limitations

- **Closed source.** Cactus is free to use, but it is distributed as binaries only; the GitHub page has the download, screenshots and the issue tracker, not the code.
- Windows x64 only. It is a zip with an exe, not an installer, and it is not code-signed, so
  Windows SmartScreen will warn you ("More info" → "Run anyway").
- Tested mostly on one machine with Steam Kenshi 1.0.65. GOG detection exists but has had
  less testing.
- World editing (placing, moving and removing objects, building interiors) works in the editor window but has **not been checked in the running game yet**; treat it as experimental.
- No upload to the Steam Workshop yet (use the FCS for that).
- Several FCS features are missing or weaker: an FCS-style "Cleanup" and error-fixing window,
  configurable list columns, notes/to-do on records, spell check, some dialogue-template features,
  a region map editor. (TODO-verify against ROADMAP right before posting; some may have landed.)
- Dialogue lines that use label/word-swap markup are shown as-is.
- It reads your game files from your installed copy. Nothing from the game is bundled.
- UI polish: this is a developer-made tool, some panels are rough.

## Roadmap

Roughly in this order, no promises on dates: remaining FCS features (cleanup, custom columns,
notes), more work on dialogue (templates, interjector/fail nodes), editing the world and a 3D scene
view, the optional in-game plugin ("Kenshi Bridge", a separate open-source RE_Kenshi plugin: it already exists and works in the game, but its link to Cactus is not yet tested with the real game; closed Cactus and open Bridge share no code), Workshop
upload, and **testing and ready-made setup for MCP clients other than Claude**.

## Please test it

If you mod Kenshi, even a little, I'd love for you to try it on one of your mods and tell me
where it breaks. The most useful reports are mods that don't open, values that differ from
the FCS, and anything the game rejects after Cactus saved it.

- Download: {GITHUB_URL}
- Video walkthrough (with a comparison to the FCS and the AI part): {YOUTUBE_URL}
- Report bugs / compatibility problems / ideas: GitHub Issues, there are templates for each.

Thanks for reading, and thanks to everyone who keeps this game alive.
