/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { PLATFORMS, PLATFORM_META, type Platform } from "../../src/model/platforms";
import type { Channel, Variant } from "../../src/model/types";
import type { AssistedBuilder, MediaInfo } from "../../src/platforms/types";
import { hostOf, mastodonInstance, subreddit } from "../../src/platforms/share";
import { ASSISTED, assistedJob, assistedTarget } from "../../src/publish/assisted";
import { channel, img, input } from "../platforms/fixtures";

const folders = import.meta.glob<{ assisted: AssistedBuilder }>("../../src/platforms/*/assisted.ts", { eager: true });

function target(platform: Platform, body: string, extra: Partial<Variant> = {}, ch: Partial<Channel> & { id?: string } = {}, media: MediaInfo[] = []) {
  const { id, ...rest } = ch;
  const c = channel(id ?? `${PLATFORM_META[platform].prefix}/you`, rest);
  return assistedTarget(assistedJob(input(platform, body, extra, media).variant, c, { body, media }));
}

describe("assisted builders", () => {
  it("exist for every platform, one per folder", () => {
    expect(Object.keys(folders)).toHaveLength(PLATFORMS.length);
    for (const p of PLATFORMS) expect(typeof ASSISTED[p]).toBe("function");
  });

  it("encodes newlines, emoji, # and &", () => {
    expect(target("x", "Line 1\nLine 2 #launch & more 🎉").url).toBe(
      "https://x.com/intent/post?text=Line%201%0ALine%202%20%23launch%20%26%20more%20%F0%9F%8E%89",
    );
  });

  it.each([
    ["LinkedIn profile", target("linkedin", "Hello world"), "https://www.linkedin.com/feed/?shareActive=true&text=Hello%20world", ["Post text"]],
    [
      "LinkedIn page with its company URL",
      target("linkedin", "Hi", {}, { id: "li/acme-studio", name: "Acme Studio", kind: "page", handle: "https://www.linkedin.com/company/acme-studio/" }),
      "https://www.linkedin.com/company/acme-studio/admin/page-posts/published/?share=true",
      ["Post text"],
    ],
    ["LinkedIn page without a handle", target("linkedin", "Hi", {}, { name: "Acme Studio", kind: "page" }), "https://www.linkedin.com/feed/", ["Post text"]],
    ["X thread", target("x", "One\n---\nTwo"), "https://x.com/intent/post?text=One", ["Post text", "Reply 2"]],
    ["Bluesky", target("bluesky", "Hi & bye"), "https://bsky.app/intent/compose?text=Hi%20%26%20bye", ["Post text"]],
    ["Mastodon on its instance", target("mastodon", "Toot", {}, { handle: "@you@mastodon.social" }), "https://mastodon.social/share?text=Toot", ["Post text"]],
    ["Mastodon without an instance", target("mastodon", "Toot"), null, ["Post text"]],
    ["Instagram", target("instagram", "Caption", {}, {}, [img("a.png")]), "https://www.instagram.com/", ["Caption", "Image 1"]],
    [
      "Facebook link share",
      target("facebook", "Hi", { url: "https://example.com/event-x" }),
      "https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fexample.com%2Fevent-x",
      ["Post text"],
    ],
    ["Telegram with a link", target("telegram", "Doors open", { url: "https://example.com" }), "https://t.me/share/url?url=https%3A%2F%2Fexample.com&text=Doors%20open", ["Post text"]],
    ["Telegram text only", target("telegram", "Doors open"), "https://t.me/share/url?url=Doors%20open", ["Post text"]],
    ["WhatsApp", target("whatsapp", "**Event X** 18:00"), "https://wa.me/?text=*Event%20X*%2018%3A00", ["Message"]],
    [
      "Discord channel link",
      target("discord", "Hey", {}, { handle: "https://discord.com/channels/1/2" }),
      "https://discord.com/channels/1/2",
      ["Message"],
    ],
    [
      "Hacker News link",
      target("hackernews", "", { title: "Show HN: OSMM", url: "https://example.com" }),
      "https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fexample.com&t=Show%20HN%3A%20OSMM",
      ["Title"],
    ],
    ["Hacker News text", target("hackernews", "Ask away", { title: "Ask HN: Planning?" }), "https://news.ycombinator.com/submit", ["Title", "Text"]],
    [
      "Reddit link",
      target("reddit", "", { title: "Hello", url: "https://example.com" }, { handle: "r/SideProject" }),
      "https://www.reddit.com/r/SideProject/submit?title=Hello&url=https%3A%2F%2Fexample.com",
      ["Title"],
    ],
    [
      "Reddit text",
      target("reddit", "Body text", { title: "Hello" }, { handle: "r/SideProject" }),
      "https://www.reddit.com/r/SideProject/submit?selftext=true&title=Hello&text=Body%20text",
      ["Title", "Text"],
    ],
    ["Indie Hackers", target("indiehackers", "Building in public.", { title: "Launch" }), "https://www.indiehackers.com/new-post", ["Title", "Text"]],
    ["WordPress", target("wordpress", "# Hi\n\nBody", { title: "Hi" }, { handle: "eventx.berlin" }), "https://eventx.berlin/wp-admin/post-new.php", ["Title", "Article"]],
  ])("%s", (_name, t, url, labels) => {
    expect(t.url).toBe(url);
    expect(t.clipboard.map((c) => c.label)).toEqual(labels);
    expect(t.hint.length).toBeGreaterThan(0);
  });

  it("puts the thread parts and images on the clipboard in order", () => {
    const t = target("bluesky", "One\n---\nTwo\n---\nThree", {}, {}, [img("a.png"), img("b.png")]);
    expect(t.clipboard).toEqual([
      { label: "Post text", text: "One" },
      { label: "Reply 2", text: "Two" },
      { label: "Reply 3", text: "Three" },
      { label: "Image 1", imagePath: "Social/a.png" },
      { label: "Image 2", imagePath: "Social/b.png" },
    ]);
    expect(t.hint).toBe("Post the first part, then reply to it with parts 2 to 3. Then add the 2 images.");
  });

  it("offers the Instagram app on phones and drops media where the platform shows none", () => {
    expect(target("instagram", "Caption", {}, {}, [img()]).mobileUrl).toBe("instagram://camera");
    expect(target("hackernews", "", { title: "T", url: "https://example.com" }, {}, [img()]).clipboard.map((c) => c.label)).toEqual(["Title"]);
  });
});

describe("share helpers", () => {
  it.each([
    ["@you@mastodon.social", "mastodon.social"],
    ["https://fosstodon.org/@you", "fosstodon.org"],
    ["@you", null],
    [undefined, null],
  ])("mastodonInstance(%s) = %s", (handle, expected) => {
    expect(mastodonInstance(handle)).toBe(expected);
  });

  it("reads hosts and subreddits", () => {
    expect(hostOf("eventx.berlin")).toBe("eventx.berlin");
    expect(hostOf("https://www.eventx.berlin/blog")).toBe("eventx.berlin");
    expect(hostOf("not a host")).toBeNull();
    expect(subreddit("r/SideProject")).toBe("SideProject");
    expect(subreddit("https://www.reddit.com/r/obsidianmd/")).toBe("obsidianmd");
    expect(subreddit("SideProject")).toBeNull();
  });
});
