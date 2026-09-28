import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import ActionsBar from "../../src/composer/ActionsBar.svelte";
import { osmmContext } from "../../src/ui/context";
import Sidebar from "../../src/views/Sidebar.svelte";
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
    // Fix round 1 (m6): actually run Undo, not just check the Notice.
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(c.index, () => c.index.getVariant(P)?.review === "claude");
    expect((await fm(c)).review).toBe("claude");
    expect((await fm(c)).status).toBe("ready");
  });

  it("hold on any non-blank review value, even in dueItems (#84 fix round 1, I1)", async () => {
    for (const val of ["Claude", "claude ", "yes", true, ["claude"]]) {
      const c = await makeCtx({
        seed: true,
        notes: [offline({ review: val, status: "scheduled", scheduled_at: "2026-10-08T09:59:00+02:00", deliveries: { "ma/you": { status: "scheduled" } } })],
      });
      expect(dueItems(c.index.variants(), TEST_NOW, 15).map((i) => i.path)).not.toContain(P);
    }
  });

  it("releases review when the user schedules it from the composer (#84 fix round 1, I3)", async () => {
    const c = await makeCtx({ seed: true, notes: [offline()] });
    const v = c.index.getVariant(P)!;
    const at = Date.parse("2026-10-09T12:00:00+02:00");
    expect(await c.ctx.composer.schedule(v, { at, reminders: [] }, [])).toBe(true);
    await indexed(c.index, () => c.index.getVariant(P)?.review === undefined);
    expect((await fm(c)).review).toBeUndefined();
    expect(dueItems(c.index.variants(), at + 1000, 15).some((i) => i.path === P)).toBe(true);
  });

  it("releases review from an already-posted note without claiming anything was scheduled (#84 fix round 1, m1)", async () => {
    const already = { status: "published", deliveries: { "ma/you": { status: "published", at: "2026-10-08T09:00:00+02:00", url: "https://mastodon.social/@you/1" } } };
    for (const over of [{}, { scheduled_at: undefined }]) {
      const c = await makeCtx({ seed: true, notes: [offline({ ...already, ...over })] });
      expect(await c.ctx.composer.approveClaudeDraft(c.index.getVariant(P)!)).toBe(true);
      expect(Notice.messages.at(-1)).not.toContain("scheduled");
      await indexed(c.index, () => c.index.getVariant(P)?.review === undefined);
      expect((await fm(c)).review).toBeUndefined();
      expect((await fm(c)).status).toBe("published");
    }
  });

  it("keep (dismiss) also releases review when nothing is pending (#84 fix round 1, m1)", async () => {
    const c = await makeCtx({
      seed: true,
      notes: [offline({ scheduled_at: undefined, status: "published", deliveries: { "ma/you": { status: "published", at: "2026-10-08T09:00:00+02:00", url: "https://mastodon.social/@you/1" } } })],
    });
    expect(await c.ctx.composer.keepClaudeDraft(c.index.getVariant(P)!)).toBe(true);
    const after = await fm(c);
    expect(after.review).toBeUndefined();
    expect(after.status).toBe("published");
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

describe("Post now on a held note (final review 8)", () => {
  const heldAssisted = (over: Record<string, unknown> = {}) => offline({ mode: "assisted", ...over });

  it("is refused outside the composer: the hold stays and nothing opens", async () => {
    const c = await makeCtx({ seed: true, notes: [heldAssisted()] });
    const open = vi.spyOn(c.ctx.publish, "openAssisted").mockReturnValue(true);
    await c.ctx.publish.postNow(P, ["ma/you"]);
    expect(Notice.messages.at(-1)).toBe("Approve it first in Written by Claude.");
    expect(open).not.toHaveBeenCalled();
    expect((await fm(c)).review).toBe("claude");
  });

  it("releases the hold from the composer's own Post now, then opens the assisted flow", async () => {
    const c = await makeCtx({ seed: true, notes: [heldAssisted()] });
    const open = vi.spyOn(c.ctx.publish, "openAssisted").mockReturnValue(true);
    render(ActionsBar, { props: { variant: c.index.getVariant(P)! }, context: osmmContext(c.ctx) });
    await fireEvent.click(screen.getByRole("button", { name: "Post now" }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(P, ["ma/you"]));
    expect((await fm(c)).review).toBeUndefined();
  });

  it("offers Review… instead of Post again in Needs attention", async () => {
    const c = await makeCtx({ seed: true, notes: [heldAssisted({ status: "attention", deliveries: { "ma/you": { status: "failed", error: "Boom" } } })] });
    const compose = vi.spyOn(c.ctx.composer, "openComposer").mockResolvedValue();
    const postNow = vi.spyOn(c.ctx.publish, "postNow");
    render(Sidebar, { context: osmmContext(c.ctx) });
    const attention = screen.getByRole("region", { name: /Needs attention/ });
    const title = c.index.getVariant(P)!.displayTitle;
    expect(within(attention).queryByRole("button", { name: `Post ${title} on @you@mastodon.social again` })).toBeNull();
    await fireEvent.click(within(attention).getByRole("button", { name: `Review ${title}` }));
    expect(compose).toHaveBeenCalledWith(P);
    expect(postNow).not.toHaveBeenCalled();
  });
});
