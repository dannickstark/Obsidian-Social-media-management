import { describe, expect, it } from "vitest";
import { imageEmbeds, markdownToHtml, type HtmlOptions } from "../../../src/platforms/wordpress/markdown";

const UPLOADED: Record<string, { src: string; alt?: string }> = {
  "cover.png": { src: "https://eventx.berlin/wp-content/uploads/2026/10/cover.png", alt: "Meta alt" },
  "img/map.png": { src: "https://eventx.berlin/wp-content/uploads/2026/10/map.png" },
};
const opts: HtmlOptions = { image: (target) => UPLOADED[target] ?? null };
const html = (md: string) => markdownToHtml(md, opts);
const COVER = "https://eventx.berlin/wp-content/uploads/2026/10/cover.png";

describe("markdownToHtml (#92)", () => {
  it("turns headings and paragraphs into HTML, a single newline into a line break", () => {
    expect(html("# Event X\n\nDoors open\nat 18:00.\n\n## Program")).toBe("<h1>Event X</h1>\n<p>Doors open<br />\nat 18:00.</p>\n<h2>Program</h2>");
    expect(html("Text\n## Heading")).toBe("<p>Text</p>\n<h2>Heading</h2>");
  });

  it("styles text inline", () => {
    expect(html("**Bold** and *it* and _it2_, ~~old~~, ==new== and `a<b>`")).toBe(
      "<p><strong>Bold</strong> and <em>it</em> and <em>it2</em>, <del>old</del>, <mark>new</mark> and <code>a&lt;b&gt;</code></p>",
    );
  });

  it("escapes raw HTML instead of passing it through", () => {
    expect(html('<script>alert("x")</script> & co')).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</p>");
  });

  it("writes wikilinks as their label", () => {
    expect(html("See [[Event X]], [[Notes/Event X|the event]] and [[#Program]].")).toBe("<p>See Event X, the event and Program.</p>");
  });

  it("links http(s) and mailto links and bare URLs, and drops other link targets", () => {
    expect(html("[Tickets](https://event.example/t?a=1&b=2) and [bad](javascript:void)")).toBe('<p><a href="https://event.example/t?a=1&amp;b=2">Tickets</a> and bad</p>');
    expect(html("More at https://event.example/x.")).toBe('<p>More at <a href="https://event.example/x">https://event.example/x</a>.</p>');
  });

  it("turns embedded images into figures with the uploaded address and alt text", () => {
    expect(html("![[cover.png]]")).toBe(`<figure class="wp-block-image"><img src="${COVER}" alt="Meta alt" /></figure>`);
    expect(html("![[cover.png|Crowd at the door]]")).toBe(`<figure class="wp-block-image"><img src="${COVER}" alt="Crowd at the door" /></figure>`);
    expect(html("![[cover.png|300]]")).toBe(`<figure class="wp-block-image"><img src="${COVER}" alt="Meta alt" /></figure>`);
    expect(html("![A map](img/map.png)")).toBe('<figure class="wp-block-image"><img src="https://eventx.berlin/wp-content/uploads/2026/10/map.png" alt="A map" /></figure>');
    expect(html("![x](https://cdn.example/a.png)")).toBe('<figure class="wp-block-image"><img src="https://cdn.example/a.png" alt="x" /></figure>');
    expect(html("Look ![[cover.png]] here")).toBe(`<p>Look <img src="${COVER}" alt="Meta alt" /> here</p>`);
  });

  it("leaves out images that weren't uploaded and embedded notes", () => {
    expect(html("![[missing.png]]\n\n![[Other note]]\n\nText")).toBe("<p>Text</p>");
  });

  it("turns callouts and quotes into blockquotes", () => {
    expect(html("> [!tip] Bring a friend\n> Free entry for two.")).toBe(
      '<blockquote class="wp-block-quote osmm-callout osmm-callout-tip"><p><strong>Bring a friend</strong></p><p>Free entry for two.</p></blockquote>',
    );
    expect(html("> [!NOTE]\n> Hi")).toBe('<blockquote class="wp-block-quote osmm-callout osmm-callout-note"><p><strong>Note</strong></p><p>Hi</p></blockquote>');
    expect(html("> Quote line\n> more")).toBe('<blockquote class="wp-block-quote"><p>Quote line<br />\nmore</p></blockquote>');
  });

  it("nests lists and keeps ordered ones ordered", () => {
    expect(html("- One\n- Two\n  - Two a\n- Three\n\n1. First\n2. Second")).toBe("<ul><li>One</li><li>Two<ul><li>Two a</li></ul></li><li>Three</li></ul>\n<ol><li>First</li><li>Second</li></ol>");
  });

  it("keeps code blocks as escaped code", () => {
    expect(html("```ts\nconst a = 1 < 2;\n```")).toBe('<pre class="wp-block-code"><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
  });

  it("builds tables", () => {
    expect(html("| Day | Time |\n| --- | ---: |\n| Thu | 18:00 |")).toBe(
      '<figure class="wp-block-table"><table><thead><tr><th>Day</th><th>Time</th></tr></thead><tbody><tr><td>Thu</td><td>18:00</td></tr></tbody></table></figure>',
    );
  });

  it("drops comments and turns a rule into <hr />", () => {
    expect(html("Visible %%hidden%% text\n\n%%\nblock\n%%\nEnd")).toBe("<p>Visible  text</p>\n<p>End</p>");
    expect(html("Before\n\n---\n\nAfter")).toBe("<p>Before</p>\n<hr />\n<p>After</p>");
  });

  it("never passes a raw <tag> from inside a link label or emphasis through unescaped", () => {
    expect(html("[<b>click</b>](https://example.com/x)")).toBe('<p><a href="https://example.com/x">&lt;b&gt;click&lt;/b&gt;</a></p>');
    expect(html("*<i>x</i>*")).toBe("<p><em>&lt;i&gt;x&lt;/i&gt;</em></p>");
  });

  it("requires word boundaries around emphasis markers", () => {
    expect(html("snake_case_word and 2*3*4 and file_name_here")).toBe("<p>snake_case_word and 2*3*4 and file_name_here</p>");
  });

  it("never lets a link's own markup escape its <a> tag or nest another tag across the boundary", () => {
    expect(html("[**Bold** label](https://example.com/x) after")).toBe('<p><a href="https://example.com/x"><strong>Bold</strong> label</a> after</p>');
  });
});

describe("imageEmbeds", () => {
  it("lists local image targets once, in order, outside comments", () => {
    expect(imageEmbeds("![[a.png]] text ![b](img/b.png) ![[a.png]] ![c](https://x.example/c.png) %%![[hidden.png]]%%")).toEqual(["a.png", "img/b.png"]);
  });
});

/** A stack-based tag-balance check: catches crossing tags (a close that doesn't match the innermost open), not only unequal counts. Void elements (self-closing, `<tag ... />`) are never pushed. */
function wellFormed(fragment: string): boolean {
  const stack: string[] = [];
  for (const m of fragment.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/gi)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) {
      if (stack.pop() !== name!.toLowerCase()) return false;
    } else {
      stack.push(name!.toLowerCase());
    }
  }
  return stack.length === 0;
}

describe("markdownToHtml fix round 1 (#92)", () => {
  it("never crosses tags on overlapping emphasis markers; an unmatched or crossing marker stays literal", () => {
    expect(wellFormed(html("*a **b* c**"))).toBe(true);
    expect(wellFormed(html("**a *b** c*"))).toBe(true);
  });

  it("keeps a balanced parenthesis in a link destination, and supports the <...> form for anything else", () => {
    expect(html("[a](https://example.com/wiki/Foo_(bar))")).toBe('<p><a href="https://example.com/wiki/Foo_(bar)">a</a></p>');
    expect(html("[a](<https://example.com/wiki/Foo_(bar>)")).toBe('<p><a href="https://example.com/wiki/Foo_(bar">a</a></p>');
  });

  it("gives ** and __ the same word-boundary guard * and _ already have", () => {
    expect(html("prefix__word__suffix")).toBe("<p>prefix__word__suffix</p>");
    expect(html("prefix**word**suffix")).toBe("<p>prefix**word**suffix</p>");
  });

  it("opens a fence even when the language token has characters outside [\\w+-]", () => {
    expect(html("```c++!\nconst a = 1;\n```")).toBe('<pre class="wp-block-code"><code class="language-c++">const a = 1;</code></pre>');
  });

  it("supports an escaped pipe inside a table cell", () => {
    expect(html("| A | B |\n| --- | --- |\n| a\\|b | c |")).toBe(
      '<figure class="wp-block-table"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>a|b</td><td>c</td></tr></tbody></table></figure>',
    );
  });
});
