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
});
