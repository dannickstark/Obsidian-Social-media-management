import { describe, expect, it } from "vitest";
import { chipStyle } from "../../src/planner/status";
import type { PostRow } from "../../src/index/queries";

const row = (status: PostRow["status"], at?: number, mode: "auto" | "assisted" = "auto") =>
  ({ key: "k", channelId: "li/me", status, at, variant: { mode } }) as unknown as PostRow;

describe("chipStyle", () => {
  it.each<[PostRow, string]>([
    [row("published"), "published"],
    [row("failed"), "attention"],
    [row("check_needed"), "attention"],
    [row("overdue"), "overdue"],
    [row("scheduled", 0), "overdue"],
    [row("scheduled", 10_000), "auto"],
    [row("scheduled", 10_000, "assisted"), "assisted"],
    [row("awaiting_you", 10_000), "assisted"],
    [row("handed_over", 0), "auto"],
    [row("draft"), "draft"],
    [row("skipped"), "draft"],
  ])("%o → %s", (r, expected) => {
    expect(chipStyle(r, 5_000)).toBe(expected);
  });

  it("uses the channel method", () => {
    expect(chipStyle(row("scheduled", 10_000), 5_000, { method: "assisted" } as never)).toBe("assisted");
  });
});
