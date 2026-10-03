import { cropRect, type Rect } from "../media/crop";
import { imageSize } from "../media/imageSize";
import type { FocalPoint } from "./types";

export type CropRenderer = (source: ArrayBuffer, rect: Rect) => Promise<ArrayBuffer>;

/** Draws a crop into a new PNG; it never edits the source buffer or vault file. */
async function renderCrop(source: ArrayBuffer, rect: Rect): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([source]));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image cropping is unavailable on this device.");
    ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode the image crop.")), "image/png"));
    return blob.arrayBuffer();
  } finally {
    bitmap.close();
  }
}

/** Makes a new PNG crop around the focal point. The original bytes remain untouched. */
export async function cropFromFocus(source: ArrayBuffer, ratio: number, focus: FocalPoint, render: CropRenderer = renderCrop): Promise<ArrayBuffer> {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 10) throw new Error("Invalid crop ratio.");
  const size = imageSize(new Uint8Array(source));
  if (!size || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192 || size.width * size.height > 40_000_000 || source.byteLength > 25 * 1024 * 1024) {
    throw new Error("Choose a supported image under 25 MB and 40 megapixels.");
  }
  const clamped: FocalPoint = focus.map((n) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5) as FocalPoint;
  const rect = cropRect(size, ratio, clamped);
  if (rect.width < 1 || rect.height < 1) throw new Error("Invalid crop ratio.");
  const result = await render(source, rect);
  if (result.byteLength > 25 * 1024 * 1024 || imageSize(new Uint8Array(result))?.mime !== "image/png") throw new Error("Could not encode the image crop.");
  return result;
}
