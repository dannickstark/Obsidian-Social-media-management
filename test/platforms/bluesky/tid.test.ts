import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { newSendKey, postRkey, tid, tidMicros, tidParts, TID_RE } from "../../../src/platforms/bluesky/tid";

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

  it("gives thread part i the root's time plus i microseconds and the root's clock id (M5 P17b)", () => {
    const root = tid(Date.UTC(2026, 9, 8, 8) * 1000 + 417, 733);
    expect(tidParts(root, 0)).toBe(root);
    expect(tidParts(root, 2)).toBe(tid(Date.UTC(2026, 9, 8, 8) * 1000 + 419, 733));
    expect(tidParts(root, 1)).toMatch(TID_RE);
    // The claim-time keys of Task 7 are the same scheme.
    const at = Date.UTC(2026, 9, 8, 8);
    expect(tidParts(postRkey(at, 0, "bs/you"), 3)).toBe(postRkey(at, 3, "bs/you"));
  });

  it("makes a send key from the time and random bits: a random sub-millisecond offset and clock id (M5 P17b)", () => {
    const now = Date.UTC(2026, 9, 8, 8);
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      (a as unknown as Uint16Array).set([999, 1023]);
      return a;
    });
    const key = newSendKey(now);
    spy.mockRestore();
    expect(key).toBe(tid(now * 1000 + 999, 1023));
    expect(key).toMatch(TID_RE);
    const keys = new Set(Array.from({ length: 50 }, () => newSendKey(now)));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(Math.floor(tidMicros(k) / 1000)).toBe(now);
  });
});
