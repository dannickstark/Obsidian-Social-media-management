# OSMM — Social Planner for Obsidian: Design Spec

- **Date:** 2026-09-27
- **Status:** Approved in brainstorming, pending written-spec review
- **Mockups:** https://claude.ai/artifact/R7UFW9n1yYY66vtntSnr3z (private design canvas, 9 artboards)

## 1. Intent

### 1.1 Problem
The user manages content for several projects across many social platforms, some with more than one account or page per platform (e.g. a LinkedIn profile plus four company pages), and also runs several WordPress sites. Today they draft posts by chatting with Claude Code, then copy and paste each one into each platform by hand. There is no single place to plan, preview, schedule, get reminded or track what went out. The same need shows up in a public Obsidian forum post: one "Event X" note holding the facts, a table to spin off per-platform variants, and publishing through APIs.

### 1.2 Outcome
An Obsidian plugin that turns the vault into a social content command centre:
- plan campaigns and standalone posts on a calendar and a pipeline board;
- write per-platform variants from one campaign brief, with realistic previews and automatic checks;
- auto-publish where an API allows, hand scheduling over to the platform where it supports that (WordPress, Facebook Pages, Mastodon), and otherwise remind the user on desktop and phone with a one-click "open the composer, already filled in" flow;
- let Claude Code plan, draft, schedule and (with approval) publish through a local MCP server plus a `/social` skill;
- generate images with OpenAI when needed.

### 1.3 Success criteria
1. A campaign with 10+ variants across 6+ platforms and several channels can be planned and scheduled without leaving Obsidian.
2. Every scheduled item either publishes automatically or produces a reminder at the configured lead times (default 1 h and 10 min) on the desktop and on the phone.
3. Posting to a platform with no API takes at most three clicks from the reminder.
4. A full campaign can be produced in one Claude Code conversation and appears live in the calendar.
5. Nothing is ever published twice, and nothing is published silently after its time has passed.

### 1.4 Constraints and decisions made during brainstorming
| Decision | Choice |
|---|---|
| Deployment | **Plugin only**: no companion server. Auto-posting happens only while Obsidian runs on the publisher device, except where scheduling is handed to the platform. |
| v1 scope | Planning + previews + assisted posting + phone reminders + auto-posting |
| Platforms | LinkedIn, X, Instagram, Facebook, Mastodon, Bluesky, Telegram, Discord, Hacker News, Indie Hackers, Reddit, WhatsApp, **WordPress** |
| Multiple channels | Several channels per platform (profiles, pages, groups, server channels, sites) |
| Multi-channel storage | **One variant note per platform, many channels**, with delivery status per channel and a "Fork for this page" action |
| Claude Code | **Both** a local MCP server (actions, checks) and a `/social` skill (workflow, voice) |
| Visuals | Attach vault images + OpenAI image generation |
| Users | A single person, one vault, possibly synced across devices |

## 2. Vault data model

The root folder can be configured (default `Social/`).

### 2.1 Campaign note
Path: `Social/<Campaign>/<Campaign>.md` (or anywhere, identified by `type`).
```yaml
---
type: social-campaign
title: Event X
anchor_date: 2026-10-12T18:00:00+02:00   # optional; drives the relative timeline (T-7 … T+1)
link: https://example.com/event-x         # optional canonical link
status: active                            # active | archived
---
Free-form brief…

```social-variants
```
```
The `social-variants` code block renders an interactive table with one row per platform (existing variants and platforms not created yet). Each row shows the channels, the mode, the scheduled time, a length bar, the status, and the actions **Preview**, **Post/Open** (**Post now** or **Open & post** when overdue) and **Create variant**.

### 2.2 Variant note
Path: `Social/<Campaign>/<Campaign> – <Platform>.md`. A standalone post has no `campaign`.
```yaml
---
type: social-post
campaign: "[[Event X]]"
platform: linkedin
channels: [li/me, li/acme-studio, li/maker-lab]
mode: auto                     # auto | assisted (per-channel capability can force assisted)
status: scheduled              # rolled up from the deliveries
scheduled_at: 2026-10-08T17:30:00+02:00
stagger_minutes: 15            # delay between channels
reminders: [60, 10]            # minutes before
media: ["[[event-x-cover.png]]"]
title:                         # HN / Reddit / Indie Hackers / WordPress
url:                           # link submissions
deliveries:
  li/me:          { status: published, at: 2026-10-08T17:30:00+02:00, url: "https://…", remote_id: "…" }
  li/acme-studio: { status: awaiting_you, at: 2026-10-08T17:45:00+02:00 }
---
Post body.
---
Next item of a thread (X / Bluesky / Mastodon only).
```
- Inside the body, a line containing only `---` separates thread items, on platforms that support threads.
- **Fork for this page** moves one channel into a new note (`… – LinkedIn – Acme Studio`) with its own copy of the text, and removes that channel from the original note.

### 2.3 WordPress variant
`platform: wordpress`, and the body is the article. Extra frontmatter: `slug`, `categories`, `tags`, `excerpt`, `featured_image`. On publish, the Markdown (wikilinks, embeds, images) is converted to HTML and local images are uploaded to the site's media library.

### 2.4 Channels
Stored in the plugin settings (synced with the vault). Secrets are kept apart (see 2.6).
```ts
Channel { id: "li/acme-studio"; platform; name; kind: profile|page|group|server_channel|site|account;
          handle; avatarColor; method: api|native|assisted; defaultTime?; defaultReminders? }
ChannelGroup { id; name; channelIds[] }
```

### 2.5 Other vault files
- `Social/_voice.md`: the user's voice profile (tone, dos and don'ts, example posts), read by the `/social` skill.
- `Social/_log.md`: an append-only publish log with one line per attempt: time, channel, result, URL or error.

### 2.6 Secrets
API tokens, page tokens, WordPress application passwords, the ntfy topic and token, and the OpenAI key live in Obsidian's per-device secret storage, with device-local storage as the fallback. They are **never** written to vault files or to synced `data.json`. Each device that publishes must be set up on its own.

## 3. UX (see the mockups)

| # | View | Key elements |
|---|---|---|
| 1 | Calendar (Month / Week) | Chips with platform badge, time and status style (solid = auto, dashed = assisted, orange = overdue, dotted = draft, muted ✓ = published); campaign anchor-day marker; sidebar with **Overdue tray**, *Up next today*, campaigns; "Plan with Claude"; MCP status light |
| 2 | Campaign note | Properties, brief, the `social-variants` table, campaign timeline relative to `anchor_date` |
| 3 | Composer | Markdown editor; live preview on a phone frame with platform tabs; **Post as** channel picker; checks panel; schedule (date, time, best-slot hint, reminder chips); Schedule / Post now / Copy & open composer; Claude quick actions |
| 4 | Pipeline board | Idea → Draft → Ready → Scheduled → Published; dragging a card changes its status |
| 5 | All-platform preview | Every variant of a campaign side by side, with warnings and "Trim with Claude" |
| 6 | Assisted publish | 3-step modal (ready → open pre-filled page with clipboard loaded → paste the live URL to mark published); desktop "In 10 min" notification; overdue banner at startup |
| 7 | Phone (ntfy) | Reminder pushes with Copy & open / Snooze / Done; auto-post confirmations |
| 8 | Channels settings | Grouped by platform, showing method, defaults, token health; channel groups |
| 9 | WordPress composer | Site picker, slug, taxonomies, featured image, site-styled preview, "Scheduled on WordPress" state, Update / Open in WP admin, "Generate social variants from article" |

Platform previews are stylized approximations, not pixel copies of each platform's design.

## 4. Architecture

One TypeScript Obsidian plugin, bundled with esbuild, with the UI in Svelte.

| Module | Responsibility | Depends on |
|---|---|---|
| `model` | Types and schema validation for Campaign, Variant, Channel, Delivery; the delivery state machine; safe frontmatter writes through `processFrontMatter` | — |
| `index` | Live in-memory index of social notes, fed by `metadataCache`; emits change events | model |
| `platforms/<name>` | Limits and `validate()`, preview renderer, adapter | model |
| `publish` | Runs a delivery: native scheduling, API post, or assisted flow; writes results and the log | platforms, secrets |
| `scheduler` | 30 s timer loop, due and overdue detection, startup reconciliation, reminder booking | index, publish, reminders |
| `reminders` | Desktop notifications; ntfy bookings | secrets |
| `views` | Calendar, Board, List, Composer, Preview grid, Channels settings, `social-variants` block | index, platforms |
| `images` | OpenAI image generation into the attachments folder; per-platform crops | secrets |
| `mcp` | Local MCP server for Claude Code (desktop only) | index, model, publish |
| `secrets` | Per-device secret storage | Obsidian API |

### 4.1 Adapter interface
```ts
interface PlatformAdapter {
  capabilities: { api: boolean; nativeSchedule: boolean; threads: boolean; media: MediaRules; limits: Limits }
  validate(variant: Variant, channel: Channel): Issue[]
  publish?(d: Delivery): Promise<{ remoteId: string; url: string }>
  schedule?(d: Delivery): Promise<{ remoteId: string }>   // hand-over to the platform
  update?(d: Delivery): Promise<void>
  cancel?(d: Delivery): Promise<void>
  lookup?(d: Delivery): Promise<RemoteState | null>       // resolves "check needed"
  assistedUrl(d: Delivery): string                        // pre-filled compose / submit URL
}
```
All network calls go through Obsidian's `requestUrl` (no CORS limits). Errors are normalised into `Transient | NeedsUser | InvalidContent`.

### 4.2 Platform matrix (v1 target)
| Platform | Method | Notes |
|---|---|---|
| Telegram channel | API (bot) | |
| Discord | API (webhook) | |
| Mastodon | API + native schedule | `scheduled_at` |
| Bluesky | API | Link cards, 300 characters |
| WordPress | API + native schedule | REST with application password, `status: future` |
| Facebook Page | API + native schedule | Meta app with page tokens |
| Instagram (business) | API | Through the Meta app; image required |
| X | API | Needs the user's own developer app (paid tier possible); assisted fallback |
| LinkedIn profile | API | "Share on LinkedIn" product |
| LinkedIn company pages | Assisted → API | API only after LinkedIn approves Community Management API access |
| Hacker News | Assisted | Pre-filled `submitlink?u=&t=` |
| Reddit | Assisted | Pre-filled submit URL; API could come later |
| Indie Hackers | Assisted | Open the page with the text on the clipboard |
| WhatsApp groups | Assisted | Copy, plus a share link |

### 4.3 Publisher device
Exactly one device is the **publisher**. This is a per-device setting and is never synced. Only the publisher runs deliveries and books ntfy reminders. Other devices show state and fire their own desktop notifications if enabled.

### 4.4 Reminders
- **Desktop:** Electron/system notifications while Obsidian is open, with actions (Open & post, Snooze).
- **Phone:** ntfy (ntfy.sh or self-hosted). Pushes are booked with delayed delivery on a **rolling 72-hour window**, because ntfy.sh holds delayed messages for at most about 3 days. Every run of the publisher device books whatever falls due in the next 72 hours. Each push carries a click action to the pre-filled URL and the note. When something is rescheduled, the plugin cancels the booked push if the ntfy server supports that. Otherwise the stale push is left alone and the new time gets a fresh booking.

## 5. Delivery lifecycle and reliability

```
draft → ready → scheduled ─┬─ native ─→ handed_over ─→ published
                           ├─ api ────→ publishing ──→ published | failed
                           └─ assisted → awaiting_you → published | skipped
             overdue ← due time passed while the publisher device was off
             check_needed ← found in `publishing` at startup
```
1. **No duplicates.** `publishing` and a timestamp are written before the API call. At startup, a delivery found in `publishing` becomes `check_needed`. `lookup()` resolves it where supported; otherwise the user confirms. It is never retried automatically.
2. **No silent late posting.** Past-due items go to the Overdue tray with Post now / Reschedule / Skip. An optional setting auto-posts items that are less than N minutes late (default off, N = 15).
3. **Error classes.** *Transient* errors are retried with back-off (1, 5, 15 min) and then marked `failed`. *NeedsUser* (auth, permissions, rejected content) marks `failed` immediately and sends a notification with a **Fix** action. *InvalidContent* is blocked at schedule time by `validate()`.
4. **Token health.** Channels show token expiry, with a reminder 7 days before.
5. **Edits after hand-over.** The note shows an "Out of sync" badge; the change is pushed only when the user confirms.
6. **Audit.** Every attempt is appended to `Social/_log.md`.

## 6. Claude Code integration

### 6.1 Local MCP server (plugin, desktop only)
- Streamable HTTP on `127.0.0.1:<port>`, with a bearer token generated by the plugin. The settings offer a "Copy Claude Code setup command" button.
- **Read:** `list_channels`, `list_campaigns`, `get_campaign`, `list_posts`, `get_post`, `get_platform_rules`, `get_log`
- **Write:** `create_campaign`, `create_variant`, `update_variant`, `fork_variant`, `schedule`, `unschedule`, `find_free_slots`, `validate`, `generate_image`
- **Publish:** `publish_now`, `push_update`. These need **in-Obsidian approval** by default ("Claude wants to publish X to N channels — Approve / Deny"); a per-channel setting can relax this.
- All writes pass through `model` validation and `validate()`. Issues are returned to Claude in a structured form.

### 6.2 `/social` skill (shipped in this repo as a Claude Code plugin)
- Workflow: read the brief and `_voice.md` → clarify goal and audience → propose a plan table (platforms × channels × timeline) → draft per-platform variants using playbooks → validate → schedule after the user confirms.
- If the MCP server is unreachable, the skill writes notes directly in the documented format. The plugin validates them the next time it opens, and nothing is published in this mode.
- Optional: publishes a campaign review page as a Claude artifact for sharing and sign-off.

### 6.3 Images
`images` calls the OpenAI Images API with the user's key, saves the PNG to the attachments folder, creates per-platform crops, and links the result into `media:`. The same code is used by the composer button and by the MCP `generate_image` tool.

## 7. Testing

- **Unit (Vitest):** model parsing and the state machine; every platform's `validate()` and `assistedUrl()`; thread splitting; Markdown → WordPress HTML.
- **Adapter contract suite:** every adapter runs against mocked `requestUrl` fixtures (success, rate limit, expired token, rejected content, timeout) and must classify errors the same way.
- **Scheduler (fake clock):** due, overdue at startup, stuck `publishing`, non-publisher device staying passive, the 72-hour booking window, stagger between channels.
- **MCP:** every tool runs against an in-memory vault; publish tools stay blocked until approved.
- **UI:** Svelte component tests for composer, previews and calendar.
- **Manual smoke checklist per platform** on test accounts, run before each release.

## 8. Milestones

| # | Milestone | Outcome for the user |
|---|---|---|
| M1 | Model, index, Channels settings, campaign and variant notes, `social-variants` table, Calendar, Board | Plan everything visually |
| M2 | Composer, previews and checks, assisted publish for all platforms, desktop reminders, Overdue tray | One-click posting everywhere |
| M3 | ntfy phone reminders, publisher device, `_log.md` | Phone reminders |
| M4 | MCP server, `/social` skill, voice profile | Campaigns run from Claude Code |
| M5 | Adapters: Telegram, Discord, Mastodon, Bluesky, WordPress (native) | Automation for the easy channels and websites |
| M6 | Adapters: Facebook/Instagram, X, LinkedIn profile (pages after approval); OpenAI images | Automation for the big platforms |

Each milestone gets its own implementation plan.

## 9. Out of scope for v1
Analytics and engagement stats; comment and reply management; team collaboration and approvals by other people; a hosted or server mode (always-on posting with Obsidian closed, beyond native hand-over); post recycling and evergreen queues.

## 10. Open risks
- **Platform API access:** X pricing, Meta app review for anything beyond development mode, and LinkedIn Community Management approval are all outside our control. The mitigation is an assisted fallback on every platform.
- **ntfy limits:** public-server delay caps and rate limits. The mitigation is the rolling window, with self-hosted ntfy as an option.
- **Obsidian secret storage availability** on older app versions; the mitigation is the device-local fallback.
