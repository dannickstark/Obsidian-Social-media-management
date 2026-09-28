import { describe, expect, it } from "vitest";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { createVoiceProfile, VOICE_TEMPLATE } from "../../src/claude/voice";
import { KEY_REUSED } from "../../src/mcp/idempotency";
import { parseCampaign } from "../../src/model/frontmatter";
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

  it("replays add_voice_refinement with the same idempotency_key, and refuses a reused key with different arguments (Task 14 fix round 1)", async () => {
    const c = await mcpCtx();
    await createVoiceProfile(c.app as never, "Social");
    const key = "voice-refine-key-1234";
    const first = await c.call("add_voice_refinement", { text: "Shorter hooks.", idempotency_key: key });
    expect(first.ok).toBe(true);
    const again = await c.call("add_voice_refinement", { text: "Shorter hooks.", idempotency_key: key });
    expect(again).toMatchObject({ ok: true, replayed: true });
    const text = await c.app.vault.read(c.app.vault.getFileByPath("Social/_voice.md")!);
    expect(text.match(/Shorter hooks\./g)).toHaveLength(1);
    const reused = await c.call("add_voice_refinement", { text: "A different refinement.", idempotency_key: key });
    expect(reused).toEqual({ ok: false, error: KEY_REUSED });
  });

  it("replays append_to_campaign with the same idempotency_key, and refuses a reused key with different arguments (Task 14 fix round 1)", async () => {
    const c = await mcpCtx();
    const path = "Social/Event X/Event X.md";
    const key = "campaign-append-key-1234";
    const first = await c.call("append_to_campaign", { path, heading: "Review decisions", text: "LinkedIn: approved.", idempotency_key: key });
    expect(first.ok).toBe(true);
    const again = await c.call("append_to_campaign", { path, heading: "Review decisions", text: "LinkedIn: approved.", idempotency_key: key });
    expect(again).toMatchObject({ ok: true, replayed: true });
    const text = await c.app.vault.read(c.app.vault.getFileByPath(path)!);
    expect(text.match(/LinkedIn: approved\./g)).toHaveLength(1);
    const reused = await c.call("append_to_campaign", { path, heading: "Review decisions", text: "A different note.", idempotency_key: key });
    expect(reused).toEqual({ ok: false, error: KEY_REUSED });
  });

  it("treats a text payload that looks like frontmatter as inert body text (add_voice_refinement)", async () => {
    const c = await mcpCtx();
    await createVoiceProfile(c.app as never, "Social");
    const payload = "---\nfoo: bar\n---\n\n## Fake section\nInjected.";
    const r = await c.call("add_voice_refinement", { text: payload });
    expect(r.ok).toBe(true);
    const file = c.app.vault.getFileByPath("Social/_voice.md")!;
    const full = await c.app.vault.read(file);
    // The profile note itself has no real frontmatter, and the injected "---" is nowhere near the
    // start of the file, so it is never read back as a frontmatter block.
    expect(getFrontMatterInfo(full).exists).toBe(false);
    expect(full).toContain(payload);
  });

  it("treats a text payload that looks like frontmatter as inert body text, without touching the real frontmatter (append_to_campaign, #85)", async () => {
    const c = await mcpCtx();
    const path = "Social/Event X/Event X.md";
    const before = await c.app.vault.read(c.app.vault.getFileByPath(path)!);
    const beforeInfo = getFrontMatterInfo(before);
    const beforeFm = parseYaml(beforeInfo.frontmatter) as Record<string, unknown>;
    const payload = "---\nfoo: bar\n---\n\n## Fake section\nInjected.";
    const r = await c.call("append_to_campaign", { path, heading: "Notes", text: payload });
    expect(r.ok).toBe(true);
    const after = await c.app.vault.read(c.app.vault.getFileByPath(path)!);
    const afterInfo = getFrontMatterInfo(after);
    // The real frontmatter block (bytes and parsed value) is exactly the one that was there before.
    expect(afterInfo.frontmatter).toBe(beforeInfo.frontmatter);
    const afterFm = parseYaml(afterInfo.frontmatter) as Record<string, unknown>;
    expect(afterFm).toEqual(beforeFm);
    expect(parseCampaign(afterFm, path).issues).toEqual([]);
    expect(after).toContain(payload);
  });
});
