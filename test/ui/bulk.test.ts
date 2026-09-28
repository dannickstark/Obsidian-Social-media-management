import { describe, expect, it } from "vitest";
import { Notice } from "../fakes/obsidian";
import { makeCtx } from "./ctx";
import { AWAITING_MOVE } from "../../src/ui/actions";
import { indexed } from "../helpers";

describe("bulk actions", () => {
  it("shifts every selected post once and skips frozen ones", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    // Selects "Event X – LinkedIn" (one channel published → skipped), "LinkedIn recap" and "Bluesky" (both moved).
    const rows = ctx.actions.rows().filter((r) => r.variant.path.includes("Event X – LinkedIn") || r.variant.path.includes("Bluesky"));
    const before = new Map(rows.map((r) => [r.variant.path, r.variant.scheduledAt!]));
    const expectedAfterShift = (path: string, at: number) => (path.endsWith("Event X – LinkedIn.md") ? at : at + 86_400_000);
    const result = await ctx.actions.bulkShift(rows, 86_400_000);
    await indexed(index, () => [...before].every(([path, at]) => index.getVariant(path)?.scheduledAt === expectedAfterShift(path, at)));
    expect(result).toEqual({ moved: 2, skipped: 1 });
    for (const [path, at] of before) {
      expect(index.getVariant(path)?.scheduledAt).toBe(expectedAfterShift(path, at));
    }
  });

  it("offers Undo after bulkShift that restores every moved post's scheduledAt", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const rows = ctx.actions.rows().filter((r) => r.variant.path.includes("Event X – LinkedIn") || r.variant.path.includes("Bluesky"));
    const before = new Map(rows.map((r) => [r.variant.path, r.variant.scheduledAt!]));
    const expectedAfterShift = (path: string, at: number) => (path.endsWith("Event X – LinkedIn.md") ? at : at + 86_400_000);
    await ctx.actions.bulkShift(rows, 86_400_000);
    await indexed(index, () => [...before].every(([path, at]) => index.getVariant(path)?.scheduledAt === expectedAfterShift(path, at)));
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(index, () => [...before].every(([path, at]) => index.getVariant(path)?.scheduledAt === at));
    for (const [path, at] of before) {
      expect(index.getVariant(path)?.scheduledAt).toBe(at);
    }
  });

  it("skips posts with channels beyond ready when changing status (review focus 5)", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const rows = ctx.actions.rows().filter((r) => r.variant.path.includes("OSMM launch") || r.variant.path.includes("Event X – LinkedIn.md"));
    const result = await ctx.actions.bulkSetStatus(rows, "draft");
    await indexed(index, () => index.getVariant("Social/OSMM launch/OSMM launch – Indie Hackers.md")?.status === "draft");
    expect(result).toEqual({ changed: 2, skipped: 1 });
    expect(index.getVariant("Social/Event X/Event X – LinkedIn.md")?.status).toBe("partial");
    expect(index.getVariant("Social/OSMM launch/OSMM launch – Indie Hackers.md")?.status).toBe("draft");
  });

  it("offers Undo after bulkSetStatus that restores the previous statuses", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const rows = ctx.actions.rows().filter((r) => r.variant.path.includes("OSMM launch") || r.variant.path.includes("Event X – LinkedIn.md"));
    const before = new Map(
      rows.map((r) => [r.variant.path, { status: r.variant.status, deliveries: JSON.parse(JSON.stringify(r.variant.deliveries)) }]),
    );
    await ctx.actions.bulkSetStatus(rows, "draft");
    await indexed(index, () => index.getVariant("Social/OSMM launch/OSMM launch – Indie Hackers.md")?.status === "draft");
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(index, () => [...before].every(([path, prev]) => index.getVariant(path)?.status === prev.status));
    for (const [path, prev] of before) {
      expect(index.getVariant(path)?.status).toBe(prev.status);
      expect(index.getVariant(path)?.deliveries).toEqual(prev.deliveries);
    }
  });

  it("moves selected notes to the trash after confirmation", async () => {
    const { app, ctx } = await makeCtx({ seed: true });
    ctx.actions.confirm = async () => true;
    const rows = ctx.actions.rows().filter((r) => r.variant.path.startsWith("Social/Posts/"));
    expect(await ctx.actions.bulkTrash(rows)).toBe(2);
    expect(app.vault.getFileByPath("Social/Posts/WhatsApp reminder.md")).toBeNull();
  });

  const publishedNoRecords = {
    path: "Social/Posts/Done.md",
    frontmatter: { type: "social-post", platform: "linkedin", channels: ["li/me"], status: "published", scheduled_at: "2026-10-05T09:00:00+02:00" },
  };

  it("bulk shift skips a post stored as published without delivery records (G3)", async () => {
    const { ctx, index } = await makeCtx({ notes: [publishedNoRecords] });
    const rows = ctx.actions.rows().filter((r) => r.variant.path === publishedNoRecords.path);
    const before = index.getVariant(publishedNoRecords.path)!.scheduledAt;
    expect(await ctx.actions.bulkShift(rows, 86_400_000)).toEqual({ moved: 0, skipped: 1 });
    expect(index.getVariant(publishedNoRecords.path)!.scheduledAt).toBe(before);
  });

  it("bulk status skips a post stored as published without delivery records (G3)", async () => {
    const { ctx, index } = await makeCtx({ notes: [publishedNoRecords] });
    const rows = ctx.actions.rows().filter((r) => r.variant.path === publishedNoRecords.path);
    expect(await ctx.actions.bulkSetStatus(rows, "draft")).toEqual({ changed: 0, skipped: 1 });
    expect(index.getVariant(publishedNoRecords.path)!.status).toBe("published");
  });

  const awaiting = {
    path: "Social/Posts/Waiting.md",
    frontmatter: {
      type: "social-post",
      platform: "linkedin",
      channels: ["li/me"],
      status: "scheduled",
      scheduled_at: "2026-10-09T09:00:00+02:00",
      deliveries: { "li/me": { status: "awaiting_you", at: "2026-10-09T09:15:00+02:00" } },
    },
  };

  it("bulk shift asks before moving an awaiting-you delivery and leaves it when declined (ruling P2)", async () => {
    const { ctx, index } = await makeCtx({ notes: [awaiting] });
    const asked: string[] = [];
    ctx.actions.confirm = async (message) => {
      asked.push(message);
      return false;
    };
    const rows = ctx.actions.rows().filter((r) => r.variant.path === awaiting.path);
    const before = index.getVariant(awaiting.path)!;
    expect(await ctx.actions.bulkShift(rows, 86_400_000)).toEqual({ moved: 0, skipped: 1 });
    expect(asked).toEqual([AWAITING_MOVE]);
    expect(index.getVariant(awaiting.path)!.scheduledAt).toBe(before.scheduledAt);
    expect(index.getVariant(awaiting.path)!.deliveries["li/me"]).toEqual(before.deliveries["li/me"]);
  });

  it("bulk shift moves an awaiting-you delivery once confirmed and keeps it waiting (ruling P2)", async () => {
    const { ctx, index } = await makeCtx({ notes: [awaiting] });
    ctx.actions.confirm = async () => true;
    const rows = ctx.actions.rows().filter((r) => r.variant.path === awaiting.path);
    const before = index.getVariant(awaiting.path)!;
    expect(await ctx.actions.bulkShift(rows, 86_400_000)).toEqual({ moved: 1, skipped: 0 });
    await indexed(index, () => index.getVariant(awaiting.path)!.scheduledAt === before.scheduledAt! + 86_400_000);
    expect(index.getVariant(awaiting.path)!.deliveries["li/me"]).toEqual({ status: "awaiting_you", at: before.deliveries["li/me"]!.at! + 86_400_000 });
  });
});
