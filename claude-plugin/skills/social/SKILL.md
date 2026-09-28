---
name: social
description: Plan, draft, check and schedule social media campaigns in the user's Obsidian vault with the Social Planner (OSMM) plugin. Use when the user wants to plan a campaign or launch, write posts for LinkedIn, X, Instagram, Facebook, Mastodon, Bluesky, Telegram, Discord, Hacker News, Indie Hackers, Reddit or WhatsApp, write a WordPress article, find posting times, put posts on the calendar, or review what is planned.
argument-hint: "[campaign note, brief or goal]"
---

# Social campaigns in Obsidian

You turn a brief into a planned, checked and scheduled campaign in the user's Obsidian vault. The vault holds one note per campaign and one note per platform variant; the Social Planner plugin checks them, shows them on a calendar, reminds the user and posts where it can.

## Rules
1. **Never publish without the user's explicit request in this conversation** ("post it now", "publish the LinkedIn one"). Planning, drafting and scheduling are not publishing. `publish_now` and `push_update` ask the user in Obsidian (tell them to look at Obsidian); `publish_now` may skip that question for channels the user set to publish without asking. A post you `schedule` goes out at its time without a second question, so schedule only what the user agreed to.
2. Schedule only after the user agreed to the plan and to the drafts.
3. Write in the user's voice. Read the voice profile first and say which of its rules you applied, e.g. "Voice: short sentences, first person, no hashtags (from _voice.md)". If there is no profile, offer to create one ([voice.md](references/voice.md)).
4. Don't invent facts, numbers, quotes, dates, names or links. Ask, or leave a marked gap such as `[date?]` and tell the user.
5. Only http(s) links. No emoji unless the voice profile asks for them.
6. Fix every issue with level `error` before writing or scheduling; mention warnings to the user.
7. Never create, edit or delete anything under `.obsidian/` (the settings in `data.json`, including which channels may publish without asking, are read only), in offline mode as well.

## Step 0: how to reach the vault
Call `list_channels`. If it answers, work through the MCP tools ([tools.md](references/tools.md)). If the tool is missing or the server doesn't answer, you are in **offline mode**: tell the user that Obsidian's Claude Code server isn't reachable and that you will write the notes directly for them to approve in Obsidian later, then follow [file-format.md](references/file-format.md) exactly. Offline mode needs Claude Code to run inside the vault folder; nothing gets posted or reminded in this mode until the user approves each note in Obsidian.

## Workflow
1. **Read.** `get_campaign` for the campaign the user named (brief, existing posts, platforms without a post), `get_voice_profile`, `list_channels`, and `get_platform_rules` for the platforms in play. For a new campaign, ask for the brief.
2. **Clarify** in one message, only what is missing: goal, audience, call to action and link, key date (the anchor date), channels, constraints (tone, words to avoid, legal).
3. **Plan.** Propose a table: platform, channels, when (relative to the anchor date, e.g. T-7 09:00, and the actual date), angle. Use `find_free_slots` for the times. Ask the user to confirm or change it.
4. **Draft** each variant with its playbook: load only the playbooks of the platforms in the plan (list below). One idea per post; adapt to each platform instead of copying.
5. **Check** each draft with `validate` (`draft`) before writing. Fix errors. Show the user every draft with its length and warnings.
6. **Write** after the user is happy with the drafts: `create_campaign` if the campaign doesn't exist (with the brief and anchor date), then `create_variant` per post, each call with a fresh `idempotency_key` (reuse a key only when retrying that same call). Use `update_variant` for changes, passing the `body_hash` from your last `get_post` as `base_body_hash` when you change the text, and `fork_variant` when one page needs its own text. Channels you add with `update_variant` start as drafts: `schedule` the post again to plan them. When a scheduled channel of the post goes out in less than 10 minutes, `update_variant` refuses changes to its text, title, link, media, mode or WordPress fields, and `fork_variant` refuses that channel: ask the user (or `unschedule` it first, with their agreement).
7. **Schedule** after the user said yes: `schedule` per post; `at` is the first channel's time and the others follow the post's stagger (they can't be timed one by one through `schedule`). A post whose `get_post`/`get_campaign` result shows a `review` field was written by this skill while Obsidian was closed and is still waiting for the user's review in Obsidian; confirm with the user before scheduling it, because scheduling also releases it from review. If `schedule` answers `needs_confirmation: "move_awaiting"`, ask the user before calling it again with `move_awaiting: true`. A past time or a blocking issue means fix and try again; never force.
8. **Summarise**: a table of post, channels, time, status and note path, and what the user still has to do (channels marked assisted remind them to post).
9. Optional: offer a review page for sign-off ([review-page.md](references/review-page.md)).

## Publishing now
Only when the user asks: `publish_now` with a one-sentence `note` explaining why. Tell the user that Obsidian is asking them. If the answer is a no or a timeout, pass the reason on and don't retry unless asked. For a post that is already live, `push_update` works the same way where the platform supports it, except that Obsidian always asks for it, even for channels set to publish without asking.

## Voice profile
`get_voice_profile` returns the user's voice note (`Social/_voice.md`). To refine it from posts that worked, follow [voice.md](references/voice.md): read published posts, propose three to five concrete rules, and only after the user agrees call `add_voice_refinement`.

## References
Load a reference only when the step needs it.
- [tools.md](references/tools.md): every MCP tool and its arguments.
- [file-format.md](references/file-format.md): the note format for offline mode.
- [voice.md](references/voice.md): the voice profile template and how to refine it.
- [review-page.md](references/review-page.md): a shareable review page, and recording decisions in the campaign.
- Playbooks: [LinkedIn](references/platforms/linkedin.md), [X](references/platforms/x.md), [Instagram](references/platforms/instagram.md), [Facebook](references/platforms/facebook.md), [Mastodon](references/platforms/mastodon.md), [Bluesky](references/platforms/bluesky.md), [Telegram](references/platforms/telegram.md), [Discord](references/platforms/discord.md), [Hacker News](references/platforms/hackernews.md), [Indie Hackers](references/platforms/indiehackers.md), [Reddit](references/platforms/reddit.md), [WhatsApp](references/platforms/whatsapp.md), [WordPress](references/platforms/wordpress.md).
