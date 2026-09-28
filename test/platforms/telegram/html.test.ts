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

  it("keeps markers inside bare URLs as part of the address (fix round 1)", () => {
    expect(telegramHtml("https://e.example/a__b__c")).toBe("https://e.example/a__b__c");
    expect(telegramHtml("See https://x.example/?q=*a* and more")).toBe("See https://x.example/?q=*a* and more");
    expect(telegramHtml("**see https://x.example/p**")).toBe("<b>see https://x.example/p</b>");
  });

  it("never puts a tag inside an href (fix round 1)", () => {
    expect(telegramHtml("[a](https://x.example/**b**)")).toBe('<a href="https://x.example/**b**">a</a>');
    expect(telegramHtml('[x](https://e.example/a"b)')).toBe('<a href="https://e.example/a&quot;b">x</a>');
    expect(telegramHtml("[**x**](https://e.example)")).toBe('<a href="https://e.example"><b>x</b></a>');
  });

  it("never mis-nests tags: a marker pair that would cross a link or another tag stays literal (fix round 1)", () => {
    expect(telegramHtml("**bold [link** x](https://e.example)")).toBe('**bold <a href="https://e.example">link** x</a>');
    expect(telegramHtml("a ~~b [c~~](https://e.example) d")).toBe('a ~~b <a href="https://e.example">c~~</a> d');
    expect(telegramHtml("*a **b* c**")).toBe("*a <b>b* c</b>");
    expect(telegramHtml("**b `c` d**")).toBe("<b>b <code>c</code> d</b>");
  });

  it("needs a non-word character or the text's edge outside **, __ and ~~ (fix round 1)", () => {
    expect(telegramHtml("snake__init__case and my__init__")).toBe("snake__init__case and my__init__");
    expect(telegramHtml("a**b**c x~~y~~z")).toBe("a**b**c x~~y~~z");
    expect(telegramHtml("(**b**) ~~s~~.")).toBe("(<b>b</b>) <s>s</s>.");
  });

  it('escapes " in a code block\'s language class (fix round 1)', () => {
    expect(telegramHtml('```a"b\nx\n```')).toBe('<pre><code class="language-a&quot;b">x</code></pre>');
  });
});
