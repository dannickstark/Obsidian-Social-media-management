import { describe, expect, it } from "vitest";
import { campaignTable } from "../../src/planner/campaignTable";
import { buildSeed } from "../../scripts/seedData";
import { migrateSettings } from "../../src/settings/settings";
import type { IndexedVariant } from "../../src/index/socialIndex";

const channels = migrateSettings(buildSeed(0).settings).channels;
const v = (path: string, platform: IndexedVariant["platform"], status: IndexedVariant["status"], ids: string[], campaignPath = "ex.md") =>
  ({ path, platform, status, channels: ids, campaignPath, deliveries: {}, bodyChars: 10, scheduledAt: 1 }) as unknown as IndexedVariant;

describe("campaignTable", () => {
  const variants = [
    v("li.md", "linkedin", "partial", ["li/me", "li/acme-studio"]),
    v("x.md", "x", "published", ["x/you"]),
    v("ig.md", "instagram", "overdue", ["ig/acmestudio"]),
    v("other.md", "x", "draft", ["x/you"], "other.md"),
  ];
  const table = campaignTable("ex.md", variants, channels);

  it("lists the campaign's variants in platform order with resolved channels", () => {
    expect(table.rows.map((r) => r.variant.path)).toEqual(["li.md", "x.md", "ig.md"]);
    expect(table.rows[0]!.channels.map((c) => c.name)).toEqual(["Me", "Acme Studio"]);
  });

  it("offers platforms that have channels but no variant yet", () => {
    expect(table.missing).toEqual(["facebook", "mastodon", "bluesky", "telegram", "discord", "hackernews", "indiehackers", "whatsapp", "wordpress"]);
  });

  it("counts created, published and overdue variants", () => {
    expect(table.counts).toEqual({ created: 3, published: 1, overdue: 1 });
  });
});
