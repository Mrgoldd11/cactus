# Where to announce Cactus: platforms (researched 2026-11-07)

Nothing is published. Rules below come from short web research; where a rule could not be
read directly it is marked **unverified**: read the live rules before posting.

| Platform | Format | Rules / risks | Recommendation |
| --- | --- | --- | --- |
| **Steam Community, Kenshi hub: "Kenshi Modding" board** ([discussions/3](https://steamcommunity.com/app/233860/discussions/3/)) | Forum thread, text + images + links | Official forum rules: "Do not spam or self-promote in the forums", but Kenshi-related content may be promoted "in the relevant discussion boards"; "if in doubt ask a moderator". So post only in the Modding board, one thread, no cross-posting to General. | **Yes, post here (main community place).** One thread, honest title, text from `post-steam.md`. |
| **Reddit r/Kenshi** | Text post with screenshots / link | Sidebar rules could not be read (only a third-party cache): **unverified**. General pattern: regulars downvote anything that reads as an advert; new/low-activity accounts get extra scrutiny; removals are silent. | **Yes, after checking the live rules** (About → Rules). Post as a "tool I made" story with screenshots, disclose that you are the author, answer comments. Do not spam other subs; a second post in r/kenshimods-style subs only if one exists and allows tools (**unverified**). |
| **Lo-Fi Games forum (phpBB)**, "Modding" section (f=11, ~680 topics) | Forum topic | Index page shows no self-promotion rules; read the board FAQ / pinned posts first. Old, slow, but modders and the developers read it. | **Yes**, one topic in Modding, text from `post-forum.md`. Register an account first (a few days before). |
| **Nexus Mods, Kenshi** ([nexusmods.com/kenshi](https://www.nexusmods.com/kenshi/mods/)) | Mod page + file upload | Site returned 403 to the fetch tool, so the upload form was not seen. Existing FCS tools there (FCS Extended #1825, FCSMTH #372, Kenshi Patcher #1763, WorkshopMod Folders Renamer #1215) sit in category **Miscellaneous** with tag **"Utilities for Modders"**, so a modding tool is clearly accepted. Nexus requires a description, images, and for tools usually a permissions/credits section. Needs an account; page goes through a short moderation. | **Yes, as a mod page of type tool** (category Miscellaneous, tag Utilities for Modders; **verify on the upload form**). Good for non-Steam (GOG) users and for direct download. Text from `post-nexus.md`; point to GitHub for the latest build. |
| **Kenshi Community Discord** (unofficial, invite via the Lo-Fi forum/Steam threads) | Short message in a modding / media channel | Old posts say there are modding channels and a place for modders to post work; the channel list has changed since (media channel merged with art/advertising). Rules text not found: **unverified**. Politics / religion are off-topic. | **Yes, short message** in the modding or media channel after reading #rules. Text from `post-discord.md`. |
| **Genesis Modding Guild** (Discord, mentioned in Steam Modding board) | Short message | Server for learning to mod and sharing work; rules not read. | **Optional**, same short text, after the main Discord. |
| **ModDB, Kenshi page** | "Add addon / Add file" upload | Tiny Kenshi section (8 mods, 2 addons), last tool uploads are very old. Needs an account. | **Skip for now.** Low audience; possible later for a mirror. |
| **Steam Workshop** | Workshop item | The Workshop is for mods; uploading goes through the FCS, and Cactus cannot publish to the Workshop yet. A standalone editor is not a Workshop item. | **No.** |
| **Kenshi wiki (kenshi.fandom.com / Modifications page)** | Wiki edit | Anyone can edit, but adding your own tool is borderline self-promotion. | **Skip**; let others add it. |

## Suggested order

1. Day 0: GitHub release is live, YouTube video is public, then post on **Steam Modding board** and
   **Lo-Fi forum** (the audience that actually mods), plus **Nexus** page.
2. Same day or next: **r/Kenshi** (after reading the live rules) and **Discord** (short).
3. A week later: a short follow-up on the same Steam thread with fixes from the first feedback
   (bumping your own thread is fine if you actually have news).

## General rules for all posts

- Say clearly that you are the author, that it is a **Beta**, and what does *not* work yet.
- Title describes the thing, not hype: "I made a free editor for Kenshi mods (FCS alternative), looking for testers".
- Always include the GitHub link and the video link; put screenshots inline where the platform allows.
- Do not argue with FCS fans: Cactus reads the same files and complements the FCS.
- Reply to every comment in the first days; collect bugs into GitHub issues (templates are in `.github/ISSUE_TEMPLATE`).
- AI side is standard MCP: say "any MCP client can connect, verified only with Claude"; do not claim tested support for other providers.

## Note on licensing wording (decision 2026-11-07)

Cactus is free proprietary software (freeware, binaries only). The GitHub repo `Mrgoldd11/Cactus`
(unconfirmed) holds only README, logo, screenshots, issue templates and Releases: no source, no
forks. Do not write "open source", "contribute", "PRs welcome" or "fork it" in any post. The in-game
plugin Kenshi Bridge is a separate optional project (GPLv3) and is not part of Beta 0.1.0.
Some communities (Nexus, Reddit) may ask about closed-source tools: answer plainly that it is
freeware, and say what the program reads and writes (only `.mod` files and its own settings).
