import { describe, expect, it } from "vitest";
import { writeNote } from "../helpers";
import { mcpCtx, type R } from "./helpers";

const EX = "Social/Event X/Event X.md";

describe("read tools (#74)", () => {
  it("lists channels and groups without credentials", async () => {
    const c = await mcpCtx();
    await c.ctx.channels.upsertChannel({ ...c.ctx.channels.get("tg/event-x")!, secretId: "osmm-channel-tg-event-x" });
    const all = await c.call("list_channels");
    expect(all.ok).toBe(true);
    expect(all.channels).toHaveLength(16);
    expect(all.channels.find((ch: R) => ch.id === "tg/event-x")).toMatchObject({ platform: "telegram", method: "api", credential: "missing" });
    expect(all.channels.find((ch: R) => ch.id === "li/me").credential).toBeNull();
    expect(all.groups).toEqual([{ id: "group:all-linkedin-pages", name: "All LinkedIn pages", channel_ids: ["li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"] }]);
    expect((await c.call("list_channels", { platform: "linkedin" })).channels).toHaveLength(5);
    expect(JSON.stringify(all)).not.toContain("secretId");
  });

  it("lists active campaigns by anchor date with progress", async () => {
    const c = await mcpCtx();
    const { campaigns } = await c.call("list_campaigns");
    expect(campaigns.map((x: R) => x.title)).toEqual(["Event X", "OSMM launch"]);
    expect(campaigns[0]).toMatchObject({ path: EX, status: "active", posts: 9, deliveries_published: 1, anchor_date: "2026-10-12T18:00:00+02:00", link: "https://example.com/event-x" });
  });

  it("returns a campaign with its brief, posts and the platforms not planned yet", async () => {
    const c = await mcpCtx();
    const r = await c.call("get_campaign", { path: "Social/Event X/Event X" });
    expect(r.brief).toContain("[FILL IN]");
    expect(r.posts).toHaveLength(9);
    expect(r.missing_platforms).toEqual(["facebook", "mastodon", "indiehackers", "whatsapp"]);
    expect((await c.call("get_campaign", { path: "Social/Nope.md" })).error).toContain("list_campaigns");
  });

  it("filters and pages posts", async () => {
    const c = await mcpCtx();
    const first = await c.call("list_posts", { campaign: EX, limit: 3 });
    expect([first.total, first.posts.length, first.next_cursor]).toEqual([9, 3, "3"]);
    const rest = await c.call("list_posts", { campaign: EX, limit: 50, cursor: "3" });
    expect(rest.posts).toHaveLength(6);
    expect(rest.next_cursor).toBeNull();
    const overdue = await c.call("list_posts", { status: ["overdue"] });
    expect(overdue.posts.map((p: R) => p.path)).toEqual(["Social/Event X/Event X – Instagram.md"]);
    const today = await c.call("list_posts", { from: "2026-10-08T00:00:00+02:00", to: "2026-10-09T00:00:00+02:00" });
    expect(today.posts.map((p: R) => p.platform)).toEqual(["bluesky", "telegram", "linkedin"]);
    expect((await c.call("list_posts", { unscheduled: true })).posts.map((p: R) => p.title)).toEqual(
      expect.arrayContaining(["Show HN: OSMM – plan social posts in Obsidian", "WhatsApp reminder"]),
    );
  });

  it("returns invalid arguments as fields to fix", async () => {
    const c = await mcpCtx();
    const r = await c.call("list_posts", { limit: 1000, from: "next tuesday" });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i: R) => i.field).sort()).toEqual(["from", "limit"]);
  });

  it("returns one post with body, checks, counters and per-channel state", async () => {
    const c = await mcpCtx();
    const x = await c.call("get_post", { path: "Social/Event X/Event X – X.md" });
    expect(x).toMatchObject({ ok: true, platform: "x", status: "scheduled", thread_items: 3, blocking: false, mode: "auto" });
    expect(x.body).toContain("One evening, twelve makers");
    expect(x.counters[0]).toMatchObject({ label: "Part 1", limit: 280 });
    expect(x.channels).toEqual([{ id: "x/you", name: "@you", status: "scheduled", at: "2026-10-09T09:00:00+02:00" }]);
    const li = await c.call("get_post", { path: "Social/Event X/Event X – LinkedIn.md" });
    expect(li.channels.find((ch: R) => ch.id === "li/me")).toMatchObject({ status: "published", url: "https://www.linkedin.com/feed/update/urn:li:activity:1" });
    expect((await c.call("get_post", { path: "Social/Nope.md" })).error).toBe('No social post at "Social/Nope.md". Use list_posts to find the path.');
  });

  it("marks unreadable delivery entries as frozen", async () => {
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Frozen.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Frozen", channels: ["li/me"], status: "scheduled", deliveries: { "li/me": { status: "publishd" } } }, body: "Hello" }],
    });
    const r = await c.call("get_post", { path: "Social/Posts/Frozen.md" });
    expect(r.channels[0]).toMatchObject({ id: "li/me", frozen: true });
    expect(r.issues.map((i: R) => i.code)).toContain("unreadable-delivery");
  });

  it("returns platform rules from the same numbers the checks use", async () => {
    const c = await mcpCtx();
    const { rules } = await c.call("get_platform_rules", { platform: "bluesky" });
    expect(rules).toEqual([expect.objectContaining({ platform: "bluesky", max_chars: 300, threads: true, thread_separator: "a line containing only ---", link: "optional" })]);
    expect((await c.call("get_platform_rules")).rules).toHaveLength(13);
  });

  it("reads the last lines of the publish log", async () => {
    const c = await mcpCtx();
    await writeNote(c.app as never, "Social/_log.md", null, "# Publish log\n\n- 2026-10-01T09:00:00+02:00 · Me (li/me) · [[A]] · published\n- 2026-10-02T09:00:00+02:00 · @you (x/you) · [[B]] · failed · 401\n- 2026-10-03T09:00:00+02:00 · Me (li/me) · [[C]] · skipped\n");
    expect((await c.call("get_log", { limit: 2 })).lines).toEqual(["2026-10-02T09:00:00+02:00 · @you (x/you) · [[B]] · failed · 401", "2026-10-03T09:00:00+02:00 · Me (li/me) · [[C]] · skipped"]);
    expect((await c.call("get_log", { contains: "LI/ME" })).total).toBe(2);
    expect(await c.call("get_log", { month: "2026-09" })).toEqual({ ok: true, path: "Social/_log/2026-09.md", total: 0, lines: [] });
  });

  describe("read tool safety", () => {
    it("never writes to the vault", async () => {
      const c = await mcpCtx();
      const before = c.app.vault.getFiles().map((f) => `${f.path}:${f.stat.mtime}`);
      await c.call("list_channels");
      await c.call("list_campaigns");
      await c.call("get_campaign", { path: EX });
      await c.call("list_posts", {});
      await c.call("get_post", { path: "Social/Event X/Event X – X.md" });
      await c.call("get_platform_rules");
      await c.call("get_log");
      // Also feed every read tool a path that does not resolve, to be sure the failure path writes nothing either.
      await c.call("get_campaign", { path: "Social/Nope.md" });
      await c.call("get_post", { path: "Social/Nope.md" });
      const after = c.app.vault.getFiles().map((f) => `${f.path}:${f.stat.mtime}`);
      expect(after).toEqual(before);
      expect(c.registry.list().filter((t) => t.name.startsWith("list_") || t.name.startsWith("get_")).every((t) => t.annotations.readOnlyHint === true)).toBe(true);
    });

    it("only reads notes known to the index, never arbitrary vault files by path", async () => {
      const c = await mcpCtx();
      // A markdown note that exists in the vault but was never indexed as a social post.
      await writeNote(c.app as never, "Social/Not a post.md", null, "Just a normal note.");
      // A file under .obsidian/, as if a traversal from the vault root reached it.
      await writeNote(c.app as never, ".obsidian/data.json", null, '{"mcp":{"token":"secret-token-value"}}');
      const unindexed = await c.call("get_post", { path: "Social/Not a post" });
      expect(unindexed).toEqual({ ok: false, error: noPostError("Social/Not a post") });
      const settings = await c.call("get_post", { path: ".obsidian/data.json" });
      expect(settings.ok).toBe(false);
      expect(JSON.stringify(settings)).not.toContain("secret-token-value");
      const campaignEscape = await c.call("get_campaign", { path: "../.obsidian/data" });
      expect(campaignEscape.ok).toBe(false);
    });

    it("does not resolve path traversal through campaign or post path arguments", async () => {
      const c = await mcpCtx();
      const traversalPaths = ["../Social/Event X/Event X – X.md", "..\\Social\\Event X\\Event X – X.md", "Social/../../.obsidian/data.json", "/../../.obsidian/data.json"];
      for (const p of traversalPaths) {
        const r = await c.call("get_post", { path: p });
        expect(r.ok).toBe(false);
      }
    });
  });
});

function noPostError(path: string): string {
  return `No social post at "${path}". Use list_posts to find the path.`;
}
