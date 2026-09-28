import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import PlatformBadge from "../../src/ui/PlatformBadge.svelte";

describe("PlatformBadge", () => {
  it("shows the short badge with an accessible label", () => {
    render(PlatformBadge, { props: { platform: "linkedin" } });
    const badge = screen.getByRole("img", { name: "LinkedIn" });
    expect(badge.textContent).toBe("in");
    expect(badge.getAttribute("style")).toContain("--osmm-platform: #6ea3e6");
  });
});
