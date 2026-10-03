import type { App, TFile } from "obsidian";
import { cropFromFocus, type CropRenderer } from "../images/crops";
import { OpenAIImageClient } from "../images/openai";
import { pngStructure } from "../images/png";
import type { FocalPoint, ImageGenerationRequest } from "../images/types";
import { attachGeneratedImage, saveGeneratedImage, type SavedGeneratedImage } from "../images/vault";
import type { SafeWriter } from "../model/writer";
import { GOES_OUT_SOON } from "../planner/leadTime";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Only messages authored by the image boundary may be shown to a user or Claude. */
export function safeImageError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^Add an OpenAI key in this device's secret storage before generating an image\.$/.test(message)) return message;
  if (/^The image prompt must contain 1–4000 characters\.$/.test(message)) return message;
  if (/^Unsupported image size\.$/.test(message)) return message;
  if (/^Negative guidance is too long\.$/.test(message)) return message;
  if (/^Image generation was cancelled\.$/.test(message)) return message;
  if (/^OpenAI image request failed(?: \(HTTP \d{3}\))?\.$/.test(message)) return message;
  if (/^OpenAI (?:image response is too large|returned an invalid image response)\.$/.test(message)) return message;
  if (message === GOES_OUT_SOON) return message;
  if (message === "Generated image must be a PNG under 20 MB and 40 megapixels." || message === "Generated crop must be a complete PNG under 20 MB.") return message;
  if (/^(?:Invalid crop ratio|Choose a supported image under 25 MB and 40 megapixels|Could not encode the image crop|Image cropping is unavailable on this device)\.$/.test(message)) return message;
  return "Image generation failed. Check the connection and try again.";
}

export interface ImageGenerationDeps {
  app: App;
  writer: SafeWriter;
  client: Pick<OpenAIImageClient, "generate">;
  rootFolder(): string;
  now(): number;
  defaultStaggerMinutes(): number;
  render?: CropRenderer;
}

/** Shared vault-local image workflow used by both the composer and Claude. */
export class ImageGenerationService {
  readonly client: Pick<OpenAIImageClient, "generate">;

  constructor(private readonly deps: ImageGenerationDeps) {
    this.client = deps.client;
  }

  open(note?: TFile): ImageGenerationSession {
    return new ImageGenerationSession(this.deps, note);
  }
}

export class ImageGenerationSession {
  private source: ArrayBuffer | null = null;
  private aborter: AbortController | null = null;
  private closed = false;
  private saving = false;
  private revision = 0;

  constructor(private readonly deps: ImageGenerationDeps, private readonly note?: TFile) {}

  async generate(request: Omit<ImageGenerationRequest, "signal">): Promise<ArrayBuffer> {
    if (this.closed || this.saving) throw new Error("Image generation was cancelled.");
    this.aborter?.abort();
    this.source = null;
    const revision = ++this.revision;
    const aborter = new AbortController();
    this.aborter = aborter;
    try {
      const bytes = await this.deps.client.generate({ ...request, signal: aborter.signal });
      if (this.closed || revision !== this.revision || aborter.signal.aborted) throw new Error("Image generation was cancelled.");
      if (bytes.byteLength > MAX_IMAGE_BYTES || !await pngStructure(new Uint8Array(bytes))) throw new Error("Generated image must be a PNG under 20 MB and 40 megapixels.");
      this.source = bytes;
      return bytes;
    } catch (error) {
      throw new Error(safeImageError(error));
    } finally {
      if (this.aborter === aborter) this.aborter = null;
    }
  }

  async previewCrop(ratio: number, focus: FocalPoint): Promise<ArrayBuffer> {
    if (this.closed || !this.source) throw new Error("Generate an image preview first.");
    try {
      return await cropFromFocus(this.source, ratio, focus, this.deps.render);
    } catch (error) {
      throw new Error(safeImageError(error));
    }
  }

  async accept(options: { ratio?: number; focus?: FocalPoint } = {}): Promise<SavedGeneratedImage> {
    if (this.closed || this.saving || !this.source) throw new Error("Generate an image preview first.");
    this.saving = true;
    try {
      const notePath = this.note?.path ?? `${this.deps.rootFolder().replace(/\/$/, "")}/_generated.md`;
      const saved = await saveGeneratedImage(this.deps.app, notePath, this.source, { ...options, render: this.deps.render });
      if (this.note) await attachGeneratedImage(this.deps.app, this.deps.writer, this.note, saved, this.deps);
      this.closed = true;
      this.source = null;
      return saved;
    } catch (error) {
      throw new Error(safeImageError(error));
    } finally {
      this.saving = false;
    }
  }

  cancel(): void {
    if (this.saving) return;
    this.closed = true;
    this.source = null;
    this.revision++;
    this.aborter?.abort();
    this.aborter = null;
  }
}
