import { describe, expect, it } from "vitest";
import { Notice } from "../fakes/obsidian";
import { makeCtx, TEST_NOW } from "./ctx";
import { indexed } from "../helpers";
import { ROW_MIME } from "../../src/ui/actions";

describe("PlannerActions.reschedule", () => {
  it("writes the new time and restores it on undo", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const row = ctx.actions.rows().find((r) => r.key === "Social/Event X/Event X – Bluesky.md#bs/you")!;
    const target = TEST_NOW + 2 * 86_400_000;
    const original = row.variant.scheduledAt;
    expect(await ctx.actions.reschedule(row, { at: target })).toBe(true);
    await indexed(index, () => index.getVariant(row.variant.path)?.scheduledAt === target);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(target);
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(index, () => index.getVariant(row.variant.path)?.scheduledAt === original);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(original);
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

  const dropEvent = (key: string) =>
    ({ preventDefault: () => undefined, dataTransfer: { getData: (mime: string) => (mime === ROW_MIME ? key : "") } }) as unknown as DragEvent;

  it("dropOnSlot reschedules the dragged row to that day and minute (G2)", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const key = "Social/Event X/Event X – Bluesky.md#bs/you";
    const path = "Social/Event X/Event X – Bluesky.md";
    const day = new Date(2026, 9, 14).getTime();
    ctx.actions.dropOnSlot(dropEvent(key), day, 14 * 60 + 45);
    const expected = new Date(2026, 9, 14, 14, 45).getTime();
    await indexed(index, () => index.getVariant(path)?.scheduledAt === expected);
    expect(index.getVariant(path)?.scheduledAt).toBe(expected);
  });

  it("dropOnDay keeps the row's time of day (G2)", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const key = "Social/Event X/Event X – Bluesky.md#bs/you";
    const row = ctx.actions.rowByKey(key)!;
    const at = new Date(row.at!);
    const expected = new Date(2026, 9, 14, at.getHours(), at.getMinutes()).getTime();
    ctx.actions.dropOnDay(dropEvent(key), new Date(2026, 9, 14).getTime());
    await indexed(index, () => index.getVariant(row.variant.path)?.scheduledAt === expected);
    expect(index.getVariant(row.variant.path)?.scheduledAt).toBe(expected);
  });
});
