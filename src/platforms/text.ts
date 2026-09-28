import { countChars, splitThread } from "../model/body";
import type { PlatformDef, TextDialect } from "./types";

const COMMENT_RE = /%%[\s\S]*?%%/g;
const WIKI_EMBED_RE = /!\[\[[^\]]*\]\]/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const HEADING_RE = /^#{1,6}[ \t]+(.+)$/gm;
const BOLD_RE = /(\*\*|__)(?=\S)([^\n]*?\S)\1/g;
const STRIKE_RE = /~~(?=\S)([^\n]*?\S)~~/g;
const ITALIC_STAR_RE = /(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/gm;
/** Placeholder for WhatsApp bold while Markdown italics are converted. */
const MARK = "\u0000";

function wikiLabel(target: string, alias: string | undefined): string {
  if (alias?.trim()) return alias.trim();
  const [note = "", heading = ""] = target.split("#");
  const name = note.trim() ? (note.split("/").pop() ?? note) : heading;
  return name.trim();
}

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

function plainLink(label: string, url: string): string {
  return bare(label) === bare(url) ? url : `${label} (${url})`;
}

/** The note's Markdown → the text a platform receives (see the dialect table in the M2a plan, Task 2). */
export function renderText(markdown: string, dialect: TextDialect): string {
  let t = markdown.replace(COMMENT_RE, "").replace(WIKI_EMBED_RE, "").replace(MD_IMAGE_RE, "");
  t = t.replace(WIKILINK_RE, (_m, target: string, alias: string | undefined) => wikiLabel(target, alias));
  if (dialect === "plain" || dialect === "whatsapp") {
    t = t.replace(MD_LINK_RE, (_m, label: string, url: string) => plainLink(label, url));
  }
  switch (dialect) {
    case "plain":
      t = t.replace(HEADING_RE, "$1").replace(BOLD_RE, "$2").replace(STRIKE_RE, "$1");
      break;
    case "whatsapp":
      t = t
        .replace(HEADING_RE, "$1")
        .replace(BOLD_RE, `${MARK}$2${MARK}`)
        .replace(ITALIC_STAR_RE, "$1_$2_")
        .replace(STRIKE_RE, "~$1~")
        .split(MARK)
        .join("*");
      break;
    case "telegram":
      t = t.replace(HEADING_RE, "**$1**");
      break;
    case "markdown":
    case "html":
      break;
  }
  return t
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Thread items on thread platforms (split on `---` lines); one item otherwise. Empty items are dropped. */
export function postItems(body: string, def: PlatformDef): string[] {
  if (!def.capabilities.threads) {
    const text = renderText(body, def.dialect);
    return text ? [text] : [];
  }
  return splitThread(body)
    .map((part) => renderText(part, def.dialect))
    .filter((part) => part.length > 0);
}

export function postText(body: string, def: PlatformDef): string {
  return postItems(body, def).join("\n\n");
}

export function countFor(text: string, def: PlatformDef): number {
  return countChars(text, def.capabilities.limits.counter);
}

const HASHTAG_RE = /(^|\s)#([\p{L}\p{N}_]+)/gu;

export function hashtags(text: string): string[] {
  return [...text.matchAll(HASHTAG_RE)].map((m) => m[2] ?? "");
}

const LINK_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export function urlsIn(text: string): string[] {
  return [...text.matchAll(LINK_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

const sameUrl = (a: string, b: string): boolean => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** The text with `url` on its own last line, unless the text already contains that link (Telegram, Discord, Mastodon). */
export function withLink(text: string, url: string | undefined): string {
  if (!url || urlsIn(text).some((u) => sameUrl(u, url))) return text;
  const body = text.trimEnd();
  return body ? `${body}\n\n${url}` : url;
}
