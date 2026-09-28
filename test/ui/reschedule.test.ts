import { describe, expect, it } from "vitest";
import { Notice } from "../fakes/obsidian";
import { makeCtx, TEST_NOW } from "./ctx";
import { settle } from "../helpers";

describe("PlannerActions.reschedule", () => {
  it("writes the new time and restores it on undo", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const row = ctx.actions.rows().find((r) => r.key === "Social/Event X/Event X – Bluesky.md#bs/you")!;
    const target = TEST_NOW + 2 * 86_400_000;
    expect(await ctx.actions.reschedule(row, { at: target })).toBe(true);
    await settle(5);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(target);
    Notice.last!.noticeEl.querySelector("button")!.click();
    await settle(5);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(row.variant.scheduledAt);
  });

  it("does nothing when confirmation is declined", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    ctx.actions.confirm = async () => false;
    const row = ctx.actions.rows().find((r) => r.status === "handed_over")!;
    expect(await ctx.actions.reschedule(row, { at: TEST_NOW })).toBe(false);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(row.variant.scheduledAt);
  });

  it("explains refusals in a notice", async () => {
    const { ctx } = await makeCtx({ seed: true });
    const row = ctx.actions.rows().find((r) => r.status === "published")!;
    expect(await ctx.actions.reschedule(row, { at: TEST_NOW })).toBe(false);
    expect(Notice.messages.at(-1)).toBe("Published or skipped posts can't be rescheduled.");
  });
});
