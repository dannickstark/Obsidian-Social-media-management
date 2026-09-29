import { cyrb53 } from "../../util/hash";

const S32 = "234567abcdefghijklmnopqrstuvwxyz";
export const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

/** A TID: 0 | 53 bits of microseconds | 10 bits of clock id, as 13 base32-sortable characters. */
export function tid(micros: number, clockId: number): string {
  let v = (BigInt(Math.floor(micros)) << 10n) | BigInt(clockId & 1023);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = S32[Number(v & 31n)]! + out;
    v >>= 5n;
  }
  return out;
}

export function tidMicros(key: string): number {
  let v = 0n;
  for (const ch of key) v = v * 32n + BigInt(S32.indexOf(ch));
  return Number(v >> 10n);
}

/**
 * The record key of thread part `index` of a delivery claimed at `claimAt` (ms): the same for the publish and
 * for the lookup after an interrupted publish (M2b P4), different per part and per channel.
 */
export function postRkey(claimAt: number, index: number, channelId: string): string {
  return tid(claimAt * 1000 + index, cyrb53(channelId) % 1024);
}
