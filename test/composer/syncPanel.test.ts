import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import SyncPanel from "../../src/composer/SyncPanel.svelte";
import { formatDateTime, HOUR } from "../../src/model/dates";
import { osmmContext } from "../../src/ui/context";
import { formatShortDate, formatTime } from "../../src/ui/format";
import { makeCtx, TEST_NOW } from "../ui/ctx";

const P = "Social/Posts/Ma.md";
const AT = TEST_NOW + 2 * HOUR;
const when = (at: number) => `${formatShortDate(at)} ${formatTime(at)}`;
const handedOver = (delivery: Record<string, unknown>) => ({
  path: P,
  frontmatter: { type: "social-post", platform: "mastodon", channels: ["ma/you"], status: "scheduled", scheduled_at: formatDateTime(AT), deliveries: { "ma/you": { status: "handed_over", remote_id: "3221", ...delivery } } },
  body: "Doors open at 18:00",
});

describe("SyncPanel (#66)", () => {
  it("shows an out-of-sync channel with what differs and the three actions", async () => {
    const c = await makeCtx({ seed: true, notes: [handedOver({ at: formatDateTime(AT + HOUR), remote_at: formatDateTime(AT), digest: "old" })] });
    const push = vi.spyOn(c.ctx.publish, "pushUpdate").mockResolvedValue(true);
    const revert = vi.spyOn(c.ctx.publish, "revertTime").mockResolvedValue(true);
    const unschedule = vi.spyOn(c.ctx.publish, "unscheduleRemote").mockResolvedValue(true);
    render(SyncPanel, { props: { variant: c.index.getVariant(P)! }, context: osmmContext(c.ctx) });
    expect(screen.getByRole("region", { name: "Scheduled on Mastodon" })).toBeTruthy();
    expect(screen.getByText("Out of sync")).toBeTruthy();
    expect(screen.getByText(`Mastodon has the version for ${when(AT)}; the text or media changed, and the time here is ${when(AT + HOUR)}.`)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Push update for @you@mastodon.social" }));
    await fireEvent.click(screen.getByRole("button", { name: "Revert time for @you@mastodon.social" }));
    await fireEvent.click(screen.getByRole("button", { name: "Unschedule @you@mastodon.social on Mastodon" }));
    expect(push).toHaveBeenCalledWith(P, "ma/you");
    expect(revert).toHaveBeenCalledWith(P, "ma/you");
    expect(unschedule).toHaveBeenCalledWith(P, "ma/you");
  });

  it("shows an in-sync channel with its platform time and no Push update", async () => {
    const c = await makeCtx({ seed: true, notes: [handedOver({ at: formatDateTime(AT), remote_at: formatDateTime(AT) })] });
    const v = c.index.getVariant(P)!;
    render(SyncPanel, { props: { variant: { ...v, deliveries: { "ma/you": { ...v.deliveries["ma/you"]!, digest: v.digest! } } } }, context: osmmContext(c.ctx) });
    expect(screen.getByText(`Scheduled on Mastodon for ${when(AT)}.`)).toBeTruthy();
    expect(screen.queryByText("Out of sync")).toBeNull();
    expect(screen.queryByRole("button", { name: /Push update/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Unschedule @you@mastodon.social on Mastodon" })).toBeTruthy();
  });

  it("renders nothing for a post with no handed-over channel", async () => {
    const c = await makeCtx({ seed: true, notes: [{ ...handedOver({}), frontmatter: { ...handedOver({}).frontmatter, deliveries: { "ma/you": { status: "scheduled" } } } }] });
    const { container } = render(SyncPanel, { props: { variant: c.index.getVariant(P)! }, context: osmmContext(c.ctx) });
    expect(container.textContent?.trim()).toBe("");
  });
});
