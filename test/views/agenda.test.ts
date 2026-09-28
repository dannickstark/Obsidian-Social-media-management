import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/svelte";
import { setPlatform } from "../fakes/obsidian";
import { formatDateTime } from "../../src/model/dates";
import { agendaDays } from "../../src/planner/agenda";
import { osmmContext } from "../../src/ui/context";
import Planner from "../../src/views/Planner.svelte";
import { makeCtx, TEST_NOW } from "../ui/ctx";

const DAY = 86_400_000;
const post = (path: string, at: number) => ({
  path,
  frontmatter: { type: "social-post", platform: "bluesky", channels: ["bs/you"], status: "scheduled", scheduled_at: formatDateTime(at) },
  body: path,
});

describe("agendaDays", () => {
  it("lists the days that have posts, in order, plus today", async () => {
    const c = await makeCtx({ notes: [post("Social/Posts/B.md", TEST_NOW + 3 * DAY), post("Social/Posts/A.md", TEST_NOW + DAY)] });
    const days = agendaDays(c.ctx.actions.rows(), TEST_NOW - 2 * DAY, TEST_NOW + 10 * DAY, TEST_NOW);
    expect(days.map((d) => [d.key, d.rows.length, d.isToday])).toEqual([
      ["2026-10-08", 0, true],
      ["2026-10-09", 1, false],
      ["2026-10-11", 1, false],
    ]);
  });

  it("leaves out posts outside the range and today when it is not in it", async () => {
    const c = await makeCtx({ notes: [post("Social/Posts/A.md", TEST_NOW + 20 * DAY)] });
    expect(agendaDays(c.ctx.actions.rows(), TEST_NOW + DAY, TEST_NOW + 10 * DAY, TEST_NOW)).toEqual([]);
  });
});

describe("Planner on a phone (#27)", () => {
  it("shows an agenda instead of the month grid", async () => {
    setPlatform("iphone");
    const c = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(c.ctx) });
    const agenda = screen.getByRole("list", { name: "Agenda" });
    expect(within(agenda).getAllByRole("listitem").filter((li) => li.classList.contains("is-today"))[0]!.textContent).toContain("Today · ");
    expect(agenda.textContent).toContain("Event X is back");
    expect(screen.queryByRole("grid", { name: "Month" })).toBeNull();
  });

  it("keeps the month grid on the desktop", async () => {
    const c = await makeCtx({ seed: true });
    render(Planner, { context: osmmContext(c.ctx) });
    expect(screen.getByRole("grid", { name: "Month" })).toBeTruthy();
  });
});
