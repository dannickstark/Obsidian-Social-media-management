import { describe, expect, it, vi } from "vitest";
import { parseYaml, getFrontMatterInfo } from "obsidian";
import { SafeWriter } from "../../src/model/writer";
import { IllegalTransitionError } from "../../src/model/stateMachine";
import { parseVariant } from "../../src/model/frontmatter";
import { expandRows } from "../../src/index/queries";
import type { IndexedVariant } from "../../src/index/socialIndex";
import { createApp, writeNote } from "../helpers";
import type { App, TFile } from "obsidian";

async function fmOf(app: App, file: TFile): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await app.vault.read(file)).frontmatter);
}

async function rowStatuses(app: App, file: TFile): Promise<Record<string, string>> {
  const parsed = parseVariant(await fmOf(app, file), file.path).value!;
  const indexed: IndexedVariant = { ...parsed, file, issues: [], excerpt: "", displayTitle: file.basename, bodyChars: 0 };
  return Object.fromEntries(expandRows([indexed], 15).map((r) => [r.channelId ?? "", r.status]));
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

  it("keeps the planned status of channels without a record while one channel publishes (final review F1)", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", {
      type: "social-post",
      platform: "linkedin",
      channels: ["li/me", "li/acme", "li/lab"],
      status: "scheduled",
      scheduled_at: "2026-10-08T17:30:00+02:00",
    });
    const writer = new SafeWriter(app);
    await writer.transitionDelivery(file, "li/me", "scheduled");
    expect((await fmOf(app, file)).status).toBe("scheduled");
    await writer.transitionDelivery(file, "li/me", "publishing");
    await writer.transitionDelivery(file, "li/me", "published");
    expect(await rowStatuses(app, file)).toEqual({ "li/me": "published", "li/acme": "scheduled", "li/lab": "scheduled" });
  });

  it("keeps the uncovered channel of the spec §2.2 example scheduled after an unrelated patch (final review F1)", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", {
      type: "social-post",
      campaign: "[[Event X]]",
      platform: "linkedin",
      channels: ["li/me", "li/acme-studio", "li/maker-lab"],
      mode: "auto",
      status: "scheduled",
      scheduled_at: "2026-10-08T17:30:00+02:00",
      stagger_minutes: 15,
      reminders: [60, 10],
      deliveries: {
        "li/me": { status: "published", at: "2026-10-08T17:30:00+02:00", url: "https://www.linkedin.com/feed/update/1", remote_id: "1" },
        "li/acme-studio": { status: "awaiting_you", at: "2026-10-08T17:45:00+02:00" },
      },
    });
    expect((await rowStatuses(app, file))["li/maker-lab"]).toBe("scheduled");
    await new SafeWriter(app).patchVariant(file, { reminders: [30] });
    expect((await rowStatuses(app, file))["li/maker-lab"]).toBe("scheduled");
  });

  it("keeps other raw delivery entries verbatim when transitioning one channel (final review F2)", async () => {
    const app = createApp();
    const other = {
      "li/me": { status: "Published", url: "https://x" },
      "li/acme": { status: "scheduled", note: "posted by hand", at: "yesterday" },
    };
    const file = await writeNote(app, "p.md", { type: "social-post", platform: "linkedin", channels: ["li/me", "li/acme", "li/lab"], deliveries: other });
    await new SafeWriter(app).transitionDelivery(file, "li/lab", "scheduled");
    expect((await fmOf(app, file)).deliveries).toEqual({ ...other, "li/lab": { status: "scheduled" } });
  });

  it("keeps other raw delivery entries verbatim when updating deliveries (final review F2)", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", {
      ...post,
      deliveries: { "li/me": { status: "Published", note: "x" }, "li/acme-studio": { status: "draft" } },
    });
    await new SafeWriter(app).updateDeliveries(file, { "li/acme-studio": null, "li/new": { status: "ready" } });
    expect((await fmOf(app, file)).deliveries).toEqual({ "li/me": { status: "Published", note: "x" }, "li/new": { status: "ready" } });
  });

  describe("updateVariant (G1)", () => {
    const raw = {
      type: "social-post",
      platform: "linkedin",
      channels: ["li/me", "li/acme"],
      status: "scheduled",
      scheduled_at: "2026-10-08T09:00:00+02:00",
      deliveries: {
        "li/me": { status: "scheduled", note: "keep me" },
        "li/acme": { status: "Handed-Over", url: "https://x" },
      },
    };

    it("plans against fresh frontmatter and patches only the returned delivery keys", async () => {
      const app = createApp();
      const file = await writeNote(app, "p.md", raw);
      const writer = new SafeWriter(app);
      const seen: unknown[] = [];
      const applied = await writer.updateVariant(file, (fresh) => {
        seen.push(fresh.deliveries["li/me"]?.status, fresh.scheduledAt);
        return { fields: { scheduledAt: Date.UTC(2026, 9, 9, 7) }, deliveries: { "li/me": { status: "ready" } } };
      });
      expect(seen).toEqual(["scheduled", Date.UTC(2026, 9, 8, 7)]);
      expect(applied).toMatchObject({ deliveries: { "li/me": { status: "ready" } } });
      const fm = await fmOf(app, file);
      expect(fm.scheduled_at).toBe("2026-10-09T09:00:00+02:00");
      expect(fm.deliveries).toEqual({
        "li/me": { status: "ready", note: "keep me" },
        "li/acme": { status: "Handed-Over", url: "https://x" },
      });
    });

    it("writes nothing when the plan refuses", async () => {
      const app = createApp();
      const file = await writeNote(app, "p.md", raw);
      const modify = vi.spyOn(app.vault, "modify");
      const result = await new SafeWriter(app).updateVariant(file, () => ({ refuse: "no" }));
      expect(result).toEqual({ refuse: "no" });
      expect(modify).not.toHaveBeenCalled();
    });

    it("sees the result of a write queued just before it", async () => {
      const app = createApp();
      const file = await writeNote(app, "p.md", raw);
      const writer = new SafeWriter(app);
      const first = writer.updateDeliveries(file, { "li/me": { status: "published", url: "https://li/1" } });
      let seen: string | undefined;
      const second = writer.updateVariant(file, (fresh) => {
        seen = fresh.deliveries["li/me"]?.status;
        return {};
      });
      await Promise.all([first, second]);
      expect(seen).toBe("published");
    });

    it("rolls up the status and reports the stored status in the applied fields", async () => {
      const app = createApp();
      const file = await writeNote(app, "p.md", { ...post, deliveries: { "li/me": { status: "ready" }, "li/acme-studio": { status: "ready" } } });
      const applied = await new SafeWriter(app).updateVariant(file, () => ({
        fields: { status: "draft" },
        deliveries: { "li/me": { status: "scheduled" }, "li/acme-studio": { status: "scheduled" } },
      }));
      expect((await fmOf(app, file)).status).toBe("scheduled");
      expect(!("refuse" in applied) && applied.fields?.status).toBe("scheduled");
    });

    it("never writes a deliveries key through fields", async () => {
      const app = createApp();
      const file = await writeNote(app, "p.md", raw);
      await new SafeWriter(app).updateVariant(file, () => ({ fields: { deliveries: {} } as never }));
      expect((await fmOf(app, file)).deliveries).toEqual(raw.deliveries);
    });
  });

  it("owns send_at and send_key: publishing removes them from the entry, keeping unknown keys (M5 P17c)", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, deliveries: { "li/me": { status: "publishing", send_at: "2026-10-08T10:00:00+02:00", send_key: "3mxdyj6ws22jm", note: "keep me" } } });
    await new SafeWriter(app).transitionDelivery(file, "li/me", "published");
    expect((await fmOf(app, file)).deliveries).toEqual({ "li/me": { status: "published", note: "keep me" } });
  });

  it("keeps unknown keys of a patched delivery entry (G1)", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, deliveries: { "li/me": { status: "scheduled", note: "keep me", at: "bad" } } });
    await new SafeWriter(app).updateDeliveries(file, { "li/me": { status: "ready" } });
    expect((await fmOf(app, file)).deliveries).toEqual({ "li/me": { status: "ready", note: "keep me" } });
  });
  it("replaces the body and keeps the frontmatter byte for byte, in the same queue as field writes", async () => {
    const app = createApp();
    const file = await writeNote(app, "p.md", { ...post, deliveries: { "li/me": { status: "publishd" } } }, "Old body\n");
    const writer = new SafeWriter(app);
    await Promise.all([writer.setFields(file, { title: "T" }), writer.editBody(file, (body) => `${body.trim()} and more`)]);
    expect((await app.vault.read(file)).endsWith("---\nOld body and more\n")).toBe(true);
    expect((await fmOf(app, file)).title).toBe("T");
    const head = (text: string) => text.slice(0, getFrontMatterInfo(text).contentStart);
    const before = head(await app.vault.read(file));
    await writer.editBody(file, () => "New");
    const after = await app.vault.read(file);
    expect(head(after)).toBe(before);
    expect(after.endsWith("---\nNew\n")).toBe(true);
    expect((await fmOf(app, file)).deliveries).toEqual({ "li/me": { status: "publishd" } });
  });
});
