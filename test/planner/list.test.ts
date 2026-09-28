import { describe, expect, it } from "vitest";
import { frozenForMove, sortRows, statusEditable, uniqueVariants } from "../../src/planner/list";
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

describe("frozenForMove / statusEditable (G3)", () => {
  const v = (partial: Record<string, unknown>) =>
    ({ path: "p.md", platform: "linkedin", channels: ["li/me", "li/acme"], mode: "auto", status: "scheduled", media: [], deliveries: {}, scheduledAt: 0, ...partial }) as never;

  it("counts a stored published status without delivery records as frozen", () => {
    expect(frozenForMove(v({ status: "published" }), 0)).toBe(true);
    expect(statusEditable(v({ status: "published" }), 0)).toBe(false);
  });

  it("is frozen when any row is published, publishing, handed over or skipped", () => {
    for (const status of ["published", "publishing", "handed_over", "skipped"]) {
      expect(frozenForMove(v({ deliveries: { "li/me": { status } } }), 0)).toBe(true);
    }
    expect(frozenForMove(v({ deliveries: { "li/me": { status: "overdue" } } }), 0)).toBe(false);
    expect(frozenForMove(v({}), 0)).toBe(false);
  });

  it("allows a status change only when every row is idea, draft or ready", () => {
    expect(statusEditable(v({ status: "idea" }), 0)).toBe(true);
    expect(statusEditable(v({ status: "ready", deliveries: { "li/me": { status: "draft" } } }), 0)).toBe(true);
    expect(statusEditable(v({ status: "draft", deliveries: { "li/me": { status: "scheduled" } } }), 0)).toBe(false);
    expect(statusEditable(v({ status: "scheduled" }), 0)).toBe(false);
  });
});
