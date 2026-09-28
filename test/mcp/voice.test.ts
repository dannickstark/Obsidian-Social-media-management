import { describe, expect, it } from "vitest";
import { createVoiceProfile, VOICE_TEMPLATE } from "../../src/claude/voice";
import { mcpCtx } from "./helpers";

describe("voice profile tools (#83)", () => {
  it("returns the template and a hint when there is no profile yet", async () => {
    const c = await mcpCtx();
    const r = await c.call("get_voice_profile");
    expect(r).toMatchObject({ ok: true, path: "Social/_voice.md", exists: false, template: VOICE_TEMPLATE });
    expect(r.hint).toContain("Create voice profile");
    expect((await c.call("add_voice_refinement", { text: "Shorter hooks." })).error).toContain("Create voice profile");
  });

  it("reads the profile and appends dated refinements without rewriting it", async () => {
    const c = await mcpCtx();
    const { created } = await createVoiceProfile(c.app as never, "Social");
    expect(created).toBe(true);
    expect((await createVoiceProfile(c.app as never, "Social")).created).toBe(false);
    expect((await c.call("get_voice_profile")).text).toBe(VOICE_TEMPLATE);
    expect((await c.call("add_voice_refinement", { text: "- Posts that open with a number did best on LinkedIn." })).ok).toBe(true);
    const text = await c.app.vault.read(c.app.vault.getFileByPath("Social/_voice.md")!);
    expect(text.startsWith(VOICE_TEMPLATE.trimEnd())).toBe(true);
    expect(text.endsWith("### 2026-10-08\n\n- Posts that open with a number did best on LinkedIn.\n")).toBe(true);
  });

  it("appends review decisions to a campaign note (#85)", async () => {
    const c = await mcpCtx();
    const r = await c.call("append_to_campaign", { path: "Social/Event X/Event X.md", heading: "Review decisions (2026-10-08)\n# injected", text: "- LinkedIn: approved.\n- X: shorten part 2." });
    expect(r.ok).toBe(true);
    const text = await c.app.vault.read(c.app.vault.getFileByPath("Social/Event X/Event X.md")!);
    expect(text).toContain("```social-variants\n```");
    expect(text.endsWith("## Review decisions (2026-10-08) injected\n\n- LinkedIn: approved.\n- X: shorten part 2.\n")).toBe(true);
    expect((await c.call("append_to_campaign", { path: "Social/Nope.md", heading: "x", text: "y" })).error).toContain("list_campaigns");
  });

  it("cannot target .obsidian/ or any path outside the index (P10)", async () => {
    const c = await mcpCtx();
    await c.app.vault.createFolder(".obsidian");
    await c.app.vault.create(".obsidian/data.json", '{"mcp":{"token":"secret-token-value"}}');
    await c.app.vault.create(".obsidian/evil.md", "---\ntype: social-campaign\ntitle: Evil\n---\n");
    for (const path of [".obsidian/data.json", "../.obsidian/data.json", "../.obsidian/evil.md", ".obsidian/evil.md"]) {
      const r = await c.call("append_to_campaign", { path, heading: "x", text: "y" });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("secret-token-value");
    }
    expect(await c.app.vault.read(c.app.vault.getFileByPath(".obsidian/data.json")!)).toBe('{"mcp":{"token":"secret-token-value"}}');
    // The voice profile tools never take a path argument at all: they always target the plugin's own
    // Social/_voice.md, so there is no argument through which a caller could reach .obsidian/.
    expect(c.registry.list().find((t) => t.name === "add_voice_refinement")!.inputSchema).not.toHaveProperty("properties.path");
  });
});
