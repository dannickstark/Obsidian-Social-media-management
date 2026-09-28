import { describe, expect, it } from "vitest";
import type { DeliveryStatus } from "../../src/model/types";
import { toAwaiting, toPublished, toSkipped } from "../../src/publish/transitions";

describe("assisted transitions", () => {
  it.each([
    ["draft", "awaiting_you"],
    ["ready", "awaiting_you"],
    ["scheduled", "awaiting_you"],
    ["overdue", "awaiting_you"],
    ["failed", "awaiting_you"],
    ["skipped", "awaiting_you"],
    ["awaiting_you", "awaiting_you"],
    ["published", null],
    ["publishing", null],
    ["handed_over", null],
    ["check_needed", null],
  ] as Array<[DeliveryStatus, DeliveryStatus | null]>)("toAwaiting(%s) = %s", (from, to) => {
    expect(toAwaiting({ status: from })?.status ?? null).toBe(to);
  });

  it.each([
    ["scheduled", "published"],
    ["awaiting_you", "published"],
    ["check_needed", "published"],
    ["handed_over", "published"],
    ["draft", "published"],
    ["published", null],
    ["publishing", null],
  ] as Array<[DeliveryStatus, DeliveryStatus | null]>)("toPublished(%s) = %s", (from, to) => {
    expect(toPublished({ status: from }, { url: "https://x" })?.status ?? null).toBe(to);
  });

  it("never jumps from scheduled straight to published", () => {
    expect(toPublished({ status: "scheduled", at: 1 }, { url: "https://x", at: 2 })).toEqual({ status: "published", at: 2, url: "https://x" });
  });

  it("skips with a reason where the state machine allows it", () => {
    expect(toSkipped({ status: "awaiting_you" }, "Posted elsewhere")).toEqual({ status: "skipped", reason: "Posted elsewhere" });
    expect(toSkipped({ status: "handed_over" })).toBeNull();
    expect(toSkipped({ status: "published" })).toBeNull();
  });
});
