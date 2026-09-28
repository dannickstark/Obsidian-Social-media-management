import type { Platform } from "../model/platforms";

/** Badge text colour; every platform colour must keep ≥ 4.5:1 against it. */
export const BADGE_TEXT = "#141418";

export const PLATFORM_COLORS: Readonly<Record<Platform, string>> = {
  linkedin: "#6ea3e6",
  x: "#e6e4df",
  instagram: "#e38bb4",
  facebook: "#8aa3f0",
  mastodon: "#a99bf6",
  bluesky: "#68b9f2",
  telegram: "#5cc6d6",
  discord: "#a0a7f3",
  hackernews: "#f29a5c",
  indiehackers: "#6fc4ae",
  reddit: "#f08a6a",
  whatsapp: "#7fd39a",
  wordpress: "#b9b3a6",
};

function channelLuminance(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channelLuminance((n >> 16) & 255) +
    0.7152 * channelLuminance((n >> 8) & 255) +
    0.0722 * channelLuminance(n & 255)
  );
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
