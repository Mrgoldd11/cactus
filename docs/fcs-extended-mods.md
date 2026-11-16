# Custom types and fields in a mod: making them work in both FCS Extended and Cactus

A short guide for mod authors. If your mod adds new record types or fields to the game (usually
together with an RE_Kenshi plugin), the editor has to be told about them. There is one format —
the one used by [FCS Extended](https://github.com/BFrizzleFoShizzle/FCS_extended). Cactus reads
the same files itself; you do not need to write anything separate for it.

## What to put in the mod folder

Next to `YourMod.mod` (in `mods/YourMod/` or in the workshop folder):

- `fcs.def` — new types, fields, enums and tree categories; read after the game's files;
- `fcs_preload.def` — the same, but read before the game's files (rarely needed);
- `NAME.def.patch` — replacements in the game files `fcs.def`, `fcs_enums.def`,
  `fcs_layout.def` (and in `fcs_preload.def`);
- `FCS_extended.json` — the list of DLL plugins for FCS Extended (`FCS_Plugins`).

Letter case in file names does not matter (`FCS.def` works too).

Cactus applies the extensions of the open mod and of all its dependencies automatically. What
was applied is shown in the **Mod info** window (the **Schema extensions** section) and by the
"extensions: N" badge on the **Mod info** button.

## Example `fcs.def`

```
// enum itemType { VARIABLE=900 }
[VARIABLE]
value: 0 "initial value of the variable"

[FCS_LAYOUT]
Variables: VARIABLE

[DIALOGUE,DIALOGUE_LINE]
variable equals: VARIABLE(0) "checks the value of the variable"
```

## Three rules

1. **Write the number of a new record type in `fcs.def` itself.** Cactus takes it from an
   `enum itemType { NAME=N }` line or from a `// enum itemType { NAME=N }` comment. FCS Extended
   learns the number from your DLL, but Cactus does not run DLLs, so without such a line it shows
   a warning and records of this type are named `TYPE_<number>`. FCS Extended ignores the
   comment, so it suits both editors. The number must match the one in the DLL and must not take
   the numbers of the game's own types.
2. **Give enum values explicit numbers:** `enum MyState { IDLE=0, ANGRY=1 }`. Then the number in
   the mod file does not depend on the order of lines or on which other extensions are loaded.
3. **DLL plugins are not run in Cactus.** Whatever a plugin adds to the FCS interface or logic
   will not appear in Cactus; types, fields, enums and categories from the `.def` files will.
   Cactus lists the DLL names in the **Mod info** window marked "not run in Cactus".

## How to check

Open the mod in Cactus: a record of the new type should have a name (not `TYPE_900`), its fields
should have the descriptions from the quotes, and new reference lists should be on the
**References** tab. If the **Mod info** window shows a "warnings: N" line, expand it — it gives
the file, the line number and what is wrong. Saving the mod does not change the data: fields
Cactus does not know stay in the file as they were.

Details for Cactus developers: [`fcs-extended-plan.md`](fcs-extended-plan.md) (internal notes,
in Russian).
