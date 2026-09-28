import { describe, expect, it } from "vitest";
import { makeCtx } from "./ctx";
import { settle } from "../helpers";

describe("bulk actions", () => {
  it("shifts every selected post once and skips frozen ones", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    // Selects "Event X – LinkedIn" (one channel published → skipped), "LinkedIn recap" and "Bluesky" (both moved).
    const rows = ctx.actions.rows().filter((r) => r.variant.path.includes("Event X – LinkedIn") || r.variant.path.includes("Bluesky"));
    const before = new Map(rows.map((r) => [r.variant.path, r.variant.scheduledAt!]));
    const result = await ctx.actions.bulkShift(rows, 86_400_000);
    await settle(5);
    expect(result).toEqual({ moved: 2, skipped: 1 });
    for (const [path, at] of before) {
      const expected = path.endsWith("Event X – LinkedIn.md") ? at : at + 86_400_000;
      expect(index.getVariant(path)?.scheduledAt).toBe(expected);
    }
  });

  it("skips posts with channels beyond ready when changing status (review focus 5)", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const rows = ctx.actions.rows().filter((r) => r.variant.path.includes("OSMM launch") || r.variant.path.includes("Event X – LinkedIn.md"));
    const result = await ctx.actions.bulkSetStatus(rows, "draft");
    await settle(5);
    expect(result).toEqual({ changed: 2, skipped: 1 });
    expect(index.getVariant("Social/Event X/Event X – LinkedIn.md")?.status).toBe("partial");
    expect(index.getVariant("Social/OSMM launch/OSMM launch – Indie Hackers.md")?.status).toBe("draft");
  });

  it("moves selected notes to the trash after confirmation", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    ctx.actions.confirm = async () => true;
    const rows = ctx.actions.rows().filter((r) => r.variant.path.startsWith("Social/Posts/"));
    expect(await ctx.actions.bulkTrash(rows)).toBe(2);
    expect(app.vault.getFileByPath("Social/Posts/WhatsApp reminder.md")).toBeNull();
  });
});
