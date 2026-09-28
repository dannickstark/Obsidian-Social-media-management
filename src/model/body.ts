import { getFrontMatterInfo } from "obsidian";

export function bodyOf(content: string): string {
  const info = getFrontMatterInfo(content);
  return info.exists ? content.slice(info.contentStart) : content;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Split a post body into thread items on lines that are exactly `---`, outside code fences. */
export function splitThread(body: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (f) {
      const ch = f[1]?.[0] ?? "`";
      if (fence === null) fence = ch;
      else if (fence === ch) fence = null;
      current.push(line);
      continue;
    }
    if (fence === null && line.trim() === "---") {
      items.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  items.push(current.join("\n"));
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

const WIKI_EMBED_RE = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const MD_EMBED_RE = /!\[[^\]]*\]\((?!https?:)([^)\s]+)\)/g;

export function extractEmbeds(body: string): string[] {
  const found: Array<{ index: number; target: string }> = [];
  for (const m of body.matchAll(WIKI_EMBED_RE)) found.push({ index: m.index ?? 0, target: (m[1] ?? "").trim() });
  for (const m of body.matchAll(MD_EMBED_RE)) found.push({ index: m.index ?? 0, target: (m[1] ?? "").trim() });
  found.sort((a, b) => a.index - b.index);
  const out: string[] = [];
  for (const { target } of found) if (target && !out.includes(target)) out.push(target);
  return out;
}

/** Markdown → readable text: drops embeds, resolves wikilinks/markdown links to their label. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, target: string) => (target.split("#")[0] ?? target).split("/").pop() ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

export function excerpt(body: string, max = 120): string {
  const line = plainText(body)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, "").trim())
    .find((l) => l.length > 0 && !FENCE_RE.test(l));
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type CharCounter = "graphemes" | "x-weighted" | "mastodon";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const URL_RE = /\bhttps?:\/\/[^\s]+/gi;
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

/** X counts most Latin text as 1 and CJK/emoji as 2 (twitter-text v3 ranges). */
function xWeight(grapheme: string): number {
  if (PICTOGRAPHIC_RE.test(grapheme)) return 2;
  const cp = grapheme.codePointAt(0) ?? 0;
  const light = cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
  return light ? 1 : 2;
}

export function countChars(text: string, counter: CharCounter = "graphemes"): number {
  if (counter === "graphemes") return [...segmenter.segment(text)].length;
  let total = 0;
  const withoutUrls = text.replace(URL_RE, () => {
    total += 23;
    return "";
  });
  // Mastodon: graphemes, and every URL counts 23 no matter its length.
  if (counter === "mastodon") return total + [...segmenter.segment(withoutUrls)].length;
  for (const { segment } of segmenter.segment(withoutUrls)) total += xWeight(segment);
  return total;
}
