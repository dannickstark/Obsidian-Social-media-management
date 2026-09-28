import { classifyError, NeedsUserError } from "./errors";
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

/** A thread stopped after its first part(s): the post is out, the rest is not (or may not be). */
export function partialNote(index: number, total: number, e: unknown): string {
  const err = classifyError(e);
  const what = err.kind === "unknown" ? "may not have been posted" : "was not posted";
  return `Part ${index + 1} of ${total} ${what}, nor any after it: ${err.message}`;
}
