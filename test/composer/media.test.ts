import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { Notice } from "../fakes/obsidian";
import MediaPanel from "../../src/composer/MediaPanel.svelte";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { png } from "../media/bytes";
import { makeCtx, type TestCtx } from "../ui/ctx";

const IG = "Social/Event X/Event X – Instagram.md";
const image = (name: string, width = 1080, height = 1350) => new File([png(width, height)], name, { type: "image/png" });

async function attach(c: TestCtx, ...files: File[]): Promise<void> {
  await c.ctx.composer.attachFiles(c.index.getVariant(IG)!, files);
}

async function renderPanel(c: TestCtx): Promise<void> {
  const v = c.index.getVariant(IG)!;
  render(MediaPanel, { props: { variant: v, media: await c.ctx.composer.media.inspect(v) }, context: osmmContext(c.ctx) });
}

describe("media attach", () => {
  it("saves an image next to the note and adds it to media:", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.composer.attachFiles(c.index.getVariant(IG)!, [image("crowd.png")])).toBe(1);
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd.png"));
    expect(c.app.vault.getFileByPath("Social/Event X/crowd.png")).not.toBeNull();
    const info = await c.ctx.composer.media.inspect(c.index.getVariant(IG)!);
    expect(info.find((m) => m.target === "crowd.png")).toMatchObject({ kind: "image", width: 1080, height: 1350 });
  });

  it("keeps both files when names collide", async () => {
    const c = await makeCtx({ seed: true });
    await attach(c, image("crowd.png"));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd.png"));
    await attach(c, image("crowd.png"));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd 1.png"));
    expect(c.index.getVariant(IG)!.media).toEqual(["event-x-cover.png", "crowd.png", "crowd 1.png"]);
  });

  it("refuses other files and flags videos as unsupported", async () => {
    const c = await makeCtx({ seed: true });
    expect(await c.ctx.composer.attachFiles(c.index.getVariant(IG)!, [new File(["x"], "doc.pdf")])).toBe(0);
    expect(Notice.messages.at(-1)).toBe("doc.pdf: use a PNG, JPG, WebP or GIF image.");
    await attach(c, new File([new Uint8Array([0, 0, 0])], "clip.mp4", { type: "video/mp4" }));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("clip.mp4"));
    const v = c.index.getVariant(IG)!;
    const issues = c.ctx.composer.check(v, await c.ctx.composer.content.load(v));
    expect(issues.map((i) => i.message)).toContain("clip.mp4: video isn't supported yet. Remove it or use an image.");
  });

  it("edits alt text and the focal point from the panel", async () => {
    const c = await makeCtx({ seed: true });
    await attach(c, image("crowd.png"));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd.png"));
    await renderPanel(c);
    await fireEvent.change(screen.getByLabelText("Alt text"), { target: { value: "Makers at laptops" } });
    await indexed(c.index, () => c.index.getVariant(IG)!.mediaMeta?.["crowd.png"]?.alt === "Makers at laptops");
    await fireEvent.keyDown(screen.getByRole("button", { name: "Set the focal point of crowd.png" }), { key: "ArrowRight" });
    await indexed(c.index, () => c.index.getVariant(IG)!.mediaMeta?.["crowd.png"]?.focus?.[0] === 0.55);
    expect(c.index.getVariant(IG)!.mediaMeta).toEqual({ "crowd.png": { alt: "Makers at laptops", focus: [0.55, 0.5] } });
  });

  it("does not move the focal point on a keyboard-activated click, but does on a real mouse click", async () => {
    const c = await makeCtx({ seed: true });
    await attach(c, image("crowd.png"));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd.png"));
    await renderPanel(c);
    const btn = screen.getByRole("button", { name: "Set the focal point of crowd.png" });
    vi.spyOn(btn, "getBoundingClientRect").mockReturnValue({
      width: 100,
      height: 100,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect);

    await fireEvent.click(btn, { detail: 0, clientX: 0, clientY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(c.index.getVariant(IG)!.mediaMeta?.["crowd.png"]?.focus).toBeUndefined();

    await fireEvent.click(btn, { detail: 1, clientX: 75, clientY: 25 });
    await indexed(c.index, () => c.index.getVariant(IG)!.mediaMeta?.["crowd.png"]?.focus !== undefined);
    expect(c.index.getVariant(IG)!.mediaMeta?.["crowd.png"]?.focus).toEqual([0.75, 0.25]);
  });

  it("reorders and removes media, with undo", async () => {
    const c = await makeCtx({ seed: true });
    await attach(c, image("crowd.png"));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("crowd.png"));
    await renderPanel(c);
    await fireEvent.click(screen.getByRole("button", { name: "Move crowd.png up" }));
    await indexed(c.index, () => c.index.getVariant(IG)!.media[0] === "crowd.png");
    await fireEvent.click(screen.getByRole("button", { name: "Remove event-x-cover.png" }));
    await indexed(c.index, () => c.index.getVariant(IG)!.media.length === 1);
    expect(c.index.getVariant(IG)!.media).toEqual(["crowd.png"]);
    Notice.last!.noticeEl.querySelector("button")!.click();
    await indexed(c.index, () => c.index.getVariant(IG)!.media.length === 2);
    expect(c.index.getVariant(IG)!.media).toEqual(["crowd.png", "event-x-cover.png"]);
  });

  it("attaches files dropped on the panel", async () => {
    const c = await makeCtx({ seed: true });
    await renderPanel(c);
    await fireEvent.drop(screen.getByRole("group", { name: "Drop images here" }), { dataTransfer: { files: [image("drop.png")] } });
    await indexed(c.index, () => c.index.getVariant(IG)!.media.includes("drop.png"));
    expect(c.index.getVariant(IG)!.media).toEqual(["event-x-cover.png", "drop.png"]);
  });
});
