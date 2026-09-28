import { countChars, extractEmbeds } from "../model/body";
import { PLATFORM_META, type Platform } from "../model/platforms";
import type { Channel, Variant } from "../model/types";
import { cropRect, feedRatio, type Rect } from "../media/crop";
import { limitFor } from "../platforms/checks";
import { countFor, postItems, renderText, urlsIn } from "../platforms/text";
import type { MediaInfo, PlatformDef, PreviewLayout, TextDialect } from "../platforms/types";
import { initials } from "../ui/format";

export interface Segment {
  text: string;
  bold?: true;
  italic?: true;
  strike?: true;
  code?: true;
  tag?: true;
  href?: string;
}

const URL_SRC = String.raw`(?<url>https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?])`;
const TAG_SRC = String.raw`(?<tag>(?<=^|\s)#[\p{L}\p{N}_]+)`;
const MARKDOWN_SRC = [
  String.raw`\[(?<lt>[^\]\n]+)\]\((?<lu>[^)\s]+)\)`,
  String.raw`\*\*(?<b>[^*\n]+)\*\*`,
  String.raw`~~(?<s>[^~\n]+)~~`,
  String.raw`\x60(?<c>[^\x60\n]+)\x60`,
  String.raw`(?<![\w*])[*_](?<i>[^*_\n]+)[*_](?![\w*])`,
];
const WHATSAPP_SRC = [
  String.raw`\x60\x60\x60(?<c>[^\x60]+)\x60\x60\x60`,
  String.raw`(?<![\w*])\*(?<b>[^*\n]+)\*(?![\w*])`,
  String.raw`(?<![\w_])_(?<i>[^_\n]+)_(?![\w_])`,
  String.raw`(?<![\w~])~(?<s>[^~\n]+)~(?![\w~])`,
];

const REGEX = new Map<TextDialect, RegExp>();

function regexFor(dialect: TextDialect): RegExp {
  let re = REGEX.get(dialect);
  if (!re) {
    const parts =
      dialect === "markdown" || dialect === "telegram"
        ? [...MARKDOWN_SRC, URL_SRC, TAG_SRC]
        : dialect === "whatsapp"
          ? [...WHATSAPP_SRC, URL_SRC, TAG_SRC]
          : [URL_SRC, TAG_SRC];
    re = new RegExp(parts.join("|"), "gu");
    REGEX.set(dialect, re);
  }
  return re;
}

/** How the text looks on the platform: emphasis per dialect, plus links and hashtags. */
export function segments(text: string, dialect: TextDialect): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(regexFor(dialect))) {
    const g = m.groups ?? {};
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (g.url !== undefined) out.push({ text: g.url, href: g.url });
    else if (g.tag !== undefined) out.push({ text: g.tag, tag: true });
    else if (g.lt !== undefined) out.push({ text: g.lt, href: g.lu });
    else if (g.b !== undefined) out.push({ text: g.b, bold: true });
    else if (g.i !== undefined) out.push({ text: g.i, italic: true });
    else if (g.s !== undefined) out.push({ text: g.s, strike: true });
    else if (g.c !== undefined) out.push({ text: g.c, code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export interface PreviewAuthor {
  name: string;
  handle?: string;
  color: string;
  initials: string;
  round: boolean;
}

export interface PreviewMedia {
  target: string;
  src: string;
  kind: MediaInfo["kind"];
  alt?: string;
  crop?: { ratio: number; rect: Rect; width: number; height: number };
}

export interface PreviewItem {
  segments: Segment[];
  chars: number;
  limit: number;
  over: boolean;
}

export interface PreviewModel {
  platform: Platform;
  label: string;
  layout: PreviewLayout;
  dialect: TextDialect;
  author: PreviewAuthor;
  title?: string;
  url?: string;
  domain?: string;
  items: PreviewItem[];
  /** The first item cut at the platform's fold, when it is longer. */
  fold?: Segment[];
  media: PreviewMedia[];
  linkCard?: { url: string; domain: string };
  featured?: PreviewMedia;
  excerpt?: string;
  /** The raw Markdown, for the article layout. */
  markdown: string;
  /** Image sources for embeds in an article body, by link target ("" when unresolved). */
  embeds?: Record<string, string>;
}

export interface PreviewInput {
  def: PlatformDef;
  variant: Pick<Variant, "title" | "url" | "wordpress">;
  body: string;
  media: MediaInfo[];
  featured?: MediaInfo;
  channel?: Channel;
  resource(path: string): string;
  /** Resolves an embed in the body to an image source (article layout). */
  embedSrc?(target: string): string;
}

/** Platforms whose feed turns a link into a card. */
const LINK_CARDS = new Set<Platform>(["linkedin", "x", "facebook", "mastodon", "bluesky", "telegram", "discord", "whatsapp"]);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncate(text: string, n: number): string {
  return [...graphemes.segment(text)]
    .slice(0, n)
    .map((s) => s.segment)
    .join("")
    .trimEnd();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function previewMedia(m: MediaInfo, def: PlatformDef, resource: (path: string) => string): PreviewMedia {
  const out: PreviewMedia = { target: m.target, src: m.path ? resource(m.path) : "", kind: m.kind };
  if (m.alt) out.alt = m.alt;
  if (m.kind === "image" && m.width && m.height) {
    const size = { width: m.width, height: m.height };
    const ratio = feedRatio(def.capabilities.media, size);
    if (ratio) out.crop = { ratio, rect: cropRect(size, ratio, m.focus), width: m.width, height: m.height };
  }
  return out;
}

/** CSS object-position that shows `crop.rect` of the image inside an `object-fit: cover` box. */
export function objectPosition(crop: NonNullable<PreviewMedia["crop"]>): string {
  const x = crop.width > crop.rect.width ? (crop.rect.x / (crop.width - crop.rect.width)) * 100 : 50;
  const y = crop.height > crop.rect.height ? (crop.rect.y / (crop.height - crop.rect.height)) * 100 : 50;
  return `${Math.round(x)}% ${Math.round(y)}%`;
}

export function previewModel(p: PreviewInput): PreviewModel {
  const { def, variant, channel } = p;
  const items = postItems(p.body, def);
  const limit = limitFor(def, channel);
  const name = channel?.name ?? "You";
  const model: PreviewModel = {
    platform: def.id,
    label: PLATFORM_META[def.id].label,
    layout: def.preview,
    dialect: def.dialect,
    author: {
      name,
      handle: channel?.handle,
      color: channel?.avatarColor ?? "#888888",
      initials: initials(name),
      round: !channel || channel.kind === "profile" || channel.kind === "account",
    },
    items: items.map((text) => {
      const chars = countFor(text, def);
      return { segments: segments(text, def.dialect), chars, limit, over: chars > limit };
    }),
    media: def.capabilities.media.maxCount > 0 ? p.media.map((m) => previewMedia(m, def, p.resource)) : [],
    markdown: p.body,
  };
  if (variant.title) model.title = variant.title;
  if (variant.url) {
    model.url = variant.url;
    model.domain = domainOf(variant.url);
  }
  const foldAt = def.capabilities.limits.foldAt;
  const first = items[0] ?? "";
  if (foldAt && countChars(first) > foldAt) model.fold = segments(truncate(first, foldAt), def.dialect);
  const cardUrl = variant.url ?? urlsIn(items.join("\n")).at(-1);
  if (cardUrl && model.media.length === 0 && LINK_CARDS.has(def.id)) model.linkCard = { url: cardUrl, domain: domainOf(cardUrl) };
  if (p.featured) model.featured = previewMedia(p.featured, def, p.resource);
  if (variant.wordpress?.excerpt) model.excerpt = variant.wordpress.excerpt;
  if (def.preview === "article") {
    model.embeds = Object.fromEntries(extractEmbeds(p.body).map((target) => [target, p.embedSrc?.(target) ?? ""]));
  }
  return model;
}

export type Block =
  | { kind: "heading"; level: number; segments: Segment[] }
  | { kind: "paragraph"; segments: Segment[] }
  | { kind: "list"; ordered: boolean; items: Segment[][] }
  | { kind: "quote"; segments: Segment[] }
  | { kind: "rule" }
  | { kind: "image"; target: string };

const inline = (text: string): Segment[] => segments(renderText(text, "markdown"), "markdown");
const WIKI_IMAGE_RE = /^!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/;
const MD_IMAGE_RE = /^!\[[^\]]*\]\(([^)\s]+)\)$/;

/** A small Markdown block parser for the neutral article preview (not a full CommonMark renderer). */
export function articleBlocks(markdown: string, title?: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Segment[][] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "paragraph", segments: inline(para.join("\n")) });
    para = [];
  };
  const flush = () => {
    flushPara();
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };
  for (const raw of markdown.replace(/%%[\s\S]*?%%/g, "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    let m: RegExpExecArray | null;
    if (!trimmed) {
      flush();
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ kind: "heading", level: m[1]!.length, segments: inline(m[2]!) });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      blocks.push({ kind: "rule" });
    } else if ((m = WIKI_IMAGE_RE.exec(trimmed) ?? MD_IMAGE_RE.exec(trimmed))) {
      flush();
      blocks.push({ kind: "image", target: m[1]!.trim() });
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      const ordered = /\d/.test(m[1]!);
      flushPara();
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push(inline(m[2]!));
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flush();
      blocks.push({ kind: "quote", segments: inline(m[1]!) });
    } else {
      if (list) flush();
      para.push(line);
    }
  }
  flush();
  const first = blocks[0];
  const plain = (s: Segment[]) => s.map((x) => x.text).join("").trim();
  if (title && first?.kind === "heading" && first.level === 1 && plain(first.segments) === title.trim()) blocks.shift();
  return blocks;
}
