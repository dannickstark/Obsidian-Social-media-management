import { classifyError, NeedsUserError, PublishError, statusOf, type ErrorKind } from "./errors";
import type { MediaInfo } from "./types";

/** The bytes of a resolved image. Checks block missing media before scheduling; this covers a file deleted since. */
export async function readMedia(read: (path: string) => Promise<ArrayBuffer>, m: Pick<MediaInfo, "path" | "target">): Promise<ArrayBuffer> {
  if (!m.path) throw new NeedsUserError(`${m.target} can't be found in the vault.`);
  try {
    return await read(m.path);
  } catch {
    throw new NeedsUserError(`${m.target} can't be read from the vault.`);
  }
}

/** An upload file name without spaces, quotes or path parts. */
export function fileName(m: Pick<MediaInfo, "path" | "target">): string {
  const name = (m.path ?? m.target).split("/").pop() ?? "";
  return name.replace(/[^\w.-]+/g, "-") || "image";
}

/**
 * How a later part of a post that is already out failed: a PublishError keeps its kind, an HTTP error is classified by
 * its status, and anything else (no status) is an unknown outcome (M2b T6).
 */
export function partialOutcome(e: unknown): { kind: ErrorKind; message: string } {
  if (e instanceof PublishError || statusOf(e) !== undefined) {
    const err = classifyError(e);
    return { kind: err.kind, message: err.message };
  }
  return { kind: "unknown", message: e instanceof Error ? e.message : String(e) };
}

/** A thread stopped after its first part(s): the post is out, the rest is not (or may not be). */
export function partialNote(index: number, total: number, e: unknown): string {
  const { kind, message } = partialOutcome(e);
  if (kind === "unknown") return `Part ${index + 1} of ${total} may have been posted; check on the platform. Nothing after it was posted: ${message}`;
  return `Part ${index + 1} of ${total} was not posted, nor any after it: ${message}`;
}
