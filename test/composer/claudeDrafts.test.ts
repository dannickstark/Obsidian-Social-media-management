import { describe, expect, it } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { Notice } from "../fakes/obsidian";
import { reminderSlots } from "../../src/reminders/reminders";
import { dueItems } from "../../src/scheduler/due";
import { indexed } from "../helpers";
import { makeCtx, TEST_NOW, type TestCtx } from "../ui/ctx";

const P = "Social/Event X/Event X – Mastodon.md";
const MIN = 60_000;
const offline = (over: Record<string, unknown> = {}, body = "Event X is back on the 12th.") => ({
  path: P,
  frontmatter: { type: "social-post", campaign: "[[Event X]]", platform: "mastodon", channels: ["ma/you"], status: "ready", review: "claude", scheduled_at: "2026-10-09T10:00:00+02:00", ...over },
  body,
});
async function fm(c: TestCtx): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(P)!)).frontmatter);
}

describe("notes written by Claude with Obsidian closed (#84)", () => {
  it("are never dispatched, marked overdue or reminded about, even when they claim to be scheduled (review focus 5)", async () => {
    const due = "2026-10-08T09:59:00+02:00";
    const held = await makeCtx({ seed: true, notes: [offline({ status: "scheduled", scheduled_at: due, deliveries: { "ma/you": { status: "scheduled" } } })] });
    expect(dueItems(held.index.variants(), TEST_NOW, 15).map((i) => i.path)).not.toContain(P);
    const soon = await makeCtx({ seed: true, notes: [offline({ status: "scheduled", scheduled_at: "2026-10-08T10:30:00+02:00", deliveries: { "ma/you": { status: "scheduled" } }, reminders: [60, 10] })] });
    expect(reminderSlots(soon.ctx.actions.rows(), TEST_NOW, TEST_NOW + 60 * MIN, TEST_NOW, (r) => r.variant.reminders ?? null).map((i) => i.path)).not.toContain(P);
    const released = await makeCtx({ seed: true, notes: [offline({ review: undefined, status: "scheduled", scheduled_at: due, deliveries: { "ma/you": { status: "scheduled" } } })] });
    expect(dueItems(released.index.variants(), TEST_NOW, 15).map((i) => i.path)).toContain(P);
  });

  it("are approved and scheduled in one write, with Undo", async () => {
    const c = await makeCtx({ seed: true, notes: [offline()] });
    expect(await c.ctx.composer.approveClaudeDraft(c.index.getVariant(P)!)).toBe(true);
    await indexed(c.index, () => c.index.getVariant(P)?.review === undefined);
    const after = await fm(c);
    expect(after.review).toBeUndefined();
    expect(after.status).toBe("scheduled");
    expect(after.deliveries).toEqual({ "ma/you": { status: "scheduled" } });
    expect(Notice.messages.at(-1)).toContain("Approved and scheduled");
  });

  it("are not approved with blocking issues or a past time", async () => {
    const long = await makeCtx({ seed: true, notes: [offline({}, "a".repeat(600))] });
    expect(await long.ctx.composer.approveClaudeDraft(long.index.getVariant(P)!)).toBe(false);
    expect(Notice.messages.at(-1)).toContain("The text is 600/500 characters.");
    expect((await fm(long)).review).toBe("claude");
    const late = await makeCtx({ seed: true, notes: [offline({ scheduled_at: "2026-10-08T09:00:00+02:00" })] });
    expect(await late.ctx.composer.approveClaudeDraft(late.index.getVariant(P)!)).toBe(false);
    expect(Notice.messages.at(-1)).toBe("The proposed time has passed. Pick a new time in the composer.");
  });

  it("can be kept as a draft, which unschedules whatever they claimed", async () => {
    const c = await makeCtx({ seed: true, notes: [offline({ status: "scheduled", deliveries: { "ma/you": { status: "scheduled" } } })] });
    expect(await c.ctx.composer.keepClaudeDraft(c.index.getVariant(P)!)).toBe(true);
    const after = await fm(c);
    expect([after.review, after.status, after.deliveries]).toEqual([undefined, "draft", { "ma/you": { status: "draft" } }]);
  });
});
