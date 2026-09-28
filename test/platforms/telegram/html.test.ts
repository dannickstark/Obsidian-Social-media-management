import { describe, expect, it } from "vitest";
import { telegramHtml, visibleLength } from "../../../src/platforms/telegram/html";

describe("telegramHtml (HTML parse mode)", () => {
  it("escapes <, > and & so the text shows as written (review focus 2)", () => {
    expect(telegramHtml("5 < 6 & 7 > 3 <b>not bold</b>")).toBe("5 &lt; 6 &amp; 7 &gt; 3 &lt;b&gt;not bold&lt;/b&gt;");
  });

  it("turns the dialect's markers into tags", () => {
    expect(telegramHtml("**Doors** open *now*, ~~late~~ `a<b` and __bold__ _it_")).toBe("<b>Doors</b> open <i>now</i>, <s>late</s> <code>a&lt;b</code> and <b>bold</b> <i>it</i>");
  });

  it("makes links from Markdown links, keeping & in the address valid", () => {
    expect(telegramHtml("[Tickets](https://event.example/t?a=1&b=2)")).toBe('<a href="https://event.example/t?a=1&amp;b=2">Tickets</a>');
  });

  it("leaves underscores and asterisks inside words and URLs alone", () => {
    expect(telegramHtml("snake_case_name and https://x.example/a_b_c and 2*3*4")).toBe("snake_case_name and https://x.example/a_b_c and 2*3*4");
  });

  it("keeps code blocks as preformatted text", () => {
    expect(telegramHtml("Run:\n```sh\nnpm i <pkg>\n```\nDone")).toBe('Run:\n<pre><code class="language-sh">npm i &lt;pkg&gt;</code></pre>\nDone');
  });

  it("measures what the reader sees", () => {
    expect(visibleLength(telegramHtml("**Hi** & <you>"))).toBe("Hi & <you>".length);
  });
});
