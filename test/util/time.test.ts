import { describe, expect, it, vi } from "vitest";
import { settlesWithin, withTimeout } from "../../src/util/time";

describe("withTimeout / settlesWithin (final review 12)", () => {
  it("gives the task's value when it settles in time, the fallback otherwise", async () => {
    vi.useFakeTimers();
    try {
      expect(await withTimeout(Promise.resolve(1), 100, "late")).toBe(1);
      const hung = withTimeout(new Promise<number>(() => undefined), 100, "late");
      await vi.advanceTimersByTimeAsync(99);
      let done: unknown = "pending";
      void hung.then((v) => (done = v));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await hung).toBe("late");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a rejection on, and a late rejection is never unhandled", async () => {
    await expect(withTimeout(Promise.reject(new Error("no")), 100, null)).rejects.toThrow("no");
    vi.useFakeTimers();
    try {
      let reject!: (e: Error) => void;
      const task = new Promise<number>((_, r) => (reject = r));
      const raced = withTimeout(task, 100, null);
      await vi.advanceTimersByTimeAsync(100);
      expect(await raced).toBeNull();
      reject(new Error("late"));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settlesWithin is true for a settled task (even a rejected one) and false after the bound", async () => {
    expect(await settlesWithin(Promise.reject(new Error("x")), 100)).toBe(true);
    vi.useFakeTimers();
    try {
      const hung = settlesWithin(new Promise(() => undefined), 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await hung).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
