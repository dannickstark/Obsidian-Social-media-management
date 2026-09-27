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
