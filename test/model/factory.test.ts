import { describe, expect, it } from "vitest";
import { getFrontMatterInfo, parseYaml, type App, type TFile } from "obsidian";
import { NoteFactory, safeFileName } from "../../src/model/factory";
import { SafeWriter } from "../../src/model/writer";
import { createApp, writeNote } from "../helpers";

async function fmOf(app: App, file: TFile): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await app.vault.read(file)).frontmatter);
}

function setup() {
  const app = createApp();
  const factory = new NoteFactory(app, new SafeWriter(app), { rootFolder: () => "Social" });
  return { app, factory };
}

describe("safeFileName (review focus 5)", () => {
  it.each([
    ["Event X", "Event X"],
    ["Q&A: what/why?", "Q&A what why"],
    ["#launch [beta] ^1", "launch beta 1"],
    ["...hidden", "hidden"],
    ["   ", "Untitled"],
    ["x".repeat(200), "x".repeat(120)],
  ])("%s → %s", (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });
});

describe("NoteFactory", () => {
  it("creates a campaign note with the variants block", async () => {
    const { app, factory } = setup();
    const file = await factory.createCampaign({ title: "Event X", anchorDate: Date.UTC(2026, 9, 12, 16), link: "https://example.com/event-x" });
    expect(file.path).toBe("Social/Event X/Event X.md");
    expect(await fmOf(app, file)).toEqual({
      type: "social-campaign",
      title: "Event X",
      status: "active",
      anchor_date: "2026-10-12T18:00:00+02:00",
      link: "https://example.com/event-x",
    });
    expect(await app.vault.read(file)).toContain("```social-variants\n```");
  });

  it("uses a safe, unique path for awkward or duplicate titles", async () => {
    const { factory } = setup();
    expect((await factory.createCampaign({ title: "Launch: v1/beta?" })).path).toBe("Social/Launch v1 beta/Launch v1 beta.md");
    expect((await factory.createCampaign({ title: "Launch: v1/beta?" })).path).toBe("Social/Launch v1 beta/Launch v1 beta 2.md");
  });

  it("rejects an empty campaign title", async () => {
    await expect(setup().factory.createCampaign({ title: " " })).rejects.toThrow(/title/);
  });

  it("creates a variant next to its campaign", async () => {
    const { app, factory } = setup();
    const campaign = await factory.createCampaign({ title: "Event X" });
    const file = await factory.createVariant({ campaign, platform: "linkedin", channels: ["li/me"], body: "Hello", scheduledAt: Date.UTC(2026, 9, 8, 15, 30) });
    expect(file.path).toBe("Social/Event X/Event X – LinkedIn.md");
    expect(await fmOf(app, file)).toEqual({
      type: "social-post",
      campaign: "[[Event X]]",
      platform: "linkedin",
      channels: ["li/me"],
      mode: "auto",
      status: "draft",
      scheduled_at: "2026-10-08T17:30:00+02:00",
    });
    expect(await app.vault.read(file)).toMatch(/---\nHello\n$/);
  });

  it("creates standalone posts under Posts/ and requires a title", async () => {
    const { factory } = setup();
    expect((await factory.createVariant({ platform: "x", title: "Launch day" })).path).toBe("Social/Posts/Launch day.md");
    await expect(factory.createVariant({ platform: "x" })).rejects.toThrow(/title/);
  });

  it("forks one channel into its own note", async () => {
    const { app, factory } = setup();
    const file = await writeNote(
      app,
      "Social/Event X/Event X – LinkedIn.md",
      {
        type: "social-post",
        platform: "linkedin",
        channels: ["li/me", "li/acme-studio"],
        status: "partial",
        deliveries: { "li/me": { status: "published" }, "li/acme-studio": { status: "scheduled" } },
      },
      "Shared text\n",
    );
    const fork = await factory.forkVariant(file, "li/acme-studio", "Acme Studio");
    expect(fork.path).toBe("Social/Event X/Event X – LinkedIn – Acme Studio.md");
    expect(await fmOf(app, fork)).toMatchObject({ channels: ["li/acme-studio"], deliveries: { "li/acme-studio": { status: "scheduled" } }, status: "scheduled" });
    expect(await app.vault.read(fork)).toMatch(/Shared text\n$/);
    expect(await fmOf(app, file)).toMatchObject({ channels: ["li/me"], deliveries: { "li/me": { status: "published" } }, status: "published" });
  });

  it("refuses to fork the only channel or an unknown one", async () => {
    const { app, factory } = setup();
    const file = await writeNote(app, "p.md", { type: "social-post", platform: "linkedin", channels: ["li/me"] });
    await expect(factory.forkVariant(file, "li/me", "Me")).rejects.toThrow(/only channel/);
    await expect(factory.forkVariant(file, "li/other", "Other")).rejects.toThrow(/not a channel/);
  });
});
