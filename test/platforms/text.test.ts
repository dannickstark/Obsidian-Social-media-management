import { describe, expect, it } from "vitest";
import { platformDef } from "../../src/platforms/registry";
import { countFor, hashtags, postItems, postText, renderText, urlsIn, withLink } from "../../src/platforms/text";

describe("renderText", () => {
  it.each([
    [
      "plain",
      "**Big** news: see [[Event X|the event]] and [the site](https://example.com).\n\n![[cover.png]]\n%%note to self%%",
      "Big news: see the event and the site (https://example.com).",
    ],
    ["plain", "# Launch day\nRSVP → [example.com/event-x](https://example.com/event-x)", "Launch day\nRSVP → https://example.com/event-x"],
    ["plain", "Keep *single stars* and ~~drop~~ strike", "Keep *single stars* and drop strike"],
    ["whatsapp", "**Event X** · _18:00_ ~~free~~ *soon*", "*Event X* · _18:00_ ~free~ _soon_"],
    ["whatsapp", "# Title\n[RSVP](https://e.x/r)", "Title\nRSVP (https://e.x/r)"],
    ["telegram", "## Details\n**18:00** at [the lab](https://lab.example)", "**Details**\n**18:00** at [the lab](https://lab.example)"],
    ["markdown", "[[Notes/Event X#Agenda]] and [[#Agenda]] **bold**", "Event X and Agenda **bold**"],
    ["html", "Intro\n\n---\n\n## Part two  \n![alt](cover.png)", "Intro\n\n---\n\n## Part two"],
  ] as const)("%s: %j", (dialect, input, expected) => {
    expect(renderText(input, dialect)).toBe(expected);
  });

  it("collapses the blank lines left by removed embeds", () => {
    expect(renderText("One\n\n![[a.png]]\n\n![[b.png]]\n\nTwo", "plain")).toBe("One\n\nTwo");
  });
});

describe("postItems", () => {
  it("splits threads only on thread platforms", () => {
    expect(postItems("One\n---\nTwo\n\n---\n", platformDef("x"))).toEqual(["One", "Two"]);
    expect(postItems("One\n---\nTwo", platformDef("linkedin"))).toEqual(["One\n---\nTwo"]);
    expect(postText("One\n---\nTwo", platformDef("bluesky"))).toBe("One\n\nTwo");
  });

  it("returns no items for an empty or embed-only body", () => {
    expect(postItems("", platformDef("x"))).toEqual([]);
    expect(postItems("![[a.png]]\n", platformDef("linkedin"))).toEqual([]);
  });
});

describe("counting helpers", () => {
  it("counts with the platform's counter", () => {
    expect(countFor("Read https://example.com/very/long/path now", platformDef("x"))).toBe(32);
    expect(countFor("Read https://example.com/very/long/path now", platformDef("bluesky"))).toBe(43);
  });

  it.each([
    ["Hi @alice@mastodon.social!", 10],
    ["@alice@mastodon.social and @bob@example.co.uk", 15],
    ["Hi @bob", 7],
    ["Mail bob@example.com", 20],
    ["Follow https://mastodon.social/@alice", 30],
  ])("Mastodon counts a remote mention by its username only: %j → %i", (text, n) => {
    expect(countFor(text, platformDef("mastodon"))).toBe(n);
  });

  it.each([
    ["See example.com", 27],
    ["Go sub.example.co.uk/path now", 30],
    ["Visit https://a.com and b.org", 57],
    ["RSVP → example.com/event-x", 31],
    ["end of example.com.", 31],
    ["Node.js rocks", 13],
    ["mail bob@example.com", 20],
    ["version 1.2.3", 13],
  ])("X counts a bare domain as 23 like a URL: %j → %i", (text, n) => {
    expect(countFor(text, platformDef("x"))).toBe(n);
  });

  it("finds hashtags and urls", () => {
    expect(hashtags("Ship it #buildinpublic #Obsidian_md and #2026 but not a#b")).toEqual(["buildinpublic", "Obsidian_md", "2026"]);
    expect(urlsIn("See https://example.com/x, and http://a.b/c?d=1.")).toEqual(["https://example.com/x", "http://a.b/c?d=1"]);
  });
});

describe("withLink", () => {
  it("adds the link on its own line unless the text already has it", () => {
    expect(withLink("Doors open", "https://event.example/x")).toBe("Doors open\n\nhttps://event.example/x");
    expect(withLink("See https://event.example/x", "https://event.example/x")).toBe("See https://event.example/x");
    expect(withLink("", "https://event.example/x")).toBe("https://event.example/x");
    expect(withLink("Doors open", undefined)).toBe("Doors open");
  });
});
