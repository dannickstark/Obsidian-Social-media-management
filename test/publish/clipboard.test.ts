import { afterEach, describe, expect, it, vi } from "vitest";
import { ClipboardService, isMobile, type ClipboardEnv } from "../../src/publish/clipboard";
import { browser } from "../fakes/browser";
import { createApp } from "../helpers";
import { jpeg, png } from "../media/bytes";

async function vault() {
  const app = createApp();
  await app.vault.createFolder("Social");
  await app.vault.createBinary("Social/a.png", png(10, 10));
  await app.vault.createBinary("Social/b.jpg", jpeg(10, 10));
  return app;
}

afterEach(() => {
  delete (window as unknown as { require?: unknown }).require;
  document.body.classList.remove("is-mobile");
});

describe("ClipboardService", () => {
  it("copies text", async () => {
    const clip = new ClipboardService((await vault()) as never);
    expect(await clip.copyText("Hello")).toBe(true);
    expect(browser.clipboard).toEqual([{ kind: "text", text: "Hello" }]);
  });

  it("reports a failed text copy", async () => {
    const env: ClipboardEnv = { writeText: async () => Promise.reject(new Error("denied")), writeImage: async () => false, reveal: () => false };
    expect(await new ClipboardService((await vault()) as never, env).copyText("Hello")).toBe(false);
  });

  it("copies a PNG with ClipboardItem when Electron is not available", async () => {
    const clip = new ClipboardService((await vault()) as never);
    expect(await clip.copyImage("Social/a.png")).toBe("copied");
    expect(browser.clipboard).toEqual([{ kind: "blob", type: "image/png", size: 33 }]);
  });

  it("uses Electron's native image clipboard on desktop", async () => {
    const writeImage = vi.fn();
    (window as unknown as { require: (m: string) => unknown }).require = () => ({
      clipboard: { writeImage },
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
    });
    const clip = new ClipboardService((await vault()) as never);
    expect(await clip.copyImage("Social/b.jpg")).toBe("copied");
    expect(writeImage).toHaveBeenCalledOnce();
  });

  it("reveals the file when the image can't go on the clipboard", async () => {
    const app = await vault();
    const showInFolder = vi.fn();
    Object.assign(app, { showInFolder });
    expect(await new ClipboardService(app as never).copyImage("Social/b.jpg")).toBe("revealed");
    expect(showInFolder).toHaveBeenCalledWith("Social/b.jpg");
    expect(await new ClipboardService(app as never).copyImage("Social/missing.png")).toBe("failed");
  });

  it("copies a clipboard item of either kind", async () => {
    const clip = new ClipboardService((await vault()) as never);
    expect(await clip.copy({ label: "Post text", text: "A" })).toBe("copied");
    expect(await clip.copy({ label: "Image 1", imagePath: "Social/a.png" })).toBe("copied");
    expect(await clip.copy({ label: "Image 2", imagePath: "Social/gone.png" })).toBe("failed");
    expect(browser.clipboard).toEqual([
      { kind: "text", text: "A" },
      { kind: "blob", type: "image/png", size: 33 },
    ]);
  });

  it("hands text and images to the share sheet on phones", async () => {
    const shared: ShareData[] = [];
    Object.defineProperty(navigator, "share", { configurable: true, value: async (data: ShareData) => void shared.push(data) });
    document.body.classList.add("is-mobile");
    expect(isMobile()).toBe(true);
    expect(await new ClipboardService((await vault()) as never).share("Caption", ["Social/a.png"])).toBe(true);
    expect(shared[0]?.text).toBe("Caption");
    expect(shared[0]?.files?.map((f) => f.name)).toEqual(["a.png"]);
    Reflect.deleteProperty(navigator, "share");
  });
});
