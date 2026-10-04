import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { ImageGenerationService } from "../../src/composer/imageGeneration";
import ImageGeneration from "../../src/composer/ImageGeneration.svelte";
import Composer from "../../src/composer/Composer.svelte";
import { composerSession } from "../../src/composer/session";
import { osmmContext } from "../../src/ui/context";
import { indexed } from "../helpers";
import { validPng } from "../images/bytes";
import { makeCtx } from "../ui/ctx";
import { TEST_NOW } from "../ui/ctx";

const POST = "Social/Event X/Event X – Instagram.md";
const source = validPng(16, 9);

describe("composer image generation", () => {
  it("opens from Media and cancels without writing any asset or note field", async () => {
    const c = await makeCtx({ seed: true });
    const session = composerSession(c.app as never, c.index);
    session.path.set(POST);
    render(Composer, { props: { session, openVariant: () => undefined }, context: osmmContext(c.ctx) });
    await screen.findByRole("button", { name: "Generate image" });
    const before = await c.app.vault.read(c.app.vault.getFileByPath(POST)!);
    await fireEvent.click(screen.getByRole("button", { name: "Generate image" }));
    expect(screen.getByRole("dialog", { name: "Generate image" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel image generation" }));
    expect(screen.queryByRole("dialog", { name: "Generate image" })).toBeNull();
    expect(await c.app.vault.read(c.app.vault.getFileByPath(POST)!)).toBe(before);
    expect(c.app.vault.getFiles().filter((f) => f.extension === "png")).toHaveLength(0);
    session.dispose();
  });

  it("regenerates a preview and writes only the accepted version with its focus and crop provenance", async () => {
    const c = await makeCtx({ seed: true });
    const images = [source, validPng(12, 9, 30)];
    const generate = vi.fn().mockImplementation(async () => images.shift()!);
    const service = new ImageGenerationService({
      app: c.app as never,
      writer: c.writer,
      client: { generate },
      rootFolder: () => "Social",
      now: () => 0,
      defaultStaggerMinutes: () => 0,
      render: async (_bytes, rect) => validPng(rect.width, rect.height),
    });
    const note = c.app.vault.getFileByPath(POST)!;
    const close = vi.fn();
    render(ImageGeneration, { props: { session: service.open(note as never), onClose: close } });
    await fireEvent.input(screen.getByLabelText("Image prompt"), { target: { value: "Berlin event poster" } });
    await fireEvent.input(screen.getByLabelText("Avoid"), { target: { value: "text" } });
    await fireEvent.change(screen.getByLabelText("Image size"), { target: { value: "1536x1024" } });
    await fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    await screen.findByRole("img", { name: "Generated crop" });
    expect(c.app.vault.getFiles().filter((f) => f.extension === "png")).toHaveLength(0);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Berlin event poster", negativePrompt: "text", size: "1536x1024" }));
    await fireEvent.click(screen.getByRole("button", { name: "Regenerate preview" }));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await screen.findByRole("img", { name: "Generated crop" });
    await fireEvent.input(screen.getByLabelText("Focal point horizontal"), { target: { value: "100" } });
    await fireEvent.input(screen.getByLabelText("Focal point vertical"), { target: { value: "25" } });
    await fireEvent.change(screen.getByLabelText("Crop ratio"), { target: { value: "1" } });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Use image" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Use image" }));
    await indexed(c.index, () => !!c.index.getVariant(POST)?.mediaMeta);
    const variant = c.index.getVariant(POST)!;
    const target = variant.media.at(-1)!;
    const meta = variant.mediaMeta?.[target];
    expect(meta).toMatchObject({ focus: [1, 0.25], cropRatio: 1 });
    expect(c.app.vault.getFileByPath(meta!.sourcePath!)).not.toBeNull();
    expect(c.app.vault.getFileByPath(meta!.cropPath!)).not.toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("keeps a missing-key error in the window and does not create an asset", async () => {
    const c = await makeCtx({ seed: true });
    const service = new ImageGenerationService({
      app: c.app as never, writer: c.writer,
      client: { generate: async () => { throw new Error("Add an OpenAI key in this device's secret storage before generating an image."); } },
      rootFolder: () => "Social",
      now: () => 0, defaultStaggerMinutes: () => 0,
    });
    render(ImageGeneration, { props: { session: service.open(c.app.vault.getFileByPath(POST)! as never), onClose: () => undefined } });
    await fireEvent.input(screen.getByLabelText("Image prompt"), { target: { value: "A lake" } });
    await fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("OpenAI key"));
    expect(c.app.vault.getFiles().filter((f) => f.extension === "png")).toHaveLength(0);
  });

  it("refuses oversized bytes before accepting and never writes a file", async () => {
    const c = await makeCtx({ seed: true });
    const service = new ImageGenerationService({
      app: c.app as never, writer: c.writer,
      client: { generate: async () => new ArrayBuffer(20 * 1024 * 1024 + 1) },
      rootFolder: () => "Social",
      now: () => 0, defaultStaggerMinutes: () => 0,
    });
    const session = service.open(c.app.vault.getFileByPath(POST)! as never);
    await expect(session.generate({ prompt: "A lake", size: "1024x1024" })).rejects.toThrow(/20 MB|too large/i);
    expect(c.app.vault.getFiles().filter((f) => f.extension === "png")).toHaveLength(0);
  });

  it("rejects a late scheduled post on the fresh attach and removes both original and crop", async () => {
    const path = "Social/Posts/Queued Image.md";
    const c = await makeCtx({ seed: true, notes: [{ path, frontmatter: {
      type: "social-post", platform: "linkedin", title: "Queued Image", channels: ["li/acme-studio"], status: "scheduled",
      scheduled_at: "2026-10-08T10:20:00+02:00", deliveries: { "li/acme-studio": { status: "scheduled" } },
    }, body: "Hello makers\n" }] });
    const note = c.app.vault.getFileByPath(path)!;
    const service = new ImageGenerationService({
      app: c.app as never, writer: c.writer, client: { generate: async () => source },
      rootFolder: () => "Social", now: () => TEST_NOW, defaultStaggerMinutes: () => 0,
      render: async (_bytes, rect) => validPng(rect.width, rect.height),
    });
    const session = service.open(note as never);
    await session.generate({ prompt: "A lake", size: "1024x1024" });
    await c.writer.patchVariant(note as never, { scheduledAt: TEST_NOW + 5 * 60_000 });
    const before = await c.app.vault.read(note);
    await expect(session.accept({ ratio: 1, focus: [0.75, 0.25] })).rejects.toThrow("This post goes out in less than 10 minutes; unschedule it first or ask the user.");
    expect(await c.app.vault.read(note)).toBe(before);
    expect(c.app.vault.getFiles().filter((f) => f.extension === "png")).toHaveLength(0);
  });
});
