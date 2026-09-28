import { describe, expect, it, vi } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
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
    const fn = vi.fn(async () => ok({ path: "a.md" }));
    expect(await cache.run("s", "key-1234", fn)).toEqual({ ok: true, data: { path: "a.md" } });
    expect(await cache.run("s", "key-1234", fn)).toEqual({ ok: true, data: { path: "a.md", replayed: true } });
    expect(await cache.run("other", "key-1234", fn)).toEqual({ ok: true, data: { path: "a.md" } });
    expect(fn).toHaveBeenCalledTimes(2);
    now = 2_000;
    await cache.run("s", "key-1234", fn);
    expect(fn).toHaveBeenCalledTimes(3);
    const failing = vi.fn(async () => fail("nope"));
    await cache.run("s", "key-fail", failing);
    await cache.run("s", "key-fail", failing);
    expect(failing).toHaveBeenCalledTimes(2);
    const noKey = vi.fn(async () => ok());
    await cache.run("s", undefined, noKey);
    await cache.run("s", undefined, noKey);
    expect(noKey).toHaveBeenCalledTimes(2);
  });
});
