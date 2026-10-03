import type { App, TFile } from "obsidian";
import { pngStructure } from "./png";
import type { SafeWriter } from "../model/writer";
import { cropFromFocus, type CropRenderer } from "./crops";
import type { FocalPoint, GeneratedMediaProvenance } from "./types";

export interface SavedGeneratedImage extends GeneratedMediaProvenance {
  /** A link target that resolves from the note, suitable for `media:`. */
  target: string;
}

export interface SaveGeneratedOptions {
  ratio?: number;
  focus?: FocalPoint;
  render?: CropRenderer;
}

/** Saves vault-local original and optional crop. The caller may preview bytes before calling this. */
export async function saveGeneratedImage(app: App, notePath: string, source: ArrayBuffer, options: SaveGeneratedOptions = {}): Promise<SavedGeneratedImage> {
  if (source.byteLength > 20 * 1024 * 1024) throw new Error("Generated image must be a PNG under 20 MB and 40 megapixels.");
  const size = pngStructure(new Uint8Array(source));
  if (!size) {
    throw new Error("Generated image must be a PNG under 20 MB and 40 megapixels.");
  }
  const focus = (options.focus ?? [0.5, 0.5]).map((n) => Math.round((Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5) * 100) / 100) as FocalPoint;
  // Render before writing either file so a failed crop leaves no orphaned original.
  const cropped = options.ratio === undefined ? undefined : await cropFromFocus(source, options.ratio, focus, options.render);
  if (cropped && (cropped.byteLength > 20 * 1024 * 1024 || !pngStructure(new Uint8Array(cropped)))) throw new Error("Generated crop must be a complete PNG under 20 MB.");
  const sourcePath = await app.fileManager.getAvailablePathForAttachment("generated-original.png", notePath);
  const original = await app.vault.createBinary(sourcePath, source);
  let crop: TFile | undefined;
  try {
    if (cropped === undefined) return { sourcePath: original.path, focus, target: app.metadataCache.fileToLinktext(original, notePath, true) };
    const cropPath = await app.fileManager.getAvailablePathForAttachment("generated-crop.png", notePath);
    crop = await app.vault.createBinary(cropPath, cropped);
    return { sourcePath: original.path, cropPath: crop.path, cropRatio: options.ratio!, focus, target: app.metadataCache.fileToLinktext(crop, notePath, true) };
  } catch (error) {
    const cleanup = await Promise.allSettled([crop, original].filter((file): file is TFile => !!file && app.vault.getFileByPath(file.path) === file).map((file) => app.vault.delete(file)));
    const failed = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length) throw new AggregateError([error, ...failed.map((result) => result.reason)], "Generated image save failed and cleanup was incomplete.");
    throw error;
  }
}

/** One fresh note write. It never schedules or publishes a delivery. */
export async function attachGeneratedImage(app: App, writer: SafeWriter, note: TFile, image: SavedGeneratedImage): Promise<void> {
  try {
    await writer.updateVariant(note, (fresh) => ({ fields: {
      media: fresh.media.includes(image.target) ? fresh.media : [...fresh.media, image.target],
      mediaMeta: { ...fresh.mediaMeta, [image.target]: {
        ...fresh.mediaMeta?.[image.target], sourcePath: image.sourcePath,
        ...(image.cropPath ? { cropPath: image.cropPath } : {}),
        ...(image.cropRatio !== undefined ? { cropRatio: image.cropRatio } : {}), focus: image.focus,
      } },
    } }));
  } catch (error) {
    // These paths were returned by saveGeneratedImage for this note. Never delete a path that no longer resolves.
    const files: TFile[] = [];
    for (const path of [image.cropPath, image.sourcePath]) {
      if (!path) continue;
      const file = app.vault.getFileByPath(path);
      if (file) files.push(file);
    }
    const cleanup = await Promise.allSettled(files.map((file) => app.vault.delete(file)));
    const failed = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length) throw new AggregateError([error, ...failed.map((result) => result.reason)], "Generated image attach failed and cleanup was incomplete.");
    throw error;
  }
}
