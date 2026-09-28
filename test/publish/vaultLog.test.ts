import { describe, expect, it } from "vitest";
import { App } from "../fakes/obsidian";
import { SecretIds, Secrets } from "../../src/secrets/secrets";
import { formatLogLine, LOG_HEADER, monthKey, VaultLog, type VaultLogDeps } from "../../src/publish/vaultLog";
import type { AttemptEntry } from "../../src/publish/log";

const OCT = Date.UTC(2026, 9, 8, 15, 30); // Thu 8 Oct 2026, 17:30 Berlin
const NOV = Date.UTC(2026, 10, 2, 8, 0); // Mon 2 Nov 2026, 09:00 Berlin
const entry = (over: Partial<AttemptEntry> = {}): AttemptEntry => ({
  at: OCT,
  path: "Social/Event X/Event X – LinkedIn.md",
  channelId: "li/acme",
  result: "published",
  url: "https://www.linkedin.com/feed/update/urn:li:share:1",
  ...over,
});

function build(over: Partial<VaultLogDeps> = {}) {
  const app = new App();
  const secrets = new Secrets(app as never);
  const warnings: string[] = [];
  const log = new VaultLog({
    app: app as never,
    rootFolder: () => "Social",
    redact: (text) => secrets.redact(text, [SecretIds.ntfyTopic, SecretIds.ntfyToken, "osmm-channel-li-acme"]),
    channelName: (id) => (id === "li/acme" ? "Acme Studio" : id),
    warn: (m) => void warnings.push(m),
    ...over,
  });
  const read = async (path = "Social/_log.md") => {
    const file = app.vault.getFileByPath(path);
    return file ? app.vault.read(file) : null;
  };
  return { app, secrets, log, warnings, read };
}

describe("formatLogLine", () => {
  it("writes time, channel, variant link, result and URL on one line", () => {
    expect(formatLogLine(entry(), "Acme Studio", (t) => t)).toBe(
      "- 2026-10-08T17:30:00+02:00 · Acme Studio (li/acme) · [[Social/Event X/Event X – LinkedIn]] · published · https://www.linkedin.com/feed/update/urn:li:share:1",
    );
  });

  it("flattens multi-line errors, strips link syntax and caps the length", () => {
    const line = formatLogLine(entry({ result: "failed", url: undefined, error: `Bad [[thing]]\n  | ${"x".repeat(400)}` }), "li/acme", (t) => t);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("[[thing");
    expect(line.startsWith("- 2026-10-08T17:30:00+02:00 · li/acme · [[Social/Event X/Event X – LinkedIn]] · failed · Bad thing / xxx")).toBe(true);
    expect(line.length).toBeLessThan(420);
  });

  it("labels every result", () => {
    expect(formatLogLine(entry({ result: "retry", url: undefined, error: "503" }), "x", (t) => t)).toContain(" · failed, will retry · 503");
    expect(formatLogLine(entry({ result: "check_needed", url: undefined }), "x", (t) => t)).toContain(" · check needed");
  });

  it("labels the hand-over results (M5)", () => {
    expect(formatLogLine(entry({ result: "handed_over", url: undefined }), "x", (t) => t)).toContain(" · handed over to the platform");
    expect(formatLogLine(entry({ result: "handover_failed", url: undefined, error: "422" }), "x", (t) => t)).toContain(" · hand-over failed, stays scheduled · 422");
    expect(formatLogLine(entry({ result: "cancelled", url: undefined }), "x", (t) => t)).toContain(" · taken off the platform's schedule");
  });

  it("keys months in local time", () => {
    expect(monthKey(Date.UTC(2026, 9, 31, 23, 30))).toBe("2026-11"); // 00:30 on 1 Nov in Berlin
  });
});

describe("VaultLog", () => {
  it("creates Social/_log.md with a header and appends one line per attempt", async () => {
    const { log, read } = build();
    await log.append(entry());
    await log.append(entry({ channelId: "li/me", result: "awaiting_you", url: undefined }));
    expect(await read()).toBe(
      `${LOG_HEADER}- 2026-10-08T17:30:00+02:00 · Acme Studio (li/acme) · [[Social/Event X/Event X – LinkedIn]] · published · https://www.linkedin.com/feed/update/urn:li:share:1\n` +
        "- 2026-10-08T17:30:00+02:00 · li/me · [[Social/Event X/Event X – LinkedIn]] · waiting for you\n",
    );
  });

  it("serializes appends that race (review focus 4)", async () => {
    const { log, read } = build();
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(entry({ at: OCT + i * 1000, url: `https://example.com/${i}` }))));
    const lines = (await read())!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(20);
    expect(lines.map((l) => l.split("/").pop())).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  });

  it("never writes a secret", async () => {
    const { log, read, secrets } = build();
    secrets.set(SecretIds.ntfyTopic, "osmm-SECRETTOPIC123");
    secrets.set("osmm-channel-li-acme", "tok_ABCDEF");
    await log.append(entry({ result: "failed", url: "https://ntfy.sh/osmm-SECRETTOPIC123", error: "401 for tok_ABCDEF" }));
    const text = (await read())!;
    expect(text).not.toContain("SECRETTOPIC123");
    expect(text).not.toContain("tok_ABCDEF");
    expect(text).toContain("401 for •••");
  });

  it("keeps the user's own edits to the log", async () => {
    const { app, log, read } = build();
    await log.append(entry());
    const file = app.vault.getFileByPath("Social/_log.md")!;
    await app.vault.modify(file, `${await app.vault.read(file)}Note to self: LinkedIn was slow today`);
    await log.append(entry({ at: OCT + 60_000 }));
    expect(await read()).toContain("Note to self: LinkedIn was slow today\n- 2026-10-08T17:31:00+02:00");
  });

  it("moves last month to _log/YYYY-MM.md on the first entry of a new month (review focus 4)", async () => {
    const { log, read } = build();
    await log.append(entry());
    await log.append(entry({ at: NOV }));
    expect(await read("Social/_log/2026-10.md")).toContain("- 2026-10-08T17:30:00+02:00");
    expect(await read()).toBe(`${LOG_HEADER}${formatLogLine(entry({ at: NOV }), "Acme Studio", (t) => t)}\n`);
  });

  it("appends an entry older than the file's month instead of archiving again", async () => {
    const { log, read } = build();
    await log.append(entry({ at: NOV }));
    await log.append(entry({ at: OCT }));
    expect(await read("Social/_log/2026-11.md")).toBeNull();
    expect((await read())!.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("merges into an existing archive", async () => {
    const { app, log, read } = build();
    await app.vault.createFolder("Social/_log");
    await app.vault.create("Social/_log/2026-10.md", "- 2026-10-01T09:00:00+02:00 · earlier\n");
    await app.vault.create("Social/_log.md", `${LOG_HEADER}- 2026-10-20T09:00:00+02:00 · later\n`);
    await log.append(entry({ at: NOV }));
    expect(await read("Social/_log/2026-10.md")).toBe("- 2026-10-01T09:00:00+02:00 · earlier\n- 2026-10-20T09:00:00+02:00 · later\n");
    expect(await read()).toContain("2026-11-02T09:00:00+01:00");
  });

  it("warns once per failure streak and keeps working afterwards", async () => {
    const { app, log, read, warnings } = build();
    const create = app.vault.create.bind(app.vault);
    app.vault.create = async () => {
      throw new Error("disk full");
    };
    await log.append(entry());
    await log.append(entry());
    expect(warnings).toEqual(["Couldn't write to the publish log: disk full"]);
    app.vault.create = create;
    await log.append(entry());
    expect(await read()).toContain("published");
    app.vault.create = async () => {
      throw new Error("disk full");
    };
    await app.vault.delete(app.vault.getFileByPath("Social/_log.md")!);
    await log.append(entry());
    expect(warnings).toHaveLength(2);
  });

  it("follows the configured root folder", async () => {
    const { log, read } = build({ rootFolder: () => "Content/Social" });
    await log.append(entry());
    expect(await read("Content/Social/_log.md")).toContain("published");
  });
});
