import { describe, expect, it } from "vitest";
import { App } from "../../fakes/obsidian";
import { BookingLedger, type Booking } from "../../../src/reminders/ntfy/bookings";

const b = (key: string, fireAt: number, version = 999): Booking => ({
  key,
  rowKey: key.replace(/@\d+:\d+$/, ""),
  minutes: 10,
  messageId: `m${fireAt}`,
  fireAt,
  version,
});

describe("BookingLedger", () => {
  it("keeps bookings across restarts, on this device only", () => {
    const app = new App();
    new BookingLedger(app as never).put(b("p.md#bs/you@100:10", 50));
    const again = new BookingLedger(app as never);
    expect(again.all()).toEqual([b("p.md#bs/you@100:10", 50)]);
    expect(again.get("p.md#bs/you@100:10")?.messageId).toBe("m50");
    expect(again.size()).toBe(1);
  });

  it("replaces, removes, prunes and clears", () => {
    const ledger = new BookingLedger(new App() as never);
    ledger.put(b("a@1:10", 10));
    ledger.put(b("b@1:10", 20));
    ledger.put({ ...b("a@1:10", 10), messageId: "new" });
    expect(ledger.all().map((x) => [x.key, x.messageId])).toEqual([
      ["a@1:10", "new"],
      ["b@1:10", "m20"],
    ]);
    ledger.prune(15);
    expect(ledger.all().map((x) => x.key)).toEqual(["b@1:10"]);
    ledger.remove("b@1:10");
    expect(ledger.all()).toEqual([]);
    ledger.put(b("c@1:10", 30));
    ledger.clear();
    expect(ledger.size()).toBe(0);
  });

  it("ignores malformed entries and never stores the topic", () => {
    const app = new App();
    app.saveLocalStorage("osmm-ntfy-bookings", {
      good: { rowKey: "r", minutes: 10, messageId: "m", fireAt: 1, version: 5 },
      bad: { rowKey: 3 },
    });
    const ledger = new BookingLedger(app as never);
    expect(ledger.all().map((x) => x.key)).toEqual(["good"]);
    ledger.put(b("d@1:10", 5));
    expect(Object.keys(Object.values(app.loadLocalStorage("osmm-ntfy-bookings") as object)[0])).toEqual([
      "rowKey",
      "minutes",
      "messageId",
      "fireAt",
      "version",
    ]);
  });

  it("keeps a stale mark (an uncancellable push still due) and revives without it", () => {
    const app = new App();
    const ledger = new BookingLedger(app as never);
    ledger.put({ ...b("s@1:10", 5), stale: true });
    expect(new BookingLedger(app as never).get("s@1:10")?.stale).toBe(true);
    ledger.put({ ...b("s@1:10", 5), stale: false });
    expect(new BookingLedger(app as never).get("s@1:10")).toEqual(b("s@1:10", 5));
    expect(Object.keys((app.loadLocalStorage("osmm-ntfy-bookings") as Record<string, object>)["s@1:10"]!)).not.toContain("stale");
  });

  it("remembers on this device that the server can't cancel, until reset", () => {
    const app = new App();
    const ledger = new BookingLedger(app as never);
    expect(ledger.cancelSupported()).toBe(true);
    ledger.markCancelUnsupported();
    ledger.clear();
    expect(new BookingLedger(app as never).cancelSupported()).toBe(false);
    ledger.resetCancelSupport();
    expect(new BookingLedger(app as never).cancelSupported()).toBe(true);
  });
});
