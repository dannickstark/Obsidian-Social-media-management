import { describe, expect, it, vi } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { MarkdownView, WorkspaceLeaf } from "../fakes/obsidian";
import { formatDateTime, MINUTE } from "../../src/model/dates";
import { dueItems } from "../../src/scheduler/due";
import { IdempotencyCache } from "../../src/mcp/idempotency";
import { fail, ok } from "../../src/mcp/tools";
import { mcpCtx, type R } from "./helpers";

const EX = "Social/Event X/Event X.md";
const LI = "Social/Event X/Event X – LinkedIn.md";

async function fm(c: Awaited<ReturnType<typeof mcpCtx>>, path: string): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}
async function body(c: Awaited<ReturnType<typeof mcpCtx>>, path: string): Promise<string> {
  const text = await c.app.vault.read(c.app.vault.getFileByPath(path)!);
  return text.slice(getFrontMatterInfo(text).contentStart);
}

describe("create_campaign", () => {
  it("creates the note with the brief and shows a notice", async () => {
    const c = await mcpCtx();
    const r = await c.call("create_campaign", { title: "Event Y", anchor_date: "2026-11-05T18:00:00+01:00", link: "https://example.com/y", brief: "A makers evening." });
    expect(r).toMatchObject({ ok: true, path: "Social/Event Y/Event Y.md" });
    expect(c.index.getCampaign(r.path)?.anchorDate).toBe(Date.parse("2026-11-05T18:00:00+01:00"));
    expect(await body(c, r.path)).toContain("A makers evening.");
  });

  it("returns the first note when retried with the same key, even concurrently (review focus 2)", async () => {
    const c = await mcpCtx();
    const key = "7f9c2c1e-retry-key";
    const [a, b] = await Promise.all([c.call("create_campaign", { title: "Event Z", idempotency_key: key }), c.call("create_campaign", { title: "Event Z", idempotency_key: key })]);
    const again = await c.call("create_campaign", { title: "Event Z", idempotency_key: key });
    expect([a.path, b.path, again.path]).toEqual(["Social/Event Z/Event Z.md", "Social/Event Z/Event Z.md", "Social/Event Z/Event Z.md"]);
    expect(again.replayed).toBe(true);
    expect(c.app.vault.getFileByPath("Social/Event Z/Event Z 2.md")).toBeNull();
  });
});

describe("create_variant", () => {
  it("creates a draft for a campaign, expanding a channel group", async () => {
    const c = await mcpCtx();
    const r = await c.call("create_variant", { platform: "linkedin", campaign: EX, channels: ["group:all-linkedin-pages"], body: "Event X is back on the 12th.", scheduled_at: "2026-10-10T09:00:00+02:00" });
    expect(r).toMatchObject({ ok: true, path: "Social/Event X/Event X – LinkedIn 2.md", status: "draft" });
    const v = c.index.getVariant(r.path)!;
    expect(v.channels).toEqual(["li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"]);
    expect([v.status, v.scheduledAt, v.campaignPath]).toEqual(["draft", Date.parse("2026-10-10T09:00:00+02:00"), EX]);
    expect(await body(c, r.path)).toBe("Event X is back on the 12th.\n");
  });

  it("writes nothing on a blocking issue unless force_draft", async () => {
    const c = await mcpCtx();
    const long = { platform: "x", campaign: EX, channels: ["x/you"], body: "a".repeat(300) };
    const refused = await c.call("create_variant", long);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("nothing was written");
    expect(refused.issues.map((i: R) => i.code)).toContain("too-long");
    expect(c.app.vault.getFileByPath("Social/Event X/Event X – X 2.md")).toBeNull();
    const forced = await c.call("create_variant", { ...long, force_draft: true });
    expect(forced).toMatchObject({ ok: true, path: "Social/Event X/Event X – X 2.md", status: "draft" });
  });

  it("never writes with an unknown channel, even with force_draft", async () => {
    const c = await mcpCtx();
    const r = await c.call("create_variant", { platform: "linkedin", title: "Solo", channels: ["li/nope", "x/you"], body: "Hi", force_draft: true });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i: R) => i.message)).toEqual(["Unknown channel li/nope. Use list_channels.", "x/you is not a LinkedIn channel."]);
  });

  it("needs a title outside a campaign and writes WordPress fields per key", async () => {
    const c = await mcpCtx();
    expect((await c.call("create_variant", { platform: "mastodon", channels: ["ma/you"], body: "Hi" })).error).toBe("A post outside a campaign needs a title.");
    const wp = await c.call("create_variant", {
      platform: "wordpress",
      campaign: EX,
      title: "Event X recap",
      channels: ["wp/eventx-berlin"],
      body: "# Recap\n\nWhat 80 makers shipped.",
      wordpress: { slug: "event-x-recap", excerpt: "What 80 makers shipped.", categories: ["Community"], tags: ["events"] },
    });
    expect(wp.ok).toBe(true);
    expect(await fm(c, wp.path)).toMatchObject({ slug: "event-x-recap", excerpt: "What 80 makers shipped.", categories: ["Community"], tags: ["events"] });
    expect(wp.issues.map((i: R) => i.code)).toContain("missing-featured");
  });
});

describe("update_variant", () => {
  it("edits text and fields, keeps every delivery entry verbatim and warns about live channels", async () => {
    const c = await mcpCtx();
    const before = (await fm(c, LI)).deliveries;
    const r = await c.call("update_variant", { path: LI, title: "Event X is back", body: "I almost didn't host Event X. Here is why." });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.issues).toEqual([expect.objectContaining({ level: "warning", code: "already-live" })]);
    expect((await fm(c, LI)).deliveries).toEqual(before);
    expect((await fm(c, LI)).title).toBe("Event X is back");
    expect(await body(c, LI)).toBe("I almost didn't host Event X. Here is why.\n");
  });

  it("keeps channel history when replacing the list", async () => {
    const c = await mcpCtx();
    const r = await c.call("update_variant", { path: LI, channels: ["li/maker-lab"] });
    expect(r.error).toBe("Me was already published, so it stays on this post.");
  });

  it("refuses force_draft on a scheduled post and allows it on a draft", async () => {
    const c = await mcpCtx();
    const long = "a".repeat(3100);
    const scheduled = await c.call("update_variant", { path: LI, body: long, force_draft: true });
    expect(scheduled.error).toContain("call unschedule first");
    expect(await body(c, LI)).not.toContain(long);
    const recap = "Social/Event X/Event X – LinkedIn recap.md";
    const draft = await c.call("update_variant", { path: recap, body: long, force_draft: true });
    expect(draft.ok).toBe(true);
    expect(draft.issues.map((i: R) => i.code)).toContain("too-long");
  });

  it("leaves an unreadable delivery entry untouched", async () => {
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Frozen.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Frozen", channels: ["li/me"], status: "draft", deliveries: { "li/me": { status: "publishd" } } }, body: "Hello" }],
    });
    const r = await c.call("update_variant", { path: "Social/Posts/Frozen.md", title: "Still frozen", force_draft: true });
    expect(r.ok).toBe(true);
    expect((await fm(c, "Social/Posts/Frozen.md")).deliveries).toEqual({ "li/me": { status: "publishd" } });
  });

  it("writes WordPress fields in the same single write, so Undo reverts them", async () => {
    const c = await mcpCtx();
    const WP = "Social/Event X/Event X – WordPress.md";
    const write = vi.spyOn(c.ctx.actions, "write");
    const setFields = vi.spyOn(c.writer, "setFields");
    const r = await c.call("update_variant", { path: WP, title: "Event X, again", wordpress: { slug: "event-x-again", excerpt: "Again.", tags: ["events", "berlin"] } });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(setFields).not.toHaveBeenCalled();
    expect(await fm(c, WP)).toMatchObject({ title: "Event X, again", slug: "event-x-again", excerpt: "Again.", categories: ["Community"], tags: ["events", "berlin"] });
    const result = (await write.mock.results[0]!.value) as R;
    expect(result.record.fields.map((f: R) => f.key).sort()).toEqual(["title", "wordpress"]);
    await c.ctx.actions.undo([result.record]);
    const undone = await fm(c, WP);
    expect(undone).toMatchObject({ title: "We're hosting Event X again", slug: "hosting-event-x-again", categories: ["Community"], tags: ["events"] });
    expect(undone.excerpt).toBeUndefined();
    expect(undone.deliveries).toEqual({ "wp/eventx-berlin": expect.objectContaining({ status: "handed_over", remote_id: "412" }) });
  });

  it("refuses WordPress fields on another platform", async () => {
    const c = await mcpCtx();
    expect((await c.call("update_variant", { path: LI, wordpress: { slug: "x" } })).error).toBe("wordpress fields are only for platform wordpress.");
  });
});

describe("fork_variant and validate", () => {
  it("forks one channel into its own note", async () => {
    const c = await mcpCtx();
    const r = await c.call("fork_variant", { path: LI, channel: "li/maker-lab" });
    expect(r).toMatchObject({ ok: true, path: "Social/Event X/Event X – LinkedIn – Maker Lab.md", original: LI });
    expect(c.index.getVariant(LI)!.channels).toEqual(["li/me", "li/acme-studio"]);
  });

  it("keeps the times of scheduled channels in the fork and in the original (cross-task b)", async () => {
    const path = "Social/Posts/Pages.md";
    const c = await mcpCtx({
      notes: [
        {
          path,
          frontmatter: {
            type: "social-post", platform: "linkedin", title: "Pages", channels: ["li/acme-studio", "li/maker-lab", "li/osmm"], stagger_minutes: 30, status: "scheduled",
            scheduled_at: "2026-10-09T10:00:00+02:00",
            deliveries: { "li/acme-studio": { status: "scheduled" }, "li/maker-lab": { status: "scheduled" }, "li/osmm": { status: "scheduled" } },
          },
          body: "Hello makers\n",
        },
      ],
    });
    const r = await c.call("fork_variant", { path, channel: "li/maker-lab" });
    expect(r.ok).toBe(true);
    expect(c.index.getVariant(r.path)!.deliveries["li/maker-lab"]).toEqual({ status: "scheduled", at: Date.parse("2026-10-09T10:30:00+02:00") });
    const orig = (await c.call("get_post", { path })).channels.map((ch: R) => [ch.id, ch.at]);
    expect(orig).toEqual([
      ["li/acme-studio", "2026-10-09T10:00:00+02:00"],
      ["li/osmm", "2026-10-09T11:00:00+02:00"],
    ]);
  });

  it("validates a note or a draft without writing", async () => {
    const c = await mcpCtx();
    expect(await c.call("validate", { path: "Social/Event X/Event X – X.md" })).toMatchObject({ ok: true, blocking: false });
    const draft = await c.call("validate", { draft: { platform: "x", channels: ["x/you"], body: "a".repeat(300) } });
    expect(draft).toMatchObject({ ok: true, blocking: true });
    expect(draft.issues.map((i: R) => i.code)).toContain("too-long");
    expect(draft.counters[0]).toEqual({ label: "Length", value: 300, limit: 280 });
    expect((await c.call("validate", {})).error).toBe("Pass either path or draft.");
  });
});

describe("write tools never publish on their own", () => {
  const WRITE_TOOLS = ["create_campaign", "create_variant", "update_variant", "fork_variant", "validate"];
  const X = "Social/Event X/Event X – X.md";

  it("offer no status, deliveries or delivery url argument", async () => {
    const c = await mcpCtx();
    for (const tool of c.registry.list().filter((t) => WRITE_TOOLS.includes(t.name))) {
      const props = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>);
      expect(props, tool.name).not.toContain("status");
      expect(props, tool.name).not.toContain("deliveries");
    }
  });

  it.each(["publishing", "published", "check_needed"])("refuses to set status %s on a post", async (status) => {
    const c = await mcpCtx();
    const before = await c.app.vault.read(c.app.vault.getFileByPath(X)!);
    const r = await c.call("update_variant", { path: X, status });
    expect(r).toMatchObject({ ok: false, error: "Invalid arguments. Fix them and call the tool again." });
    expect(await c.app.vault.read(c.app.vault.getFileByPath(X)!)).toBe(before);
    const created = await c.call("create_variant", { platform: "x", campaign: EX, channels: ["x/you"], body: "Hi", status });
    expect(created.ok).toBe(false);
    expect(c.app.vault.getFileByPath("Social/Event X/Event X – X 2.md")).toBeNull();
  });

  it("refuses to write a delivery entry or its url", async () => {
    const c = await mcpCtx();
    const before = await c.app.vault.read(c.app.vault.getFileByPath(X)!);
    const deliveries = { "x/you": { status: "published", url: "https://x.com/you/status/1" } };
    expect((await c.call("update_variant", { path: X, deliveries })).ok).toBe(false);
    expect(await c.app.vault.read(c.app.vault.getFileByPath(X)!)).toBe(before);
    expect((await c.call("create_variant", { platform: "x", campaign: EX, channels: ["x/you"], body: "Hi", deliveries })).ok).toBe(false);
    expect(c.app.vault.getFileByPath("Social/Event X/Event X – X 2.md")).toBeNull();
  });

  it("writes url as the post's link only, never as a delivery url", async () => {
    const c = await mcpCtx();
    const before = await fm(c, X);
    const r = await c.call("update_variant", { path: X, url: "https://example.com/event-x" });
    expect(r).toMatchObject({ ok: true, changed: true });
    const after = await fm(c, X);
    expect(after.url).toBe("https://example.com/event-x");
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.status).toBe("scheduled");
    expect(c.index.getVariant(X)!.deliveries["x/you"]).toEqual({ status: "scheduled" });
  });

  it("refuses to edit a post that is being published", async () => {
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Busy.md", frontmatter: { type: "social-post", platform: "x", title: "Busy", channels: ["x/you"], status: "scheduled", scheduled_at: "2026-10-08T09:00:00+02:00", deliveries: { "x/you": { status: "publishing" } } }, body: "Hello" }],
    });
    const r = await c.call("update_variant", { path: "Social/Posts/Busy.md", body: "Changed" });
    expect(r.error).toBe("This post is being published right now. Try again in a minute.");
    expect(await body(c, "Social/Posts/Busy.md")).toBe("Hello");
  });

  it("keeps a check_needed entry verbatim and refuses to drop that channel", async () => {
    const deliveries = { "li/me": { status: "check_needed", error: "Timed out" }, "li/acme-studio": { status: "scheduled" } };
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Check.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Check", channels: ["li/me", "li/acme-studio"], status: "attention", scheduled_at: "2026-10-08T09:00:00+02:00", deliveries }, body: "Hello" }],
    });
    const path = "Social/Posts/Check.md";
    expect((await c.call("update_variant", { path, channels: ["li/acme-studio"] })).error).toBe("Me needs a check after an interrupted publish, so it stays on this post.");
    expect((await c.call("update_variant", { path, body: "Hello again" })).ok).toBe(true);
    expect((await fm(c, path)).deliveries).toEqual(deliveries);
  });
});

describe("fork_variant guards", () => {
  it("refuses a channel that is being published (M4 P4) or whose entry can't be read", async () => {
    const busy = { "li/me": { status: "publishing" }, "li/acme-studio": { status: "scheduled" } };
    const frozen = { "li/me": { status: "publishd" } };
    const base = { type: "social-post", platform: "linkedin", channels: ["li/me", "li/acme-studio"], status: "scheduled", scheduled_at: "2026-10-08T09:00:00+02:00" };
    const c = await mcpCtx({
      notes: [
        { path: "Social/Posts/Busy.md", frontmatter: { ...base, title: "Busy", deliveries: busy }, body: "Hello" },
        { path: "Social/Posts/Frozen.md", frontmatter: { ...base, title: "Frozen", deliveries: frozen }, body: "Hello" },
      ],
    });
    expect((await c.call("fork_variant", { path: "Social/Posts/Busy.md", channel: "li/me" })).error).toBe("Me is being published right now. Try again in a minute.");
    expect((await fm(c, "Social/Posts/Busy.md")).deliveries).toEqual(busy);
    expect((await c.call("fork_variant", { path: "Social/Posts/Frozen.md", channel: "li/me" })).error).toBe("li/me's delivery entry can't be read. Fix its status in the note before forking it.");
    expect((await fm(c, "Social/Posts/Frozen.md")).deliveries).toEqual(frozen);
    expect(c.app.vault.getFiles().filter((f) => f.basename.includes("– Me"))).toEqual([]);
  });

  it("refuses a channel that needs a check (P4, extended): a pending lookup still targets this note", async () => {
    const deliveries = { "li/me": { status: "check_needed", error: "Timed out" }, "li/acme-studio": { status: "scheduled" } };
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Check.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Check", channels: ["li/me", "li/acme-studio"], status: "attention", scheduled_at: "2026-10-08T09:00:00+02:00", deliveries }, body: "Hello" }],
    });
    expect((await c.call("fork_variant", { path: "Social/Posts/Check.md", channel: "li/me" })).error).toBe("Me needs a check first (did it go out?). Resolve it in Needs attention, then try again.");
    expect(await fm(c, "Social/Posts/Check.md")).toMatchObject({ channels: ["li/me", "li/acme-studio"], deliveries });
    expect(c.app.vault.getFiles().filter((f) => f.basename.includes("– Me"))).toEqual([]);
  });
});

describe("paths stay inside the root folder", () => {
  const inside = (path: string) => path.startsWith("Social/") && path.split("/").every((seg) => seg.length > 0 && !seg.startsWith("."));

  it("sanitises titles into file names under the root folder", async () => {
    const c = await mcpCtx();
    const campaign = await c.call("create_campaign", { title: "../../.obsidian/plugins/osmm" });
    expect(campaign.ok).toBe(true);
    expect(inside(campaign.path)).toBe(true);
    const post = await c.call("create_variant", { platform: "mastodon", title: "../.obsidian/data", channels: ["ma/you"], body: "Hi" });
    expect(post.ok).toBe(true);
    expect(inside(post.path)).toBe(true);
    expect(post.path.startsWith("Social/Posts/")).toBe(true);
    expect(c.app.vault.getFiles().filter((f) => f.path.includes(".obsidian"))).toEqual([]);
  });

  it("resolves notes only through the index", async () => {
    const c = await mcpCtx();
    await c.app.vault.createFolder(".obsidian");
    await c.app.vault.create(".obsidian/evil.md", "---\ntype: social-campaign\ntitle: Evil\n---\n");
    expect((await c.call("create_variant", { platform: "x", campaign: "../.obsidian/evil.md", channels: ["x/you"], body: "Hi" })).error).toContain("No campaign note");
    expect((await c.call("update_variant", { path: "../Social/Event X/Event X – X.md", body: "Hi" })).error).toContain("No social post");
    expect((await c.call("fork_variant", { path: "Notes/elsewhere.md", channel: "x/you" })).error).toContain("No social post");
  });
});

describe("IdempotencyCache", () => {
  it("replays a success, forgets failures and expires after the TTL", async () => {
    let now = 0;
    const cache = new IdempotencyCache(() => now, 1_000);
    const args = { title: "A" };
    const fn = vi.fn(async () => ok({ path: "a.md" }));
    expect(await cache.run("s", "key-1234", args, fn)).toEqual({ ok: true, data: { path: "a.md" } });
    expect(await cache.run("s", "key-1234", args, fn)).toEqual({ ok: true, data: { path: "a.md", replayed: true } });
    expect(await cache.run("other", "key-1234", args, fn)).toEqual({ ok: true, data: { path: "a.md" } });
    expect(fn).toHaveBeenCalledTimes(2);
    now = 2_000;
    await cache.run("s", "key-1234", args, fn);
    expect(fn).toHaveBeenCalledTimes(3);
    const failing = vi.fn(async () => fail("nope"));
    await cache.run("s", "key-fail", args, failing);
    await cache.run("s", "key-fail", args, failing);
    expect(failing).toHaveBeenCalledTimes(2);
    const noKey = vi.fn(async () => ok());
    await cache.run("s", undefined, args, noKey);
    await cache.run("s", undefined, args, noKey);
    expect(noKey).toHaveBeenCalledTimes(2);
  });

  it("refuses a key reused with different arguments; key order does not matter (I2)", async () => {
    const cache = new IdempotencyCache(() => 0);
    const fn = vi.fn(async () => ok({ path: "a.md" }));
    await cache.run("s", "key-1234", { title: "A", body: { x: 1, y: 2 } }, fn);
    expect(await cache.run("s", "key-1234", { body: { y: 2, x: 1 }, title: "A" }, fn)).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await cache.run("s", "key-1234", { title: "B" }, fn)).toEqual({ ok: false, error: "This idempotency_key was already used with different arguments. Use a new key." });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs once when concurrent replays find the first result gone (minor 4)", async () => {
    const cache = new IdempotencyCache(() => 0);
    let n = 0;
    let valid = false;
    const fn = vi.fn(async () => ok({ path: `a${++n}.md` }));
    await cache.run("s", "key-1234", {}, fn, () => valid);
    valid = false;
    const stillValid = (o: R) => valid || o.data.path !== "a1.md";
    const [a, b] = await Promise.all([cache.run("s", "key-1234", {}, fn, stillValid), cache.run("s", "key-1234", {}, fn, stillValid)]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect([a.ok && a.data.path, b.ok && b.data.path]).toEqual(["a2.md", "a2.md"]);
  });
});

describe("fix round 1", () => {
  const WP = "Social/Posts/Recap.md";
  const wpNote = {
    path: WP,
    frontmatter: { type: "social-post", platform: "wordpress", title: "Recap", channels: ["wp/eventx-berlin"], status: "draft", slug: "recap", tags: ["events"], featured_image: "[[event-x-cover.png|Cover]]" },
    body: "# Recap\n\nText.\n",
  };

  it("adds a channel to a scheduled post as a draft, never inheriting scheduled (I1)", async () => {
    const now = Date.parse("2026-10-08T09:00:00+02:00");
    const at = now + 3 * MINUTE;
    const path = "Social/Posts/Soon.md";
    const c = await mcpCtx({
      now,
      notes: [{ path, frontmatter: { type: "social-post", platform: "linkedin", title: "Soon", channels: ["li/acme-studio"], status: "scheduled", scheduled_at: formatDateTime(at), deliveries: { "li/acme-studio": { status: "scheduled" } } }, body: "Hello\n" }],
    });
    const r = await c.call("update_variant", { path, channels: ["li/acme-studio", "li/maker-lab"] });
    expect(r).toMatchObject({ ok: true, changed: true, note: "Added as draft; call schedule to plan it." });
    const v = c.index.getVariant(path)!;
    expect(v.deliveries["li/maker-lab"]).toEqual({ status: "draft" });
    expect(v.deliveries["li/acme-studio"]).toEqual({ status: "scheduled" });
    const due = dueItems(c.index.variants(), at + 60 * MINUTE, 15).filter((d) => d.path === path);
    expect(due.map((d) => d.channelId)).toEqual(["li/acme-studio"]);
  });

  it("keeps each scheduled channel's time when the stagger changes (cross-task a)", async () => {
    const now = Date.parse("2026-10-08T10:09:00+02:00");
    const path = "Social/Posts/Staggered.md";
    const c = await mcpCtx({
      now,
      notes: [
        {
          path,
          frontmatter: {
            type: "social-post", platform: "linkedin", title: "Staggered", channels: ["li/acme-studio", "li/maker-lab"], stagger_minutes: 60, status: "scheduled",
            scheduled_at: "2026-10-08T10:10:00+02:00",
            deliveries: { "li/acme-studio": { status: "scheduled" }, "li/maker-lab": { status: "scheduled" } },
          },
          body: "Hello makers\n",
        },
      ],
    });
    const r = await c.call("update_variant", { path, stagger_minutes: 0 });
    expect(r).toMatchObject({ ok: true, changed: true });
    const v = c.index.getVariant(path)!;
    expect(v.staggerMinutes).toBe(0);
    expect(v.deliveries["li/maker-lab"]).toEqual({ status: "scheduled", at: Date.parse("2026-10-08T11:10:00+02:00") });
    const times = (await c.call("get_post", { path })).channels.map((ch: R) => [ch.id, ch.at]);
    expect(times).toEqual([
      ["li/acme-studio", "2026-10-08T10:10:00+02:00"],
      ["li/maker-lab", "2026-10-08T11:10:00+02:00"],
    ]);
    const due = dueItems(c.index.variants(), now + 30 * MINUTE, 15).filter((d) => d.path === path);
    expect(due.map((d) => d.channelId)).toEqual(["li/acme-studio"]);
  });

  it("keeps the remaining channels' times when a channel is removed", async () => {
    const path = "Social/Posts/Staggered.md";
    const c = await mcpCtx({
      notes: [
        {
          path,
          frontmatter: {
            type: "social-post", platform: "linkedin", title: "Staggered", channels: ["li/acme-studio", "li/maker-lab"], stagger_minutes: 60, status: "scheduled",
            scheduled_at: "2026-10-09T10:10:00+02:00",
            deliveries: { "li/acme-studio": { status: "scheduled" }, "li/maker-lab": { status: "scheduled" } },
          },
          body: "Hello makers\n",
        },
      ],
    });
    expect((await c.call("update_variant", { path, channels: ["li/maker-lab"] })).ok).toBe(true);
    expect(c.index.getVariant(path)!.deliveries).toEqual({ "li/maker-lab": { status: "scheduled", at: Date.parse("2026-10-09T11:10:00+02:00") } });
  });

  it("changes no stored time when the stagger changes on an unscheduled post", async () => {
    const c = await mcpCtx();
    const path = "Social/Event X/Event X – LinkedIn recap.md";
    expect((await c.call("update_variant", { path, stagger_minutes: 5 })).ok).toBe(true);
    expect(c.index.getVariant(path)!.deliveries).toEqual({});
  });

  it("refuses a body write when the user edited the note after it was read (I3)", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    const file = c.app.vault.getFileByPath(X)!;
    const write = c.deps.planner.write.bind(c.deps.planner);
    vi.spyOn(c.deps.planner, "write").mockImplementationOnce(async (f, plan) => {
      const result = await write(f, plan);
      await c.app.vault.process(file, (t) => t.replace("twelve makers", "thirteen makers"));
      return result;
    });
    const r = await c.call("update_variant", { path: X, body: "Claude's text" });
    expect(r).toMatchObject({ ok: false, error: "The note changed since you read it; call get_post again." });
    expect(await body(c, X)).toContain("thirteen makers");
  });

  it("flushes the open editor and refuses a stale base_body_hash (I3)", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    const read = await c.call("get_post", { path: X });
    expect(typeof read.body_hash).toBe("string");
    const disk = await c.app.vault.read(c.app.vault.getFileByPath(X)!);
    const leaf = new WorkspaceLeaf(c.app);
    const md = new MarkdownView(leaf);
    md.file = c.app.vault.getFileByPath(X) as never;
    md.editor = { getValue: () => disk.replace("One evening", "One late evening") };
    leaf.view = md;
    leaf.viewType = "markdown";
    c.app.workspace.leaves.push(leaf);
    const r = await c.call("update_variant", { path: X, body: "Claude's text", base_body_hash: read.body_hash });
    expect(r).toMatchObject({ ok: false, error: "The note changed since you read it; call get_post again." });
    expect(await body(c, X)).toContain("One late evening");
    const again = await c.call("get_post", { path: X });
    expect(again.body_hash).not.toBe(read.body_hash);
    expect((await c.call("update_variant", { path: X, body: "Claude's text", base_body_hash: again.body_hash })).ok).toBe(true);
  });

  it("refuses the body write when a channel started publishing meanwhile (minor 3)", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    const file = c.app.vault.getFileByPath(X)!;
    const write = c.deps.planner.write.bind(c.deps.planner);
    vi.spyOn(c.deps.planner, "write").mockImplementationOnce(async (f, plan) => {
      const result = await write(f, plan);
      await c.writer.transitionDelivery(file as never, "x/you", "publishing");
      return result;
    });
    const r = await c.call("update_variant", { path: X, body: "Claude's text" });
    expect(r).toMatchObject({ ok: false, error: "This post is being published right now. Try again in a minute." });
    expect(await body(c, X)).not.toContain("Claude's text");
  });

  it("writes only the WordPress keys that change; an aliased featured image survives (minor 1)", async () => {
    const c = await mcpCtx({ notes: [wpNote] });
    const file = c.app.vault.getFileByPath(WP)!;
    const before = await c.app.vault.read(file);
    const same = await c.call("update_variant", { path: WP, wordpress: { slug: "recap", tags: ["events"], featured_image: "event-x-cover.png" } });
    expect(same).toMatchObject({ ok: true, changed: false });
    expect(await c.app.vault.read(file)).toBe(before);
    const r = await c.call("update_variant", { path: WP, wordpress: { tags: ["events", "recap"] } });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(await fm(c, WP)).toMatchObject({ tags: ["events", "recap"], slug: "recap", featured_image: "[[event-x-cover.png|Cover]]" });
  });

  it("keeps the key on the created note when a later step fails, so a retry returns it (minor 5)", async () => {
    const c = await mcpCtx();
    vi.spyOn(c.writer, "patchVariant").mockRejectedValueOnce(new Error("disk full"));
    const args = { platform: "x", campaign: EX, channels: ["x/you"], body: "Hi", url: "https://example.com/x", idempotency_key: "retry-after-partial" };
    const first = await c.call("create_variant", args);
    expect(first).toMatchObject({ ok: false, path: "Social/Event X/Event X – X 2.md" });
    expect(first.error).toContain("disk full");
    const retry = await c.call("create_variant", args);
    expect(retry.path).toBe("Social/Event X/Event X – X 2.md");
    expect(c.app.vault.getFileByPath("Social/Event X/Event X – X 3.md")).toBeNull();
  });

  it("does not count a trailing newline as a body change (minor 6)", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    const current = await body(c, X);
    const r = await c.call("update_variant", { path: X, body: current.replace(/\n+$/, "") });
    expect(r).toMatchObject({ ok: true, changed: false });
  });
});
