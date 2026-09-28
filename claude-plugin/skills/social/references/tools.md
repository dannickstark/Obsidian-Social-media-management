# Social Planner MCP tools

All tools answer with JSON: `ok: true` plus data, or `ok: false` with `error` and, when the plugin found problems, `issues` (`level` error or warning, `field`, `message`, `code?`). Errors must be fixed; warnings are for the user to decide. Times are ISO 8601 with an offset, e.g. `2026-10-08T17:30:00+02:00`. Paths are vault paths as the list tools return them. Channels are ids such as `li/acme-studio`, or `group:<id>` for a channel group. Nothing here ever touches `.obsidian/`: the plugin's own settings (including which channels may publish without asking) are read only.

## Read

### list_channels
The places posts go to: `id`, `platform`, `name`, `method` (`api` posts by itself, `native` is handed to the platform, `assisted` reminds the user to post), usual posting time and reminders; and the channel groups (`group:<id>`). `platform` filters. Never returns credentials.

### list_campaigns
Campaigns by anchor date with post counts and progress. `status`: `active` (default), `archived` or `all`.

### get_campaign
One campaign: fields, `brief` (the note's text), `posts` with per-channel status, and `missing_platforms` (platforms with channels but no post yet). Start here.

### list_posts
Posts filtered by `campaign`, `platform`, `channel`, `status` (per-channel statuses such as `scheduled`, `overdue`, `published`), a range `from`/`to`, or `unscheduled: true`. Pages with `limit` (at most 100) and `next_cursor`.

### get_post
One post: fields, `body` (Markdown; on X, Mastodon and Bluesky a line with only `---` starts the next thread item), `body_hash` (a short hash of the body — pass it back as `update_variant`'s `base_body_hash` when you edit the text, so a change is refused if the note moved on since you read it), per-channel `channels` (status, time, live link, error, `frozen` for an entry the plugin can't read), `issues`, `blocking`, `counters` (length per part against the limit), `thread_items`, `review: "claude"` when written offline.

### get_platform_rules
The limits the plugin checks per platform: characters and how they are counted, fold, title, link, hashtags, media, threads (`a line containing only ---`) and text format. Read before drafting.

### get_log
The last lines of the publish log (`Social/_log.md`): time · channel · post · result · link or error. `limit`, `contains`, `month` (an archive, `YYYY-MM`).

## Write

### create_campaign
`title`, `anchor_date`, `link`, `brief`, `idempotency_key`. Creates `Social/<Title>/<Title>.md` with the brief and the variants table.

### create_variant
`platform`, `campaign` (its path; or leave out and give `title` for a standalone post), `channels`, `body`, `title`, `url`, `media` (vault image names), `mode`, `scheduled_at` (a proposed time only), `reminders`, `wordpress` (`slug`, `excerpt`, `categories`, `tags`, `featured_image`), `force_draft`, `idempotency_key`. Always a draft. Checked first: on a blocking issue nothing is written unless `force_draft`. Unknown or wrong-platform channels always block.

### update_variant
`path` plus any of `title` (`null` removes it), `url` (`null` removes it), `body` (the whole new body), `channels` (the complete new list), `mode`, `reminders`, `stagger_minutes`, `media`, `wordpress`, `force_draft`, `base_body_hash`. Checked first. Channels that were published, handed over or wait for the user stay. `force_draft` is refused on a scheduled post. A channel you *add* here always starts as a draft delivery, even if the rest of the post is already scheduled — call `schedule` again afterwards to plan it (the answer's `note` says so). Editing never changes what is already live: see `push_update`. Pass `base_body_hash` (from `get_post`) whenever you change `body`: if the note's text no longer matches what you read, the edit is refused ("The note changed since you read it; call `get_post` again.") instead of overwriting a concurrent change. **Close to the send time:** when any scheduled channel of the post goes out in less than 10 minutes (its own time, or the post's time plus the stagger; a scheduled time already past counts too), a change to `body`, `title`, `url`, `media`, `mode` or `wordpress` is refused ("This post goes out in less than 10 minutes; unschedule it first or ask the user."), so what goes out is what the user last saw. Reminders, stagger and channels are not affected.

### fork_variant
`path`, `channel`: moves one channel into its own note with a copy of the text, for a page that needs different wording. Refused while that channel is `publishing` or `check_needed` (an in-flight or unresolved send would lose track of its result), and when it is scheduled to go out in less than 10 minutes (same message as `update_variant`).

### validate
Either `path` (an existing post) or `draft` (`platform`, `channels`, `title`, `url`, `body`, `media`, `wordpress`). Returns `issues`, `blocking` and `counters` without writing. Use it before `create_variant`.

### Idempotency keys
`create_campaign` and `create_variant` take an `idempotency_key` (any string, at least 8 characters — a UUID is fine). Use a fresh key per post or campaign and reuse it only to retry that exact call: a retry with the same key and the same arguments returns the first result again (`replayed: true`) instead of creating a second note. **Calling the same key again with different arguments is refused** ("This idempotency_key was already used with different arguments. Use a new key.") — pick a new key instead of changing your mind about a call already in flight.

## Schedule

### schedule
`path`, `at`, `reminders` (minutes before), `move_awaiting`. Makes the post go out at `at` on all its channels (staggered): `at` is the first channel's time, and each channel after it follows the post's stagger (`stagger_minutes`, or the plugin's default). Those later times can't be set one by one through `schedule`; change the stagger with `update_variant`, or `fork_variant` a channel and `schedule` the new note on its own. Refused for a time in the past (`past-time`) or **less than 10 minutes from now** (`too-soon` — this is the only lead time Claude gets before the post goes out unattended; for anything sooner, ask the user whether to `publish_now` instead, which asks them in Obsidian unless the channel is set to publish without asking), for blocking issues, and for channels already handed over to the platform. Channels waiting for the user (`awaiting_you`) are left alone unless you pass `move_awaiting: true`; without it the answer carries `needs_confirmation: "move_awaiting"` — **ask the user before calling schedule again with `move_awaiting: true`.** Scheduling a note that carries `review: "claude"` (written by the skill while Obsidian was closed) also releases it from review, since the plugin has now checked it.

### unschedule
`path`, `to` (`draft` or `ready`). Refused, with nothing written, when any channel is:

- `publishing` — being published right now ("… Try again in a minute.");
- `check_needed` — it may or may not have gone out; the user resolves it in Obsidian (Needs attention);
- `failed` — the user posts it again or fixes it in Obsidian (Needs attention);
- `handed_over` or `published` (or the post is published without delivery records) — already out; "Some channels were already handed over or published…";
- `awaiting_you` — the user is posting it by hand.

The `error` names the reason; ask the user rather than working around it.

## Slots

### find_free_slots
`channels`, `from`, `to` (at most 62 days), `min_spacing_minutes` (default 180), `preferred_windows` (`days` 0 = Sunday … 6 = Saturday, `start`, `end` as HH:mm), `step_minutes`, `per_channel`. Free times per channel, away from everything already planned there, closest to the channel's usual time first. Never proposes a time less than 15 minutes from now: `schedule` needs 10, and the margin leaves time to confirm the plan with the user. Deterministic.

## Publish (asks the user in Obsidian)

Publishing always goes through Obsidian, never straight from Claude. The two publish tools differ in how much say the user's settings have:

- **`publish_now` asks the user in Obsidian by default, unless the channel is on the `publishWithoutAsking` list the user set in Obsidian's settings** — that list is read only from here and can't be changed by any tool. A channel the user is posting by hand (`awaiting_you`) is never sent under that policy; it always waits for them.
- **`push_update` always asks, even for channels on that list**, because it changes something that is already public.

Either way: no answer within 2 minutes counts as a no, only one question is open in Obsidian at a time (a second request while one is pending is refused), and closing Obsidian while a question is open answers no. Approval only covers `publish_now` and `push_update`; a post `schedule` plans goes out at its time without a second question (see `schedule` above).

### publish_now
`path`, `channels` (optional subset), `note` (one sentence for the user, shown in the question). Only when the user asked to publish now. API channels post from the publisher device only ("No device publishes through the API yet…" or "Posts go out through the API only from the publisher device (<name>)…" otherwise); the other channels open the assisted flow in Obsidian for the user to post by hand. If the post changed after it was approved (text, channels or how a channel goes out), nothing is sent: the whole send is refused, and you ask again with the new text. Answers `approved: true` with `started_api` / `opened_assisted`, or `approved: false` with the reason (a timeout, a deny, or another question already open).

### push_update
`path`, `channels`, `note`. Sends the current text to channels where the post is already live (`published` or `handed_over`) and the platform supports updates, after the same approval. A failed send is logged as `update_failed`, never `failed`, so a live post is never shown as failed in the log.

## Voice and notes

### get_voice_profile
The voice profile (`Social/_voice.md`) as text, or `exists: false` with the template and a hint. Read it before drafting.

### add_voice_refinement
`text`, `idempotency_key`. Appends a dated entry under Refinements. Only after the user agreed to the exact text.

### append_to_campaign
`path`, `heading`, `text`, `idempotency_key`. Adds a section at the end of a campaign note, e.g. "Review decisions (2026-10-08)". Never changes existing text.

## Refusal codes

A tool result's top-level `error` is always readable prose; `issues[].code` is the machine-readable reason underneath it, when there is one:

| Code | Where | Meaning |
|---|---|---|
| `unknown-channel` | create_variant, update_variant, validate | A channel id isn't in `list_channels`. |
| `wrong-platform` | create_variant, update_variant, validate | A channel named directly (not through a group) belongs to a different platform. |
| `past-time` | schedule | `at` is not in the future. |
| `too-soon` | schedule | `at` (or a channel's actual send time) is less than 10 minutes from now. |
| `unreadable-delivery` | any tool that checks a post | The note has a delivery entry the plugin can't parse; that channel is frozen until the user fixes it in Obsidian. |
| `already-live` | update_variant | A channel in the edit is already published or handed over; the edit doesn't change what's live there (warning; use `push_update`). |
| `empty-body` | validate, create_variant, update_variant | No text (error, unless the platform needs only media). |
| `too-long` | validate, create_variant, update_variant | The text (or one thread part) is over the platform's character limit. |
| `caption-too-long` | validate, create_variant, update_variant | With media attached, the caption is over the platform's shorter limit. |
| `too-many-hashtags` | validate, create_variant, update_variant | More hashtags than the platform allows. |
| `missing-title` | validate, create_variant, update_variant | The platform requires a title and none was given. |
| `title-too-long` | validate, create_variant, update_variant | The title is over the platform's limit. |
| `missing-url` | validate, create_variant, update_variant | The platform needs a link (or a link or text) and none was given. |
| `unsafe-url` | validate, create_variant, update_variant | `url` isn't http(s). |
| `url-ignored` | validate, create_variant, update_variant | The platform has no use for `url` (warning). |
| `link-in-body` | validate, create_variant, update_variant | A link in the text on a platform that folds reach for it (warning; e.g. LinkedIn). |
| `bluesky-card` | validate, create_variant, update_variant | Both an image and a link card are set; Bluesky shows only one (warning). |
| `media-required` | validate, create_variant, update_variant | The platform needs at least one image and none is attached. |
| `too-many-media` | validate, create_variant, update_variant | More images than the platform allows. |
| `media-ignored` | validate, create_variant, update_variant | The platform doesn't show attached images at all (warning). |
| `media-missing` | validate, create_variant, update_variant | An attached image wasn't found in the vault. |
| `media-type` | validate, create_variant, update_variant | An attachment isn't a PNG, JPG, WebP or GIF. |
| `media-too-large` | validate, create_variant, update_variant | An image is over the platform's size limit. |
| `media-ratio` | validate, create_variant, update_variant | An image's aspect ratio is outside the platform's range. |
| `video-unsupported` | validate, create_variant, update_variant | Video isn't supported yet. |
| `missing-alt` | validate, create_variant, update_variant | An image has no alt text (warning). |
| `missing-slug` | validate, create_variant, update_variant | WordPress needs a slug. |
| `bad-slug` | validate, create_variant, update_variant | The slug isn't lowercase letters, digits and dashes. |
| `missing-featured` | validate, create_variant, update_variant | No WordPress featured image set (warning). |
| `missing-subreddit` | validate, create_variant, update_variant | A Reddit channel's handle isn't a subreddit. |

Refusals without a `code` (the tool's `error` string is the whole story): a post already `publishing` ("This post is being published right now. Try again in a minute."); the note changed since you read it (`base_body_hash` mismatch, or the body moved between the flush and the write); a channel is not a channel of the post (`fork_variant`); a scheduled post can't take `force_draft`; a post that goes out in less than 10 minutes can't have its content changed or a channel forked (`update_variant`, `fork_variant`); an `unschedule` refused for a channel's status (see `unschedule`); nothing left to send because every remaining channel is waiting for the user; a schedule refused because a channel was already handed over to the platform, or because a channel is `awaiting_you` and `move_awaiting` wasn't set (see `needs_confirmation: "move_awaiting"` above); an idempotency key reused with different arguments; the approval timed out, was denied, or another question was already open in Obsidian.
