import { describe, expect, it } from "vitest";
import { Semaphore } from "../../src/publish/semaphore";

describe("Semaphore", () => {
  it("never runs more than the limit at once, and runs everything", async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let max = 0;
    const job = async (n: number) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    };
    expect(await Promise.all([1, 2, 3, 4, 5].map((n) => gate.run(() => job(n))))).toEqual([1, 2, 3, 4, 5]);
    expect(max).toBe(2);
  });

  it("releases the slot when a job throws", async () => {
    const gate = new Semaphore(1);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await gate.run(async () => "next")).toBe("next");
  });
});
