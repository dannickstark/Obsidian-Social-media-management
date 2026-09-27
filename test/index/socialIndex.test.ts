import { afterEach, describe, expect, it } from "vitest";
import { SocialIndex } from "../../src/index/socialIndex";
import { createApp, nextChange, settle, writeNote } from "../helpers";

let index: SocialIndex | undefined;
afterEach(() => index?.stop());

async function vaultWithCampaign() {
  const app = createApp();
  await writeNote(app, "Social/Event X/Event X.md", { type: "social-campaign", title: "Event X" }, "Brief");
  await writeNote(
    app,
    "Social/Event X/Event X – LinkedIn.md",
    { type: "social-post", campaign: "[[Event X]]", platform: "linkedin", channels: ["li/me"] },
    "\n# I almost didn't host Event X.\n\nMore text",
  );
  await writeNote(app, "Notes/Random.md", { tags: ["x"] }, "Not social");
  await writeNote(app, "Social/Broken.md", { type: "social-post" }, "");
  await settle();
  index = new SocialIndex(app, 0);
  await index.build();
  index.start();
  return { app, index };
}

describe("SocialIndex", () => {
  it("indexes campaigns, variants and invalid notes; ignores other notes", async () => {
    const { index } = await vaultWithCampaign();
    expect(index.campaigns().map((c) => c.title)).toEqual(["Event X"]);
    const [variant] = index.variants();
    expect(variant).toMatchObject({
      platform: "linkedin",
      campaignPath: "Social/Event X/Event X.md",
      excerpt: "I almost didn't host Event X.",
      displayTitle: "I almost didn't host Event X.",
    });
    expect(index.invalidNotes().map((n) => n.file.path)).toEqual(["Social/Broken.md"]);
    expect(index.variantsOf("Social/Event X/Event X.md")).toHaveLength(1);
  });

  it("emits changes when a note is modified", async () => {
    const { app, index } = await vaultWithCampaign();
    const change = nextChange(index);
    await writeNote(app, "Social/Event X/Event X – LinkedIn.md", { type: "social-post", campaign: "[[Event X]]", platform: "linkedin", channels: ["li/me"], title: "New title" });
    expect(await change).toEqual({ changed: ["Social/Event X/Event X – LinkedIn.md"], removed: [] });
    expect(index.getVariant("Social/Event X/Event X – LinkedIn.md")?.displayTitle).toBe("New title");
  });

  it("removes notes that are deleted or stop being social notes", async () => {
    const { app, index } = await vaultWithCampaign();
    let change = nextChange(index);
    await writeNote(app, "Social/Event X/Event X – LinkedIn.md", { type: "note" });
    expect((await change).removed).toEqual(["Social/Event X/Event X – LinkedIn.md"]);
    change = nextChange(index);
    await app.vault.delete(app.vault.getFileByPath("Social/Event X/Event X.md")!);
    expect((await change).removed).toEqual(["Social/Event X/Event X.md"]);
    expect(index.campaigns()).toEqual([]);
  });

  it("follows a renamed variant", async () => {
    const { app, index } = await vaultWithCampaign();
    const change = nextChange(index);
    await app.vault.rename(app.vault.getFileByPath("Social/Event X/Event X – LinkedIn.md")!, "Social/Event X/LI.md");
    expect(await change).toEqual({ changed: ["Social/Event X/LI.md"], removed: ["Social/Event X/Event X – LinkedIn.md"] });
  });

  it("re-links variants when a campaign is renamed and links are updated (review focus 4)", async () => {
    const { app, index } = await vaultWithCampaign();
    await app.vault.rename(app.vault.getFileByPath("Social/Event X/Event X.md")!, "Social/Event X/Event X 2026.md");
    await settle(5);
    expect(index.variants()[0]?.campaignPath).toBeUndefined();
    const change = nextChange(index);
    await writeNote(app, "Social/Event X/Event X – LinkedIn.md", { type: "social-post", campaign: "[[Event X 2026]]", platform: "linkedin", channels: ["li/me"] });
    await change;
    expect(index.variants()[0]?.campaignPath).toBe("Social/Event X/Event X 2026.md");
  });

  it("stops listening after stop()", async () => {
    const { app, index } = await vaultWithCampaign();
    index.stop();
    let fired = false;
    index.onChange(() => (fired = true));
    await writeNote(app, "Social/Event X/Event X – LinkedIn.md", { type: "social-post", platform: "x" });
    await settle(5);
    expect(fired).toBe(false);
  });

  it("increments the revision on every emitted change", async () => {
    const { app, index } = await vaultWithCampaign();
    const before = index.revision;
    const change = nextChange(index);
    await writeNote(app, "Social/Posts/Solo.md", { type: "social-post", platform: "x", title: "Solo" });
    await change;
    expect(index.revision).toBe(before + 1);
  });

  it("keeps a change that lands while build() is still reading (final review F3)", async () => {
    const app = createApp();
    const path = "Social/Posts/Solo.md";
    const file = await writeNote(app, path, { type: "social-post", platform: "x", title: "Old" });
    await settle();
    // Hold the first body read (the one build() makes) until the change has been indexed.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    let first = true;
    app.vault.cachedRead = async (f) => {
      const content = await cachedRead(f);
      if (first) {
        first = false;
        await gate;
      }
      return content;
    };
    index = new SocialIndex(app, 0);
    index.start();
    const built = index.build();
    await writeNote(app, path, { type: "social-post", platform: "x", title: "New" });
    await settle(5);
    expect(index.getVariant(path)?.displayTitle).toBe("New");
    release();
    await built;
    expect(index.getVariant(file.path)?.displayTitle).toBe("New");
  });

  it("forgets sequence tokens once reindexing settles (final review F5.5)", async () => {
    const { app, index } = await vaultWithCampaign();
    const change = nextChange(index);
    await writeNote(app, "Social/Posts/Solo.md", { type: "social-post", platform: "x", title: "Solo" });
    await writeNote(app, "Notes/Other.md", { tags: ["y"] });
    await change;
    await settle(5);
    expect((index as unknown as { sequence: Map<string, number> }).sequence.size).toBe(0);
  });

  it("replaces relinked variants instead of mutating them (final review F5.5)", async () => {
    const { app, index } = await vaultWithCampaign();
    const before = index.variants()[0]!;
    const change = nextChange(index);
    await app.vault.rename(app.vault.getFileByPath("Social/Event X/Event X.md")!, "Social/Event X/Event X 2026.md");
    await change;
    expect(before.campaignPath).toBe("Social/Event X/Event X.md");
    expect(index.variants()[0]).not.toBe(before);
    expect(index.variants()[0]?.campaignPath).toBeUndefined();
  });

  it("never reuses a sequence token, so an older read cannot overwrite a newer one (M1a carry-over 0a)", async () => {
    const app = createApp();
    const path = "Social/Posts/Solo.md";
    await writeNote(app, path, { type: "social-post", platform: "x", title: "V1" });
    await settle();
    // Failing sequence from the brief: build() claims 1 and is still reading → change B claims 2,
    // finishes and deletes the token → change C claims a token and is still reading → build()
    // finishes and must not treat itself as fresh just because its claimed number (1) got reused;
    // C's newer result must win once it resolves.
    let callCount = 0;
    const gateResolvers: Record<number, () => void> = {};
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    app.vault.cachedRead = async (f) => {
      const content = await cachedRead(f);
      const n = ++callCount;
      if (n === 1 || n === 3) {
        await new Promise<void>((resolve) => (gateResolvers[n] = resolve));
      }
      return content;
    };
    index = new SocialIndex(app, 0);
    index.start();
    const built = index.build();
    await settle(5); // build() claims its token and blocks on read #1
    await writeNote(app, path, { type: "social-post", platform: "x", title: "V2" });
    await settle(5); // change B claims, reads (#2, unblocked), stores "V2" and deletes its token
    await writeNote(app, path, { type: "social-post", platform: "x", title: "V3" });
    await settle(5); // change C claims a token and blocks on read #3, still in flight
    gateResolvers[1]?.(); // let build()'s stale read resolve first
    await settle(5); // build() must not (mis)treat its stale claim as still current
    gateResolvers[3]?.(); // now let C's newer read resolve
    await built;
    await settle(5);
    expect(index.getVariant(path)?.displayTitle).toBe("V3");
  });

  it("keeps the token bound to its claimed path so a rename during build cannot leak it (M1a carry-over 0b)", async () => {
    const app = createApp();
    const path = "Social/Posts/Solo.md";
    const file = await writeNote(app, path, { type: "social-post", platform: "x", title: "Old" });
    await settle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    let first = true;
    app.vault.cachedRead = async (f) => {
      const content = await cachedRead(f);
      if (first) {
        first = false;
        await gate;
      }
      return content;
    };
    index = new SocialIndex(app, 0);
    index.start();
    const built = index.build();
    await settle(5); // let build() claim its token under the old path and start its (blocked) read
    await app.vault.rename(file, "Social/Posts/Renamed.md");
    await settle(5); // let the rename's own reindex run and complete under the new path
    release();
    await built;
    await settle(5);
    expect(index.getVariant("Social/Posts/Renamed.md")?.displayTitle).toBe("Old");
    expect(index.getVariant(path)).toBeUndefined();
    expect((index as unknown as { sequence: Map<string, number> }).sequence.has(path)).toBe(false);
  });
});
