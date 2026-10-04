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

/** `@user@domain` (not an email: nothing word-like before the first `@`). Mastodon counts it as `@user`. */
const REMOTE_MENTION_RE = /(^|[^\w@])(@\w+)@(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;

/** Common generic TLDs; with the country codes below, what X links without `https://`. */
const GENERIC_TLDS =
  "com net org edu gov mil int info biz name pro mobi xyz app dev page online site tech store shop blog news cloud design art club live space website world today link social events community studio agency email";
const COUNTRY_TLDS =
  "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw";
const TLDS = [...GENERIC_TLDS.split(" "), ...COUNTRY_TLDS.split(" ")].sort((a, b) => b.length - a.length).join("|");
/** A domain without a scheme (`example.com`, `sub.example.co.uk/path`), not part of an email or a longer word. */
const BARE_DOMAIN_RE = new RegExp(`(^|[^\\w@./-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![\\w-])(?:/[^\\s]*)?)`, "gi");

/** Return the end of a matched link before terminal prose punctuation and unmatched closers. */
function linkEnd(link: string): number {
  let end = link.length;
  while (end > 0) {
    const last = link[end - 1]!;
    if (/[.,!?;:]/.test(last)) { end--; continue; }
    const open = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : undefined;
    if (open) {
      const closingCount = [...link.slice(0, end)].filter((c) => c === last).length;
      const openingCount = [...link.slice(0, end)].filter((c) => c === open).length;
      if (closingCount > openingCount) { end--; continue; }
    }
    break;
  }
  return end;
}

export function countChars(text: string, counter: CharCounter = "graphemes"): number {
  if (counter === "graphemes") return [...segmenter.segment(text)].length;
  let total = 0;
  const withoutUrls = text.replace(URL_RE, (url) => {
    // twitter-text treats terminal punctuation as prose, and excludes only unmatched closing brackets
    // from a URL. Keep these characters in the text so they retain their normal weight.
    const end = linkEnd(url);
    total += 23;
    return url.slice(end);
  });
  // Mastodon: graphemes, every URL counts 23 no matter its length, and `@user@domain` counts as `@user`.
  if (counter === "mastodon") return total + [...segmenter.segment(withoutUrls.replace(REMOTE_MENTION_RE, "$1$2"))].length;
  // X also shortens bare domains to a 23-character t.co link.
  const withoutDomains = withoutUrls.replace(BARE_DOMAIN_RE, (_m, lead: string, link: string) => {
    const end = linkEnd(link);
    total += 23;
    return lead + link.slice(end);
  });
  for (const { segment } of segmenter.segment(withoutDomains)) total += xWeight(segment);
  return total;
}
