import type { AssistedJob, ClipItem } from "./types";

export const enc = encodeURIComponent;

export function imageItems(job: AssistedJob): ClipItem[] {
  return job.media
    .filter((m) => m.kind === "image" && m.path)
    .map((m, i) => ({ label: `Image ${i + 1}`, imagePath: m.path! }));
}

/** The first thread item as the post, the others as replies. */
export function threadItems(items: readonly string[]): ClipItem[] {
  return items.map((text, i) => ({ label: i === 0 ? "Post text" : `Reply ${i + 1}`, text }));
}

export function threadHint(items: readonly string[], single: string): string {
  if (items.length < 2) return single;
  return `Post the first part, then reply to it with ${items.length === 2 ? "part 2" : `parts 2 to ${items.length}`}.`;
}

/** "eventx.berlin", "https://www.eventx.berlin/blog" → "eventx.berlin"; null unless it looks like a domain. */
export function hostOf(value?: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** "@you@mastodon.social" or "https://fosstodon.org/@you" → the instance host. */
export function mastodonInstance(handle?: string): string | null {
  const at = /^@?[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(handle?.trim() ?? "");
  return at ? at[1]!.toLowerCase() : hostOf(handle);
}

/** "r/SideProject" or "https://www.reddit.com/r/SideProject/" → "SideProject". */
export function subreddit(handle?: string): string | null {
  return /(?:^|\/)r\/([A-Za-z0-9_]{2,21})\/?$/.exec(handle?.trim() ?? "")?.[1] ?? null;
}
