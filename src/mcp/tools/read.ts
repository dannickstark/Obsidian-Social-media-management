import { normalizePath } from "obsidian";
import { z } from "zod";
import { campaignProgress } from "../../index/queries";
import type { IndexedVariant } from "../../index/socialIndex";
import { bodyOf } from "../../model/body";
import { PLATFORMS } from "../../model/platforms";
import { DELIVERY_STATUSES } from "../../model/schemas";
import { blocking } from "../../platforms/checks";
import { platformDef } from "../../platforms/registry";
import { postItems } from "../../platforms/text";
import { bodyHash, clip, findPost, noPost, normalizePathArg, zPath, zWhen } from "../common";
import type { McpToolDeps } from "../deps";
import { campaignInfo, channelInfo, platformRules, postSummary } from "../present";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

const ROW_STATUSES = [...DELIVERY_STATUSES, "idea"] as const;
const READ = { readOnlyHint: true, openWorldHint: false } as const;

const byTime = (a: IndexedVariant, b: IndexedVariant): number =>
  (a.scheduledAt ?? Number.POSITIVE_INFINITY) - (b.scheduledAt ?? Number.POSITIVE_INFINITY) || a.path.localeCompare(b.path);

export function registerReadTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const stagger = () => deps.settings().defaultStaggerMinutes;
  const nameOf = (id: string) => deps.channels.get(id)?.name ?? id;

  registry.add(
    defineTool({
      name: "list_channels",
      title: "List channels",
      description:
        "The accounts, pages, groups and sites posts can go to: id (such as li/acme-studio), platform, name, publish method (api, native or assisted), usual posting time and default reminders. Also the channel groups; pass group:<id> wherever channels are asked for. Never returns credentials.",
      input: z.object({ platform: z.enum(PLATFORMS).optional() }).strict(),
      annotations: READ,
      run: async ({ platform }) => {
        const list = platform ? deps.channels.byPlatform(platform) : deps.channels.list();
        const channels = list.map((c) => channelInfo(c, c.secretId ? (deps.secrets.has(c.secretId) ? "set" : "missing") : null));
        const groups = deps.channels.groups().map((g) => ({ id: `group:${g.id}`, name: g.name, channel_ids: g.channelIds }));
        return ok({ channels, groups });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "list_campaigns",
      title: "List campaigns",
      description: "Campaign notes, ordered by anchor date (the event or launch date), with how many posts each has and how many deliveries are published.",
      input: z.object({ status: z.enum(["active", "archived", "all"]).default("active") }).strict(),
      annotations: READ,
      run: async ({ status }) => {
        const variants = deps.index.variants();
        const campaigns = deps.index
          .campaigns()
          .filter((c) => status === "all" || c.status === status)
          .sort((a, b) => (a.anchorDate ?? Number.POSITIVE_INFINITY) - (b.anchorDate ?? Number.POSITIVE_INFINITY) || a.path.localeCompare(b.path))
          .map((c) => campaignInfo(c, campaignProgress(variants, c.path), deps.index.variantsOf(c.path).length));
        return ok({ campaigns });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "get_campaign",
      title: "Get a campaign",
      description:
        "One campaign: its fields, the brief (the note's text), every post with per-channel status, and the platforms that have channels but no post in this campaign yet.",
      input: z.object({ path: zPath }).strict(),
      annotations: READ,
      run: async ({ path }) => {
        const c = deps.index.getCampaign(normalizePathArg(path));
        if (!c) return fail(`No campaign note at "${path}". Use list_campaigns to find the path.`);
        const variants = deps.index.variantsOf(c.path).sort(byTime);
        const present = new Set(variants.map((v) => v.platform));
        const configured = new Set(deps.channels.list().map((ch) => ch.platform));
        return ok({
          campaign: campaignInfo(c, campaignProgress(deps.index.variants(), c.path), variants.length),
          brief: clip(bodyOf(await deps.app.vault.cachedRead(c.file)).trim(), 20_000),
          note_issues: c.issues,
          posts: variants.map((v) => postSummary(v, stagger(), nameOf)),
          missing_platforms: PLATFORMS.filter((p) => configured.has(p) && !present.has(p)),
        });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "list_posts",
      title: "List posts",
      description:
        "Posts (platform variants), filtered by campaign, platform, channel, row status or a time range [from, to), ordered by their earliest delivery. Pages with limit and next_cursor. Use get_post for the text.",
      input: z
        .object({
          campaign: zPath.optional().describe("Only the posts of this campaign note"),
          platform: z.enum(PLATFORMS).optional(),
          channel: z.string().trim().max(80).optional().describe("Only posts going to this channel id"),
          status: z.array(z.enum(ROW_STATUSES)).max(12).optional().describe('Per-channel statuses to include, e.g. ["scheduled", "overdue"]'),
          from: zWhen.optional(),
          to: zWhen.optional(),
          unscheduled: z.boolean().optional().describe("Only channels without a time"),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: z
            .string()
            .regex(/^\d{1,6}$/)
            .optional()
            .describe("next_cursor from the previous page"),
        })
        .strict(),
      annotations: READ,
      run: async (a) => {
        if (a.from !== undefined && a.to !== undefined && a.to <= a.from) return fail("to must be after from.");
        const campaign = a.campaign ? normalizePathArg(a.campaign) : undefined;
        if (campaign && !deps.index.getCampaign(campaign)) return fail(`No campaign note at "${a.campaign}". Use list_campaigns to find the path.`);
        const rows = deps.planner.rows().filter((r) => {
          if (campaign && r.variant.campaignPath !== campaign) return false;
          if (a.platform && r.variant.platform !== a.platform) return false;
          if (a.channel && r.channelId !== a.channel) return false;
          if (a.status && !a.status.includes(r.status)) return false;
          if (a.unscheduled && r.at !== undefined) return false;
          if (a.from !== undefined && (r.at === undefined || r.at < a.from)) return false;
          if (a.to !== undefined && (r.at === undefined || r.at >= a.to)) return false;
          return true;
        });
        const first = new Map<string, { v: IndexedVariant; at: number }>();
        for (const r of rows) {
          const at = r.at ?? Number.POSITIVE_INFINITY;
          const seen = first.get(r.variant.path);
          if (!seen || at < seen.at) first.set(r.variant.path, { v: r.variant, at });
        }
        const ordered = [...first.values()].sort((x, y) => x.at - y.at || x.v.path.localeCompare(y.v.path));
        const offset = a.cursor ? Number(a.cursor) : 0;
        const page = ordered.slice(offset, offset + a.limit);
        return ok({
          total: ordered.length,
          posts: page.map(({ v }) => postSummary(v, stagger(), nameOf)),
          next_cursor: offset + a.limit < ordered.length ? String(offset + a.limit) : null,
        });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "get_post",
      title: "Get a post",
      description:
        "One post: fields, body (Markdown; on X, Mastodon and Bluesky a line with only --- starts the next thread item), per-channel status, the plugin's checks (issues, blocking) and the length counters.",
      input: z.object({ path: zPath }).strict(),
      annotations: READ,
      run: async ({ path }) => {
        const v = findPost(deps, path);
        if (!v) return fail(noPost(path));
        const content = await deps.composer.content.load(v);
        const issues = deps.composer.check(v, content);
        const def = platformDef(v.platform);
        const wp = v.wordpress;
        return ok({
          ...postSummary(v, stagger(), nameOf),
          mode: v.mode,
          reminders: v.reminders ?? null,
          stagger_minutes: v.staggerMinutes ?? null,
          url: v.url ?? null,
          media: v.media,
          ...(wp
            ? { wordpress: { slug: wp.slug ?? null, excerpt: wp.excerpt ?? null, categories: wp.categories, tags: wp.tags, featured_image: wp.featuredImage ?? null } }
            : {}),
          body: clip(content.body, 100_000),
          body_hash: bodyHash(content.body),
          thread_items: def.capabilities.threads ? postItems(content.body, def).length : null,
          note_issues: v.issues,
          issues,
          blocking: blocking(issues),
          counters: deps.composer.counters(v, content),
        });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "get_platform_rules",
      title: "Get platform rules",
      description:
        "Limits the plugin checks per platform: characters (and how they are counted), fold, title, link, hashtags, media, threads and the text format. Read before drafting.",
      input: z.object({ platform: z.enum(PLATFORMS).optional() }).strict(),
      annotations: READ,
      run: async ({ platform }) => ok({ rules: (platform ? [platform] : [...PLATFORMS]).map(platformRules) }),
    }),
  );

  registry.add(
    defineTool({
      name: "get_log",
      title: "Read the publish log",
      description: "The last lines of the publish log (Social/_log.md): time · channel · post · result · link or error. month reads an archived month.",
      input: z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          contains: z.string().trim().min(1).max(200).optional().describe("Only lines containing this text (case-insensitive)"),
          month: z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .optional()
            .describe("An archived month, e.g. 2026-09"),
        })
        .strict(),
      annotations: READ,
      run: async (a) => {
        const root = deps.settings().rootFolder;
        const path = normalizePath(a.month ? `${root}/_log/${a.month}.md` : `${root}/_log.md`);
        const file = deps.app.vault.getFileByPath(path);
        if (!file) return ok({ path, total: 0, lines: [] });
        const needle = a.contains?.toLowerCase();
        const lines = (await deps.app.vault.cachedRead(file))
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2))
          .filter((l) => !needle || l.toLowerCase().includes(needle));
        return ok({ path, total: lines.length, lines: lines.slice(-a.limit) });
      },
    }),
  );
}
