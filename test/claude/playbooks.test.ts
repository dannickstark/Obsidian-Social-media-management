import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_META, PLATFORMS } from "../../src/model/platforms";
import { fmt } from "../../src/platforms/checks";
import { PLATFORM_DEFS } from "../../src/platforms/registry";

// jsdom's URL implementation rejects a relative `new URL(..., import.meta.url)` (not a file: URL
// there, as test/claude/package.test.ts also notes), so the repo root comes from process.cwd()
// (vitest always runs from the repo root).
const read = (p: string) => readFileSync(join(process.cwd(), `claude-plugin/skills/social/references/platforms/${p}.md`), "utf8");

describe.each([...PLATFORMS])("%s playbook (#82)", (p) => {
  it("states the limits the plugin checks, with no emoji", () => {
    const text = read(p);
    const { limits, media, threads } = PLATFORM_DEFS[p].capabilities;
    expect(text.startsWith(`# ${PLATFORM_META[p].label}\n`)).toBe(true);
    expect(text).toContain(`Hard limit: ${fmt(limits.maxChars)} characters`);
    if (limits.foldAt) expect(text).toContain(`folds after about ${fmt(limits.foldAt)} characters`);
    if (limits.titleMax) expect(text).toContain(`Title: at most ${fmt(limits.titleMax)} characters`);
    if (limits.maxHashtags) expect(text).toContain(`at most ${limits.maxHashtags} hashtags`);
    if (limits.maxCharsWithMedia) expect(text).toContain(`${fmt(limits.maxCharsWithMedia)} characters when an image is attached`);
    if (threads) expect(text).toContain("a line with only ---");
    if (media.required) expect(text).toContain("needs at least one image");
    for (const section of ["## Format", "## Tone", "## Length", "## Hashtags", "## Links", "## Structure", "## Checklist"]) expect(text).toContain(section);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
