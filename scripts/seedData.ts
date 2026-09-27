import { DAY, HOUR, formatDateTime } from "../src/model/dates";

export interface SeedNote {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

const ch = (id: string, platform: string, name: string, kind: string, avatarColor: string, method: string) => ({ id, platform, name, kind, avatarColor, method });

const CHANNELS = [
  ch("li/me", "linkedin", "Me", "profile", "#c9c3b8", "api"),
  ch("li/acme-studio", "linkedin", "Acme Studio", "page", "#6ea3e6", "assisted"),
  ch("li/maker-lab", "linkedin", "Maker Lab", "page", "#6fc4ae", "assisted"),
  ch("li/osmm", "linkedin", "OSMM", "page", "#9d8cf5", "assisted"),
  ch("li/event-x-berlin", "linkedin", "Event X Berlin", "page", "#f29a5c", "assisted"),
  ch("fb/event-x-berlin", "facebook", "Event X Berlin", "page", "#8aa3f0", "native"),
  ch("ig/acmestudio", "instagram", "@acmestudio", "account", "#e38bb4", "api"),
  ch("x/you", "x", "@you", "profile", "#e6e4df", "api"),
  ch("ma/you", "mastodon", "@you@mastodon.social", "profile", "#a99bf6", "native"),
  ch("bs/you", "bluesky", "@you.bsky.social", "profile", "#68b9f2", "api"),
  ch("tg/event-x", "telegram", "Event X channel", "page", "#5cc6d6", "api"),
  ch("dc/maker-lab", "discord", "Maker Lab #announcements", "server_channel", "#a0a7f3", "api"),
  ch("hn/you", "hackernews", "HN", "account", "#f29a5c", "assisted"),
  ch("ih/you", "indiehackers", "Indie Hackers", "account", "#6fc4ae", "assisted"),
  ch("wa/makers-berlin", "whatsapp", "Makers Berlin", "group", "#7fd39a", "assisted"),
  ch("wp/eventx-berlin", "wordpress", "eventx.berlin", "site", "#f29a5c", "native"),
];

const GROUPS = [
  { id: "all-linkedin-pages", name: "All LinkedIn pages", channelIds: ["li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"] },
];

export function buildSeed(now: number, opts: { large?: boolean } = {}): { notes: SeedNote[]; settings: Record<string, unknown> } {
  const day = (d: number, h: number, m = 0) => {
    const base = new Date(now);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, h, m).getTime();
  };
  const iso = formatDateTime;
  const notes: SeedNote[] = [];
  const campaign = (folder: string, title: string, extra: Record<string, unknown> = {}) =>
    notes.push({ path: `Social/${folder}/${title}.md`, frontmatter: { type: "social-campaign", title, status: "active", ...extra }, body: "\n## Brief\n\n[FILL IN]\n\n```social-variants\n```\n" });
  const post = (path: string, fm: Record<string, unknown>, body: string) =>
    notes.push({ path, frontmatter: { type: "social-post", mode: "auto", ...fm }, body });

  campaign("Event X", "Event X", { anchor_date: iso(day(4, 18)), link: "https://example.com/event-x" });
  const ex = (p: string) => `Social/Event X/Event X – ${p}.md`;
  post(ex("LinkedIn"), {
    campaign: "[[Event X]]", platform: "linkedin", status: "partial",
    channels: ["li/me", "li/acme-studio", "li/maker-lab"], scheduled_at: iso(day(0, 17, 30)), stagger_minutes: 15, reminders: [60, 10],
    deliveries: { "li/me": { status: "published", at: iso(day(-3, 9)), url: "https://www.linkedin.com/feed/update/urn:li:activity:1" }, "li/acme-studio": { status: "awaiting_you", at: iso(day(0, 17, 45)) }, "li/maker-lab": { status: "scheduled", at: iso(day(0, 18)) } },
  }, "I almost didn't host Event X.\n\nSix months ago I was shipping alone…\n");
  post(ex("X"), { campaign: "[[Event X]]", platform: "x", status: "scheduled", channels: ["x/you"], scheduled_at: iso(day(1, 9)), deliveries: { "x/you": { status: "scheduled" } } }, "I almost didn't host Event X.\n---\nOne evening, twelve makers…\n---\nRSVP → example.com/event-x\n");
  post(ex("Instagram"), { campaign: "[[Event X]]", platform: "instagram", status: "overdue", channels: ["ig/acmestudio"], scheduled_at: iso(day(-2, 18)), media: ["[[event-x-cover.png]]"], deliveries: { "ig/acmestudio": { status: "overdue" } } }, "One evening. Eighty makers. Laptops open.\n");
  post(ex("Hacker News"), { campaign: "[[Event X]]", platform: "hackernews", mode: "assisted", status: "scheduled", title: "Show HN: Event X – a monthly evening for makers", url: "https://example.com/event-x", channels: ["hn/you"], scheduled_at: iso(day(-1, 15)), deliveries: { "hn/you": { status: "scheduled" } } }, "");
  post(ex("Bluesky"), { campaign: "[[Event X]]", platform: "bluesky", status: "scheduled", channels: ["bs/you"], scheduled_at: iso(day(0, 11)), deliveries: { "bs/you": { status: "scheduled" } } }, "Event X is back on the 12th — one evening, 80 makers.\n");
  post(ex("Telegram"), { campaign: "[[Event X]]", platform: "telegram", status: "attention", channels: ["tg/event-x"], scheduled_at: iso(day(0, 12)), deliveries: { "tg/event-x": { status: "failed", error: "Bot is not an admin of the channel" } } }, "**Event X — 18:00**\n80 seats · free\n");
  post(ex("Discord"), { campaign: "[[Event X]]", platform: "discord", status: "scheduled", channels: ["dc/maker-lab"], scheduled_at: iso(day(2, 19)), deliveries: { "dc/maker-lab": { status: "scheduled" } } }, "@everyone Event X is on!\n");
  post(ex("WordPress"), { campaign: "[[Event X]]", platform: "wordpress", status: "scheduled", title: "We're hosting Event X again", channels: ["wp/eventx-berlin"], scheduled_at: iso(day(-2, 8)), slug: "hosting-event-x-again", categories: ["Community"], tags: ["events"], deliveries: { "wp/eventx-berlin": { status: "handed_over", at: iso(day(-2, 8)), remote_id: "412" } } }, "# We're hosting Event X again\n\nSix months ago…\n");
  post(ex("LinkedIn recap"), { campaign: "[[Event X]]", platform: "linkedin", status: "draft", channels: ["li/me"], scheduled_at: iso(day(6, 9)) }, "Event X recap: what 80 makers shipped.\n");

  campaign("OSMM launch", "OSMM launch", { anchor_date: iso(day(14, 9)) });
  post("Social/OSMM launch/OSMM launch – Hacker News.md", { campaign: "[[OSMM launch]]", platform: "hackernews", mode: "assisted", status: "idea", title: "Show HN: OSMM – plan social posts in Obsidian", channels: ["hn/you"] }, "");
  post("Social/OSMM launch/OSMM launch – Indie Hackers.md", { campaign: "[[OSMM launch]]", platform: "indiehackers", mode: "assisted", status: "ready", channels: ["ih/you"] }, "Building OSMM in public.\n");

  post("Social/Posts/Weekly devlog 12.md", { platform: "mastodon", title: "Weekly devlog #12", status: "published", channels: ["ma/you"], scheduled_at: iso(day(-8, 9)), deliveries: { "ma/you": { status: "published", url: "https://mastodon.social/@you/1" } } }, "Devlog #12: calendar view landed.\n");
  post("Social/Posts/WhatsApp reminder.md", { platform: "whatsapp", mode: "assisted", title: "WhatsApp reminder", status: "draft", channels: ["wa/makers-berlin"] }, "*Event X · 18:00* RSVP: example.com/event-x\n");

  if (opts.large) {
    const platforms: Array<[string, string]> = [["linkedin", "li/me"], ["x", "x/you"], ["instagram", "ig/acmestudio"], ["facebook", "fb/event-x-berlin"], ["mastodon", "ma/you"], ["bluesky", "bs/you"], ["telegram", "tg/event-x"], ["discord", "dc/maker-lab"], ["hackernews", "hn/you"]];
    for (let c = 0; c < 500; c++) {
      const title = `Bulk ${c}`;
      campaign(`Bulk/${title}`, title);
      platforms.forEach(([platform, channel], i) =>
        post(`Social/Bulk/${title}/${title} – ${platform}.md`, { campaign: `[[${title}]]`, platform, status: "draft", channels: [channel], scheduled_at: iso(now + ((c * 9 + i) % 90) * DAY + i * HOUR) }, `Bulk post ${c}/${i}\n`),
      );
    }
  }

  return { notes, settings: { schemaVersion: 1, rootFolder: "Social", channels: CHANNELS, channelGroups: GROUPS } };
}
