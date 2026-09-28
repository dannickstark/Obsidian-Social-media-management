import type { MediaRules } from "../platforms/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clampRatio(ratio: number, range?: { min: number; max: number }): number {
  if (!range) return ratio;
  return Math.min(range.max, Math.max(range.min, ratio));
}

/** The part of the image (in source pixels) a feed with `ratio` shows, centred on the focal point. */
export function cropRect(size: { width: number; height: number }, ratio: number, focus: [number, number] = [0.5, 0.5]): Rect {
  let width = size.width;
  let height = size.height;
  if (size.width / size.height > ratio) width = Math.round(size.height * ratio);
  else height = Math.round(size.width / ratio);
  const x = Math.round(Math.min(Math.max(focus[0] * size.width - width / 2, 0), size.width - width));
  const y = Math.round(Math.min(Math.max(focus[1] * size.height - height / 2, 0), size.height - height));
  return { x, y, width, height };
}

/** The ratio a feed shows a single image at, or null when the platform shows images uncropped. */
export function feedRatio(rules: MediaRules, size: { width: number; height: number }): number | null {
  if (rules.cropRatio) return rules.cropRatio;
  if (rules.ratio) return clampRatio(size.width / size.height, rules.ratio);
  return null;
}

/** A click inside `box` → focal point (0..1, two decimals). */
export function focusFromPoint(x: number, y: number, box: { left: number; top: number; width: number; height: number }): [number, number] {
  const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 100) / 100));
  return [clamp((x - box.left) / box.width), clamp((y - box.top) / box.height)];
}
