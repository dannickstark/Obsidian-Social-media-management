import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  campaignProgress,
  expandRows,
  filterRows,
  overdueRows,
  rowsBetween,
  unscheduledRows,
  upcomingRows,
} from "../../src/index/queries";
import { indexStore } from "../../src/index/stores";
import { SocialIndex, type IndexedVariant } from "../../src/index/socialIndex";
import { createApp, nextChange, writeNote } from "../helpers";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 8, 10);

function v(partial: Partial<IndexedVariant> & Pick<IndexedVariant, "path" | "platform">): IndexedVariant {
  return {
    channels: [],
    mode: "auto",
    status: "draft",
    media: [],
    deliveries: {},
    issues: [],
    excerpt: "",
    displayTitle: partial.path,
    file: {} as IndexedVariant["file"],
    ...partial,
  };
}

const variants = [
  v({ path: "li.md", platform: "linkedin", campaignPath: "ex.md", channels: ["li/me", "li/acme"], scheduledAt: NOW + H, staggerMinutes: 15, deliveries: { "li/me": { status: "published" }, "li/acme": { status: "scheduled" } } }),
  v({ path: "ig.md", platform: "instagram", campaignPath: "ex.md", channels: ["ig/acme"], scheduledAt: NOW - 2 * H, deliveries: { "ig/acme": { status: "scheduled" } } }),
  v({ path: "hn.md", platform: "hackernews", channels: ["hn/you"], scheduledAt: NOW - H, deliveries: { "hn/you": { status: "overdue" } } }),
  v({ path: "idea.md", platform: "x", status: "idea" }),
];

describe("expandRows", () => {
  const rows = expandRows(variants, 10);

  it("creates one row per channel and one for channel-less variants", () => {
    expect(rows.map((r) => r.key)).toEqual(["li.md#li/me", "li.md#li/acme", "ig.md#ig/acme", "hn.md#hn/you", "idea.md#"]);
    expect(rows.find((r) => r.key === "idea.md#")).toMatchObject({ channelId: null, status: "idea", at: undefined });
  });

  it("applies stagger to delivery times", () => {
    expect(rows.find((r) => r.key === "li.md#li/acme")?.at).toBe(NOW + H + 15 * 60_000);
  });
});

describe("row queries", () => {
  const rows = expandRows(variants, 10);

  it("filters by platform, channel, campaign and status", () => {
    expect(filterRows(rows, { platforms: ["linkedin"] }).map((r) => r.key)).toEqual(["li.md#li/me", "li.md#li/acme"]);
    expect(filterRows(rows, { channelIds: ["ig/acme"] }).map((r) => r.key)).toEqual(["ig.md#ig/acme"]);
    expect(filterRows(rows, { campaignPaths: [""] }).map((r) => r.key)).toEqual(["hn.md#hn/you", "idea.md#"]);
    expect(filterRows(rows, { statuses: ["published"] }).map((r) => r.key)).toEqual(["li.md#li/me"]);
    expect(filterRows(rows, {})).toHaveLength(rows.length);
  });

  it("finds rows in a time range, sorted", () => {
    expect(rowsBetween(rows, NOW - 3 * H, NOW + H).map((r) => r.key)).toEqual(["ig.md#ig/acme", "hn.md#hn/you"]);
  });

  it("finds overdue rows: past scheduled rows and explicit overdue", () => {
    expect(overdueRows(rows, NOW).map((r) => r.key)).toEqual(["ig.md#ig/acme", "hn.md#hn/you"]);
  });

  it("finds upcoming and unscheduled rows", () => {
    expect(upcomingRows(rows, NOW, 2 * H).map((r) => r.key)).toEqual(["li.md#li/acme"]);
    expect(unscheduledRows(rows).map((r) => r.key)).toEqual(["idea.md#"]);
  });

  it("computes campaign progress", () => {
    expect(campaignProgress(variants, "ex.md")).toEqual({ published: 1, total: 3 });
  });
});

describe("status handling for posts without delivery records", () => {
  it("preserves published status for channel-less variant with no deliveries", () => {
    const published = v({ path: "p.md", platform: "x", status: "published", campaignPath: "camp.md" });
    const rows = expandRows([published], 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelId: null, status: "published" });
    expect(campaignProgress([published], "camp.md")).toEqual({ published: 1, total: 1 });
  });

  it("applies stored status to all rows when variant has no delivery records", () => {
    const skipped = v({ path: "skip.md", platform: "x", status: "skipped", channels: ["x/main", "x/alt"] });
    const rows = expandRows([skipped], 10);
    expect(rows.map((r) => ({ key: r.key, status: r.status }))).toEqual([
      { key: "skip.md#x/main", status: "skipped" },
      { key: "skip.md#x/alt", status: "skipped" },
    ]);
  });

  it("maps attention→failed and partial→scheduled for variants without deliveries", () => {
    const attention = v({ path: "att.md", platform: "x", status: "attention", channels: ["x/main"] });
    const partial = v({ path: "par.md", platform: "x", status: "partial", channels: ["x/main"] });
    const rows = expandRows([attention, partial], 10);
    expect(rows.find((r) => r.key === "att.md#x/main")?.status).toBe("failed");
    expect(rows.find((r) => r.key === "par.md#x/main")?.status).toBe("scheduled");
  });

  it("partially-delivered variant: uncovered channel row inherits scheduled when scheduledAt is set", () => {
    const partial = v({
      path: "mixed.md",
      platform: "x",
      status: "partial",
      scheduledAt: NOW,
      channels: ["x/one", "x/two"],
      deliveries: { "x/one": { status: "published" } },
    });
    const rows = expandRows([partial], 10);
    expect(rows.find((r) => r.key === "mixed.md#x/one")?.status).toBe("published");
    expect(rows.find((r) => r.key === "mixed.md#x/two")?.status).toBe("scheduled");
  });

  it("partially-delivered variant: uncovered channel row is draft without scheduledAt", () => {
    const partial = v({
      path: "mixed.md",
      platform: "x",
      status: "partial",
      channels: ["x/one", "x/two"],
      deliveries: { "x/one": { status: "published" } },
    });
    expect(expandRows([partial], 10).find((r) => r.key === "mixed.md#x/two")?.status).toBe("draft");
  });

  it("keeps idea rows for idea variants with some records", () => {
    const idea = v({ path: "i.md", platform: "x", status: "idea", channels: ["x/one", "x/two"], deliveries: { "x/one": { status: "draft" } } });
    expect(expandRows([idea], 10).find((r) => r.key === "i.md#x/two")?.status).toBe("idea");
  });

  it("ignores records for unlisted channels when deciding whether the stored status is authoritative", () => {
    const skipped = v({ path: "s.md", platform: "x", status: "skipped", channels: ["x/one"], deliveries: { "x/gone": { status: "published" } } });
    expect(expandRows([skipped], 10)[0]?.status).toBe("skipped");
  });
});

describe("indexStore", () => {
  it("publishes a new snapshot on every index change", async () => {
    const app = createApp();
    const index = new SocialIndex(app, 0);
    await index.build();
    index.start();
    const store = indexStore(index);
    const seen: number[] = [];
    const off = store.subscribe((s) => seen.push(s.variants.length));
    const change = nextChange(index);
    await writeNote(app, "Social/Posts/Solo.md", { type: "social-post", platform: "x", title: "Solo" });
    await change;
    expect(seen).toEqual([0, 1]);
    expect(get(store).revision).toBe(index.revision);
    off();
    index.stop();
  });
});
