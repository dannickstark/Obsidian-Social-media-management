import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { buildSeed } from "../../scripts/seedData";
import { VOICE_TEMPLATE } from "../../src/claude/voice";
import { parseCampaign, parseVariant, socialKind } from "../../src/model/frontmatter";
import { validateAll } from "../../src/platforms/checks";
import { migrateSettings } from "../../src/settings/settings";
import { mcpCtx } from "../mcp/helpers";
import { TEST_NOW } from "../ui/ctx";

// jsdom's URL implementation rejects a relative `new URL(..., import.meta.url)` (not a file: URL
// there, as test/claude/package.test.ts also notes), so the repo root comes from process.cwd()
// (vitest always runs from the repo root).
const REFS = join(process.cwd(), "claude-plugin/skills/social/references");
const read = (name: string) => readFileSync(join(REFS, name), "utf8");
const EXAMPLE_RE = /^(`{4,})markdown\n([\s\S]*?)^\1$/gm;

describe("skill references", () => {
  it("documents exactly the tools the server offers", async () => {
    const c = await mcpCtx();
    const documented = [...read("tools.md").matchAll(/^### ([a-z_]+)$/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual(c.registry.names().sort());
    // Every input schema converts to JSON Schema (tools/list would fail for Claude otherwise).
    expect(c.registry.list().every((t) => t.inputSchema.type === "object")).toBe(true);
  });

  it("gives offline examples that the plugin reads without issues and that pass its checks (#84)", () => {
    const channels = migrateSettings(buildSeed(TEST_NOW).settings).channels;
    const blocks = [...read("file-format.md").matchAll(EXAMPLE_RE)].map((m) => m[2]!);
    const kinds = blocks.map((text) => {
      const info = getFrontMatterInfo(text);
      const fm = parseYaml(info.frontmatter) as Record<string, unknown>;
      const kind = socialKind(fm);
      if (kind === "campaign") {
        expect(parseCampaign(fm, "Social/Event X/Event X.md").issues).toEqual([]);
        return kind;
      }
      expect(kind).toBe("post");
      expect([fm.status, fm.review, fm.deliveries]).toEqual(["ready", "claude", undefined]);
      const parsed = parseVariant(fm, "Social/Event X/Example.md");
      expect(parsed.issues).toEqual([]);
      const v = parsed.value!;
      const errors = validateAll({ variant: v, body: text.slice(info.contentStart), media: [] }, channels.filter((ch) => v.channels.includes(ch.id))).filter(
        (i) => i.level === "error",
      );
      expect(errors).toEqual([]);
      return kind;
    });
    expect(kinds.filter((k) => k === "campaign")).toHaveLength(1);
    expect(kinds.filter((k) => k === "post").length).toBeGreaterThanOrEqual(4);
  });
});

// jsdom's URL implementation rejects a relative `new URL(..., import.meta.url)` (see REFS above),
// so this too is built from process.cwd().
const SKILL = join(process.cwd(), "claude-plugin/skills/social");

function files(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix)).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(join(dir, rel)).isDirectory() ? files(dir, rel) : [rel];
  });
}

describe("SKILL.md links (#82)", () => {
  it("links every reference file, and every link resolves", () => {
    const skill = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]!);
    const all = files(SKILL, "references");
    expect([...new Set(links)].sort()).toEqual(all.sort());
  });

  it("ships the same voice template as the plugin's Create voice profile command (#83)", () => {
    const block = /^````markdown\n([\s\S]*?)^````$/m.exec(read("voice.md"))![1];
    expect(block).toBe(VOICE_TEMPLATE);
  });
});
