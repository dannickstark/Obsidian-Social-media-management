export interface HtmlOptions {
  /** The uploaded address (and media_meta alt text) of an image embedded in the body; null leaves the embed out. */
  image(target: string): { src: string; alt?: string } | null;
}

interface Embed {
  target: string;
  alt: string;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SAFE_HREF = /^(https?:|mailto:)/i;
const REMOTE = /^https?:\/\//i;
/** Marks a piece of finished HTML inside text that is still to be escaped and styled. */
const PH = "\u0000";

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LONE_EMBED_RE = /^\s*(!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\))\s*$/;
const EMBED_ANY = /!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/g;
const WIKI_EMBED = /^!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/;
const MD_EMBED = /^!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)$/;

const stripComments = (md: string): string => md.replace(/%%[\s\S]*?%%/g, "");

function embedOf(e: string): Embed | null {
  const wiki = WIKI_EMBED.exec(e);
  if (wiki) {
    const label = (wiki[2] ?? "").trim();
    // `![[x.png|300]]` and `|300x200` are sizes, not alt text.
    return { target: wiki[1]!.trim(), alt: /^\d+(x\d+)?$/.test(label) ? "" : label };
  }
  const md = MD_EMBED.exec(e);
  if (!md) return null;
  let target = md[2]!;
  try {
    target = decodeURI(target);
  } catch {
    // Keep a malformed escape as written.
  }
  return { target, alt: md[1]! };
}

/** The local image targets embedded in a body, in order and once each (what the WordPress adapter uploads). */
export function imageEmbeds(md: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(md).matchAll(EMBED_ANY)) {
    const e = embedOf(m[0]);
    if (e && !REMOTE.test(e.target) && !out.includes(e.target)) out.push(e.target);
  }
  return out;
}

function img(e: Embed, opts: HtmlOptions): string | null {
  if (REMOTE.test(e.target)) return `<img src="${escapeHtml(e.target)}" alt="${escapeHtml(e.alt)}" />`;
  const found = opts.image(e.target);
  return found ? `<img src="${escapeHtml(found.src)}" alt="${escapeHtml(e.alt || found.alt || "")}" />` : null;
}

/**
 * Inline text (already outside code blocks): embeds, wikilinks, Markdown links and bare URLs are set aside as
 * finished HTML first, so the emphasis rules below never see them and can't reach into an href or a target.
 * Everything else is escaped, so raw HTML in the note shows as text; then `**`, `*`, `_`, `~~` and `==` become tags,
 * each with a word boundary on its outer side so markers inside words are left alone.
 */
function spans(text: string, opts: HtmlOptions): string {
  const saved: string[] = [];
  const keep = (html: string): string => `${PH}${saved.push(html) - 1}${PH}`;
  const marked = text
    .replace(EMBED_ANY, (raw) => {
      const e = embedOf(raw);
      const html = e ? img(e, opts) : null;
      return html ? keep(html) : "";
    })
    .replace(/\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]+))?\]\]/g, (_m, target: string, heading: string | undefined, alias: string | undefined) =>
      keep(escapeHtml((alias ?? (target.trim() ? (target.split("/").pop() ?? target) : (heading ?? ""))).trim())),
    )
    .replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?\)/g, (_m, label: string, href: string) =>
      keep(SAFE_HREF.test(href) ? `<a href="${escapeHtml(href)}">${spans(label, opts)}</a>` : spans(label, opts)),
    )
    .replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => {
      const clean = url.replace(/[.,;:!?]+$/, "");
      return keep(`<a href="${escapeHtml(clean)}">${escapeHtml(clean)}</a>`) + url.slice(clean.length);
    });
  return escapeHtml(marked)
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "<strong>$2</strong>")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "<del>$1</del>")
    .replace(/==(?=\S)([^\n]*?\S)==/g, "<mark>$1</mark>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, "$1<em>$2</em>")
    .replace(new RegExp(`${PH}(\\d+)${PH}`, "g"), (_m, n: string) => saved[Number(n)] ?? "");
}

function inline(raw: string, opts: HtmlOptions): string {
  return raw
    .split(/(`[^`\n]+`)/g)
    .map((part) => (/^`[^`\n]+`$/.test(part) ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : spans(part, opts)))
    .join("");
}

function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    /^\s*>/.test(line) ||
    LIST_RE.test(line) ||
    LONE_EMBED_RE.test(line) ||
    (line.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? ""))
  );
}

const width = (indent: string): number => indent.replace(/\t/g, "    ").length;

function list(lines: readonly string[], start: number, opts: HtmlOptions): { html: string; next: number } {
  const first = LIST_RE.exec(lines[start]!)!;
  const indent = width(first[1]!);
  const ordered = /\d/.test(first[2]!);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = LIST_RE.exec(line);
    if (!m) {
      // An indented line under an item continues it.
      if (line.trim() && /^\s+/.test(line) && items.length) {
        items[items.length - 1] += ` ${inline(line.trim(), opts)}`;
        i++;
        continue;
      }
      break;
    }
    const level = width(m[1]!);
    if (level < indent) break;
    if (level > indent && items.length) {
      const sub = list(lines, i, opts);
      items[items.length - 1] += sub.html;
      i = sub.next;
      continue;
    }
    if (/\d/.test(m[2]!) !== ordered) break;
    items.push(inline(m[3]!, opts));
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`, next: i };
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function table(lines: readonly string[], start: number, opts: HtmlOptions): { html: string; next: number } {
  const head = cells(lines[start]!);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) rows.push(cells(lines[i++]!));
  const th = head.map((c) => `<th>${inline(c, opts)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join("")}</tr>`).join("");
  return { html: `<figure class="wp-block-table"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></figure>`, next: i };
}

function quote(lines: readonly string[], opts: HtmlOptions): string {
  const callout = /^\[!([\w-]+)\][+-]?\s*(.*)$/.exec(lines[0] ?? "");
  if (!callout) return `<blockquote class="wp-block-quote">${blocks(lines, opts).join("")}</blockquote>`;
  const type = callout[1]!.toLowerCase();
  const title = callout[2]!.trim() || type.charAt(0).toUpperCase() + type.slice(1);
  return `<blockquote class="wp-block-quote osmm-callout osmm-callout-${escapeHtml(type)}"><p><strong>${inline(title, opts)}</strong></p>${blocks(lines.slice(1), opts).join("")}</blockquote>`;
}

function blocks(lines: readonly string[], opts: HtmlOptions): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) code.push(lines[i++]!);
      i++;
      const lang = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : "";
      out.push(`<pre class="wp-block-code"><code${lang}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const n = heading[1]!.length;
      out.push(`<h${n}>${inline(heading[2]!, opts)}</h${n}>`);
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*> ?/, ""));
      out.push(quote(quoted, opts));
      continue;
    }
    if (LIST_RE.test(line)) {
      const r = list(lines, i, opts);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (line.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
      const r = table(lines, i, opts);
      out.push(r.html);
      i = r.next;
      continue;
    }
    const lone = LONE_EMBED_RE.exec(line);
    if (lone) {
      const e = embedOf(lone[1]!);
      const embedHtml = e ? img(e, opts) : null;
      if (embedHtml) out.push(`<figure class="wp-block-image">${embedHtml}</figure>`);
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++]!.trim());
    out.push(`<p>${para.map((l) => inline(l, opts)).join("<br />\n")}</p>`);
  }
  return out;
}

/** An article body (Obsidian Markdown) → HTML for the WordPress REST API (#92, spec §2.3). */
export function markdownToHtml(md: string, opts: HtmlOptions): string {
  return blocks(stripComments(md).replace(/\r\n?/g, "\n").split("\n"), opts).join("\n");
}
