import { Platform, type App } from "obsidian";
import type { ClipItem } from "../platforms/types";

export type CopyResult = "copied" | "revealed" | "failed";

export interface ClipboardEnv {
  writeText(text: string): Promise<void>;
  /** Puts an image on the clipboard; false when this device can't. */
  writeImage(bytes: ArrayBuffer, mime: string): Promise<boolean>;
  /** Shows the file in the system file manager; false when unavailable (mobile). */
  reveal(path: string): boolean;
}

interface ElectronLike {
  clipboard?: { writeImage(image: unknown): void };
  nativeImage?: { createFromBuffer(buffer: Buffer): { isEmpty(): boolean } };
}

const MIME: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Phones and tablets: Obsidian's Platform flag, or the `is-mobile` class it puts on <body>. */
export function isMobile(): boolean {
  return Platform.isMobile || document.body.classList.contains("is-mobile");
}

export function browserClipboard(app: App): ClipboardEnv {
  return {
    writeText: (text) => navigator.clipboard.writeText(text),
    async writeImage(bytes, mime) {
      // Electron (and Node's Buffer) exist only in the desktop app (#27).
      if (Platform.isDesktopApp) {
        const electron = (window as unknown as { require?: (m: string) => unknown }).require?.("electron") as ElectronLike | undefined;
        if (electron?.clipboard && electron.nativeImage) {
          const image = electron.nativeImage.createFromBuffer(Buffer.from(bytes));
          if (!image.isEmpty()) {
            electron.clipboard.writeImage(image);
            return true;
          }
        }
      }
      if (typeof ClipboardItem !== "undefined" && mime === "image/png") {
        await navigator.clipboard.write([new ClipboardItem({ [mime]: new Blob([bytes], { type: mime }) })]);
        return true;
      }
      return false;
    },
    reveal(path) {
      if (!Platform.isDesktopApp) return false;
      const show = (app as unknown as { showInFolder?: (path: string) => void }).showInFolder;
      if (!show) return false;
      show.call(app, path);
      return true;
    },
  };
}

export class ClipboardService {
  constructor(
    private readonly app: App,
    private readonly env: ClipboardEnv = browserClipboard(app),
  ) {}

  async copyText(text: string): Promise<boolean> {
    try {
      await this.env.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Image on the clipboard where possible; otherwise the file is revealed so it can be dragged in. */
  async copyImage(path: string): Promise<CopyResult> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return "failed";
    const mime = MIME[file.extension.toLowerCase()] ?? "application/octet-stream";
    try {
      if (await this.env.writeImage(await this.app.vault.readBinary(file), mime)) return "copied";
    } catch {
      // fall back to revealing the file
    }
    return this.env.reveal(path) ? "revealed" : "failed";
  }

  async copy(item: ClipItem): Promise<CopyResult> {
    if ("text" in item) return (await this.copyText(item.text)) ? "copied" : "failed";
    return this.copyImage(item.imagePath);
  }

  /** Phones: hand the text and images to the system share sheet. */
  async share(text: string, imagePaths: readonly string[] = []): Promise<boolean> {
    const share = (navigator as unknown as { share?: (data: ShareData) => Promise<void> }).share;
    if (!share) return false;
    const files: File[] = [];
    for (const path of imagePaths) {
      const file = this.app.vault.getFileByPath(path);
      if (file) files.push(new File([await this.app.vault.readBinary(file)], file.name, { type: MIME[file.extension.toLowerCase()] ?? "" }));
    }
    try {
      await share.call(navigator, files.length ? { text, files } : { text });
      return true;
    } catch {
      return false;
    }
  }
}
