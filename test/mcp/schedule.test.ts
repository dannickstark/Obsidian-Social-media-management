import { describe, expect, it, vi } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { Notice } from "../fakes/obsidian";
import { expandRows, rowsBetween } from "../../src/index/queries";
import { formatDateTime, MINUTE } from "../../src/model/dates";
import { mcpCtx, type R } from "./helpers";

const EX = "Social/Event X/Event X.md";
const LI = "Social/Event X/Event X – LinkedIn.md";
const FRI_9 = "2026-10-09T09:00:00+02:00";

async function fm(c: Awaited<ReturnType<typeof mcpCtx>>, path: string): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

describe("schedule (#75)", () => {
  it("round trip: create → validate → schedule shows up in the calendar (#75 acceptance)", async () => {
    const c = await mcpCtx();
    const created = await c.call("create_variant", { platform: "bluesky", campaign: EX, channels: ["bs/you"], body: "Event X is back on the 12th. One evening, 80 makers.", idempotency_key: "round-trip-0001" });
    expect(created.ok).toBe(true);
    expect(await c.call("validate", { path: created.path })).toMatchObject({ ok: true, blocking: false });
    const r = await c.call("schedule", { path: created.path, at: FRI_9, reminders: [60, 10] });
    expect(r).toMatchObject({ ok: true, path: created.path, scheduled_at: FRI_9, reminders: [60, 10] });
    expect(r.channels).toEqual([{ id: "bs/you", name: "@you.bsky.social", status: "scheduled", at: FRI_9 }]);
    const rows = expandRows(c.index.variants(), 15);
    const week = rowsBetween(rows, Date.parse("2026-10-05T00:00:00+02:00"), Date.parse("2026-10-12T00:00:00+02:00"));
    expect(week.find((row) => row.variant.path === created.path)).toMatchObject({ channelId: "bs/you", status: "scheduled", at: Date.parse(FRI_9) });
    expect((await c.call("get_post", { path: created.path })).status).toBe("scheduled");
  });

  it("releases a note written offline once the plugin has validated and scheduled it", async () => {
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Offline.md", frontmatter: { type: "social-post", platform: "mastodon", title: "Offline", channels: ["ma/you"], status: "ready", review: "claude" }, body: "Written while Obsidian was closed." }],
    });
    expect((await c.call("get_post", { path: "Social/Posts/Offline.md" })).review).toBe("claude");
    expect((await c.call("schedule", { path: "Social/Posts/Offline.md", at: FRI_9 })).ok).toBe(true);
    expect((await fm(c, "Social/Posts/Offline.md")).review).toBeUndefined();
    expect(Notice.messages.at(-1)).toContain("released for review");
  });

  it("mentions releasing a held note in the tool description (#84 fix round 1, m7)", async () => {
    const c = await mcpCtx();
    const tool = c.registry.list().find((t) => t.name === "schedule")!;
    expect(tool.description).toContain("releases it from review");
  });

  it("is idempotent: scheduling again at the same time changes nothing (review focus 2)", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    await c.call("schedule", { path: X, at: FRI_9 });
    const once = await c.app.vault.read(c.app.vault.getFileByPath(X)!);
    const again = await c.call("schedule", { path: X, at: FRI_9 });
    expect(again.ok).toBe(true);
    expect(await c.app.vault.read(c.app.vault.getFileByPath(X)!)).toBe(once);
  });

  it("refuses a time in the past and writes nothing", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    const before = await fm(c, X);
    const r = await c.call("schedule", { path: X, at: "2026-10-01T09:00:00+02:00" });
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([expect.objectContaining({ field: "at", code: "past-time" })]);
    expect(await fm(c, X)).toEqual(before);
  });

  it("refuses a time less than 10 minutes ahead and writes nothing (Ruling P5)", async () => {
    const c = await mcpCtx(); // now: Thu 8 Oct 2026, 10:00 Berlin
    const X = "Social/Event X/Event X – X.md";
    const before = await fm(c, X);
    const r = await c.call("schedule", { path: X, at: "2026-10-08T10:09:59+02:00" });
    expect(r).toMatchObject({
      ok: false,
      error: "That is too soon for Claude to schedule. Pick a time at least 10 minutes ahead, or ask the user to publish it now (publish_now asks them in Obsidian).",
    });
    expect(r.issues).toEqual([expect.objectContaining({ level: "error", field: "at", code: "too-soon" })]);
    expect(await fm(c, X)).toEqual(before);
    const edge = await c.call("schedule", { path: X, at: "2026-10-08T10:10:00+02:00" });
    expect(edge).toMatchObject({ ok: true, scheduled_at: "2026-10-08T10:10:00+02:00" });
  });

  it("checks the lead time again inside the write, against the clock at that moment (Ruling P5)", async () => {
    const c = await mcpCtx(); // now: Thu 8 Oct 2026, 10:00 Berlin
    const X = "Social/Event X/Event X – X.md";
    const before = await fm(c, X);
    const write = c.deps.planner.write.bind(c.deps.planner);
    vi.spyOn(c.deps.planner, "write").mockImplementationOnce(async (f, plan) => {
      c.now.set(Date.parse("2026-10-08T10:02:00+02:00"));
      return write(f, plan);
    });
    const r = await c.call("schedule", { path: X, at: "2026-10-08T10:11:00+02:00" });
    expect(r).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "too-soon" })] });
    expect(await fm(c, X)).toEqual(before);
  });

  it("asks for confirmation when a channel starts waiting for the user during the write (M2b P2)", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    const file = c.app.vault.getFileByPath(X)!;
    const write = c.deps.planner.write.bind(c.deps.planner);
    vi.spyOn(c.deps.planner, "write").mockImplementationOnce(async (f, plan) => {
      await c.app.vault.process(file, (t) => t.replace(/("?x\/you"?:\s*\n\s*status:) scheduled/, "$1 awaiting_you"));
      return write(f, plan);
    });
    const r = await c.call("schedule", { path: X, at: "2026-10-10T09:00:00+02:00" });
    expect(r).toMatchObject({ ok: false, needs_confirmation: "move_awaiting", error: expect.stringContaining("waiting for the user") });
    expect(((await fm(c, X)).deliveries as Record<string, unknown>)["x/you"]).toEqual({ status: "awaiting_you" });
  });

  it("reads a time without an offset as local time", async () => {
    const c = await mcpCtx(); // now: Thu 8 Oct 2026, 10:00 Berlin
    const r = await c.call("schedule", { path: "Social/Event X/Event X – X.md", at: "2026-10-08T10:15:00" });
    expect(r).toMatchObject({ ok: true, scheduled_at: "2026-10-08T10:15:00+02:00" });
    expect(r.channels[0].at).toBe("2026-10-08T10:15:00+02:00");
  });

  it("moves a time in the spring-forward gap to the first real time after it", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    // 28 Mar 2027, Berlin: 02:00–03:00 does not exist.
    const local = await c.call("schedule", { path: X, at: "2027-03-28T02:30:00" });
    expect(local).toMatchObject({ ok: true, scheduled_at: "2027-03-28T03:30:00+02:00" });
    expect(c.index.getVariant(X)!.scheduledAt).toBe(Date.parse("2027-03-28T01:30:00Z"));
    const zoned = await c.call("schedule", { path: X, at: "2027-03-28T02:30:00+01:00" });
    expect(zoned).toMatchObject({ ok: true, scheduled_at: "2027-03-28T03:30:00+02:00" });
  });

  it("staggers the channels after the first one, all at least 10 minutes ahead (Ruling P5)", async () => {
    const path = "Social/Posts/Pages.md";
    const c = await mcpCtx({
      notes: [{ path, frontmatter: { type: "social-post", platform: "linkedin", title: "Pages", channels: ["li/acme-studio", "li/maker-lab"], stagger_minutes: 5, status: "draft" }, body: "Hello makers\n" }],
    });
    const r = await c.call("schedule", { path, at: "2026-10-08T10:10:00+02:00" });
    expect(r.ok).toBe(true);
    expect(r.channels.map((ch: R) => [ch.id, ch.status, ch.at])).toEqual([
      ["li/acme-studio", "scheduled", "2026-10-08T10:10:00+02:00"],
      ["li/maker-lab", "scheduled", "2026-10-08T10:15:00+02:00"],
    ]);
  });

  it("schedules a channel that update_variant added as a draft (Task 5 I1)", async () => {
    const now = Date.parse("2026-10-08T09:00:00+02:00");
    const at = now + 3 * MINUTE;
    const path = "Social/Posts/Soon.md";
    const c = await mcpCtx({
      now,
      notes: [{ path, frontmatter: { type: "social-post", platform: "linkedin", title: "Soon", channels: ["li/acme-studio"], status: "scheduled", scheduled_at: formatDateTime(at), deliveries: { "li/acme-studio": { status: "scheduled" } } }, body: "Hello\n" }],
    });
    expect((await c.call("update_variant", { path, channels: ["li/acme-studio", "li/maker-lab"] })).ok).toBe(true);
    expect((await c.call("schedule", { path, at: formatDateTime(at) })).issues).toEqual([expect.objectContaining({ code: "too-soon" })]);
    expect(c.index.getVariant(path)!.deliveries["li/maker-lab"]).toEqual({ status: "draft" });
    const later = formatDateTime(now + 30 * MINUTE);
    const r = await c.call("schedule", { path, at: later });
    expect(r.ok).toBe(true);
    const d = (await fm(c, path)).deliveries as Record<string, unknown>;
    expect(d).toEqual({ "li/acme-studio": { status: "scheduled" }, "li/maker-lab": { status: "scheduled" } });
  });

  it("refuses blocking issues and posts handed over to the platform", async () => {
    const c = await mcpCtx();
    const ig = await c.call("create_variant", { platform: "instagram", campaign: EX, channels: ["ig/acmestudio"], body: "No image yet", force_draft: true });
    const blocked = await c.call("schedule", { path: ig.path, at: FRI_9 });
    expect(blocked.ok).toBe(false);
    expect(blocked.issues.some((i: R) => i.level === "error")).toBe(true);
    expect(c.index.getVariant(ig.path)!.status).toBe("draft");
    const wp = await c.call("schedule", { path: "Social/Event X/Event X – WordPress.md", at: FRI_9 });
    expect(wp.error).toContain("handed over");
  });

  it("refuses a post without channels", async () => {
    const c = await mcpCtx({
      notes: [{ path: "Social/Posts/Empty.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Empty", channels: [], status: "draft" }, body: "Hello\n" }],
    });
    const r = await c.call("schedule", { path: "Social/Posts/Empty.md", at: FRI_9 });
    expect(r).toMatchObject({ ok: false, error: "Pick at least one channel first (update_variant with channels)." });
  });

  it("asks before moving channels that wait for the user (M2b P2)", async () => {
    const c = await mcpCtx();
    const first = await c.call("schedule", { path: LI, at: FRI_9 });
    expect(first).toMatchObject({ ok: false, needs_confirmation: "move_awaiting" });
    const confirmed = await c.call("schedule", { path: LI, at: FRI_9, move_awaiting: true });
    expect(confirmed.ok).toBe(true);
    const d = (await fm(c, LI)).deliveries as Record<string, Record<string, unknown>>;
    expect(d["li/me"]).toMatchObject({ status: "published" });
    expect(d["li/acme-studio"]).toMatchObject({ status: "awaiting_you" });
    expect(d["li/acme-studio"]!.at).toBeUndefined();
    expect(d["li/maker-lab"]).toEqual({ status: "scheduled" });
  });

  it("leaves channels that are publishing or need a check alone", async () => {
    const busy = "Social/Posts/Busy.md";
    const check = "Social/Posts/Check.md";
    const note = (path: string, status: string) => ({
      path,
      frontmatter: { type: "social-post", platform: "linkedin", title: "Busy", channels: ["li/me", "li/osmm"], status: "scheduled", scheduled_at: FRI_9, deliveries: { "li/me": { status } } },
      body: "Hello makers\n",
    });
    const c = await mcpCtx({ notes: [note(busy, "publishing"), note(check, "check_needed")] });
    const before = await fm(c, busy);
    const r = await c.call("schedule", { path: busy, at: "2026-10-10T09:00:00+02:00" });
    expect(r).toMatchObject({ ok: false, error: "This post is being published right now." });
    expect(await fm(c, busy)).toEqual(before);
    const checked = await c.call("schedule", { path: check, at: "2026-10-10T09:00:00+02:00" });
    expect(checked.ok).toBe(true);
    const d = (await fm(c, check)).deliveries as Record<string, Record<string, unknown>>;
    expect(d["li/me"]).toEqual({ status: "check_needed", at: FRI_9 });
    expect(d["li/osmm"]).toEqual({ status: "scheduled" });
  });

  it("refuses a note with an unreadable entry and leaves it untouched (frozen)", async () => {
    const c = await mcpCtx({
      notes: [
        {
          path: "Social/Posts/Frozen.md",
          frontmatter: { type: "social-post", platform: "linkedin", title: "Frozen", channels: ["li/me", "li/osmm"], status: "draft", deliveries: { "li/me": { status: "publishd" } } },
          body: "Hello makers",
        },
      ],
    });
    const r = await c.call("schedule", { path: "Social/Posts/Frozen.md", at: FRI_9 });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i: R) => i.code)).toContain("unreadable-delivery");
    expect((await fm(c, "Social/Posts/Frozen.md")).deliveries).toEqual({ "li/me": { status: "publishd" } });
  });
});

describe("unschedule", () => {
  it("moves a scheduled post back to draft and refuses one that was handed over", async () => {
    const c = await mcpCtx();
    const X = "Social/Event X/Event X – X.md";
    const r = await c.call("unschedule", { path: X });
    expect(r).toMatchObject({ ok: true, status: "draft" });
    expect(((await fm(c, X)).deliveries as Record<string, unknown>)["x/you"]).toEqual({ status: "draft" });
    expect((await c.call("unschedule", { path: "Social/Event X/Event X – WordPress.md" })).error).toBe(
      "Some channels were already handed over or published. Unschedule the remaining ones from the post itself.",
    );
  });

  it("refuses channels awaiting the user, publishing or needing a check, and published posts", async () => {
    const c = await mcpCtx({
      notes: [
        { path: "Social/Posts/Busy.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Busy", channels: ["li/me"], status: "scheduled", scheduled_at: FRI_9, deliveries: { "li/me": { status: "publishing" } } }, body: "Hi\n" },
        { path: "Social/Posts/Check.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Check", channels: ["li/me"], status: "scheduled", scheduled_at: FRI_9, deliveries: { "li/me": { status: "check_needed" } } }, body: "Hi\n" },
        { path: "Social/Posts/Done.md", frontmatter: { type: "social-post", platform: "linkedin", title: "Done", channels: ["li/me"], status: "published" }, body: "Hi\n" },
      ],
    });
    for (const path of [LI, "Social/Posts/Busy.md", "Social/Posts/Check.md", "Social/Posts/Done.md"]) {
      const before = await fm(c, path);
      expect((await c.call("unschedule", { path })).error).toBe("Some channels were already handed over or published. Unschedule the remaining ones from the post itself.");
      expect(await fm(c, path)).toEqual(before);
    }
  });

  it("leaves an unreadable entry untouched", async () => {
    const path = "Social/Posts/Frozen.md";
    const c = await mcpCtx({
      notes: [
        {
          path,
          frontmatter: { type: "social-post", platform: "linkedin", title: "Frozen", channels: ["li/me", "li/osmm"], status: "scheduled", scheduled_at: FRI_9, deliveries: { "li/me": { status: "publishd" }, "li/osmm": { status: "scheduled" } } },
          body: "Hello makers\n",
        },
      ],
    });
    const r = await c.call("unschedule", { path, to: "ready" });
    expect(r).toMatchObject({ ok: true, status: "ready" });
    expect((await fm(c, path)).deliveries).toEqual({ "li/me": { status: "publishd" }, "li/osmm": { status: "ready" } });
  });
});
