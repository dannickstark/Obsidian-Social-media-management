const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string): string => escape(s).replace(/"/g, "&quot;");

/** Stands in for a protected segment (code, link, bare URL) while the span rules run; never in user text after escape. */
const OPEN = "";
const CLOSE = "";
const SLOT_RE = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

/** Inline code, a Markdown link, or a bare address: segments the span rules never look into. */
const PROTECTED_RE = /(`[^`\n]+`)|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>]+)/g;
/** Punctuation and markers that end a sentence or a span rather than the bare address before them. */
const URL_TAIL_RE = /[*_~.,;:!?)\]'"]+$/;

/** True when the tags in `html` open and close in order (the span rules only ever produce b, i, s, code, a). */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (!m[1]) stack.push(m[2]!);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

/** `wrap` for a marker pair, unless the text between them would leave a tag open or close one it didn't open. */
const tag = (name: string) => (m: string, pre: string, inner: string) => (balanced(inner) ? `${pre}<${name}>${inner}</${name}>` : m);

/**
 * Bold, strike and italic on already-escaped text. `**`, `__` and `~~` need a non-word character (or the text's
 * edge) on their outer side, so markers inside words (snake__case, 2*3) stay as they are.
 */
function spans(t: string): string {
  return t
    .replace(/(^|[^\w])\*\*(?=\S)([^\n]*?\S)\*\*(?!\w)/gm, tag("b"))
    .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/gm, tag("b"))
    .replace(/(^|[^\w])~~(?=\S)([^\n]*?\S)~~(?!\w)/gm, tag("s"))
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/gm, tag("i"))
    .replace(/(^|[^_\w/])_(?=\S)([^_\n]*?\S)_(?![_\w])/gm, tag("i"));
}

/** Text outside code blocks: code, links and bare addresses are set aside first, then the span rules run on the rest. */
function inline(text: string): string {
  const slots: string[] = [];
  const hold = (html: string): string => `${OPEN}${slots.push(html) - 1}${CLOSE}`;
  const marked = text.replace(/[\uE000\uE001]/g, "").replace(PROTECTED_RE, (m, code?: string, label?: string, href?: string) => {
    if (code) return hold(`<code>${escape(code.slice(1, -1))}</code>`);
    // A label can't hold another link (no "]"); its own markers become tags inside the <a>, never in the href.
    if (label !== undefined && href !== undefined) return hold(`<a href="${attr(href)}">${inline(label)}</a>`);
    const tail = URL_TAIL_RE.exec(m)?.[0] ?? "";
    return hold(escape(m.slice(0, m.length - tail.length))) + tail;
  });
  return spans(escape(marked)).replace(SLOT_RE, (_m, i: string) => slots[Number(i)] ?? "");
}

/**
 * The `telegram` dialect (renderText) → Bot API HTML (parse_mode "HTML"). Everything the user wrote is escaped
 * first, so `<`, `>` and `&` show as written; only the dialect's own markers become tags, and tags always nest.
 */
export function telegramHtml(text: string): string {
  return text
    .split(/(```[^\n]*\n[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```([^\n]*)\n([\s\S]*?)```$/.exec(part);
      if (!fence) return inline(part);
      const lang = (fence[1] ?? "").trim();
      const code = escape((fence[2] ?? "").replace(/\n$/, ""));
      return lang ? `<pre><code class="language-${attr(lang)}">${code}</code></pre>` : `<pre>${code}</pre>`;
    })
    .join("");
}

/** The length the reader sees (tags dropped, entities as one character): what Telegram's 1024-character caption limit counts. */
export function visibleLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:lt|gt|amp|quot);/g, "_").length;
}
