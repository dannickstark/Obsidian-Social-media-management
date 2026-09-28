import { describe, expect, it } from "vitest";
import { blocking, validateFor } from "../../src/platforms/checks";
import { platformDef } from "../../src/platforms/registry";
import { input, messages } from "./fixtures";

describe("linkChecks: only http(s) links", () => {
  it("blocks a javascript: url", () => {
    const issues = validateFor(input("hackernews", "", { title: "Show HN: OSMM", url: "javascript:alert(1)" }), platformDef("hackernews"));
    expect(messages(issues)).toContain("error:url:Use an http(s) link");
    expect(blocking(issues)).toBe(true);
  });

  it("leaves an https: url unaffected", () => {
    const issues = validateFor(input("hackernews", "", { title: "Show HN: OSMM", url: "https://example.com" }), platformDef("hackernews"));
    expect(messages(issues)).not.toContain("error:url:Use an http(s) link");
    expect(blocking(issues)).toBe(false);
  });
});
