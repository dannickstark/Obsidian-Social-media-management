import { describe, expect, it } from "vitest";
import { saveGeneratedImage, attachGeneratedImage } from "../../src/images/vault";
import { parseVariant } from "../../src/model/frontmatter";
import { SafeWriter } from "../../src/model/writer";
import { SocialIndex } from "../../src/index/socialIndex";
import { MediaInspector } from "../../src/media/mediaInfo";
import { sendDigest } from "../../src/publish/actions";
import { createApp, indexed, writeNote } from "../helpers";
import { png } from "../media/bytes";

describe("generated vault assets", () => {
  it("preserves the original, writes a crop, and attaches only the crop to the note", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] }, "Body");
    const source = png(1600, 900);
    const asset = await saveGeneratedImage(app as never, file.path, source, {
      ratio: 1, focus: [1, 0.5], render: async (_input, rect) => png(rect.width, rect.height),
    });
    expect(asset.sourcePath).not.toBe(asset.cropPath);
    expect(new Uint8Array(await app.vault.readBinary(app.vault.getFileByPath(asset.sourcePath)!))).toEqual(new Uint8Array(source));
    expect(app.vault.getFileByPath(asset.cropPath!)).not.toBeNull();
    await attachGeneratedImage(new SafeWriter(app as never), file as never, asset);
    const fm = app.metadataCache.getFileCache(file)!.frontmatter!;
    const v = parseVariant(fm, file.path).value!;
    expect(v.media).toEqual([asset.target]);
    expect(v.mediaMeta?.[asset.target]).toEqual({ sourcePath: asset.sourcePath, cropPath: asset.cropPath, cropRatio: 1, focus: [1, 0.5] });
  });

  it("invalidates approval and the indexed content digest when either asset changes", async () => {
    const app = createApp();
    const file = await writeNote(app, "Social/Post.md", { type: "social-post", platform: "instagram", channels: ["ig/me"] }, "Body");
    const asset = await saveGeneratedImage(app as never, file.path, png(1600, 900), { ratio: 1, render: async (_input, rect) => png(rect.width, rect.height) });
    await attachGeneratedImage(new SafeWriter(app as never), file as never, asset);
    const index = new SocialIndex(app as never, 0);
    await index.build();
    index.start();
    const inspect = new MediaInspector(app as never);
    const initial = index.getVariant(file.path)!;
    const content = async () => ({ body: "Body", media: await inspect.inspect(index.getVariant(file.path)!) });
    const approval = sendDigest(initial, await content());
    const handover = initial.digest;
    await app.vault.modifyBinary(app.vault.getFileByPath(asset.sourcePath)!, png(1500, 900));
    await indexed(index, () => index.getVariant(file.path)?.digest !== handover);
    expect(sendDigest(index.getVariant(file.path)!, await content())).not.toBe(approval);
    const afterSource = index.getVariant(file.path)!.digest;
    const sourceApproval = sendDigest(index.getVariant(file.path)!, await content());
    await app.vault.modifyBinary(app.vault.getFileByPath(asset.cropPath!)!, png(899, 900));
    await indexed(index, () => index.getVariant(file.path)?.digest !== afterSource);
    expect(sendDigest(index.getVariant(file.path)!, await content())).not.toBe(sourceApproval);
    index.stop();
  });
});
