import { describe, expect, it, vi } from "vitest";
import { SecretIds } from "../../src/secrets/secrets";
import { validPng } from "../images/bytes";
import { indexed } from "../helpers";
import { mcpCtx } from "./helpers";

const POST = "Social/Event X/Event X – Instagram.md";

describe("generate_image tool", () => {
  it("registers a bounded write tool with explicit non-publishing semantics", async () => {
    const c = await mcpCtx();
    const tool = c.registry.list().find((item) => item.name === "generate_image")!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema).toMatchObject({
      properties: { prompt: expect.any(Object), negative_prompt: expect.any(Object), size: expect.any(Object), path: expect.any(Object) },
      required: ["prompt"],
      additionalProperties: false,
    });
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(tool.description).toMatch(/never publishes/i);
  });

  it("generates into the attachments folder and attaches provenance to a known post without publishing", async () => {
    const c = await mcpCtx();
    const generate = vi.spyOn(c.deps.images.client, "generate").mockResolvedValue(validPng(8, 8));
    const result = await c.call("generate_image", { prompt: "A lake", negative_prompt: "people", size: "1024x1024", path: POST });
    expect(result).toMatchObject({ ok: true, path: POST, source_path: expect.stringMatching(/^Social\/Event X\/generated-/), focus: [0.5, 0.5] });
    await indexed(c.index, () => c.index.getVariant(POST)!.media.includes(result.media));
    expect(c.index.getVariant(POST)!.mediaMeta?.[result.media]).toMatchObject({ sourcePath: result.source_path, focus: [0.5, 0.5] });
    expect(c.log.entries).toHaveLength(0);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "A lake", negativePrompt: "people", size: "1024x1024" }));
  });

  it("saves an unattached image under the configured attachments folder when no path is given", async () => {
    const c = await mcpCtx();
    vi.spyOn(c.deps.images.client, "generate").mockResolvedValue(validPng(8, 8));
    const result = await c.call("generate_image", { prompt: "A lake" });
    expect(result).toMatchObject({ ok: true, source_path: expect.stringMatching(/^Social\/generated-/), focus: [0.5, 0.5] });
    expect(c.app.vault.getFileByPath(result.source_path)).not.toBeNull();
    expect(c.index.getVariant(POST)!.media).not.toContain(result.media);
  });

  it("rejects unknown notes before calling the image provider", async () => {
    const c = await mcpCtx();
    const generate = vi.spyOn(c.deps.images.client, "generate");
    const result = await c.call("generate_image", { prompt: "A lake", path: ".obsidian/secrets.md" });
    expect(result).toMatchObject({ ok: false });
    expect(generate).not.toHaveBeenCalled();
  });

  it("reports missing keys and redacts provider failures without writing", async () => {
    const c = await mcpCtx();
    const missing = await c.call("generate_image", { prompt: "A lake" });
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/OpenAI key/i) });
    c.app.secretStorage.setSecret(SecretIds.openaiKey, "super-private-key");
    vi.spyOn(c.deps.images.client, "generate").mockRejectedValue(new Error("Generated image must be super-private-key."));
    const failed = await c.call("generate_image", { prompt: "A lake" });
    expect(failed).toMatchObject({ ok: false });
    expect(JSON.stringify(failed)).not.toContain("super-private-key");
    expect(c.app.vault.getFiles().filter((f) => f.extension === "png")).toHaveLength(0);
  });
});
