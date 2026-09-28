import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import Preview from "../../src/previews/Preview.svelte";
import { channel, img } from "../platforms/fixtures";
import { pv } from "./helpers";

describe("chat previews", () => {
  it("shows WhatsApp bold as bold (formatting differs per platform)", () => {
    const { container } = render(Preview, { props: { model: pv("whatsapp", "**Event X** at 18:00") } });
    expect(container.querySelector(".osmm-pv-chat strong")?.textContent).toBe("Event X");
    expect(container.textContent).not.toContain("*");
  });

  it("shows a Telegram channel post with its heading turned bold", () => {
    const tg = channel("tg/event-x", { name: "Event X channel", kind: "page" });
    const { container } = render(Preview, { props: { model: pv("telegram", "## Details\n**18:00**", {}, [], tg) } });
    expect(container.querySelector(".osmm-pv-channel")?.textContent).toBe("Event X channel");
    expect([...container.querySelectorAll("strong")].map((s) => s.textContent)).toEqual(["Event X channel", "Details", "18:00"]);
  });

  it("shows a Discord message with its author", () => {
    const dc = channel("dc/maker-lab", { name: "Maker Lab #announcements", kind: "server_channel" });
    render(Preview, { props: { model: pv("discord", "@everyone Event X is on!", {}, [], dc) } });
    expect(screen.getByRole("figure", { name: "Discord preview" }).textContent).toContain("Maker Lab #announcements");
  });
});

describe("link previews", () => {
  it("shows a Hacker News submission with title and domain", () => {
    render(Preview, { props: { model: pv("hackernews", "", { title: "Show HN: OSMM", url: "https://www.example.com/osmm" }) } });
    expect(screen.getByRole("heading").textContent).toBe("Show HN: OSMM (example.com)");
    expect(screen.getByRole("figure").textContent).toContain("1 point by you");
  });

  it("shows the subreddit of a Reddit post", () => {
    const rd = channel("rd/side", { name: "Side projects", handle: "r/SideProject" });
    render(Preview, { props: { model: pv("reddit", "Text post body", { title: "Hello" }, [], rd) } });
    expect(screen.getByRole("figure").textContent).toContain("r/SideProject");
  });
});

describe("article preview", () => {
  it("renders a neutral WordPress article", () => {
    const site = channel("wp/eventx-berlin", { name: "eventx.berlin", kind: "site" });
    const body = "# We're back\n\nIntro **bold**\n\n## Agenda\n- talks\n- demos\n\n![[inline.png]]";
    const model = pv(
      "wordpress",
      body,
      { title: "We're back", wordpress: { categories: [], tags: [], excerpt: "Short intro" } },
      [],
      site,
      img("cover.png", 1600, 900, { alt: "Cover" }),
    );
    render(Preview, { props: { model } });
    expect(screen.getAllByRole("heading").map((h) => [h.tagName, h.textContent])).toEqual([
      ["H1", "We're back"],
      ["H3", "Agenda"],
    ]);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["talks", "demos"]);
    expect(screen.getByRole("img", { name: "Cover" }).getAttribute("src")).toBe("app://local/Social/cover.png");
    expect(screen.getByRole("img", { name: "inline.png is not shown" })).toBeTruthy();
    expect(screen.getByRole("figure").textContent).toContain("Short intro");
  });
});
