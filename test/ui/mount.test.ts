import { describe, expect, it, vi } from "vitest";
import { mountSvelte } from "../../src/ui/mount";
import Hello from "../fixtures/Hello.svelte";

describe("mountSvelte", () => {
  it("mounts with props and context, and unmounts exactly once", () => {
    const target = document.createElement("div");
    const onGone = vi.fn();
    const mounted = mountSvelte(target, Hello, { name: "Ada", onGone }, new Map([["greeting", "Hi"]]));
    expect(target.textContent).toContain("Hi, Ada!");
    mounted.destroy();
    mounted.destroy();
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(target.textContent).toBe("");
  });
});
