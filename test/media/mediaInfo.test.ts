import { describe, expect, it, vi } from "vitest";
import { MediaInspector, mediaKind } from "../../src/media/mediaInfo";
import { createApp } from "../helpers";
import { png } from "./bytes";

async function vault() {
  const app = createApp();
  await app.vault.createFolder("Social/Event X");
  await app.vault.createBinary("Social/Event X/cover.png", png(1080, 1350));
  await app.vault.createBinary("Social/Event X/clip.mp4", new Uint8Array([0, 0, 0]).buffer);
  await app.vault.createBinary("Social/Event X/doc.pdf", new Uint8Array([1, 2]).buffer);
  await app.vault.createBinary("Social/Event X/broken.png", new TextEncoder().encode("not a png").buffer);
  return app;
}

const variant = {
  path: "Social/Event X/Event X – Instagram.md",
  media: ["cover.png", "clip.mp4", "doc.pdf", "gone.png", "broken.png"],
  mediaMeta: { "cover.png": { alt: "Makers at laptops", focus: [0.5, 0.3] as [number, number] } },
};

describe("MediaInspector", () => {
  it("resolves each media link and reads kind, size and dimensions (review focus 2)", async () => {
    const inspector = new MediaInspector((await vault()) as never);
    expect(await inspector.inspect(variant)).toEqual([
      {
        target: "cover.png",
        path: "Social/Event X/cover.png",
        kind: "image",
        mime: "image/png",
        bytes: 33,
        width: 1080,
        height: 1350,
        alt: "Makers at laptops",
        focus: [0.5, 0.3],
      },
      { target: "clip.mp4", path: "Social/Event X/clip.mp4", kind: "video", bytes: 3 },
      { target: "doc.pdf", path: "Social/Event X/doc.pdf", kind: "unsupported", bytes: 2 },
      { target: "gone.png", kind: "missing" },
      { target: "broken.png", path: "Social/Event X/broken.png", kind: "image", mime: "image/png", bytes: 9 },
    ]);
  });

  it("reads each image once until it changes", async () => {
    const app = await vault();
    const spy = vi.spyOn(app.vault, "readBinary");
    const inspector = new MediaInspector(app as never);
    await inspector.inspect({ path: variant.path, media: ["cover.png"] });
    await inspector.inspect({ path: variant.path, media: ["cover.png"] });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("gives a resource URL for previews", async () => {
    const inspector = new MediaInspector((await vault()) as never);
    expect(inspector.resourceUrl("Social/Event X/cover.png")).toBe("app://local/Social/Event X/cover.png");
    expect(inspector.resourceUrl("nope.png")).toBe("");
  });

  it.each([
    ["PNG", "image"],
    ["jpeg", "image"],
    ["webp", "image"],
    ["gif", "image"],
    ["mov", "video"],
    ["pdf", "unsupported"],
  ])("%s is %s", (ext, kind) => {
    expect(mediaKind(ext)).toBe(kind);
  });
});
