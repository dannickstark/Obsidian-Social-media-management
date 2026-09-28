import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { requestUrl, requestUrlMock } from "./obsidian";
import { createApp, settle, writeNote } from "../helpers";

describe("obsidian fake", () => {
  it("runs in Europe/Berlin", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(-120);
  });

  it("parses frontmatter into the cache and emits changed asynchronously", async () => {
    const app = createApp();
    const seen: string[] = [];
    app.metadataCache.on("changed", (file: TFile) => seen.push(file.path));
    const file = await writeNote(app, "Social/Event X/Event X.md", { type: "social-campaign", title: "Event X" }, "Brief\n");
    expect(app.metadataCache.getFileCache(file)?.frontmatter).toEqual({ type: "social-campaign", title: "Event X" });
    expect(seen).toEqual([]);
    await settle();
    expect(seen).toEqual(["Social/Event X/Event X.md"]);
  });

  it("refuses to create a file in a missing folder", async () => {
    await expect(createApp().vault.create("Nope/a.md", "")).rejects.toThrow(/does not exist/);
  });

  it("processFrontMatter rewrites the frontmatter and keeps the body", async () => {
    const app = createApp();
    const file = await writeNote(app, "a.md", { a: 1 }, "Body\n");
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm.b = 2;
    });
    expect(await app.vault.read(file)).toBe("---\na: 1\nb: 2\n---\nBody\n");
  });

  it("rename moves the cache and emits rename with the old path", async () => {
    const app = createApp();
    const renames: Array<[string, string]> = [];
    app.vault.on("rename", (f, old) => renames.push([f.path, old]));
    const file = await writeNote(app, "a.md", { a: 1 });
    await app.vault.rename(file, "b.md");
    expect(renames).toEqual([["b.md", "a.md"]]);
    expect(app.metadataCache.getFileCache(file)?.frontmatter).toEqual({ a: 1 });
    expect(app.vault.getFileByPath("a.md")).toBeNull();
  });

  it("resolves wikilinks by path or basename", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Event X/Event X.md", { a: 1 });
    expect(app.metadataCache.getFirstLinkpathDest("Event X", "x.md")).toBe(file);
    expect(app.metadataCache.getFirstLinkpathDest("Social/Event X/Event X", "x.md")).toBe(file);
    expect(app.metadataCache.getFirstLinkpathDest("Missing", "x.md")).toBeNull();
  });

  it("validates secret ids like Obsidian", () => {
    const app = createApp();
    expect(() => app.secretStorage.setSecret("Bad Id", "x")).toThrow();
    app.secretStorage.setSecret("osmm-openai-key", "sk-test");
    expect(app.secretStorage.getSecret("osmm-openai-key")).toBe("sk-test");
    expect(app.secretStorage.listSecrets()).toEqual(["osmm-openai-key"]);
  });

  it("serves requestUrl fixtures and throws on error statuses", async () => {
    requestUrlMock.queue.push(() => ({ status: 200, headers: {}, json: { ok: true }, text: "{\"ok\":true}", arrayBuffer: new ArrayBuffer(0) }));
    expect((await requestUrl({ url: "https://example.com" })).json).toEqual({ ok: true });
    requestUrlMock.queue.push(() => ({ status: 429, headers: { "retry-after": "5" }, json: null, text: "", arrayBuffer: new ArrayBuffer(0) }));
    await expect(requestUrl({ url: "https://example.com" })).rejects.toMatchObject({ status: 429 });
  });
});
