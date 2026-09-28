import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../src/model/dates";
import { findFreeSlots, type SlotQuery } from "../../src/mcp/slots";
import { mcpCtx, type R } from "./helpers";

/** Local (Berlin) time on day `d` after Monday 12 Oct 2026. */
const at = (d: number, h: number, m = 0) => new Date(2026, 9, 12 + d, h, m).getTime();
const q = (over: Partial<SlotQuery> = {}): SlotQuery => ({ from: at(0, 0), to: at(1, 0), now: at(0, 0) - 1, minSpacingMinutes: 120, stepMinutes: 60, perChannel: 3, ...over });
const times = (slots: Array<{ at: number }>) => slots.map((s) => formatDateTime(s.at).slice(0, 16));

describe("findFreeSlots (#76)", () => {
  it("prefers the start of the window and keeps picks apart", () => {
    const slots = findFreeSlots([], q());
    expect(times(slots)).toEqual(["2026-10-12T09:00", "2026-10-12T11:00", "2026-10-12T13:00"]);
    expect(slots.map((s) => [s.score, s.nearestMinutes])).toEqual([[100, null], [80, null], [60, null]]);
  });

  it("avoids existing posts on the channel by the minimum spacing", () => {
    const slots = findFreeSlots([at(0, 10)], q());
    expect(times(slots)).toEqual(["2026-10-12T12:00", "2026-10-12T14:00", "2026-10-12T16:00"]);
    expect(slots.map((s) => s.nearestMinutes)).toEqual([120, 240, 360]);
  });

  it("ranks by closeness to the channel's usual time", () => {
    const slots = findFreeSlots([], q({ preferredTime: "17:30", stepMinutes: 30, perChannel: 2 }));
    expect(times(slots)).toEqual(["2026-10-12T17:30", "2026-10-12T15:30"]);
    expect(slots.map((s) => s.score)).toEqual([100, 80]);
  });

  it("keeps to the preferred weekdays", () => {
    const slots = findFreeSlots([], q({ to: at(7, 0), windows: [{ days: [6, 0], start: "10:00", end: "10:00" }], perChannel: 5 }));
    expect(times(slots)).toEqual(["2026-10-17T10:00", "2026-10-18T10:00"]);
  });

  it("keeps the wall-clock time across the end of summer time", () => {
    const slots = findFreeSlots([], q({ from: at(12, 0), to: at(14, 0), windows: [{ start: "09:00", end: "09:00" }], perChannel: 5 }));
    expect(slots.map((s) => formatDateTime(s.at))).toEqual(["2026-10-24T09:00:00+02:00", "2026-10-25T09:00:00+01:00"]);
  });

  it("never proposes the past and is deterministic", () => {
    const later = q({ now: at(0, 12) });
    expect(findFreeSlots([], later).every((s) => s.at > at(0, 12))).toBe(true);
    expect(findFreeSlots([at(0, 15)], later)).toEqual(findFreeSlots([at(0, 15)], later));
  });
});

describe("find_free_slots tool", () => {
  it("proposes spaced slots per channel, expanding groups and reporting unknown ids", async () => {
    const c = await mcpCtx();
    const r = await c.call("find_free_slots", {
      channels: ["li/me", "group:all-linkedin-pages", "li/nope"],
      from: "2026-10-08T12:00:00+02:00",
      to: "2026-10-10T00:00:00+02:00",
    });
    expect(r.ok).toBe(true);
    expect(r.unknown_channels).toEqual(["li/nope"]);
    expect(r.channels.map((ch: R) => ch.channel_id)).toEqual(["li/me", "li/acme-studio", "li/maker-lab", "li/osmm", "li/event-x-berlin"]);
    const acme = r.channels.find((ch: R) => ch.channel_id === "li/acme-studio");
    const awaiting = Date.parse("2026-10-08T17:45:00+02:00");
    expect(acme.slots.length).toBeGreaterThan(0);
    for (const s of acme.slots) expect(Math.abs(Date.parse(s.at) - awaiting)).toBeGreaterThanOrEqual(180 * 60_000);
    const all = r.channels[0].slots.map((s: R) => Date.parse(s.at)).sort((a: number, b: number) => a - b);
    for (let i = 1; i < all.length; i++) expect(all[i] - all[i - 1]).toBeGreaterThanOrEqual(180 * 60_000);
  });

  it("refuses ranges that are backwards or too long", async () => {
    const c = await mcpCtx();
    expect((await c.call("find_free_slots", { channels: ["li/me"], from: "2026-10-10T00:00:00+02:00", to: "2026-10-09T00:00:00+02:00" })).error).toBe("to must be after from.");
    expect((await c.call("find_free_slots", { channels: ["li/me"], from: "2026-10-10T00:00:00+02:00", to: "2027-01-10T00:00:00+01:00" })).error).toBe("Ask for at most 62 days at a time.");
    expect((await c.call("find_free_slots", { channels: ["li/me"], preferred_windows: [{ start: "18:00", end: "09:00" }] })).error).toBe("Each window must start before it ends.");
  });
});
