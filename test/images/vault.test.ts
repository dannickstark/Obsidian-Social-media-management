import { describe, expect, it, vi } from "vitest";
import { saveGeneratedImage, attachGeneratedImage } from "../../src/images/vault";
import { parseVariant } from "../../src/model/frontmatter";
import { SafeWriter } from "../../src/model/writer";
import { SocialIndex } from "../../src/index/socialIndex";
import { MediaInspector } from "../../src/media/mediaInfo";
import { sendDigest } from "../../src/publish/actions";
import { createApp, indexed, writeNote } from "../helpers";
import { png } from "../media/bytes";
import { validPng } from "./bytes";
import { splitIdatPng, truncatedDeflatePng } from "./bytes";
import { makeCtx } from "../ui/ctx";
import { Vault as FakeVault } from "../fakes/obsidian";

describe("generated vault assets", () => {
  it("preserves the original, writes a crop, and attaches only the crop to the note", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] }, "Body");
    const source = validPng(16, 9);
    const asset = await saveGeneratedImage(app as never, file.path, source, {
      ratio: 1, focus: [1, 0.5], render: async (_input, rect) => validPng(rect.width, rect.height),
    });
    expect(asset.sourcePath).not.toBe(asset.cropPath);
    expect(new Uint8Array(await app.vault.readBinary(app.vault.getFileByPath(asset.sourcePath)!))).toEqual(new Uint8Array(source));
    expect(app.vault.getFileByPath(asset.cropPath!)).not.toBeNull();
    await attachGeneratedImage(app as never, new SafeWriter(app as never), file as never, asset);
    const fm = app.metadataCache.getFileCache(file)!.frontmatter!;
    const v = parseVariant(fm, file.path).value!;
    expect(v.media).toEqual([asset.target]);
    expect(v.mediaMeta?.[asset.target]).toEqual({ sourcePath: asset.sourcePath, cropPath: asset.cropPath, cropRatio: 1, focus: [1, 0.5] });
  });

  it("invalidates approval and the indexed content digest when either asset changes", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] }, "Body");
    const asset = await saveGeneratedImage(app as never, file.path, validPng(16, 9), { ratio: 1, render: async (_input, rect) => validPng(rect.width, rect.height) });
    await attachGeneratedImage(app as never, new SafeWriter(app as never), file as never, asset);
    const index = new SocialIndex(app as never, 0);
    await index.build();
    index.start();
    const inspect = new MediaInspector(app as never);
    const initial = index.getVariant(file.path)!;
    const content = async () => ({ body: "Body", media: await inspect.inspect(index.getVariant(file.path)!) });
    const approval = sendDigest(initial, await content());
    const handover = initial.digest;
    await app.vault.modifyBinary(app.vault.getFileByPath(asset.sourcePath)!, validPng(15, 9));
    await indexed(index, () => index.getVariant(file.path)?.digest !== handover);
    expect(sendDigest(index.getVariant(file.path)!, await content())).not.toBe(approval);
    const afterSource = index.getVariant(file.path)!.digest;
    const sourceApproval = sendDigest(index.getVariant(file.path)!, await content());
    await app.vault.modifyBinary(app.vault.getFileByPath(asset.cropPath!)!, validPng(8, 9));
    await indexed(index, () => index.getVariant(file.path)?.digest !== afterSource);
    expect(sendDigest(index.getVariant(file.path)!, await content())).not.toBe(sourceApproval);
    index.stop();
  });

  it("rejects header-only PNG bytes before creating any vault file", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] });
    await expect(saveGeneratedImage(app as never, file.path, png(8, 8))).rejects.toThrow(/PNG/i);
    expect(app.vault.getFileByPath("Social/generated-original.png")).toBeNull();
    await expect(saveGeneratedImage(app as never, file.path, truncatedDeflatePng(8, 8))).rejects.toThrow(/PNG/i);
    expect(app.vault.getFileByPath("Social/generated-original.png")).toBeNull();
    expect((await saveGeneratedImage(app as never, file.path, splitIdatPng(8, 8))).sourcePath).toBe("Social/generated-original.png");
  });

  it("removes the original when createBinary writes it and then rejects", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] });
    const create = app.vault.createBinary.bind(app.vault);
    vi.spyOn(app.vault, "createBinary").mockImplementation(async (path, data) => { await create(path, data); throw new Error("write acknowledgement lost"); });
    await expect(saveGeneratedImage(app as never, file.path, validPng(8, 8))).rejects.toThrow("write acknowledgement lost");
    expect(app.vault.getFileByPath("Social/generated-original.png")).toBeNull();
  });

  it("removes both files when the crop write succeeds but rejects before returning", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] });
    const create = app.vault.createBinary.bind(app.vault);
    vi.spyOn(app.vault, "createBinary").mockImplementation(async (path, data) => {
      const written = await create(path, data);
      if (path.includes("generated-crop")) throw new Error("crop acknowledgement lost");
      return written;
    });
    await expect(saveGeneratedImage(app as never, file.path, validPng(16, 9), { ratio: 1, render: async (_input, rect) => validPng(rect.width, rect.height) })).rejects.toThrow("crop acknowledgement lost");
    expect(app.vault.getFileByPath("Social/generated-original.png")).toBeNull();
    expect(app.vault.getFileByPath("Social/generated-crop.png")).toBeNull();
  });

  it("removes the original if writing the crop fails", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] });
    const create = app.vault.createBinary.bind(app.vault);
    vi.spyOn(app.vault, "createBinary").mockImplementation(async (path, data) => path.includes("generated-crop") ? Promise.reject(new Error("disk full")) : create(path, data));
    await expect(saveGeneratedImage(app as never, file.path, validPng(16, 9), { ratio: 1, render: async (_input, rect) => validPng(rect.width, rect.height) })).rejects.toThrow("disk full");
    expect(app.vault.getFileByPath("Social/generated-original.png")).toBeNull();
  });

  it("removes both created files when attaching to the note fails", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] });
    const asset = await saveGeneratedImage(app as never, file.path, validPng(16, 9), { ratio: 1, render: async (_input, rect) => validPng(rect.width, rect.height) });
    const writer = new SafeWriter(app as never);
    vi.spyOn(writer, "updateVariant").mockRejectedValueOnce(new Error("note write failed"));
    await expect(attachGeneratedImage(app as never, writer, file as never, asset)).rejects.toThrow("note write failed");
    expect(app.vault.getFileByPath(asset.sourcePath)).toBeNull();
    expect(app.vault.getFileByPath(asset.cropPath!)).toBeNull();
  });

  it("removes both files if the crop link cannot be made after writing it", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] });
    vi.spyOn(app.metadataCache, "fileToLinktext").mockImplementationOnce(() => { throw new Error("link unavailable"); });
    await expect(saveGeneratedImage(app as never, file.path, validPng(16, 9), { ratio: 1, render: async (_input, rect) => validPng(rect.width, rect.height) })).rejects.toThrow("link unavailable");
    expect(app.vault.getFileByPath("Social/generated-original.png")).toBeNull();
    expect(app.vault.getFileByPath("Social/generated-crop.png")).toBeNull();
  });

  it("recomputes generated fingerprints after a same-path, same-mtime binary edit", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] });
    const asset = await saveGeneratedImage(app as never, file.path, validPng(8, 8), { ratio: 1, render: async (_input, rect) => validPng(rect.width, rect.height) });
    await attachGeneratedImage(app as never, new SafeWriter(app as never), file as never, asset);
    const index = new SocialIndex(app as never, 0);
    await index.build();
    index.start();
    const before = index.getVariant(file.path)!.digest;
    const original = app.vault.getFileByPath(asset.sourcePath)!;
    const oldMtime = original.stat.mtime;
    await (app.vault as unknown as FakeVault).modifyBinary(original as never, validPng(8, 8, 80), { preserveMtime: true });
    expect(original.stat.mtime).toBe(oldMtime);
    await indexed(index, () => index.getVariant(file.path)?.digest !== before);
    index.stop();
  });

  it("rejects stale approval for a generated WordPress body image omitted from media", async () => {
    const path = "Social/Posts/Wp-generated.md";
    const note = { path, frontmatter: {
      type: "social-post", platform: "wordpress", title: "Recap", channels: ["wp/eventx-berlin"], status: "scheduled",
      scheduled_at: "2026-10-08T14:00:00+02:00", deliveries: { "wp/eventx-berlin": { status: "scheduled" } },
      slug: "recap", media: [], media_meta: { "body.png": { source_path: "Social/Posts/original.png", crop_path: "Social/Posts/body.png", crop_ratio: 1, focus: [0.5, 0.5] } },
    }, body: "Recap\n\n![[body.png]]" };
    const c = await makeCtx({ seed: true, notes: [note] });
    await c.app.vault.createBinary("Social/Posts/original.png", validPng(8, 8));
    await c.app.vault.createBinary("Social/Posts/body.png", validPng(8, 8));
    const plan = await c.ctx.publish.prepareSend(path);
    if ("refuse" in plan) throw new Error(plan.refuse);
    const initial = sendDigest(c.index.getVariant(path)!, await c.ctx.composer.content.load(c.index.getVariant(path)!));
    await c.app.vault.modifyBinary(c.app.vault.getFileByPath("Social/Posts/original.png")!, validPng(8, 8, 40));
    expect(sendDigest(c.index.getVariant(path)!, await c.ctx.composer.content.load(c.index.getVariant(path)!))).not.toBe(initial);
    expect(await c.ctx.publish.sendApproved(plan)).toMatchObject({ refuse: expect.stringMatching(/changed after it was approved/i) });
    const again = await c.ctx.publish.prepareSend(path);
    if ("refuse" in again) throw new Error(again.refuse);
    await c.app.vault.modifyBinary(c.app.vault.getFileByPath("Social/Posts/body.png")!, validPng(8, 8, 120));
    expect(await c.ctx.publish.sendApproved(again)).toMatchObject({ refuse: expect.stringMatching(/changed after it was approved/i) });
    c.index.stop();
  });
});
