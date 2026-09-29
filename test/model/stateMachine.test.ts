import { describe, expect, it } from "vitest";
import { DELIVERY_STATUSES } from "../../src/model/schemas";
import {
  IllegalTransitionError,
  canTransition,
  deliveryTime,
  inheritedStatus,
  rollupStatus,
  transition,
} from "../../src/model/stateMachine";
import type { Delivery, DeliveryStatus } from "../../src/model/types";

describe("delivery transitions (spec §5)", () => {
  it.each<[DeliveryStatus, DeliveryStatus]>([
    ["draft", "ready"],
    ["ready", "scheduled"],
    ["scheduled", "handed_over"],
    ["scheduled", "publishing"],
    ["scheduled", "awaiting_you"],
    ["scheduled", "overdue"],
    ["handed_over", "published"],
    ["publishing", "published"],
    ["publishing", "failed"],
    ["publishing", "check_needed"],
    ["awaiting_you", "published"],
    ["awaiting_you", "skipped"],
    ["overdue", "publishing"],
    ["overdue", "scheduled"],
    ["failed", "publishing"],
    ["check_needed", "published"],
    ["check_needed", "handed_over"],
  ])("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    // M5 P11: check_needed → handed_over needs a hand-over baseline (remoteAt).
    const d: Delivery = from === "check_needed" && to === "handed_over" ? { status: from, remoteAt: 1 } : { status: from };
    expect(transition(d, to).status).toBe(to);
  });

  it.each<[DeliveryStatus, DeliveryStatus]>([
    ["draft", "published"],
    ["publishing", "scheduled"],
    ["publishing", "publishing"],
    ["check_needed", "publishing"],
    ["handed_over", "publishing"],
  ])("refuses %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => transition({ status: from }, to)).toThrow(IllegalTransitionError);
  });

  it("returns check_needed to handed_over only with a hand-over baseline (M5 P11)", () => {
    expect(() => transition({ status: "check_needed" }, "handed_over", { remoteId: "1" })).toThrow(IllegalTransitionError);
    expect(transition({ status: "check_needed", remoteAt: 5 }, "handed_over", { remoteId: "1" })).toEqual({ status: "handed_over", remoteAt: 5, remoteId: "1" });
    expect(transition({ status: "check_needed" }, "handed_over", { remoteAt: 5 }).status).toBe("handed_over");
    // The guard checks the merged result: a patch that clears remoteAt leaves no baseline.
    expect(() => transition({ status: "check_needed", remoteAt: 5 }, "handed_over", { remoteAt: undefined })).toThrow(IllegalTransitionError);
  });

  it("keeps the send key (sendAt) while a send is outstanding and clears it once the delivery is done or re-planned (M5 P17)", () => {
    const d = (status: DeliveryStatus): Delivery => ({ status, at: 1000, sendAt: 2000 });
    // Kept: the retry, the user's re-send from failed, the check.
    expect(transition(d("publishing"), "failed").sendAt).toBe(2000);
    expect(transition(d("failed"), "publishing").sendAt).toBe(2000);
    expect(transition(d("publishing"), "check_needed").sendAt).toBe(2000);
    expect(transition(d("check_needed"), "failed").sendAt).toBe(2000);
    // Cleared: published, back to draft or ready, rescheduled or unscheduled.
    for (const [from, to] of [["publishing", "published"], ["check_needed", "published"], ["failed", "scheduled"], ["check_needed", "scheduled"], ["failed", "ready"], ["overdue", "scheduled"], ["scheduled", "draft"]] as Array<[DeliveryStatus, DeliveryStatus]>) {
      expect(transition(d(from), to), `${from} → ${to}`).not.toHaveProperty("sendAt");
    }
  });

  it("never leaves published", () => {
    for (const to of DELIVERY_STATUSES) expect(canTransition("published", to)).toBe(false);
  });

  it("keeps existing fields and applies the patch", () => {
    const d: Delivery = { status: "publishing", at: 1000, attempts: 1 };
    expect(transition(d, "published", { url: "https://x.com/1", remoteId: "1" })).toEqual({
      status: "published",
      at: 1000,
      attempts: 1,
      url: "https://x.com/1",
      remoteId: "1",
    });
  });
});

describe("rollupStatus", () => {
  const v = (status: string[], stored = "draft") => ({
    status: stored as never,
    channels: status.map((_, i) => `li/c${i}`),
    deliveries: Object.fromEntries(status.map((s, i) => [`li/c${i}`, { status: s as DeliveryStatus }])),
  });

  it.each([
    [[], "idea", "idea"],
    [[], "ready", "ready"],
    [["failed", "published"], "draft", "attention"],
    [["check_needed"], "draft", "attention"],
    [["overdue", "scheduled"], "draft", "overdue"],
    [["published", "published"], "draft", "published"],
    [["published", "skipped"], "draft", "published"],
    [["skipped", "skipped"], "draft", "skipped"],
    [["published", "scheduled"], "draft", "partial"],
    [["scheduled", "awaiting_you"], "draft", "scheduled"],
    [["handed_over"], "draft", "scheduled"],
    [["ready", "ready"], "draft", "ready"],
    [["ready", "draft"], "draft", "draft"],
    [["draft"], "idea", "idea"],
  ])("%j (stored %s) → %s", (statuses, stored, expected) => {
    expect(rollupStatus(v(statuses, stored))).toBe(expected);
  });

  it("treats channels without a delivery as draft when the stored status is draft", () => {
    expect(rollupStatus({ status: "draft", channels: ["li/a", "li/b"], deliveries: { "li/a": { status: "published" } } })).toBe("partial");
  });

  it("lets channels without a delivery inherit the stored planned status (final review F1)", () => {
    const channels = ["li/a", "li/b"];
    expect(rollupStatus({ status: "scheduled", scheduledAt: 1, channels, deliveries: { "li/a": { status: "scheduled" } } })).toBe("scheduled");
    expect(rollupStatus({ status: "ready", channels, deliveries: { "li/a": { status: "ready" } } })).toBe("ready");
    expect(rollupStatus({ status: "scheduled", channels, deliveries: { "li/a": { status: "ready" } } })).toBe("draft");
  });

  it("returns the stored status when only unlisted channels have records", () => {
    expect(rollupStatus({ status: "scheduled", channels: ["li/a"], deliveries: { "li/z": { status: "published" } } })).toBe("scheduled");
  });
});

describe("inheritedStatus", () => {
  it.each([
    ["idea", undefined, "draft"],
    ["draft", 1, "draft"],
    ["ready", 1, "ready"],
    ["ready", undefined, "ready"],
    ["scheduled", 1, "scheduled"],
    ["scheduled", undefined, "draft"],
    ["partial", 1, "scheduled"],
    ["overdue", 1, "scheduled"],
    ["attention", 1, "scheduled"],
    ["published", 1, "scheduled"],
    ["skipped", 1, "scheduled"],
    ["skipped", undefined, "draft"],
  ])("stored %s (scheduledAt %s) → %s", (status, scheduledAt, expected) => {
    expect(inheritedStatus({ status: status as never, scheduledAt })).toBe(expected);
  });
});

describe("deliveryTime", () => {
  const variant = { scheduledAt: 1_000_000, channels: ["li/a", "li/b", "li/c"], staggerMinutes: 15, deliveries: {} as Record<string, Delivery> };

  it("staggers channels by their index", () => {
    expect(deliveryTime(variant, "li/a", 5)).toBe(1_000_000);
    expect(deliveryTime(variant, "li/c", 5)).toBe(1_000_000 + 30 * 60_000);
  });

  it("uses the default stagger when none is set", () => {
    expect(deliveryTime({ ...variant, staggerMinutes: undefined }, "li/b", 5)).toBe(1_000_000 + 5 * 60_000);
  });

  it("prefers an explicit delivery time", () => {
    expect(deliveryTime({ ...variant, deliveries: { "li/b": { status: "scheduled", at: 42 } } }, "li/b", 5)).toBe(42);
  });

  it("is undefined without a schedule", () => {
    expect(deliveryTime({ ...variant, scheduledAt: undefined }, "li/a", 5)).toBeUndefined();
  });
});
