function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** RFC 7636 S256, with 256 bits of randomness from the platform CSPRNG. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const verifier = base64url(bytes);
  // Node crypto is loaded only when the desktop flow starts; mobile can still load the plugin.
  const { createHash } = await import("node:crypto");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

export function newState(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Compare without an early exit for different characters or lengths. */
export function equalState(expected: string, received: string): boolean {
  let difference = expected.length ^ received.length;
  for (let i = 0; i < Math.max(expected.length, received.length); i++) {
    difference |= (expected.charCodeAt(i) || 0) ^ (received.charCodeAt(i) || 0);
  }
  return difference === 0;
}
