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
});
