import { describe, expect, it } from "vitest";
import { requestUrlMock } from "../fakes/obsidian";
import { obsidianHttp } from "../../src/platforms/http";
import { CARD_FAILURE_TTL_MS, CARD_TTL_MS, LinkCardFetcher, parseLinkCard } from "../../src/platforms/og";
import { bytes, call, hang, html, json, queue } from "./http";

const URL = "https://event.example/x";
const FULL = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="Event X, Berlin">
  <meta property="og:description" content="Monthly makers evening">
  <meta property="og:image" content="/img/cover.png">
  <meta property="og:site_name" content="Event X">
</head><body></body></html>`;

function fetcher(now = { t: 0 }) {
  return { now, cards: new LinkCardFetcher({ http: obsidianHttp, now: () => now.t, timeoutMs: 20 }) };
}

describe("parseLinkCard", () => {
  it("reads OpenGraph and resolves a relative image", () => {
    expect(parseLinkCard(FULL, URL)).toEqual({ url: URL, title: "Event X, Berlin", description: "Monthly makers evening", image: "https://event.example/img/cover.png", siteName: "Event X" });
  });

  it("falls back to twitter tags, then the title and meta description, then the host", () => {
    expect(parseLinkCard('<meta name="twitter:title" content="T"><meta name="twitter:description" content="D">', URL)).toMatchObject({ title: "T", description: "D" });
    expect(parseLinkCard('<title> Plain page </title><meta name="description" content="About it">', URL)).toEqual({ url: URL, title: "Plain page", description: "About it" });
    expect(parseLinkCard("<p>No head at all</p>", URL)).toEqual({ url: URL, title: "event.example", description: "" });
  });

  it("drops an image that is not http(s)", () => {
    expect(parseLinkCard('<meta property="og:title" content="T"><meta property="og:image" content="javascript:alert(1)">', URL).image).toBeUndefined();
  });

  it("drops an og:image that resolves to plain http (must be https)", () => {
    expect(parseLinkCard('<meta property="og:title" content="T"><meta property="og:image" content="http://event.example/cover.png">', URL).image).toBeUndefined();
  });

  it("clips very long titles and descriptions", () => {
    const card = parseLinkCard(`<meta property="og:title" content="${"t".repeat(500)}"><meta property="og:description" content="${"d".repeat(2000)}">`, URL);
    expect(card.title.length).toBe(300);
    expect(card.description.length).toBe(1000);
  });

  it("strips markup and control characters from title and description", () => {
    const card = parseLinkCard(
      `<meta property="og:title" content="Hi <b>${"\u0007"}there</b></b>"><meta property="og:description" content="Line1${"\u0000"}Line2">`,
      URL,
    );
    expect(card.title).toBe("Hi there");
    expect(card.description).toBe("Line1Line2");
  });
});

describe("LinkCardFetcher", () => {
  it("fetches once and serves the cache for an hour", async () => {
    const { now, cards } = fetcher();
    queue(html(200, FULL));
    expect(await cards.get(URL)).toMatchObject({ title: "Event X, Berlin" });
    expect(await cards.get(URL)).toMatchObject({ title: "Event X, Berlin" });
    expect(requestUrlMock.calls).toHaveLength(1);
    expect(call(0)).toMatchObject({ url: URL, method: "GET", throw: false });
    expect(cards.peek(URL)).toMatchObject({ title: "Event X, Berlin" });
    now.t = CARD_TTL_MS + 1;
    expect(cards.peek(URL)).toBeUndefined();
  });

  it("gives a host-only card for a page that is not HTML", async () => {
    queue(bytes(200, new Uint8Array([37, 80, 68, 70]), "application/pdf"));
    expect(await fetcher().cards.get("https://event.example/flyer.pdf")).toEqual({ url: "https://event.example/flyer.pdf", title: "event.example", description: "" });
  });

  it("returns null for an error page or no answer, and retries after five minutes", async () => {
    const { now, cards } = fetcher();
    queue(json(404, {}));
    expect(await cards.get(URL)).toBeNull();
    expect(await cards.get(URL)).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(1);
    now.t = CARD_FAILURE_TTL_MS + 1;
    queue(hang);
    expect(await cards.get(URL)).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(2);
  });

  it("shares one request between callers and never fetches a non-http link", async () => {
    const { cards } = fetcher();
    queue(html(200, FULL));
    const [a, b] = await Promise.all([cards.get(URL), cards.get(URL)]);
    expect(a).toEqual(b);
    expect(await cards.get("javascript:alert(1)")).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(1);
  });

  it("refuses plain http (SSRF guard: https only) without any request", async () => {
    const { cards } = fetcher();
    expect(await cards.get("http://event.example/x")).toBeNull();
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("refuses private, loopback and link-local hosts without any request", async () => {
    const { cards } = fetcher();
    const blocked = [
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://10.1.2.3/x",
      "https://192.168.1.5/x",
      "https://169.254.169.254/x",
      "https://[::1]/x",
      "https://my-box.local/x",
    ];
    for (const url of blocked) {
      expect(await cards.get(url)).toBeNull();
    }
    expect(requestUrlMock.calls).toHaveLength(0);
  });

  it("never sends credentials (no Authorization/Cookie header, no basic auth in the url)", async () => {
    const { cards } = fetcher();
    queue(html(200, FULL));
    await cards.get(URL);
    const req = call(0);
    const headerNames = Object.keys(req.headers ?? {}).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("cookie");
  });

  it("bounds the cache size", async () => {
    const { cards } = fetcher();
    for (let i = 0; i < 105; i++) {
      queue(html(200, `<meta property="og:title" content="T${i}">`));
      await cards.get(`https://event.example/p${i}`);
    }
    expect(cards.peek("https://event.example/p0")).toBeUndefined();
    expect(cards.peek("https://event.example/p104")).toMatchObject({ title: "T104" });
  });
});
