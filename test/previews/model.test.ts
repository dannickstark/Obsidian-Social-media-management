import { describe, expect, it } from "vitest";
import { cropRect } from "../../src/media/crop";
import { domainOf, objectPosition, segments } from "../../src/previews/model";
import { channel, img } from "../platforms/fixtures";
import { pv } from "./helpers";

describe("segments", () => {
  it("renders Markdown emphasis, links, urls and hashtags", () => {
    expect(segments("Hi **you** and *me* see [site](https://a.b) or https://c.d/e. #tag", "markdown")).toEqual([
      { text: "Hi " },
      { text: "you", bold: true },
      { text: " and " },
      { text: "me", italic: true },
      { text: " see " },
      { text: "site", href: "https://a.b" },
      { text: " or " },
      { text: "https://c.d/e", href: "https://c.d/e" },
      { text: ". " },
      { text: "#tag", tag: true },
    ]);
  });

  it("renders WhatsApp formatting", () => {
    expect(segments("*Event X* · _18:00_ ~free~", "whatsapp")).toEqual([
      { text: "Event X", bold: true },
      { text: " · " },
      { text: "18:00", italic: true },
      { text: " " },
      { text: "free", strike: true },
    ]);
  });

  it("leaves Markdown markers alone on plain platforms", () => {
    expect(segments("**not bold** https://x.y", "plain")).toEqual([{ text: "**not bold** " }, { text: "https://x.y", href: "https://x.y" }]);
  });

  it("only links http(s) urls, never javascript:, data:, vbscript: or relative/obsidian: schemes", () => {
    const hasHref = (text: string) => segments(text, "markdown").some((s) => s.href !== undefined);
    expect(hasHref("[click](javascript:alert(1))")).toBe(false);
    expect(segments("[click](data:text/html,x)", "markdown")).toEqual([{ text: "click" }]);
    expect(hasHref("[click](vbscript:msgbox(1))")).toBe(false);
    expect(segments("[click](obsidian://open?vault=x)", "markdown")).toEqual([{ text: "click" }]);
    expect(segments("[click](/relative/path)", "markdown")).toEqual([{ text: "click" }]);
    expect(segments("[click](https://example.com)", "markdown")).toEqual([{ text: "click", href: "https://example.com" }]);
  });
});

describe("previewModel", () => {
  it("folds LinkedIn text after 210 characters", () => {
    const m = pv("linkedin", "a".repeat(250));
    expect(m.fold).toEqual([{ text: "a".repeat(210) }]);
    expect(m.items).toEqual([{ segments: [{ text: "a".repeat(250) }], chars: 250, limit: 3000, over: false }]);
  });

  it("splits an X thread and shows a link card for the last link", () => {
    const m = pv("x", "One\n---\nTwo #launch\n---\nhttps://example.com/rsvp");
    expect(m.items.map((i) => i.segments)).toEqual([
      [{ text: "One" }],
      [{ text: "Two " }, { text: "#launch", tag: true }],
      [{ text: "https://example.com/rsvp", href: "https://example.com/rsvp" }],
    ]);
    expect(m.linkCard).toEqual({ url: "https://example.com/rsvp", domain: "example.com" });
  });

  it("crops Instagram images to the accepted ratio around the focal point", () => {
    const m = pv("instagram", "Caption", {}, [img("a.png", 1080, 1920, { focus: [0.5, 0.2] })]);
    const crop = { ratio: 0.8, rect: cropRect({ width: 1080, height: 1920 }, 0.8, [0.5, 0.2]), width: 1080, height: 1920 };
    expect(m.media).toEqual([{ target: "a.png", src: "app://local/Social/a.png", kind: "image", alt: "An image", crop }]);
    expect(objectPosition(crop)).toBe("50% 0%");
    expect(m.linkCard).toBeUndefined();
  });

  it("drops media on platforms that show none", () => {
    expect(pv("hackernews", "", { title: "Show HN", url: "https://example.com" }, [img()]).media).toEqual([]);
  });

  it("uses the channel's name, handle, colour and shape", () => {
    const acme = channel("li/acme-studio", { name: "Acme Studio", kind: "page", avatarColor: "#6ea3e6" });
    expect(pv("linkedin", "Hi", {}, [], acme).author).toEqual({ name: "Acme Studio", handle: undefined, color: "#6ea3e6", initials: "AS", round: false });
    expect(pv("linkedin", "Hi").author).toMatchObject({ name: "You", round: true });
  });

  it("flags items over the limit", () => {
    expect(pv("bluesky", "a".repeat(301)).items[0]).toMatchObject({ chars: 301, limit: 300, over: true });
  });

  it("reads the domain of a url", () => {
    expect(domainOf("https://www.example.com/a")).toBe("example.com");
    expect(domainOf("not a url")).toBe("not a url");
  });

  const SAMPLE = "**Event X** is back on the 12th.\n\nEighty makers, one evening. #events\n\nRSVP: https://example.com/event-x";
  const IDS = { linkedin: "li/you", x: "x/you", instagram: "ig/you", facebook: "fb/you", mastodon: "ma/you", bluesky: "bs/you" } as const;
  it.each(Object.keys(IDS) as Array<keyof typeof IDS>)("%s model snapshot", (platform) => {
    const ch = channel(IDS[platform], { name: "Event X", handle: "@eventx" });
    expect(pv(platform, SAMPLE, {}, [img("cover.png", 1600, 900)], ch)).toMatchSnapshot();
  });
});
