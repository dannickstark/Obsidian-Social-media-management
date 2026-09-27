import { describe, expect, it } from "vitest";
import { DELIVERY_STATUSES } from "../../src/model/schemas";
import {
  IllegalTransitionError,
  canTransition,
  deliveryTime,
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
  ])("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition({ status: from }, to).status).toBe(to);
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

  it("treats channels without a delivery as draft", () => {
    expect(rollupStatus({ status: "draft", channels: ["li/a", "li/b"], deliveries: { "li/a": { status: "published" } } })).toBe("partial");
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
