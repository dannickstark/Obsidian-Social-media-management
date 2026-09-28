import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import Preview from "../../src/previews/Preview.svelte";
import { img } from "../platforms/fixtures";
import { pv } from "./helpers";

describe("feed previews", () => {
  it("folds long LinkedIn text behind “…see more”", async () => {
    render(Preview, { props: { model: pv("linkedin", "a".repeat(250)) } });
    const figure = screen.getByRole("figure", { name: "LinkedIn preview" });
    expect(figure.textContent).toContain("a".repeat(210));
    expect(figure.textContent).not.toContain("a".repeat(211));
    await fireEvent.click(screen.getByRole("button", { name: "…see more" }));
    expect(figure.textContent).toContain("a".repeat(250));
  });

  it("renders an X thread as numbered posts", () => {
    render(Preview, { props: { model: pv("x", "One\n---\nTwo\n---\nThree") } });
    const posts = screen.getByRole("figure", { name: "X preview" }).querySelectorAll(".osmm-pv-post");
    expect([...posts].map((p) => p.querySelector(".osmm-pv-meta")?.textContent)).toEqual(["1/3", "2/3", "3/3"]);
  });

  it("shows hashtags and links, plus a link card", () => {
    const { container } = render(Preview, { props: { model: pv("mastodon", "Hi #launch https://example.com/x") } });
    expect(container.querySelector(".osmm-pv-tag")?.textContent).toBe("#launch");
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["https://example.com/x", "https://example.com/x"]);
  });

  it("puts Instagram images before the caption", () => {
    const { container } = render(Preview, { props: { model: pv("instagram", "Caption", {}, [img("a.png", 1080, 1350)]) } });
    const tile = container.querySelector(".osmm-pv-tile")!;
    const text = container.querySelector(".osmm-pv-text")!;
    expect(tile.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("img", { name: "An image" }).getAttribute("src")).toBe("app://local/Social/a.png");
  });

  it("shows a missing image as a labelled placeholder", () => {
    render(Preview, { props: { model: pv("linkedin", "Hi", {}, [{ target: "gone.png", kind: "missing" }]) } });
    expect(screen.getByRole("img", { name: "gone.png is not shown" })).toBeTruthy();
  });

  it("flags a post over the limit", () => {
    render(Preview, { props: { model: pv("bluesky", "a".repeat(301)) } });
    expect(screen.getByRole("status").textContent).toBe("301/300 characters");
  });

  it("switches between mobile and desktop widths", () => {
    render(Preview, { props: { model: pv("facebook", "Hi"), width: "desktop" } });
    expect(screen.getByRole("figure").getAttribute("data-width")).toBe("desktop");
  });
});
