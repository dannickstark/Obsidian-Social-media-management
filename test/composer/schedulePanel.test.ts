import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { getFrontMatterInfo, parseYaml } from "obsidian";
import SchedulePanel from "../../src/composer/SchedulePanel.svelte";
import { formatDateTime } from "../../src/model/dates";
import { osmmContext } from "../../src/ui/context";
import { makeCtx, type TestCtx } from "../ui/ctx";

const P = "Social/Posts/P.md";
const note = { path: P, frontmatter: { type: "social-post", platform: "linkedin", channels: ["li/me", "li/acme-studio"], status: "draft" }, body: "Hello" };

async function fm(c: TestCtx, path = P): Promise<Record<string, unknown>> {
  return parseYaml(getFrontMatterInfo(await c.app.vault.read(c.app.vault.getFileByPath(path)!)).frontmatter);
}

async function setWhen(date: string, time: string): Promise<void> {
  await fireEvent.input(screen.getByLabelText("Date"), { target: { value: date } });
  await fireEvent.input(screen.getByLabelText("Time"), { target: { value: time } });
}

describe("SchedulePanel", () => {
  it("writes scheduled_at, reminders and delivery states in one write", async () => {
    const c = await makeCtx({ seed: true, notes: [note] });
    const spy = vi.spyOn(c.writer, "updateVariant");
    render(SchedulePanel, { props: { variant: c.index.getVariant(P)!, issues: [] }, context: osmmContext(c.ctx) });
    await setWhen("2026-10-20", "09:30");
    await fireEvent.click(screen.getByRole("button", { name: "Remove reminder 10 min before" }));
    await fireEvent.input(screen.getByLabelText("Add a reminder (minutes before)"), { target: { value: "30" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    await fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await vi.waitFor(async () => expect((await fm(c)).status).toBe("scheduled"));
    expect(await fm(c)).toMatchObject({
      scheduled_at: formatDateTime(new Date(2026, 9, 20, 9, 30).getTime()),
      reminders: [60, 30],
      deliveries: { "li/me": { status: "scheduled" }, "li/acme-studio": { status: "scheduled" } },
    });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("disables Schedule while there are blocking issues", async () => {
    const c = await makeCtx({ seed: true, notes: [note] });
    const issues = [{ level: "error" as const, field: "body", message: "The text is 3,001/3,000 characters." }];
    render(SchedulePanel, { props: { variant: c.index.getVariant(P)!, issues }, context: osmmContext(c.ctx) });
    expect((screen.getByRole("button", { name: "Schedule" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toBe("Fix the blocking issues to schedule.");
  });

  it("asks before scheduling in the past", async () => {
    const c = await makeCtx({ seed: true, notes: [note] });
    const asked: string[] = [];
    c.ctx.actions.confirm = async (message) => {
      asked.push(message);
      return false;
    };
    render(SchedulePanel, { props: { variant: c.index.getVariant(P)!, issues: [] }, context: osmmContext(c.ctx) });
    await setWhen("2026-10-01", "09:00");
    await fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await vi.waitFor(() => expect(asked).toEqual(["That time is in the past, so the post will show as overdue right away. Schedule anyway?"]));
    expect((await fm(c)).scheduled_at).toBeUndefined();
  });

  it("keeps a published channel untouched when rescheduling a partial post (review focus 5)", async () => {
    const c = await makeCtx({ seed: true });
    const LI = "Social/Event X/Event X – LinkedIn.md";
    // li/acme-studio is awaiting_you in the seed data (M2b ruling P2): confirm the move.
    c.ctx.actions.confirm = async () => true;
    const before = (await fm(c, LI)).deliveries as Record<string, unknown>;
    render(SchedulePanel, { props: { variant: c.index.getVariant(LI)!, issues: [] }, context: osmmContext(c.ctx) });
    await setWhen("2026-10-15", "17:30");
    await fireEvent.click(screen.getByRole("button", { name: "Update schedule" }));
    await vi.waitFor(async () => expect((await fm(c, LI)).scheduled_at).toBe(formatDateTime(new Date(2026, 9, 15, 17, 30).getTime())));
    const after = (await fm(c, LI)).deliveries as Record<string, unknown>;
    expect(after["li/me"]).toEqual(before["li/me"]);
    expect(after["li/acme-studio"]).toEqual({ status: "scheduled" });
    expect(after["li/maker-lab"]).toEqual({ status: "scheduled" });
  });

  it("changes the mode and shows how each channel will post", async () => {
    const c = await makeCtx({ seed: true, notes: [note] });
    render(SchedulePanel, { props: { variant: c.index.getVariant(P)!, issues: [] }, context: osmmContext(c.ctx) });
    expect(screen.getByRole("region", { name: "Schedule" }).textContent).toContain("Reminder + pre-filled composer");
    await fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "assisted" } });
    await vi.waitFor(async () => expect((await fm(c)).mode).toBe("assisted"));
  });
});
