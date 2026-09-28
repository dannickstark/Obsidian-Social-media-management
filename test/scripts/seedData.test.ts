import { describe, expect, it } from "vitest";
import { buildSeed } from "../../scripts/seedData";
import { parseCampaign, parseVariant } from "../../src/model/frontmatter";
import { migrateSettings } from "../../src/settings/settings";

const NOW = Date.UTC(2026, 9, 8, 8);

describe("seed data", () => {
  const seed = buildSeed(NOW);

  it("produces notes that parse without errors or warnings", () => {
    for (const note of seed.notes) {
      const parsed = note.frontmatter.type === "social-campaign" ? parseCampaign(note.frontmatter, note.path) : parseVariant(note.frontmatter, note.path);
      expect({ path: note.path, issues: parsed.issues }).toEqual({ path: note.path, issues: [] });
    }
  });

  it("covers every delivery state the UI must show", () => {
    const statuses = new Set(seed.notes.flatMap((n) => Object.values((n.frontmatter.deliveries ?? {}) as Record<string, { status: string }>).map((d) => d.status)));
    for (const s of ["published", "scheduled", "awaiting_you", "overdue", "failed"]) expect(statuses).toContain(s);
  });

  it("produces valid settings with channels for every platform used", () => {
    const settings = migrateSettings(seed.settings);
    const ids = new Set(settings.channels.map((c) => c.id));
    for (const n of seed.notes) for (const id of (n.frontmatter.channels ?? []) as string[]) expect(ids).toContain(id);
  });

  it("generates 5,000+ notes in large mode", () => {
    expect(buildSeed(NOW, { large: true }).notes.length).toBeGreaterThanOrEqual(5000);
  });
});
