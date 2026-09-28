# Social Planner (OSMM) for Obsidian

Plan, preview, schedule and post your social media content, for every platform and every page you run, from your vault.

![The planner: month view with the Overdue tray](docs/images/planner.png)

## What it does

- **Plan** campaigns and standalone posts on a calendar (month and week), a pipeline board and a list. Drag to reschedule, or use the context menu (right click, Shift+F10, or a long press on a phone).
- **Write per-platform variants** from one campaign brief. Each variant is a normal note: its frontmatter holds the platform, the channels (profiles, pages, groups, sites), the time and the delivery status per channel.
- **Preview and check** every post the way each platform shows it (stylized, not pixel-perfect): character counts the way the platform counts them, thread splitting, image crops, hashtags, titles and links. Blocking problems stop you from scheduling.
- **Post in one click where there is no API yet:** "Copy & open" opens the platform's compose page, already filled in where the platform allows it, with the text on your clipboard. Paste the live link back and the post is marked published.
- **Never miss or double-post:** reminders before each assisted post (60 and 10 minutes by default), a desktop notification when it is due, an Overdue tray for anything whose time passed while Obsidian was closed, and a scheduler that never posts the same delivery twice and never posts late without asking.

Supported platforms: LinkedIn (profile and pages), X, Instagram, Facebook, Mastodon, Bluesky, Telegram, Discord, Hacker News, Indie Hackers, Reddit, WhatsApp and WordPress. Today every platform posts through the assisted flow; automatic posting through the platforms' APIs is on the roadmap (Telegram, Discord, Mastodon, Bluesky and WordPress first).

![The composer: live preview, channels, checks and schedule](docs/images/composer.png)

## Install

The plugin is not in the community catalogue yet. Install it with BRAT:

1. In Obsidian, install and enable **BRAT** from Community plugins.
2. Run **BRAT: Add a beta plugin for testing** and enter `dannickstark/Obsidian-Social-media-management`.
3. Enable **Social Planner (OSMM)** under Community plugins.

Obsidian 1.11.4 or newer is required. The plugin works on desktop and on phones; reminders on phones arrive with a later version.

## Get started in 10 minutes

Follow [the getting-started guide](docs/getting-started.md): add a channel, write a post, check it, schedule it, and post it with the assisted flow when the reminder comes.

![The assisted publish flow](docs/images/assisted.png)

## Your data

- Posts and campaigns are Markdown notes under `Social/` (configurable). Nothing leaves your vault unless you post it.
- Channels live in the plugin settings. Credentials (for the API posting that comes later) are kept in Obsidian's per-device secret storage, never in your notes or in synced settings.
- Reminders and notification settings are per device.

## Development

Requirements: Node 22+, Obsidian 1.11.4+.

    npm install
    npm run seed          # creates dev-vault/ with sample campaigns (add -- --large for 5,000 notes)
    npm run dev           # builds and copies the plugin into dev-vault/ on every change

Open `dev-vault/` as a vault in Obsidian and enable **Social Planner (OSMM)** under Community plugins.

    npm test              # unit tests (Vitest, TZ=Europe/Berlin)
    npm run typecheck && npm run lint

Design spec: `docs/superpowers/specs/2026-09-27-osmm-social-planner-design.md` · implementation plans: `docs/superpowers/plans/` · manual QA: `docs/qa/`.
