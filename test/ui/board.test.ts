import { describe, expect, it } from "vitest";
import { Notice } from "../fakes/obsidian";
import { makeCtx, TEST_NOW } from "./ctx";
import { settle } from "../helpers";

describe("board actions", () => {
  it("schedules a ready post", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const post = index.variants().find((x) => x.status === "ready")!;
    await ctx.actions.schedule(post, TEST_NOW + 86_400_000);
    await settle(5);
    const after = index.getVariant(post.path)!;
    expect(after.status).toBe("scheduled");
    expect(after.scheduledAt).toBe(TEST_NOW + 86_400_000);
  });

  it("explains a refused move", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const published = index.variants().find((x) => x.status === "published")!;
    await ctx.actions.moveOnBoard(published, "draft");
    expect(Notice.messages.at(-1)).toBe("Published posts stay published.");
  });

  it("syncs delivery records when moving back to ready after a schedule/unschedule cycle", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const post = index.variants().find((x) => x.status === "ready")!;
    await ctx.actions.schedule(post, TEST_NOW + 86_400_000);
    await settle(5);
    const scheduled = index.getVariant(post.path)!;
    await ctx.actions.unschedule(scheduled, "draft");
    await settle(5);
    const draft = index.getVariant(post.path)!;
    await ctx.actions.moveOnBoard(draft, "ready");
    await settle(5);
    const after = index.getVariant(post.path)!;
    expect(after.status).toBe("ready");
    expect(Object.values(after.deliveries).length).toBeGreaterThan(0);
    expect(Object.values(after.deliveries).every((d) => d.status === "ready")).toBe(true);
  });

  it("setStatus shows a notice with an Undo button that restores the previous status", async () => {
    const { ctx, index } = await makeCtx({ seed: true });
    const post = index.variants().find((x) => x.status === "idea")!;
    await ctx.actions.setStatus(post, "ready");
    await settle(5);
    expect(index.getVariant(post.path)!.status).toBe("ready");
    Notice.last!.noticeEl.querySelector("button")!.click();
    await settle(5);
    expect(index.getVariant(post.path)!.status).toBe("idea");
  });
});
