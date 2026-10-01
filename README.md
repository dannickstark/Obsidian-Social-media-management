# Social Planner (OSMM) for Obsidian

Plan, preview, schedule and post your social media content, for every platform and every page you run, from your vault.

<!-- ![The planner: month view with the Overdue tray](docs/images/planner.png) (screenshot pending: see docs/qa/m2b.md) -->

## What it does

- **Plan** campaigns and standalone posts on a calendar (month and week), a pipeline board and a list. Drag to reschedule, or use the context menu (right click, Shift+F10, or a long press on a phone).
- **Write per-platform variants** from one campaign brief. Each variant is a normal note: its frontmatter holds the platform, the channels (profiles, pages, groups, sites), the time and the delivery status per channel.
- **Preview and check** every post the way each platform shows it (stylized, not pixel-perfect): character counts the way the platform counts them, thread splitting, image crops, hashtags, titles and links. Blocking problems stop you from scheduling.
- **Post in one click where there is no API yet:** "Copy & open" opens the platform's compose page, already filled in where the platform allows it, with the text on your clipboard. Paste the live link back and the post is marked published.
- **Post automatically** to Telegram channels, Discord server channels (webhooks), Mastodon, Bluesky and WordPress sites from the publisher device, with images, alt text, threads and link cards. Mastodon and WordPress posts can be **handed over** to the platform's own scheduler, so they go out on time even with Obsidian closed; edit one afterwards and it shows **Out of sync** until you push the update. A post whose outcome is unknown is not sent again automatically: the plugin asks the platform where it can, or asks you.
- **Don't miss a post, and guard against double posts:** reminders before each assisted post (60 and 10 minutes by default) on the desktop and, through the free ntfy app, on your phone even when the computer is asleep; an Overdue tray for anything whose time passed while Obsidian was closed; one publisher device, so a vault synced to several devices has a single device that posts; a scheduler that never retries a post whose outcome is unknown and never posts late without asking; and a publish log in `Social/_log.md`.
- **Plan with Claude Code:** a local MCP server (desktop, off by default) lets Claude Code read your plan, draft posts in your voice, check them with the plugin's own rules, find free posting times and schedule them. It never publishes on its own: when Claude posts now (`publish_now`) or edits a live post (`push_update`), Obsidian asks you first (you can let a channel skip that question for posting now); a post Claude schedules goes out at its time without a second question. The `/osmm:social` skill (a Claude Code plugin in this repo) turns one conversation into a scheduled campaign, and still works when Obsidian is closed by writing notes you approve later.

Supported platforms: LinkedIn (profile and pages), X, Instagram, Facebook, Mastodon, Bluesky, Telegram, Discord, Hacker News, Indie Hackers, Reddit, WhatsApp and WordPress. Telegram, Discord, Mastodon, Bluesky and WordPress post through their APIs; the others use the assisted flow for now (Facebook, Instagram, X and LinkedIn are next).

<!-- ![The composer: live preview, channels, checks and schedule](docs/images/composer.png) (screenshot pending: see docs/qa/m2b.md) -->

## Install

The plugin is not in the community catalogue yet. Install it with BRAT:

1. In Obsidian, install and enable **BRAT** from Community plugins.
2. Run **BRAT: Add a beta plugin for testing** and enter `dannickstark/Obsidian-Social-media-management`.
3. Enable **Social Planner (OSMM)** under Community plugins.

Obsidian 1.11.4 or newer is required. The plugin works on desktop and on phones (iOS and Android); phone reminders use the free ntfy app. If your vault syncs to several devices, update the plugin on every device before you choose the publisher device: a device still on an older version keeps posting on its own.

## Get started in 10 minutes

Follow [the getting-started guide](docs/getting-started.md): add a channel, write a post, check it, schedule it, and post it with the assisted flow when the reminder comes.

<!-- ![The assisted publish flow](docs/images/assisted.png) (screenshot pending: see docs/qa/m2b.md) -->

## Claude Code

1. In Obsidian: **Settings → Social Planner → Claude Code**, turn on **MCP server on this device**, click **Copy setup command** and run it in a terminal. The command has the form `claude mcp add --transport http --scope user osmm http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`. `claude mcp list` should show `osmm` as connected. After **New token** or a port change, run `claude mcp remove --scope user osmm` first, then copy and run the new setup command.
2. Install the skill: `claude plugin marketplace add dannickstark/Obsidian-Social-media-management`, then `claude plugin install osmm@osmm-social-planner`.
3. In Claude Code: `/osmm:social plan the launch of <your product> on LinkedIn, X and Mastodon for next week`.

Optional: run **Create voice profile** in Obsidian and fill in `Social/_voice.md`; Claude reads it before drafting. See [the getting-started guide](docs/getting-started.md#8-plan-a-campaign-with-claude-code-5-minutes-optional).

## Your data

- Posts and campaigns are Markdown notes under `Social/` (configurable). Nothing leaves your vault unless you post it.
- Channels live in the plugin settings. Credentials, the ntfy topic and the ntfy token are kept in Obsidian's per-device secret storage, never in your notes or in synced settings.
- API credentials (bot tokens, webhook URLs, access tokens, app passwords and WordPress application passwords) stay in each device's secret storage; set them up on the publisher device. Bluesky sessions are kept in memory only. Posts, images and link-card requests go straight from your device to each platform; there is no server in between.
- Every publish attempt is appended to `Social/_log.md` (earlier months move to `Social/_log/`). Secrets are never written there.
- Reminders, notification settings, the device name and the phone-reminder setup are per device. The synced settings only record which device publishes (its id and name).
- Phone reminders go through an ntfy server and carry the post's title, platform and text (the tap link opens the compose page with the text filled in), plus the vault name and the note's path (in the links that open Obsidian). On the public ntfy.sh server anyone who knows the topic can read them: keep the random topic private, or run your own ntfy server with an access token over https.
- The Claude Code server listens on 127.0.0.1 only and refuses requests from web pages. The setup command you copy from Obsidian contains the access token in the clear, and running it stores that token in Claude Code's own configuration and possibly your shell history, so don't share the command. Claude sees your posts, campaigns, channel names and the publish log, never credentials. An Obsidian approval covers `publish_now` (post now) and `push_update` (edit a live post); a channel can be allowed to skip that question for `publish_now` only, `push_update` always asks, and a post Claude schedules goes out at its time without a second question.

## Development

Requirements: Node 22+, Obsidian 1.11.4+.

    npm install
    npm run seed          # creates dev-vault/ with sample campaigns (add -- --large for 5,000 notes)
    npm run dev           # builds and copies the plugin into dev-vault/ on every change

Open `dev-vault/` as a vault in Obsidian and enable **Social Planner (OSMM)** under Community plugins.

    npm test              # unit tests (Vitest, TZ=Europe/Berlin)
    npm run typecheck && npm run lint

Design spec: `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` · implementation plans: `docs/superpowers/plans/` · manual QA: `docs/qa/`.
