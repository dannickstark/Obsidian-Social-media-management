import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_META } from "../../src/model/platforms";
import { createAdapters } from "../../src/platforms/adapters";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const shipped = () =>
  createAdapters({ http: async () => ({ status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) }), now: () => 0, readBinary: async () => new ArrayBuffer(0), sleep: async () => undefined }).map((a) => a.platform);

describe("M5 smoke checklist (#111)", () => {
  it("has a section for every platform that posts through an API, and one for native scheduling", () => {
    const doc = read("docs/qa/m5-smoke.md");
    for (const p of shipped()) expect(doc).toContain(`## ${PLATFORM_META[p].label}`);
    expect(doc).toContain("## Native scheduling");
  });

  it("is linked from the release notes the release workflow publishes", () => {
    expect(read(".github/release-notes.md")).toContain("docs/qa/m5-smoke.md");
    expect(read(".github/workflows/release.yml")).toContain("--notes-file .github/release-notes.md");
  });

  it("no longer calls automatic posting a roadmap item", () => {
    expect(read("README.md")).not.toContain("automatic posting through the platforms' APIs is on the roadmap");
  });
});
