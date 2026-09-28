import { describe, expect, it } from "vitest";
import { sortRows, uniqueVariants } from "../../src/planner/list";
import type { PostRow } from "../../src/index/queries";

const row = (key: string, at: number | undefined, platform: string, title: string): PostRow =>
  ({ key, at, status: "scheduled", channelId: null, variant: { path: key.split("#")[0], platform, displayTitle: title } }) as unknown as PostRow;

describe("list", () => {
  const rows = [row("a.md#", 3, "x", "Beta"), row("b.md#", undefined, "linkedin", "alpha"), row("c.md#", 1, "bluesky", "Gamma")];

  it("sorts by time with unscheduled rows last", () => {
    expect(sortRows(rows, "at", "asc").map((r) => r.key)).toEqual(["c.md#", "a.md#", "b.md#"]);
    expect(sortRows(rows, "at", "desc").map((r) => r.key)).toEqual(["a.md#", "c.md#", "b.md#"]);
  });

  it("sorts by title case-insensitively and by platform label", () => {
    expect(sortRows(rows, "title", "asc").map((r) => r.key)).toEqual(["b.md#", "a.md#", "c.md#"]);
    expect(sortRows(rows, "platform", "asc").map((r) => r.key)).toEqual(["c.md#", "b.md#", "a.md#"]);
  });

  it("deduplicates variants", () => {
    const v = { path: "p.md" };
    expect(uniqueVariants([{ variant: v }, { variant: v }] as unknown as PostRow[])).toHaveLength(1);
  });
});
