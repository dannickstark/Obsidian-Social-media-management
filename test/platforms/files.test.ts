import { describe, expect, it } from "vitest";
import { InvalidContentError, NeedsUserError, TransientError, UnknownOutcomeError } from "../../src/platforms/errors";
import { fileName, partialNote, readMedia } from "../../src/platforms/files";
import { img } from "./fixtures";

describe("adapter file helpers", () => {
  it("reads a resolved image and refuses a missing or unreadable one as needs-user", async () => {
    const data = new Uint8Array([1, 2]).buffer;
    expect(await readMedia(async () => data, img())).toBe(data);
    await expect(readMedia(async () => data, img("gone.png", 1, 1, { path: undefined, kind: "missing" }))).rejects.toThrow(new NeedsUserError("gone.png can't be found in the vault."));
    await expect(readMedia(async () => Promise.reject(new Error("EACCES")), img())).rejects.toThrow(new NeedsUserError("a.png can't be read from the vault."));
  });

  it("makes a safe upload file name", () => {
    expect(fileName(img("Event X cover (final).png", 1, 1, { path: "Social/Event X cover (final).png" }))).toBe("Event-X-cover-final-.png");
    expect(fileName(img("x.png", 1, 1, { path: undefined }))).toBe("x.png");
    expect(fileName(img("", 1, 1, { path: undefined }))).toBe("image");
  });

  it("says which thread part stopped, and whether it may have gone out", () => {
    expect(partialNote(1, 3, new InvalidContentError("Bluesky: too long (HTTP 400)"))).toBe("Part 2 of 3 was not posted, nor any after it: Bluesky: too long (HTTP 400)");
    expect(partialNote(2, 3, new UnknownOutcomeError("Bluesky: no answer in time while posting, so it is not known whether it went out."))).toBe(
      "Part 3 of 3 may have been posted; check on the platform. Nothing after it was posted: Bluesky: no answer in time while posting, so it is not known whether it went out.",
    );
  });

  it("treats an error without a status as an unknown outcome, and an HTTP error by its status", () => {
    expect(partialNote(0, 2, new Error("socket hang up"))).toBe("Part 1 of 2 may have been posted; check on the platform. Nothing after it was posted: socket hang up");
    expect(partialNote(0, 2, "boom")).toBe("Part 1 of 2 may have been posted; check on the platform. Nothing after it was posted: boom");
    expect(partialNote(1, 2, Object.assign(new Error("Request failed, status 422"), { status: 422 }))).toBe("Part 2 of 2 was not posted, nor any after it: Request failed, status 422");
    expect(partialNote(1, 2, new TransientError("Bluesky: Slow down (HTTP 429)"))).toBe("Part 2 of 2 was not posted, nor any after it: Bluesky: Slow down (HTTP 429)");
  });
});
