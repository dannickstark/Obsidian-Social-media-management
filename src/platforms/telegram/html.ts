const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Bold, strike and italic on already-escaped text; markers inside words (snake_case, 2*3) stay as they are. */
function spans(t: string): string {
  return t
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "<b>$2</b>")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/gm, "$1<i>$2</i>")
    .replace(/(^|[^_\w/])_(?=\S)([^_\n]*?\S)_(?![_\w])/gm, "$1<i>$2</i>");
}

function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part) => (/^`[^`\n]+`$/.test(part) ? `<code>${escape(part.slice(1, -1))}</code>` : spans(escape(part))))
    .join("");
}

/**
 * The `telegram` dialect (renderText) → Bot API HTML (parse_mode "HTML"). Everything the user wrote is escaped
 * first, so `<`, `>` and `&` show as written; only the dialect's own markers become tags.
 */
export function telegramHtml(text: string): string {
  return text
    .split(/(```[^\n]*\n[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```([^\n]*)\n([\s\S]*?)```$/.exec(part);
      if (!fence) return inline(part);
      const lang = (fence[1] ?? "").trim();
      const code = escape((fence[2] ?? "").replace(/\n$/, ""));
      return lang ? `<pre><code class="language-${escape(lang)}">${code}</code></pre>` : `<pre>${code}</pre>`;
    })
    .join("");
}

/** The length the reader sees (tags dropped, entities as one character): what Telegram's 1024-character caption limit counts. */
export function visibleLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:lt|gt|amp|quot);/g, "_").length;
}
