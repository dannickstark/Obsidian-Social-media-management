import { describe, expect, it } from "vitest";
import { postRkey, tid, tidMicros, TID_RE } from "../../../src/platforms/bluesky/tid";

describe("TID record keys", () => {
  it("has the TID shape and round-trips the time", () => {
    const micros = Date.UTC(2026, 9, 8, 8) * 1000 + 3;
    const key = tid(micros, 517);
    expect(key).toMatch(TID_RE);
    expect(tidMicros(key)).toBe(micros);
    expect(tid(0, 0)).toBe("2222222222222");
  });

  it("sorts by time as a string", () => {
    expect(tid(1_000, 1) < tid(2_000, 0)).toBe(true);
  });

  it("gives each thread part its own key, stable for a claim and a channel", () => {
    const at = Date.UTC(2026, 9, 8, 8);
    expect(postRkey(at, 0, "bs/you")).toBe(postRkey(at, 0, "bs/you"));
    expect(postRkey(at, 1, "bs/you")).not.toBe(postRkey(at, 0, "bs/you"));
    expect(postRkey(at, 0, "bs/other")).not.toBe(postRkey(at, 0, "bs/you"));
    expect(postRkey(at, 0, "bs/you")).toMatch(TID_RE);
  });
});
