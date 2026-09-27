import { describe, expect, it } from "vitest";
import { parseYaml, getFrontMatterInfo } from "obsidian";
import { SafeWriter } from "../../src/model/writer";
import { IllegalTransitionError } from "../../src/model/stateMachine";
import { createApp, writeNote } from "../helpers";
import type { App, TFile } from "obsidian";

async function fmOf(app: App, file: TFile): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await app.vault.read(file)).frontmatter);
}

const post = { type: "social-post", platform: "linkedin", channels: ["li/me", "li/acme-studio"], status: "draft" };

describe("SafeWriter", () => {
  it("sets and deletes fields, keeping the body", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, title: "Old" }, "Body\n");
    await new SafeWriter(app).setFields(file, { title: undefined, url: "https://a.b" });
    const fm = await fmOf(app, file);
    expect(fm.title).toBeUndefined();
    expect(fm.url).toBe("https://a.b");
    expect((await app.vault.read(file)).endsWith("Body\n")).toBe(true);
  });

  it("serializes concurrent writes so none are lost", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", post);
    const writer = new SafeWriter(app);
    await Promise.all(Array.from({ length: 10 }, (_, i) => writer.setFields(file, { [`k${i}`]: i })));
    const fm = await fmOf(app, file);
    for (let i = 0; i < 10; i++) expect(fm[`k${i}`]).toBe(i);
  });

  it("keeps queued writes on a file renamed mid-queue (review focus 3)", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", post);
    const writer = new SafeWriter(app);
    const first = writer.setFields(file, { a: 1 });
    await app.vault.rename(file, "renamed.md");
    const second = writer.setFields(file, { b: 2 });
    await Promise.all([first, second]);
    const fm = await fmOf(app, app.vault.getFileByPath("renamed.md")!);
    expect(fm).toMatchObject({ a: 1, b: 2 });
  });

  it("updates deliveries and rolls up the status", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", post);
    await new SafeWriter(app).updateDeliveries(file, {
      "li/me": { status: "published", url: "https://www.linkedin.com/feed/update/1" },
      "li/acme-studio": { status: "scheduled", at: Date.UTC(2026, 9, 8, 15, 45) },
    });
    const fm = await fmOf(app, file);
    expect(fm.status).toBe("partial");
    expect(fm.deliveries).toEqual({
      "li/me": { status: "published", url: "https://www.linkedin.com/feed/update/1" },
      "li/acme-studio": { status: "scheduled", at: "2026-10-08T17:45:00+02:00" },
    });
  });

  it("patches variant fields with frontmatter key names", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", post);
    await new SafeWriter(app).patchVariant(file, { scheduledAt: Date.UTC(2026, 9, 8, 15, 30), staggerMinutes: 10 });
    expect(await fmOf(app, file)).toMatchObject({ scheduled_at: "2026-10-08T17:30:00+02:00", stagger_minutes: 10 });
  });

  it("transitions a delivery and refuses illegal moves without writing", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, deliveries: { "li/me": { status: "scheduled" } } });
    const writer = new SafeWriter(app);
    const next = await writer.transitionDelivery(file, "li/me", "publishing");
    expect(next.status).toBe("publishing");
    const before = await app.vault.read(file);
    await expect(writer.transitionDelivery(file, "li/me", "scheduled")).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(await app.vault.read(file)).toBe(before);
  });

  it("removes a delivery when patched with null", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, deliveries: { "li/me": { status: "draft" } } });
    await new SafeWriter(app).updateDeliveries(file, { "li/me": null });
    expect((await fmOf(app, file)).deliveries).toBeUndefined();
  });
});
