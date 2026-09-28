import type { TFile } from "obsidian";
import { serializeDelivery, variantFields, type VariantPatch } from "../model/frontmatter";
import type { VariantUpdate } from "../model/writer";
import type { Delivery, Variant } from "../model/types";

export type FieldKey = keyof Omit<VariantPatch, "deliveries">;

/** Equal as they would be stored in frontmatter (so sub-second or unit differences don't count). */
export function sameDelivery(a: Delivery | null | undefined, b: Delivery | null | undefined): boolean {
  return JSON.stringify(a ? serializeDelivery(a) : null) === JSON.stringify(b ? serializeDelivery(b) : null);
}

/** Compares on the frontmatter keys `b` writes (one key per field; a partial `wordpress` writes only some keys). */
export function sameField(key: FieldKey, a: unknown, b: unknown): boolean {
  const fa = variantFields({ [key]: a });
  const fb = variantFields({ [key]: b });
  return Object.keys(fb).every((k) => JSON.stringify(fa[k]) === JSON.stringify(fb[k]));
}

/** The value before a write, limited to what the write touched (a partial `wordpress` restores only its keys). */
function beforeOf(key: FieldKey, fresh: Variant, after: unknown): unknown {
  const before = fresh[key];
  if (key !== "wordpress" || !before || !after || typeof after !== "object") return before;
  return Object.fromEntries(Object.keys(after).map((k) => [k, (before as unknown as Record<string, unknown>)[k]]));
}

/** The entries of a planned full delivery map that differ from the fresh ones (keys absent from `next` are left alone). */
export function deliveryChanges(fresh: Pick<Variant, "deliveries">, next: Record<string, Delivery>): Record<string, Delivery> {
  const out: Record<string, Delivery> = {};
  for (const [id, d] of Object.entries(next)) if (!sameDelivery(fresh.deliveries[id], d)) out[id] = d;
  return out;
}

/** What one write changed on one note: before/after per field and per delivery key. */
export interface WriteRecord {
  file: TFile;
  fields: Array<{ key: FieldKey; before: unknown; after: unknown }>;
  deliveries: Array<{ id: string; before: Delivery | null; after: Delivery | null }>;
}

export function recordWrite(file: TFile, fresh: Variant, applied: VariantUpdate): WriteRecord {
  const record: WriteRecord = { file, fields: [], deliveries: [] };
  for (const [key, after] of Object.entries(applied.fields ?? {}) as Array<[FieldKey, unknown]>) {
    const before = beforeOf(key, fresh, after);
    if (!sameField(key, before, after)) record.fields.push({ key, before, after });
  }
  for (const [id, after] of Object.entries(applied.deliveries ?? {})) {
    const before = fresh.deliveries[id] ?? null;
    if (!sameDelivery(before, after)) record.deliveries.push({ id, before, after });
  }
  return record;
}

/**
 * Plan that reverts `record` on fresh frontmatter: a field or delivery key is restored only when it
 * still holds the value the write left; anything else changed since and counts as a conflict.
 */
export function planUndo(record: WriteRecord, fresh: Variant): { update: VariantUpdate; conflicts: number } {
  let conflicts = 0;
  const fields: Record<string, unknown> = {};
  const deliveries: Record<string, Delivery | null> = {};
  for (const f of record.fields) {
    if (sameField(f.key, fresh[f.key], f.after)) fields[f.key] = f.before;
    else conflicts++;
  }
  for (const d of record.deliveries) {
    if (sameDelivery(fresh.deliveries[d.id], d.after)) deliveries[d.id] = d.before;
    else conflicts++;
  }
  return { update: { fields: fields as VariantUpdate["fields"], deliveries }, conflicts };
}
