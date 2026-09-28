import type { App, TFile } from "obsidian";
import type { Variant } from "../model/types";
import type { MediaInfo } from "../platforms/types";
import { imageSize } from "./imageSize";

const IMAGE_MIME: Readonly<Record<string, string>> = {
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
  private readonly sizes = new Map<string, { mtime: number; size: Size }>();

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
    const size = await this.size(file);
    return size ? { ...info, width: size.width, height: size.height } : info;
  }

  private async size(file: TFile): Promise<Size> {
    const cached = this.sizes.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.size;
    const found = imageSize(new Uint8Array(await this.app.vault.readBinary(file)));
    const size = found ? { width: found.width, height: found.height } : null;
    this.sizes.set(file.path, { mtime: file.stat.mtime, size });
    return size;
  }
}
