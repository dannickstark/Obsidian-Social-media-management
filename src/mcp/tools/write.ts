import { z } from "zod";
import { GROUP_PREFIX } from "../../channels/registry";
import { planSetChannels } from "../../composer/channels";
import { channelRowStatus, type RowStatus } from "../../index/queries";
import type { VariantPatch } from "../../model/frontmatter";
import { PLATFORM_META, PLATFORMS, type Platform } from "../../model/platforms";
import { POST_MODES, zMinutesList } from "../../model/schemas";
import type { Channel, Issue, Variant, WordPressFields } from "../../model/types";
import { blocking } from "../../platforms/checks";
import { claudeNotice, findPost, noPost, normalizePathArg, untilIndexed, zChannelsArg, zHttpUrl, zKey, zPath, zWhen } from "../common";
import type { McpToolDeps } from "../deps";
import { IdempotencyCache } from "../idempotency";
import { defineTool, fail, ok, type ToolRegistry } from "../tools";

export const BLOCKED = "Blocking issues, so nothing was written. Fix them, or pass force_draft: true to save the post as a draft anyway.";
const PENDING = new Set<RowStatus>(["scheduled", "awaiting_you", "handed_over", "overdue"]);
const LIVE = new Set<string>(["published", "handed_over"]);

const zBody = z.string().max(100_000).describe("Markdown. On X, Mastodon and Bluesky a line with only --- starts the next thread item.");
const zMedia = z.array(z.string().trim().min(1).max(300)).max(20).describe('Vault images by file name or path, e.g. "event-x-cover.png"');
const zWordPress = z
  .object({
    slug: z.string().trim().max(200).optional(),
    excerpt: z.string().trim().max(1_000).optional(),
    categories: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    featured_image: z.string().trim().max(300).optional().describe("A vault image, e.g. event-x-cover.png"),
  })
  .strict()
  .describe("WordPress only: slug, excerpt, categories, tags and featured image");
type WordPressInput = z.infer<typeof zWordPress>;

/** Channel ids (or group:<id>) → channels of `platform`; unknown or foreign ids become blocking issues. */
export function resolveChannels(deps: Pick<McpToolDeps, "channels">, ids: readonly string[], platform: Platform): { channels: Channel[]; issues: Issue[] } {
  const channels: Channel[] = [];
  const issues: Issue[] = [];
  for (const raw of ids) {
    const expanded = deps.channels.expand([raw]);
    if (!expanded.length) {
      issues.push({ level: "error", field: "channels", code: "unknown-channel", message: `Unknown channel ${raw}. Use list_channels.` });
      continue;
    }
    for (const id of expanded) {
      const channel = deps.channels.get(id);
      if (!channel) continue;
      if (channel.platform !== platform) {
        // A group may mix platforms; only a channel named directly is a mistake.
        if (!raw.startsWith(GROUP_PREFIX)) issues.push({ level: "error", field: "channels", code: "wrong-platform", message: `${id} is not a ${PLATFORM_META[platform].label} channel.` });
        continue;
      }
      if (!channels.includes(channel)) channels.push(channel);
    }
  }
  return { channels, issues };
}

/** Frontmatter keys for the WordPress fields that were passed ("" removes a key). */
export function wordpressFields(wp: WordPressInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (wp.slug !== undefined) out.slug = wp.slug || undefined;
  if (wp.excerpt !== undefined) out.excerpt = wp.excerpt || undefined;
  if (wp.categories) out.categories = wp.categories;
  if (wp.tags) out.tags = wp.tags;
  if (wp.featured_image !== undefined) out.featured_image = wp.featured_image ? `[[${wp.featured_image}]]` : undefined;
  return out;
}

function mergeWordPress(current: WordPressFields | undefined, wp: WordPressInput | undefined): WordPressFields {
  return {
    slug: wp?.slug !== undefined ? wp.slug || undefined : current?.slug,
    excerpt: wp?.excerpt !== undefined ? wp.excerpt || undefined : current?.excerpt,
    categories: wp?.categories ?? current?.categories ?? [],
    tags: wp?.tags ?? current?.tags ?? [],
    featuredImage: wp?.featured_image !== undefined ? wp.featured_image || undefined : current?.featuredImage,
  };
}

/** A post with deliveries still to happen (or waiting on the user) can't hold blocking issues. */
export function pendingDeliveries(v: Pick<Variant, "channels" | "deliveries" | "status" | "scheduledAt">): boolean {
  if (!v.channels.length) return v.status === "scheduled";
  return v.channels.some((id) => PENDING.has(channelRowStatus(v, id)));
}

async function draftIssues(deps: McpToolDeps, variant: Variant, body: string): Promise<Issue[]> {
  const media = await deps.composer.media.inspect(variant);
  return deps.composer.check(variant, { body, media });
}

export function registerWriteTools(registry: ToolRegistry, deps: McpToolDeps): void {
  const idem = new IdempotencyCache(() => deps.now());
  const nameOf = (id: string) => deps.channels.get(id)?.name ?? id;
  const exists = (o: { ok: boolean; data?: Record<string, unknown> }) => !o.ok || !!deps.app.vault.getFileByPath(String(o.data?.path));

  registry.add(
    defineTool({
      name: "create_campaign",
      title: "Create a campaign",
      description:
        "Creates a campaign note (Social/<Title>/<Title>.md) holding the brief and the variants table. anchor_date is the event or launch date the timeline counts from. Pass idempotency_key so a retry never creates a second note.",
      input: z
        .object({
          title: z.string().trim().min(1).max(120),
          anchor_date: zWhen.optional(),
          link: zHttpUrl.optional().describe("The canonical link of the campaign"),
          brief: z.string().max(20_000).optional().describe("Goal, audience, key facts, call to action"),
          idempotency_key: zKey,
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: (a) =>
        idem.run(
          "create_campaign",
          a.idempotency_key,
          async () => {
            const file = await deps.factory.createCampaign({ title: a.title, anchorDate: a.anchor_date, link: a.link, brief: a.brief });
            await untilIndexed(deps.index, () => !!deps.index.getCampaign(file.path));
            claudeNotice(deps, `Claude created the campaign ${a.title}.`, file.path);
            return ok({ path: file.path });
          },
          exists,
        ),
    }),
  );

  registry.add(
    defineTool({
      name: "create_variant",
      title: "Create a post",
      description:
        "Creates one platform variant as a draft: in a campaign (campaign = its note path) or standalone (title required). The text is checked first; on a blocking issue nothing is written unless force_draft. scheduled_at only proposes a time: call schedule to make it go out. Pass idempotency_key so a retry never creates a second note.",
      input: z
        .object({
          platform: z.enum(PLATFORMS),
          campaign: zPath.optional().describe("Path of the campaign note; leave out for a standalone post"),
          title: z.string().trim().min(1).max(300).optional().describe("Required for standalone posts, Hacker News, Reddit, Indie Hackers and WordPress"),
          channels: zChannelsArg.optional(),
          body: zBody.optional(),
          url: zHttpUrl.optional().describe("Link submissions (Hacker News, Reddit) and link cards"),
          media: zMedia.optional(),
          mode: z.enum(POST_MODES).optional().describe("auto posts by API where possible; assisted always reminds the user to post"),
          scheduled_at: zWhen.optional().describe("A proposed time; the post stays a draft until schedule is called"),
          reminders: zMinutesList.optional().describe("Minutes before the post, e.g. [60, 10]"),
          wordpress: zWordPress.optional(),
          force_draft: z.boolean().optional(),
          idempotency_key: zKey,
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: (a) =>
        idem.run(
          "create_variant",
          a.idempotency_key,
          async () => {
            if (a.wordpress && a.platform !== "wordpress") return fail("wordpress fields are only for platform wordpress.");
            const campaign = a.campaign ? deps.index.getCampaign(normalizePathArg(a.campaign)) : undefined;
            if (a.campaign && !campaign) return fail(`No campaign note at "${a.campaign}". Use list_campaigns to find the path.`);
            const title = a.title?.trim() || undefined;
            if (!campaign && !title) return fail("A post outside a campaign needs a title.");
            const resolved = resolveChannels(deps, a.channels ?? [], a.platform);
            if (blocking(resolved.issues)) return fail("Unknown or wrong channels, so nothing was written.", resolved.issues);
            const variant: Variant = {
              path: campaign?.path ?? `${deps.settings().rootFolder}/Posts/${title}.md`,
              platform: a.platform,
              channels: resolved.channels.map((c) => c.id),
              mode: a.mode ?? "auto",
              status: "draft",
              media: a.media ?? [],
              deliveries: {},
              ...(title ? { title } : {}),
              ...(a.url ? { url: a.url } : {}),
              ...(a.scheduled_at !== undefined ? { scheduledAt: a.scheduled_at } : {}),
              ...(a.reminders ? { reminders: a.reminders } : {}),
              ...(a.platform === "wordpress" ? { wordpress: mergeWordPress(undefined, a.wordpress) } : {}),
            };
            const body = a.body ?? "";
            const issues = await draftIssues(deps, variant, body);
            if (blocking(issues) && !a.force_draft) return fail(BLOCKED, issues);
            const file = await deps.factory.createVariant({ platform: a.platform, campaign: campaign?.file, title, channels: variant.channels, body, scheduledAt: a.scheduled_at });
            const patch: VariantPatch = {};
            if (a.url) patch.url = a.url;
            if (a.media?.length) patch.media = a.media;
            if (a.reminders) patch.reminders = a.reminders;
            if (a.mode) patch.mode = a.mode;
            if (Object.keys(patch).length) await deps.writer.patchVariant(file, patch);
            if (a.wordpress) await deps.writer.setFields(file, wordpressFields(a.wordpress));
            await untilIndexed(deps.index, () => !!deps.index.getVariant(file.path));
            claudeNotice(deps, `Claude created ${file.basename}.`, file.path);
            return ok({ path: file.path, status: "draft", issues });
          },
          exists,
        ),
    }),
  );

  registry.add(
    defineTool({
      name: "update_variant",
      title: "Update a post",
      description:
        "Changes a post: text (body replaces the whole body), title, link, channels (the complete new list), mode, reminders, stagger, media, WordPress fields. Checked first; nothing is written on a blocking issue unless force_draft, which is refused for a scheduled post. Channels already published, handed over or waiting for the user stay. Edits don't change posts that are already live: use push_update for those.",
      input: z
        .object({
          path: zPath,
          title: z.union([z.string().trim().min(1).max(300), z.null()]).optional().describe("null removes it"),
          url: z.union([zHttpUrl, z.null()]).optional().describe("null removes it"),
          body: zBody.optional(),
          channels: zChannelsArg.optional(),
          mode: z.enum(POST_MODES).optional(),
          reminders: zMinutesList.optional(),
          stagger_minutes: z.number().int().min(0).max(1440).optional(),
          media: zMedia.optional(),
          wordpress: zWordPress.optional(),
          force_draft: z.boolean().optional(),
        })
        .strict(),
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        if (a.wordpress && v.platform !== "wordpress") return fail("wordpress fields are only for platform wordpress.");
        if (v.channels.some((id) => v.deliveries[id]?.status === "publishing")) return fail("This post is being published right now. Try again in a minute.");
        let resolved: Channel[] | undefined;
        if (a.channels) {
          const r = resolveChannels(deps, a.channels, v.platform);
          if (blocking(r.issues)) return fail("Unknown or wrong channels, so nothing was written.", r.issues);
          resolved = r.channels;
        }
        const fields: Omit<VariantPatch, "deliveries" | "channels"> = {};
        if (a.title !== undefined) fields.title = a.title ?? undefined;
        if (a.url !== undefined) fields.url = a.url ?? undefined;
        if (a.mode) fields.mode = a.mode;
        if (a.reminders) fields.reminders = a.reminders;
        if (a.stagger_minutes !== undefined) fields.staggerMinutes = a.stagger_minutes;
        if (a.media) fields.media = a.media;
        const content = await deps.composer.content.load(v);
        const draft: Variant = {
          ...v,
          ...fields,
          ...(resolved ? { channels: resolved.map((c) => c.id) } : {}),
          ...(a.wordpress ? { wordpress: mergeWordPress(v.wordpress, a.wordpress) } : {}),
        };
        const nextBody = a.body ?? content.body;
        const issues = await draftIssues(deps, draft, nextBody);
        if (blocking(issues)) {
          if (!a.force_draft) return fail(BLOCKED, issues);
          if (pendingDeliveries(v)) return fail("This post is scheduled, so it can't be saved with blocking issues. Fix them, or call unschedule first.", issues);
        }
        const live = v.channels.filter((id) => LIVE.has(v.deliveries[id]?.status ?? ""));
        if (live.length) {
          issues.push({
            level: "warning",
            field: "deliveries",
            code: "already-live",
            message: `Already live on ${live.map(nameOf).join(", ")}. This edit doesn't change those posts; use push_update to change them there.`,
          });
        }
        const result = await deps.planner.write(v.file, (fresh) => {
          if (fresh.channels.some((id) => fresh.deliveries[id]?.status === "publishing")) return { refuse: "This post is being published right now. Try again in a minute." };
          if (!resolved) return { fields };
          const plan = planSetChannels(fresh, resolved, nameOf);
          if ("refuse" in plan) return plan;
          return { fields: { ...fields, ...plan.fields }, ...(plan.deliveries ? { deliveries: plan.deliveries } : {}) };
        });
        if (!result.ok) return fail(result.reason, issues);
        if (a.wordpress) await deps.writer.setFields(v.file, wordpressFields(a.wordpress));
        const bodyChanged = a.body !== undefined && a.body !== content.body;
        if (bodyChanged) await deps.writer.editBody(v.file, () => a.body as string);
        const changed = result.record.fields.length + result.record.deliveries.length > 0 || !!a.wordpress || bodyChanged;
        if (changed) {
          await untilIndexed(deps.index, () => deps.index.getVariant(v.path) !== v);
          claudeNotice(deps, `Claude updated ${v.displayTitle}.`, v.path);
        }
        return ok({ path: v.path, changed, issues });
      },
    }),
  );

  registry.add(
    defineTool({
      name: "fork_variant",
      title: "Fork a channel into its own post",
      description:
        "Moves one channel of a post into a new note with its own copy of the text (for example a company page that needs different wording). The channel is removed from the original.",
      input: z.object({ path: zPath, channel: z.string().trim().min(1).max(80) }).strict(),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: async (a) => {
        const v = findPost(deps, a.path);
        if (!v) return fail(noPost(a.path));
        if (!v.channels.includes(a.channel)) return fail(`${a.channel} is not a channel of this post.`);
        try {
          const file = await deps.factory.forkVariant(v.file, a.channel, nameOf(a.channel));
          await untilIndexed(deps.index, () => !!deps.index.getVariant(file.path));
          claudeNotice(deps, `Claude forked ${nameOf(a.channel)} into its own note.`, file.path);
          return ok({ path: file.path, original: v.path });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    }),
  );

  registry.add(
    defineTool({
      name: "validate",
      title: "Validate a post",
      description:
        "Runs the plugin's checks without writing: either an existing note (path) or a draft you are about to write (draft). Returns issues (errors block scheduling), blocking, and the length counters.",
      input: z
        .object({
          path: zPath.optional(),
          draft: z
            .object({
              platform: z.enum(PLATFORMS),
              channels: zChannelsArg.optional(),
              title: z.string().trim().max(300).optional(),
              url: zHttpUrl.optional(),
              body: zBody,
              media: zMedia.optional(),
              wordpress: zWordPress.optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (a) => {
        if (!a.path === !a.draft) return fail("Pass either path or draft.");
        if (a.path) {
          const v = findPost(deps, a.path);
          if (!v) return fail(noPost(a.path));
          const content = await deps.composer.content.load(v);
          const issues = deps.composer.check(v, content);
          return ok({ path: v.path, issues, blocking: blocking(issues), counters: deps.composer.counters(v, content) });
        }
        const d = a.draft!;
        const resolved = resolveChannels(deps, d.channels ?? [], d.platform);
        const variant: Variant = {
          path: `${deps.settings().rootFolder}/Posts/draft.md`,
          platform: d.platform,
          channels: resolved.channels.map((c) => c.id),
          mode: "auto",
          status: "draft",
          media: d.media ?? [],
          deliveries: {},
          ...(d.title ? { title: d.title } : {}),
          ...(d.url ? { url: d.url } : {}),
          ...(d.platform === "wordpress" ? { wordpress: mergeWordPress(undefined, d.wordpress) } : {}),
        };
        const media = await deps.composer.media.inspect(variant);
        const issues = [...resolved.issues, ...deps.composer.check(variant, { body: d.body, media })];
        return ok({ issues, blocking: blocking(issues), counters: deps.composer.counters(variant, { body: d.body, media }) });
      },
    }),
  );
}
