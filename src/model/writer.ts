import { getFrontMatterInfo, parseYaml, type App, type TFile } from "obsidian";
import { isRecord, parseVariant, serializeDelivery, variantFields, type VariantPatch } from "./frontmatter";
import { rollupStatus, transition } from "./stateMachine";
import type { Delivery, DeliveryStatus, Variant } from "./types";

type Frontmatter = Record<string, unknown>;

/** A frontmatter change computed against fresh frontmatter: plain fields plus a per-channel delivery patch. */
export interface VariantUpdate {
  fields?: Omit<VariantPatch, "deliveries">;
  /** Per channel id; `null` deletes that entry only. Other entries stay verbatim. */
  deliveries?: Record<string, Delivery | null>;
}

export type VariantPlan = (fresh: Variant) => VariantUpdate | { refuse: string };

/** Thrown inside processFrontMatter to abort it, so a refused plan writes nothing at all. */
class Refusal {
  constructor(readonly result: { refuse: string }) {}
}

/** Frontmatter keys owned by `serializeDelivery`; any other key in a raw delivery entry is kept. */
const DELIVERY_KEYS = ["status", "at", "url", "remote_id", "error", "attempts", "reason", "remote_at", "digest"];

function applyFields(fm: Frontmatter, fields: Frontmatter): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete fm[key];
    else fm[key] = value;
  }
}

function requireVariant(fm: Frontmatter, path: string): Variant {
  const parsed = parseVariant(fm, path).value;
  if (!parsed) throw new Error(`${path} is not a valid social post`);
  return parsed;
}

/**
 * Apply a per-channel delivery patch to the raw `deliveries` map, touching only the patched keys
 * (other entries stay verbatim, even ones that do not parse), then roll up the status.
 */
function applyDeliveryPatch(fm: Frontmatter, v: Variant, patch: Record<string, Delivery | null>): void {
  const raw: Frontmatter = isRecord(fm.deliveries) ? fm.deliveries : {};
  const deliveries = { ...v.deliveries };
  for (const [id, d] of Object.entries(patch)) {
    if (d === null) {
      delete raw[id];
      delete deliveries[id];
    } else {
      const entry: Frontmatter = isRecord(raw[id]) ? { ...raw[id] } : {};
      for (const key of DELIVERY_KEYS) delete entry[key];
      raw[id] = { ...serializeDelivery(d), ...entry };
      deliveries[id] = d;
    }
  }
  if (Object.keys(raw).length > 0) fm.deliveries = raw;
  else delete fm.deliveries;
  fm.status = rollupStatus({ ...v, deliveries });
}

/**
 * The single entry point for mutating frontmatter of existing notes.
 * Writes to the same TFile are applied one after another (keyed by object identity, so renames are safe).
 */
export class SafeWriter {
  private readonly queues = new WeakMap<TFile, Promise<unknown>>();

  constructor(private readonly app: App) {}

  /** One queue per file (object identity), for frontmatter and body writes alike. */
  private enqueue<T>(file: TFile, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(
      file,
      next.catch(() => undefined),
    );
    return next;
  }

  run<T>(file: TFile, fn: (fm: Frontmatter) => T): Promise<T> {
    return this.enqueue(file, async () => {
      let result!: T;
      await this.app.fileManager.processFrontMatter(file, (fm: Frontmatter) => {
        result = fn(fm);
      });
      return result;
    });
  }

  /**
   * Replaces the note's body; the frontmatter block is kept exactly as it is. `edit` also sees the current
   * frontmatter (read only) and may throw to abort: then nothing is written.
   */
  editBody(file: TFile, edit: (body: string, fm: Frontmatter) => string): Promise<void> {
    return this.enqueue(file, async () => {
      await this.app.vault.process(file, (content) => {
        const info = getFrontMatterInfo(content);
        const head = info.exists ? content.slice(0, info.contentStart) : "";
        const parsed: unknown = info.exists ? parseYaml(info.frontmatter) : null;
        const next = edit(info.exists ? content.slice(info.contentStart) : content, isRecord(parsed) ? parsed : {});
        return head + (next.endsWith("\n") ? next : `${next}\n`);
      });
    });
  }

  setFields(file: TFile, fields: Frontmatter): Promise<void> {
    return this.run(file, (fm) => applyFields(fm, fields));
  }

  patchVariant(file: TFile, patch: VariantPatch): Promise<void> {
    return this.run(file, (fm) => {
      applyFields(fm, variantFields(patch));
      const v = requireVariant(fm, file.path);
      fm.status = rollupStatus(v);
    });
  }

  /**
   * Read-modify-write: `plan` runs inside the write queue against the freshly parsed variant, so it
   * never works from a stale snapshot. Fields go through `variantFields` (never `deliveries`),
   * deliveries through the per-key patch; the status is rolled up afterwards. A `refuse` writes
   * nothing. The result is the applied update, with `fields.status` (if planned) set to the status
   * actually stored after roll-up.
   */
  async updateVariant(file: TFile, plan: VariantPlan): Promise<VariantUpdate | { refuse: string }> {
    try {
      return await this.run(file, (fm) => this.applyPlan(fm, file, plan));
    } catch (e) {
      if (e instanceof Refusal) return e.result;
      throw e;
    }
  }

  private applyPlan(fm: Frontmatter, file: TFile, plan: VariantPlan): VariantUpdate {
    const planned = plan(requireVariant(fm, file.path));
    if ("refuse" in planned) throw new Refusal(planned);
    const fields: VariantPatch = { ...planned.fields };
    delete fields.deliveries;
    applyFields(fm, variantFields(fields));
    const v = requireVariant(fm, file.path);
    if (planned.deliveries && Object.keys(planned.deliveries).length > 0) applyDeliveryPatch(fm, v, planned.deliveries);
    else fm.status = rollupStatus(v);
    const applied: VariantUpdate = {};
    if (planned.fields) applied.fields = "status" in fields ? { ...fields, status: requireVariant(fm, file.path).status } : fields;
    if (planned.deliveries) applied.deliveries = planned.deliveries;
    return applied;
  }

  updateDeliveries(file: TFile, patch: Record<string, Delivery | null>): Promise<void> {
    return this.run(file, (fm) => applyDeliveryPatch(fm, requireVariant(fm, file.path), patch));
  }

  transitionDelivery(
    file: TFile,
    channelId: string,
    to: DeliveryStatus,
    patch: Partial<Omit<Delivery, "status">> = {},
  ): Promise<Delivery> {
    return this.run(file, (fm) => {
      const v = requireVariant(fm, file.path);
      const next = transition(v.deliveries[channelId] ?? { status: "draft" }, to, patch);
      applyDeliveryPatch(fm, v, { [channelId]: next });
      return next;
    });
  }
}
