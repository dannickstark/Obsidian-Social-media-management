import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFrontMatterInfo } from "obsidian";
import YAML from "yaml";

// jsdom's URL implementation rejects `new URL("../..", import.meta.url)` (not a file: URL there),
// so the repo root is taken from the working directory (vitest always runs from the repo root).
const ROOT = process.cwd();
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;

describe("Claude Code plugin packaging (#80)", () => {
  const marketplace = json(".claude-plugin/marketplace.json");
  const entry = (marketplace.plugins as Array<Record<string, unknown>>)[0]!;

  it("has a marketplace at the repo root with one plugin entry", () => {
    expect(marketplace.name).toBe("osmm-social-planner");
    expect(marketplace.name).toMatch(/^[a-z0-9-]+$/);
    expect(marketplace.owner).toEqual({ name: "dannickstark" });
    expect(marketplace.plugins).toHaveLength(1);
    expect(entry).toMatchObject({ name: "osmm", source: "./claude-plugin" });
    expect(String(entry.source)).not.toContain("..");
  });

  it("points at a plugin whose manifest name and version match (versions aligned with the Obsidian plugin)", () => {
    const pluginPath = join(String(entry.source), ".claude-plugin/plugin.json");
    expect(existsSync(join(ROOT, pluginPath))).toBe(true);
    const plugin = json(pluginPath);
    expect(plugin.name).toBe(entry.name);
    expect(plugin.version).toBe(json("manifest.json").version);
    expect(plugin.license).toBe("MIT");
    expect(() => new URL(String(plugin.homepage))).not.toThrow();
  });

  it("ships the social skill with a usable description", () => {
    const text = readFileSync(join(ROOT, "claude-plugin/skills/social/SKILL.md"), "utf8");
    const info = getFrontMatterInfo(text);
    const fm = YAML.parse(info.frontmatter) as { name: string; description: string };
    expect(fm.name).toBe("social");
    expect(fm.description.length).toBeGreaterThan(100);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
    expect(fm.description).toContain("Obsidian");
    const body = text.slice(info.contentStart);
    expect(body).toContain("Never publish without");
    expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("bumps the Claude plugin's version together with the Obsidian plugin's", () => {
    const dir = mkdtempSync(join(tmpdir(), "osmm-bump-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "0.1.0", minAppVersion: "1.11.4" }));
    writeFileSync(join(dir, "versions.json"), "{}");
    mkdirSync(join(dir, "claude-plugin/.claude-plugin"), { recursive: true });
    writeFileSync(join(dir, "claude-plugin/.claude-plugin/plugin.json"), JSON.stringify({ name: "osmm", version: "0.1.0" }));
    execFileSync(process.execPath, [join(ROOT, "scripts/version-bump.mjs")], { cwd: dir, env: { ...process.env, npm_package_version: "0.4.0" } });
    expect(JSON.parse(readFileSync(join(dir, "claude-plugin/.claude-plugin/plugin.json"), "utf8"))).toEqual({ name: "osmm", version: "0.4.0" });
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version).toBe("0.4.0");
  });
});
