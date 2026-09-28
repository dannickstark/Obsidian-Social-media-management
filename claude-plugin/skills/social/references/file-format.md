# Note format for offline mode

Use this only when the Social Planner MCP tools are not available (Obsidian is closed or the server is off). You write Markdown files directly. The plugin checks them the next time Obsidian opens and lists them under **Written by Claude** in its sidebar; nothing you write this way is posted or reminded about until the user approves it there.

## Where things are
- Vault root: the folder that contains `.obsidian/`. Claude Code must run there.
- Settings, read only (never edit): `.obsidian/plugins/osmm-social-planner/data.json`. `rootFolder` is the social folder (default `Social`), `channels` lists the channels (`id`, `platform`, `name`, `method`) and `channelGroups` the groups. It holds no secrets.
- Campaign: `<root>/<Campaign>/<Campaign>.md`.
- Post of a campaign: `<root>/<Campaign>/<Campaign> – <Platform>.md` (space, en dash, space; the platform's label, e.g. `Hacker News`). If the file exists, add ` 2`, ` 3`, …
- Standalone post: `<root>/Posts/<Title>.md`.
- Voice profile: `<root>/_voice.md`. Publish log (read only): `<root>/_log.md`.
- File names: none of `\ / : * ? " < > | # ^ [ ]`, at most 120 characters.

## Rules
1. Every post you write has `status: ready` and `review: claude`. Never write `status: scheduled`, never a `deliveries:` map, and never touch `review` on a note you didn't write.
2. `scheduled_at` is the proposed time, ISO 8601 with the offset: `2026-10-08T17:30:00+02:00`.
3. `channels` is a YAML list of channel ids of the note's platform, from data.json.
4. Don't edit a note that has `deliveries:` (it is already scheduled or published); tell the user what to change instead.
5. Keep within the platform's limits (see the playbooks); the plugin checks again.
6. Tell the user which files you wrote and that they approve them in Obsidian (sidebar, **Written by Claude**, **Approve & schedule**).
7. Never create, edit or delete anything under `.obsidian/` — the settings in `data.json`, including which channels may publish without asking, are read only, in offline mode as well.

## Fields
| Field | Notes |
|---|---|
| `type` | `social-campaign` or `social-post` |
| `campaign` | `"[[<Campaign>]]"` (quoted wikilink); leave out for a standalone post |
| `platform` | `linkedin`, `x`, `instagram`, `facebook`, `mastodon`, `bluesky`, `telegram`, `discord`, `hackernews`, `indiehackers`, `reddit`, `whatsapp`, `wordpress` |
| `title` | required for standalone posts, Hacker News, Reddit, Indie Hackers and WordPress |
| `url` | http(s) link for link submissions and link cards |
| `channels` | list of channel ids, e.g. `[li/acme-studio, li/maker-lab]` |
| `mode` | `auto` (post by API where possible) or `assisted` (always remind) |
| `status` | always `ready` in offline mode |
| `review` | always exactly `claude` in offline mode (any other non-blank value also holds the note, but only `claude` is what this skill writes) |
| `scheduled_at` | proposed time with offset |
| `stagger_minutes` | minutes between channels (optional) |
| `reminders` | minutes before, e.g. `[60, 10]` (optional) |
| `media` | list of quoted wikilinks to vault images, e.g. `["[[event-x-cover.png]]"]` |
| `slug`, `excerpt`, `categories`, `tags`, `featured_image` | WordPress only; `featured_image: "[[cover.png]]"` |

The body is the post. On X, Mastodon and Bluesky, a line with only `---` starts the next post of a thread.

## Campaign

````markdown
---
type: social-campaign
title: Event X
anchor_date: 2026-10-12T18:00:00+02:00
link: https://example.com/event-x
status: active
---

## Brief

A free evening for makers in Berlin, 80 seats. Goal: 60 sign-ups by 10 October.

## Variants

```social-variants
```
````

## LinkedIn post for two company pages

````markdown
---
type: social-post
campaign: "[[Event X]]"
platform: linkedin
channels:
  - li/acme-studio
  - li/maker-lab
mode: auto
status: ready
review: claude
scheduled_at: 2026-10-05T09:00:00+02:00
reminders: [60, 10]
---
I almost didn't host Event X again.

Six months ago twelve makers came to the first one. On the 12th, eighty are coming.

If you build things on your own, come and meet the people who do the same. Free, 18:00, Berlin.
````

## X thread

````markdown
---
type: social-post
campaign: "[[Event X]]"
platform: x
channels: [x/you]
mode: auto
status: ready
review: claude
scheduled_at: 2026-10-06T12:00:00+02:00
---
I almost didn't host Event X again.
---
Six months ago, twelve makers showed up. On the 12th, eighty are coming.
---
Free, 18:00, Berlin. Sign up: https://example.com/event-x
````

## WordPress article

````markdown
---
type: social-post
campaign: "[[Event X]]"
platform: wordpress
title: Event X is back on 12 October
slug: event-x-is-back
excerpt: A free evening for 80 makers in Berlin.
categories: [Community]
tags: [events, makers]
channels: [wp/eventx-berlin]
mode: auto
status: ready
review: claude
scheduled_at: 2026-10-07T08:00:00+02:00
---
# Event X is back

Six months ago, twelve makers met in a back room to show what they were building. On 12 October we do it again, with eighty.

## What happens

- 18:00 doors open
- 18:30 five short demos
- 19:30 open tables
````

## Standalone Mastodon post

````markdown
---
type: social-post
platform: mastodon
title: Weekly devlog 13
channels: [ma/you]
mode: auto
status: ready
review: claude
scheduled_at: 2026-10-09T09:00:00+02:00
---
Devlog 13: the calendar learned to talk to Claude Code.
````
