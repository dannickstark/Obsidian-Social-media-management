import { describe, expect, it, vi } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { Notice } from "../fakes/obsidian";
import { parseVariant, serializeDelivery } from "../../src/model/frontmatter";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const BS = "Social/Event X/Event X – Bluesky.md";
const LI = "Social/Event X/Event X – LinkedIn.md";

async function fm(c: TestCtx, path: string): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

describe("PublishActions.markPublished", () => {
  it("records the live URL and rolls the status up at once", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.publish.markPublished(BS, "bs/you", " https://bsky.app/profile/you/post/1 ")).toEqual({ ok: true });
    await indexed(c.index, () => c.index.getVariant(BS)?.status === "published");
    expect(c.index.getVariant(BS)!.deliveries["bs/you"]).toEqual({ status: "published", at: TEST_NOW, url: "https://bsky.app/profile/you/post/1" });
    expect(c.ctx.actions.rows().find((r) => r.key === `${BS}#bs/you`)?.status).toBe("published");
    expect(c.log.entries).toEqual([{ at: TEST_NOW, path: BS, channelId: "bs/you", result: "published", url: "https://bsky.app/profile/you/post/1" }]);
  });

  it("refuses a link to another platform and writes nothing (review focus 4)", async () => {
    const c = await makeCtx({ seed: true });
    const before = await fm(c, BS);
    expect(await c.ctx.publish.markPublished(BS, "bs/you", "https://x.com/you/status/1")).toEqual({
      ok: false,
      reason: "That isn't a Bluesky link (expected bsky.app).",
    });
    expect(await fm(c, BS)).toEqual(before);
    expect(c.log.entries).toEqual([]);
  });

  it("can mark without a link, and undo it", async () => {
    const c = await makeCtx({ seed: true });
    await c.ctx.publish.markPublished(BS, "bs/you");
    await indexed(c.index, () => c.index.getVariant(BS)?.status === "published");
    expect(Notice.messages.at(-1)).toBe("Marked @you.bsky.social as published. Undo");
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(c.index, () => c.index.getVariant(BS)?.status === "scheduled");
    expect(c.index.getVariant(BS)!.deliveries["bs/you"]).toEqual({ status: "scheduled" });
  });

  it("refuses a channel that is already published", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.publish.markPublished(LI, "li/me", "https://www.linkedin.com/feed/update/2")).toEqual({
      ok: false,
      reason: "Me is already marked as published.",
    });
  });

  it("resolves a check-needed delivery", async () => {
    const path = "Social/Posts/Check.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", platform: "telegram", channels: ["tg/event-x"], status: "attention", deliveries: { "tg/event-x": { status: "check_needed" } } } }],
    });
    expect(await c.ctx.publish.markPublished(path, "tg/event-x", "https://t.me/eventx/12")).toEqual({ ok: true });
    await indexed(c.index, () => c.index.getVariant(path)?.status === "published");
  });
});

describe("PublishActions.skip and startAssisted", () => {
  it("skips with a reason", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.publish.skip(BS, "bs/you", "Posted by hand elsewhere")).toBe(true);
    await vi.waitFor(async () => expect(((await fm(c, BS)).deliveries as Record<string, unknown>)["bs/you"]).toEqual({ status: "skipped", reason: "Posted by hand elsewhere" }));
    expect(c.log.entries.at(-1)).toMatchObject({ result: "skipped" });
  });

  it("walks a draft channel through scheduled to awaiting_you", async () => {
    const c = await makeCtx({ seed: true });
    const path = "Social/Posts/WhatsApp reminder.md";
    expect(await c.ctx.publish.startAssisted(path, "wa/makers-berlin")).toBe(true);
    await indexed(c.index, () => c.index.getVariant(path)?.deliveries["wa/makers-berlin"]?.status === "awaiting_you");
  });

  it("refuses unreadable and finished deliveries", async () => {
    const path = "Social/Posts/Typo.md";
    const c = await makeCtx({
      seed: true,
      notes: [{ path, frontmatter: { type: "social-post", platform: "linkedin", channels: ["li/me"], status: "scheduled", deliveries: { "li/me": { status: "Handed-Over" } } } }],
    });
    expect(await c.ctx.publish.startAssisted(path, "li/me")).toBe(false);
    expect(await c.ctx.publish.markPublished(path, "li/me")).toEqual({
      ok: false,
      reason: "Me can't be marked as published: fix its delivery status in the note first.",
    });
    expect(await c.ctx.publish.startAssisted(LI, "li/me")).toBe(false);
  });
});

describe("Delivery.reason", () => {
  it("round-trips through frontmatter", () => {
    expect(serializeDelivery({ status: "skipped", reason: "Duplicate" })).toEqual({ status: "skipped", reason: "Duplicate" });
    const v = parseVariant({ platform: "x", channels: ["x/you"], deliveries: { "x/you": { status: "skipped", reason: "Duplicate" } } }, "p.md");
    expect(v.value?.deliveries["x/you"]).toEqual({ status: "skipped", reason: "Duplicate" });
  });
});
