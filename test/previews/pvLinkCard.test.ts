import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import PvLinkCard from "../../src/previews/PvLinkCard.svelte";

describe("PvLinkCard", () => {
  it("renders an http(s) url as a link", () => {
    render(PvLinkCard, { props: { card: { url: "https://example.com/page", domain: "example.com" } } });
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/page");
    expect(link.textContent).toContain("example.com");
  });

  it("renders a javascript: url as plain text with no link", () => {
    render(PvLinkCard, { props: { card: { url: "javascript:alert(1)", domain: "javascript:alert(1)" } } });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getAllByText("javascript:alert(1)").length).toBeGreaterThan(0);
  });
});
