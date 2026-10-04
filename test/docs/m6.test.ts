import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const GUIDES = ["facebook", "instagram", "x", "linkedin"] as const;
/** Every setup guide answers the same questions, under the same headings. */
const SECTIONS = [
  "## Register an app",
  "## Scopes and permissions",
  "## Choose the account",
  "## Limitations",
  "## Test the connection",
  "## Assisted fallback",
  "## Where the credential is stored",
];

describe("M6 platform setup guides (#112)", () => {
  for (const guide of GUIDES) {
    it(`documents every setup step for ${guide}`, () => {
      const doc = read(`docs/setup/${guide}.md`);
      for (const section of SECTIONS) expect(doc).toContain(section);
      expect(doc).toMatch(/secret storage/i);
      expect(doc).toMatch(/Assisted/);
    });

    it(`does not overstate what ${guide} can do today`, () => {
      const doc = read(`docs/setup/${guide}.md`);
      expect(doc).toMatch(/unverified|not (?:been )?verified/i);
      // No example credential that could be mistaken for a real one.
      expect(doc).not.toMatch(
        /EAA[A-Za-z0-9]{20,}|AQ[A-Za-z0-9_-]{40,}|Bearer [A-Za-z0-9._-]{20,}/,
      );
    });
  }

  it("names the permissions each provider requires", () => {
    expect(read("docs/setup/facebook.md")).toMatch(
      /pages_show_list[\s\S]*pages_read_engagement[\s\S]*pages_manage_posts/,
    );
    expect(read("docs/setup/instagram.md")).toContain("instagram_content_publish");
    expect(read("docs/setup/instagram.md")).toContain("CREATE_CONTENT");
    expect(read("docs/setup/x.md")).toMatch(/tweet\.write[\s\S]*media\.write/);
    expect(read("docs/setup/linkedin.md")).toMatch(/w_member_social[\s\S]*w_organization_social/);
  });

  it("is linked from the getting-started guide and the README", () => {
    for (const guide of GUIDES) {
      expect(read("docs/getting-started.md")).toContain(`setup/${guide}.md`);
      expect(read("README.md")).toContain(`docs/setup/${guide}.md`);
    }
  });
});

describe("M6 smoke checklist and release gates (#112)", () => {
  it("covers OAuth, both modes, Meta image hosting, Facebook native scheduling, generated images, and token health", () => {
    const doc = read("docs/qa/m6-smoke.md");
    for (const heading of [
      "## OAuth and credentials",
      "## API and assisted modes",
      "## Meta image hosting",
      "## Facebook native scheduling",
      "## Generated images",
      "## Token health",
      "## Community-plugin submission",
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it("is a gate in the release notes the release workflow publishes", () => {
    const notes = read(".github/release-notes.md");
    expect(notes).toContain("docs/qa/m6-smoke.md");
    expect(notes).toContain("docs/qa/m5-smoke.md");
    expect(notes).toMatch(/Community-plugin submission/);
  });

  it("no longer lists Facebook, Instagram, X and LinkedIn as next", () => {
    expect(read("README.md")).not.toContain("Facebook, Instagram, X and LinkedIn are next");
  });
});
