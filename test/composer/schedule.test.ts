import { describe, expect, it } from "vitest";
import { bestSlot, planComposerSchedule, reminderDefaults, scheduleNeeds } from "../../src/composer/schedule";
import type { Variant } from "../../src/model/types";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import { channel } from "../platforms/fixtures";

const T = Date.UTC(2026, 9, 12, 7); // Mon 12 Oct 2026, 09:00 Berlin
const NEW = T + 2 * 86_400_000;
const v = (extra: Partial<Variant> = {}): Variant => ({
  path: "p.md",
  platform: "linkedin",
  channels: ["li/me", "li/acme", "li/maker"],
  mode: "auto",
  status: "draft",
  scheduledAt: T,
  staggerMinutes: 15,
  media: [],
  deliveries: {},
  ...extra,
});

describe("planComposerSchedule", () => {
  it("moves only the pending channels of a partly published post (review focus 5)", () => {
    const post = v({
      status: "partial",
      deliveries: {
        "li/me": { status: "published", url: "https://li/1" },
        "li/acme": { status: "overdue", at: T + 900_000 },
        "li/maker": { status: "failed", error: "Rate limited", attempts: 2 },
      },
    });
    expect(planComposerSchedule(post, { at: NEW, reminders: [60] }, 15)).toEqual({
      fields: { scheduledAt: NEW, reminders: [60] },
      deliveries: {
        "li/me": { status: "published", url: "https://li/1", at: T },
        "li/acme": { status: "scheduled" },
        "li/maker": { status: "scheduled", attempts: 2 },
      },
    });
  });

  it("keeps the send key of a failed channel it schedules again, so the next send resumes it (M5 P17c)", () => {
    const post = v({ channels: ["li/me"], deliveries: { "li/me": { status: "failed", attempts: 1, sendAt: T, sendKey: "3mxdyj6ws22jm" } } });
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toMatchObject({ deliveries: { "li/me": { status: "scheduled", attempts: 1, sendAt: T, sendKey: "3mxdyj6ws22jm" } } });
  });

  it("schedules channels without records and keeps handed-over ones where they are", () => {
    const post = v({ deliveries: { "li/maker": { status: "handed_over", remoteId: "9" } } });
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toEqual({
      fields: { scheduledAt: NEW, reminders: [] },
      deliveries: {
        "li/me": { status: "scheduled" },
        "li/acme": { status: "scheduled" },
        "li/maker": { status: "handed_over", remoteId: "9", at: T + 30 * 60_000 },
      },
    });
  });

  it("moves the local time of a handed-over channel with a baseline, so it shows as out of sync (#66)", () => {
    const post = v({ deliveries: { "li/maker": { status: "handed_over", remoteId: "9", at: T + 30 * 60_000, remoteAt: T + 30 * 60_000, digest: "d" } } });
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toMatchObject({
      deliveries: { "li/maker": { status: "handed_over", remoteId: "9", at: NEW + 30 * 60_000, remoteAt: T + 30 * 60_000, digest: "d" } },
    });
  });

  it.each([
    [v({ channels: [] }), "Pick at least one channel before scheduling."],
    [v({ deliveries: { "li/me": { status: "publishing" } } }), "This post is being published right now."],
    [v({ status: "published" }), "This post was already published."],
  ])("refuses %#", (post, reason) => {
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toEqual({ refuse: reason });
  });

  it("keeps an awaiting-you channel waiting and moves only its time (ruling P2)", () => {
    const post = v({ status: "scheduled", deliveries: { "li/acme": { status: "awaiting_you", at: T + 900_000 } } });
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toEqual({
      fields: { scheduledAt: NEW, reminders: [] },
      deliveries: { "li/me": { status: "scheduled" }, "li/acme": { status: "awaiting_you" }, "li/maker": { status: "scheduled" } },
    });
  });

  it("skips a channel with an unreadable delivery entry and reports it (M2b ruling P1)", () => {
    const post = v({ invalidDeliveries: ["li/acme"] });
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toEqual({
      fields: { scheduledAt: NEW, reminders: [] },
      deliveries: { "li/me": { status: "scheduled" }, "li/maker": { status: "scheduled" } },
      frozen: ["li/acme"],
    });
  });

  it("refuses when every channel has an unreadable delivery entry (M2b ruling P1)", () => {
    const post = v({ channels: ["li/acme"], invalidDeliveries: ["li/acme"] });
    expect(planComposerSchedule(post, { at: NEW, reminders: [] }, 15)).toEqual({
      refuse: "Every channel's delivery status can't be read from the note. Fix it before scheduling.",
    });
  });
});

describe("schedule helpers", () => {
  it("says what needs confirming", () => {
    expect(scheduleNeeds(v(), T - 1, T)).toEqual({ past: true, handedOver: false, awaitingYou: false });
    expect(scheduleNeeds(v({ deliveries: { "li/acme": { status: "handed_over" } } }), T + 1, T)).toEqual({ past: false, handedOver: true, awaitingYou: false });
    expect(scheduleNeeds(v({ deliveries: { "li/acme": { status: "awaiting_you" } } }), T + 1, T)).toEqual({ past: false, handedOver: false, awaitingYou: true });
  });

  it("finds the best slot from the channels' usual times", () => {
    expect(bestSlot([channel("li/me"), channel("li/acme", { name: "Acme Studio", defaultTime: "08:30" })])).toEqual({ time: "08:30", channel: "Acme Studio" });
    expect(bestSlot([channel("li/me")])).toBeNull();
  });

  it("picks reminders from the post, then the channel, then the settings", () => {
    const acme = channel("li/acme", { defaultReminders: [30] });
    expect(reminderDefaults(v({ reminders: [5] }), [acme], DEFAULT_SETTINGS)).toEqual([5]);
    expect(reminderDefaults(v(), [channel("li/me"), acme], DEFAULT_SETTINGS)).toEqual([30]);
    expect(reminderDefaults(v(), [channel("li/me")], DEFAULT_SETTINGS)).toEqual([60, 10]);
  });
});
