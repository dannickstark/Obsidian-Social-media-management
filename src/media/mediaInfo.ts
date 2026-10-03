import type { App, TFile } from "obsidian";
import type { Variant } from "../model/types";
import type { MediaInfo } from "../platforms/types";
import { imageSize } from "./imageSize";

export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);

export function mediaKind(extension: string): MediaInfo["kind"] {
  const ext = extension.toLowerCase();
  if (ext in IMAGE_MIME) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "unsupported";
}

type Size = { width: number; height: number } | null;

/** Resolves `media:` links and reads what checks and previews need. Image sizes are cached per path and mtime. */
export class MediaInspector {
  private readonly sizes = new Map<string, { mtime: number; size: Size; fingerprint: string }>();

  constructor(private readonly app: App) {}

  resolve(target: string, sourcePath: string): TFile | null {
    return this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
  }

  inspect(v: Pick<Variant, "path" | "media" | "mediaMeta">): Promise<MediaInfo[]> {
    return Promise.all(v.media.map((target) => this.one(target, v)));
  }

  resourceUrl(path: string): string {
    const file = this.app.vault.getFileByPath(path);
    return file ? this.app.vault.getResourcePath(file) : "";
  }

  private async one(target: string, v: Pick<Variant, "path" | "mediaMeta">): Promise<MediaInfo> {
    const meta = v.mediaMeta?.[target];
    const base: MediaInfo = { target, kind: "missing" };
    if (meta?.alt) base.alt = meta.alt;
    if (meta?.focus) base.focus = meta.focus;
    const file = this.resolve(target, v.path);
    if (!file) return base;
    const kind = mediaKind(file.extension);
    const info: MediaInfo = { ...base, path: file.path, kind, bytes: file.stat.size };
    if (kind !== "image") return info;
    info.mime = IMAGE_MIME[file.extension.toLowerCase()];
    const detail = await this.detail(file, !!meta?.sourcePath);
    if (meta?.sourcePath) {
      info.fingerprint = detail.fingerprint;
      const source = this.app.vault.getFileByPath(meta.sourcePath);
      info.sourceFingerprint = source ? (await this.detail(source, true)).fingerprint : "missing";
    }
    return detail.size ? { ...info, width: detail.size.width, height: detail.size.height } : info;
  }

  private async detail(file: TFile, live = false): Promise<{ size: Size; fingerprint: string }> {
    const cached = this.sizes.get(file.path);
    if (!live && cached && cached.mtime === file.stat.mtime) return cached;
    const bytes = await this.app.vault.readBinary(file);
    const found = imageSize(new Uint8Array(bytes));
    const size = found ? { width: found.width, height: found.height } : null;
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const fingerprint = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.sizes.set(file.path, { mtime: file.stat.mtime, size, fingerprint });
    return { size, fingerprint };
  }
}
